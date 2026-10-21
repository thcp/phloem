// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GLSL ES 3.00 sources for the 3D renderer.
 *
 * Tubes and food are camera-facing impostors: one instanced quad per segment
 * (4 vertices from gl_VertexID), built in view space on the plane through the
 * segment midpoint that faces the camera. The fragment shader reconstructs the
 * capsule surface analytically (normal + true depth via gl_FragDepth), so
 * neighbouring segments that share an endpoint sphere merge into one smooth
 * tube, and crossings are depth-correct.
 *
 * Every impostor is drawn twice, by two builds of its fragment shader:
 * the opaque pass writes fully covered, fully opaque fragments with
 * gl_FragDepth; the translucent pass draws only the remainder (anti-aliased
 * rim, sub-pixel threads, fading tubes) premultiplied-alpha blended and
 * depth-tested against the opaque pass. It does not write gl_FragDepth (the
 * quad's own depth is within half a segment of the truth), so GPUs can
 * early-reject fringe fragments hidden behind opaque veins, and sub-pixel
 * threads take a cheap unlit path.
 */

import { FLOOD_FRONT, FLOOD_WAKE, GHOST_ALPHA } from '../sim/activity';

const WOBBLE = /* glsl */ `
uniform float uTime;
uniform float uWobble;
// Shared positional sin-noise (x, y components identical to the 2D version; labels/select.ts has a CPU copy).
vec3 wobble(vec3 p) {
  float t = uTime;
  vec3 w = vec3(
    sin(p.x * 0.043 + t * 0.53) + sin(p.y * 0.057 - t * 0.41 + 1.3) + 0.5 * sin((p.x + p.y) * 0.13 + t * 0.9),
    sin(p.y * 0.047 + t * 0.47 + 2.1) + sin(p.x * 0.061 + t * 0.37 + 4.2) + 0.5 * sin((p.x - p.y) * 0.12 - t * 0.8),
    sin(p.z * 0.051 + t * 0.43 + 0.7) + sin(p.x * 0.053 - t * 0.39 + 2.9) + 0.5 * sin((p.y + p.z) * 0.11 + t * 0.7)
  );
  return w * uWobble;
}
`;

const VIEW = /* glsl */ `
uniform mat4 uView;
uniform mat4 uProj;
uniform float uPxScale; // world units per device px at view depth 1
`;

/** Billboard frame helpers shared by the impostor vertex shaders. */
const BILLBOARD = /* glsl */ `
// Unit axis u (projection of d on the plane facing the camera) and side s; V points to the camera.
void billboardBasis(vec3 V, vec3 d, out vec3 u, out vec3 s, out float L) {
  vec3 dp = d - V * dot(d, V);
  L = length(dp);
  if (L > 1e-5) u = dp / L;
  else {
    vec3 a = abs(V.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    u = normalize(cross(a, V));
    L = 0.0;
  }
  s = cross(V, u);
}
`;

/** Lighting shared by tubes and food (view space). */
const SHADE = /* glsl */ `
uniform vec2 uFog; // view depth where the depth cue starts / is full
const vec3 OCHRE = vec3(0.55, 0.28, 0.025);
const vec3 GOLD = vec3(0.98, 0.66, 0.08);
const vec3 BUTTER = vec3(1.0, 0.86, 0.40);
const vec3 KEY = vec3(-0.42, 0.70, 0.58); // normalized below
const vec3 FILL = vec3(0.55, -0.25, 0.35);

// Glossy translucent slime: wrapped diffuse, tight specular, golden fresnel rim.
vec3 shade(vec3 N, vec3 P, vec3 albedo, float gloss, float rimAmt) {
  vec3 Vd = normalize(-P);
  vec3 L = normalize(KEY);
  float ndl = dot(N, L);
  float diff = max(0.0, ndl * 0.6 + 0.4);
  float fill = max(0.0, dot(N, normalize(FILL))) * 0.22;
  float ndv = max(dot(N, Vd), 0.0);
  vec3 H = normalize(L + Vd);
  float spec = pow(max(dot(N, H), 0.0), 60.0) * gloss;
  float spec2 = pow(max(dot(N, H), 0.0), 9.0) * gloss * 0.12;
  float fres = pow(1.0 - ndv, 3.0);
  vec3 col = albedo * (0.2 + 1.15 * diff + fill);
  col += vec3(1.0, 0.94, 0.8) * (spec * 1.8 + spec2);
  col += mix(GOLD, BUTTER, 0.5) * fres * rimAmt * 1.2;
  return col;
}

// Depth cue: far veins dim and sink into the agar.
vec3 fog(vec3 col, float depth) {
  float f = smoothstep(uFog.x, uFog.y, depth);
  float l = dot(col, vec3(0.3, 0.5, 0.2));
  col = mix(col, vec3(l) * vec3(0.9, 0.62, 0.32), f * 0.55);
  return col * mix(1.0, 0.16, f);
}

float fragDepth(vec3 P) {
  vec4 c = uProj * vec4(P, 1.0);
  return clamp((c.z / c.w) * 0.5 + 0.5, 0.0, 1.0);
}
`;

/** Flags selecting a build of the segment shaders (see quality.ts `Effects`). */
export interface SegVariant {
  opaque: boolean;
  streaming: 0 | 1 | 2;
  radiusPulse: boolean;
  gel: boolean;
  flood: boolean;
  /** Measurement only: reproduce the pre-effects shader cost (no opaque-pass culling, no colour-by-meaning, per-fragment wave). */
  legacy?: boolean;
}

const defines = (v: SegVariant): string =>
  `#define OPAQUE ${v.opaque ? 1 : 0}
#define STREAM ${v.streaming}
#define RPULSE ${v.radiusPulse ? 1 : 0}
#define GEL ${v.gel ? 1 : 0}
#define FLOODS ${v.flood ? 1 : 0}
#define LEGACY ${v.legacy ? 1 : 0}
`;

/**
 * Commit floods (mirror of sim/activity.ts floodAt): uBurst[k] = (front distance, energy, author hue, -).
 * Returns rgb = tinted light, a = summed intensity (soft-capped so overlapping bursts never blow out).
 */
const FLOOD = /* glsl */ `
uniform vec4 uBurst[4];
uniform float uReach;
vec3 hue2rgb(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}
float floodOne(float d, vec4 b) {
  if (b.y <= 0.0 || b.x < 0.0) return 0.0;
  float x = b.x - d;
  float g = exp(-(x * x) / (${FLOOD_FRONT.toFixed(1)} * ${FLOOD_FRONT.toFixed(1)}));
  float shape = x < 0.0 ? g : exp(-x / ${FLOOD_WAKE.toFixed(1)}) * 0.85 + 0.15 * g;
  float travel = 1.0 - smoothstep(0.0, 1.0, b.x / (max(uReach, 60.0) + ${(2 * FLOOD_WAKE).toFixed(1)}));
  return b.y * shape * travel;
}
vec4 flood(float d) {
  vec4 acc = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    float f = floodOne(d, uBurst[k]);
    // gold-white light with a hint of the committing author's hue
    acc += vec4(mix(vec3(1.0, 0.8, 0.4), hue2rgb(uBurst[k].z) * 0.6 + 0.4, 0.22) * f, f);
  }
  float capped = 1.25 * (1.0 - exp(-acc.a / 1.25));
  return acc.a > 1e-4 ? acc * (capped / acc.a) : vec4(0.0);
}
`;

/** Slowly varying per-region phase offset, so neighbouring veins do not pulse in lockstep. */
const REGION = /* glsl */ `
float regionPhase(vec3 p) {
  return 2.2 * sin(dot(p, vec3(0.0123, 0.0157, 0.0111)) + 1.3 * sin(dot(p, vec3(-0.0071, 0.0093, 0.0131))));
}
`;

export const segVs = (v: SegVariant): string => /* glsl */ `#version 300 es
${defines(v)}
precision highp float;
layout(location = 0) in vec3 aP0;
layout(location = 1) in vec3 aP1;
layout(location = 2) in vec2 aR;     // unorm16 radii (x SEG_R_MAX)
layout(location = 3) in vec2 aAE;    // unorm8 alpha, emit (heat nibble << 4 | warmth nibble)
layout(location = 4) in float aDist; // unorm16 growth distance of endpoint 0 (x uDistMax)
uniform float uRMax;
uniform float uDistMax;
uniform float uMotion; // 1, or 0 under prefers-reduced-motion
uniform float uRadiusLod; // tube thickness factor (1 = as is; lower when the view is crowded)
uniform float uThreadLod; // opacity of the finest threads (1 = all drawn; lower when the view is crowded, see crowd.ts)
${VIEW}
${WOBBLE}
${BILLBOARD}
${FLOOD}
${REGION}
out vec2 vLocal;    // along, across (world units in the billboard plane)
out float vLen;
out vec2 vR;
out vec2 vOff;      // axis offset toward the camera at both ends
out vec3 vPos;      // view-space billboard point
out vec3 vU;
out vec3 vS;
out vec3 vV;
out vec4 vAxis;     // xyz: unit 3D axis (view space), w: 1 / cos(tilt out of the billboard plane)
out float vAlpha;
out float vCov;
out float vPx;
out vec3 vHWG;      // heat, warmth, ghost (0/1)
out vec2 vSeg;      // growth distance at endpoint 0, world length (s = x + t * y)
out vec4 vFlood;    // flood light (rgb) and intensity (a), linear along the axis
out float vWave;    // streaming / breathing brightness factor, linear along the axis
out float vPh;      // region phase, linear along the axis

// Thickness-tuned peristaltic streaming at growth distance d: x = wave (-1..1), y = slow breathing (-1..1).
// Two bands blended by thickness (a per-edge frequency would drift apart from its neighbour's over time):
// trunks throb slowly with a long wavelength, thin veins flicker quickly; the crest pattern of both slides
// back and forth (shuttle streaming), and the breathing tide rolls outward from the inoculum.
vec2 stream(float d, float ph, float th) {
  float t = uTime;
  float slosh = 2.6 * sin(0.31 * t + ph);
  float trunk = sin(d * 0.05 - 0.6 * t - slosh + ph);
  float thread = sin(d * 0.17 - 2.9 * t - 0.5 * slosh + 2.0 * ph);
  float w = mix(thread, trunk, smoothstep(0.1, 0.55, th));
  float breath = sin(0.75 * t - d * 0.012 + 0.6 * ph);
  return vec2(w, breath) * uMotion;
}

void main() {
  float e8 = floor(aAE.y * 255.0 + 0.5);
  float heatN = floor(e8 / 16.0);
  vHWG = vec3(heatN / 15.0, (e8 - heatN * 16.0) / 15.0, aAE.x < ${(GHOST_ALPHA + 0.008).toFixed(3)} ? 1.0 : 0.0);
  float r0 = aR.x * uRMax;
  float r1 = aR.y * uRMax;
  // crowded view: the finest threads (explorer hair) fade first, the trunks keep the structure
  float lod = mix(1.0, uThreadLod, 1.0 - smoothstep(0.3, 0.9, max(r0, r1)));
  r0 *= uRadiusLod;
  r1 *= uRadiusLod;
#if OPAQUE && !LEGACY
  // fading tubes and ghosts never have solid pixels: skip their quads in the opaque pass
  if (aAE.x < 0.99 || lod < 0.99) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
#endif
  if (lod < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float d0 = aDist * uDistMax;
  float len3w = length(aP1 - aP0);
  float d1 = d0 + len3w;
  float th = clamp((0.5 * (r0 + r1) - 0.12) / 1.6, 0.0, 1.0);
  float ph0 = regionPhase(aP0);
  float ph1 = regionPhase(aP1);
#if STREAM > 0
  vec2 s0 = stream(d0, ph0, th);
  vec2 s1 = stream(d1, ph1, th);
  float amp = mix(0.24, 0.17, th);
  float wv0 = 0.9 + amp * s0.x + 0.09 * s0.y;
  float wv1 = 0.9 + amp * s1.x + 0.09 * s1.y;
#else
  // legacy: one slow brightness wave along the growth distance
  float wv0 = 0.82 + 0.18 * sin(d0 * 0.09 - uTime * 2.2);
  float wv1 = 0.82 + 0.18 * sin(d1 * 0.09 - uTime * 2.2);
#endif
#if FLOODS
  vec4 f0 = flood(d0);
  vec4 f1 = flood(d1);
#else
  vec4 f0 = vec4(0.0);
  vec4 f1 = vec4(0.0);
#endif
#if RPULSE && STREAM > 0
  // peristalsis: the tube wall contracts with the wave, breathes, and swells as a flood passes
  float ra = mix(0.03, 0.085, th);
  float live = 1.0 - vHWG.z; // ghosts do not pulse
  r0 *= 1.0 + live * (ra * s0.x + 0.035 * s0.y + 0.22 * f0.a);
  r1 *= 1.0 + live * (ra * s1.x + 0.035 * s1.y + 0.22 * f1.a);
#endif
  vec3 w0 = aP0 + wobble(aP0);
  vec3 w1 = aP1 + wobble(aP1);
  vec3 v0 = (uView * vec4(w0, 1.0)).xyz;
  vec3 v1 = (uView * vec4(w1, 1.0)).xyz;
  vec3 mid = (v0 + v1) * 0.5;
  vec3 V = normalize(-mid);
  vec3 u; vec3 s; float L;
  billboardBasis(V, v1 - v0, u, s, L);
  float o0 = dot(v0 - mid, V);
  float o1 = dot(v1 - mid, V);
  vec3 q0 = v0 - V * o0; // endpoint 0 on the billboard plane
  float px = uPxScale * max(-mid.z, 1e-3);
  float minR = 0.7 * px;
  vCov = clamp(max(r0, r1) / minR, 0.0, 1.0);
#if OPAQUE && !LEGACY
  if (vCov < 0.999) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
#endif
  r0 = max(r0, minR);
  r1 = max(r1, minR);
  float pad = max(r0, r1) + 1.5 * px;
  float cx = float(gl_VertexID & 1);
  float cy = float(gl_VertexID >> 1);
  float along = mix(-pad, L + pad, cx);
  float across = mix(-pad, pad, cy);
  vec3 pos = q0 + u * along + s * across;
  vLocal = vec2(along, across);
  vLen = L;
  vR = vec2(r0, r1);
  vOff = vec2(o0, o1);
  vPos = pos;
  vU = u;
  vS = s;
  vV = V;
  vec3 d3 = v1 - v0;
  float len3 = length(d3);
  vAxis = vec4(len3 > 1e-5 ? d3 / len3 : u, len3 / max(L, 0.08 * len3 + 1e-5));
  vAlpha = aAE.x * lod;
  vPx = px;
  vSeg = vec2(d0, len3w);
  // per-endpoint values, extended linearly over the quad so they interpolate exactly along the axis
  float k = clamp(along / max(L, 1e-4), -0.5, 1.5);
  vFlood = mix(f0, f1, k);
  vWave = mix(wv0, wv1, k);
  vPh = mix(ph0, ph1, k);
  gl_Position = uProj * vec4(pos, 1.0);
}`;

/** Tube fragment shader (see the header comment and `SegVariant`). */
export const segFs = (v: SegVariant): string => /* glsl */ `#version 300 es
${defines(v)}
precision highp float;
uniform float uTime;
uniform float uMotion;
uniform mat4 uProj;
${SHADE}
in vec2 vLocal;
in float vLen;
in vec2 vR;
in vec2 vOff;
in vec3 vPos;
in vec3 vU;
in vec3 vS;
in vec3 vV;
in vec4 vAxis;
in float vAlpha;
in float vCov;
in float vPx;
in vec3 vHWG;
in vec2 vSeg;
in vec4 vFlood;
in float vWave;
in float vPh;
out vec4 outColor;

// Colour by meaning: recently active veins run warmer and brighter, dormant ones cool and dim;
// withering veins (fading without flux) desaturate and darken.
vec3 meaning(vec3 col, float heat, float warm, float alpha) {
  float w = max(warm, heat);
  col *= mix(vec3(0.8, 0.84, 0.82), vec3(1.1, 1.0, 0.84), w);
  float wi = clamp((1.0 - alpha) * 1.25, 0.0, 1.0) * (1.0 - heat);
  float l = dot(col, vec3(0.3, 0.55, 0.15));
  return mix(col, l * vec3(0.8, 0.7, 0.58), 0.75 * wi) * (1.0 - 0.45 * wi);
}

#if STREAM > 1
uint pcgHash(uint h) {
  h = h * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return (h >> 22u) ^ h;
}
float cellHash(vec2 c) {
  ivec2 i = ivec2(c);
  return float(pcgHash(uint(i.x) * 1597334677u ^ uint(i.y) * 3812015801u)) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cellHash(i), cellHash(i + vec2(1.0, 0.0)), f.x),
             mix(cellHash(i + vec2(0.0, 1.0)), cellHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
#endif

void main() {
  float t = clamp(vLocal.x / max(vLen, 1e-4), 0.0, 1.0);
  float dx = vLocal.x - clamp(vLocal.x, 0.0, vLen);
  float dist = length(vec2(dx, vLocal.y));
  float r = mix(vR.x, vR.y, t);
  float cov = 1.0 - smoothstep(r - vPx * 0.6, r + vPx * 0.6, dist);
  float a = cov * vCov * vAlpha;
  bool solid = cov >= 0.999 && vCov >= 0.999 && vAlpha >= 0.99;
  float heat = vHWG.x;
  float warm = vHWG.y;
#if OPAQUE
  if (!solid) discard;
#else
  if (solid || a < 0.004) discard;
  if (vHWG.z > 0.5) {
    // afterglow ghost of a pruned vein: a faint, cool, soft trail of dried slime (unlit)
    float qg = clamp(dist / r, 0.0, 1.0);
    float ga = cov * (vAlpha / ${GHOST_ALPHA.toFixed(3)}) * 0.3 * (0.3 + 0.7 * sqrt(1.0 - qg * qg));
    vec3 Pg = vPos + vV * mix(vOff.x, vOff.y, t);
    vec3 cg = fog(vec3(0.72, 0.5, 0.22), -Pg.z);
    outColor = vec4(cg * ga, ga);
    return;
  }
#endif
  float thick = clamp((r - 0.12) / 1.6, 0.0, 1.0);
  vec3 albedo = mix(OCHRE, GOLD, smoothstep(0.0, 0.35, thick) * 0.7 + 0.3);
  albedo = mix(albedo, BUTTER, smoothstep(0.45, 1.0, thick) * 0.6);
#if LEGACY
  float wave = 0.82 + 0.18 * sin((vSeg.x + vLocal.x) * 0.09 - uTime * 2.2);
#define meaning(c, h, w, a) (c)
#else
  float wave = vWave;
#endif
  float e = heat * heat;
  // growth tips flare (white-hot, flickering slightly while they advance)
  e *= 1.0 + 0.3 * uMotion * e * sin(uTime * 12.0 + vSeg.x * 0.9);
  vec3 hot = (vec3(1.0, 0.92, 0.68) * 2.4 + vec3(1.0, 0.6, 0.1)) * e;
  vec3 fl = vFlood.rgb;
#if !OPAQUE
  if (vCov < 0.999) {
    // sub-pixel thread: no surface to light, just its tint (cheap path; most of the far fringe)
    vec3 c = albedo * wave * 0.75 * (0.42 + 0.58 * sqrt(thick));
    c = meaning(c, heat, warm, vAlpha) + hot * 0.7 + fl * 0.6;
    vec3 Pa = vPos + vV * mix(vOff.x, vOff.y, t);
    c = fog(c, -Pa.z);
    outColor = vec4(c * a, a);
    return;
  }
#endif
  float q = clamp(dist / r, 0.0, 1.0);
  float h = sqrt(1.0 - q * q);
  vec2 rd = dist > 1e-6 ? vec2(dx, vLocal.y) / dist : vec2(0.0);
  vec3 N = (vU * rd.x + vS * rd.y) * q + vV * h;
  float lift = r * h;
  if (dx == 0.0) {
    // cylinder body: a tube tilted out of the billboard plane is deeper by 1/cos(tilt),
    // and its normal is perpendicular to the 3D axis (keeps the end spheres inscribed)
    lift *= vAxis.w;
    N -= vAxis.xyz * dot(N, vAxis.xyz);
  }
  N = normalize(N);
  vec3 P = vPos + vV * (mix(vOff.x, vOff.y, t) + lift);
#if OPAQUE
  gl_FragDepth = fragDepth(P);
#endif
#if STREAM > 1
  // endoplasm: granules flowing inside the core, sliding back and forth (shuttle streaming) with a slow net
  // drift outward; trunks carry big slow beads, thin veins small quick ones
  {
    float s = vSeg.x + t * vSeg.y;
    float om = mix(0.95, 0.4, thick);
    float X = uMotion * (mix(1.8, 5.5, thick) * sin(om * uTime + vPh) + uTime * mix(1.1, 0.4, thick));
    float acrossN = vLocal.y / r;
    // streaks: stretched along the flow, a few lanes across the channel
    float n = vnoise(vec2((s - X) * mix(0.55, 0.26, thick), acrossN * 2.4 + vPh * 3.0));
    float bead = smoothstep(0.42, 0.9, n);
    float mask = smoothstep(0.8, 0.1, q) * smoothstep(1.8, 5.0, r / vPx);
    wave *= 1.0 + mask * (bead * 0.55 - 0.16);
  }
#endif
#if GEL
  // translucent gel: Beer-Lambert through the chord of the tube. Thin gel (rims, threads) is pale and warm,
  // the long path through a trunk's core is dense amber; light scattered inside glows back out.
  float chord = 2.0 * r * h;
  float dens = 1.0 - exp(-chord * 0.55);
  vec3 gelAlb = mix(vec3(1.0, 0.86, 0.5), vec3(0.92, 0.47, 0.04), dens);
  albedo = mix(albedo, gelAlb, 0.7);
  vec3 col = shade(N, P, albedo * wave, 0.4 + 0.6 * thick, 0.25 + 0.2 * thick);
  // light transmitted through the thin gel near the silhouette glows back out, pale and warm
  vec3 trans = exp(-chord * vec3(0.12, 0.3, 1.0));
  float back = 0.5 + 0.5 * dot(N, normalize(vec3(0.35, -0.55, -0.4)));
  float rimT = pow(1.0 - h, 1.5);
  col += vec3(1.0, 0.8, 0.45) * trans * (0.1 + 0.6 * rimT) * (0.55 + 0.45 * back) * (0.6 + 0.4 * wave);
  col += GOLD * dens * h * (0.1 + 0.22 * thick) * wave;
#else
  // thin threads are translucent and dimmer, thick veins dense and glossy
  vec3 col = shade(N, P, albedo * wave, 0.35 + 0.65 * thick, 0.55 + 0.35 * thick);
  // inner glow: light scattered inside the plasmodium, brightest at the core
  col += GOLD * h * (0.08 + 0.25 * thick) * wave;
#endif
  // fine threads read as translucent and dimmer; the thick trunks carry the structure
  col *= 0.42 + 0.58 * sqrt(thick);
  col = meaning(col, heat, warm, vAlpha);
  col += hot * (0.45 + 0.55 * h);
  // commit flood: light pouring through the core of the vein
  col += fl * (0.35 + 0.7 * h);
  col = fog(col, -P.z);
#if OPAQUE
  outColor = vec4(col, 1.0);
#else
  outColor = vec4(col * a, a);
#endif
}`;

export const FOOD_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aA; // x y z radius
layout(location = 1) in vec4 aB; // nutrient engulf fade seedKind
uniform float uFoodLod; // size of file dots (1 = full; 0 when files are only a few pixels apart, see crowd.ts)
${VIEW}
${WOBBLE}
out vec2 vLocal;
out float vRad;
out vec4 vB;
out vec3 vC;
out float vPx;
void main() {
  vec3 c = (uView * vec4(aA.xyz + wobble(aA.xyz), 1.0)).xyz;
  vec3 V = normalize(-c);
  vec3 a = abs(V.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 u = normalize(cross(a, V));
  vec3 s = cross(V, u);
  float px = uPxScale * max(-c.z, 1e-3);
  float kind = floor(aB.w * 0.5);
  float rad = max(aA.w, 1.1 * px) * (0.4 + 0.6 * aB.z);
  if (kind < 0.5) {
    rad *= uFoodLod;
    if (rad < 0.25 * px) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vLocal = vec2(0.0); vRad = 0.0; vB = aB; vC = c; vPx = px; return; }
  }
  float pad = rad * (kind > 0.5 ? 2.4 : 1.6) + 2.0 * px;
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vLocal = corner * pad;
  vRad = rad;
  vB = aB;
  vC = c;
  vPx = px;
  gl_Position = uProj * vec4(c + (u * corner.x + s * corner.y) * pad, 1.0);
}`;

/** Food / inoculum fragment shader; `opaque` selects the pass. */
export const foodFs = (opaque: boolean): string => /* glsl */ `#version 300 es
#define OPAQUE ${opaque ? 1 : 0}
precision highp float;
uniform float uTime;
uniform mat4 uProj;
${SHADE}
in vec2 vLocal;
in float vRad;
in vec4 vB;
in vec3 vC;
in float vPx;
out vec4 outColor;
void main() {
  float nutrient = vB.x;
  float engulf = vB.y;
  float fade = vB.z;
  float kind = floor(vB.w * 0.5);
  float seed = fract(vB.w * 0.5) * 2.0;
  vec3 V = normalize(-vC);
  vec3 ax = abs(V.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 U = normalize(cross(ax, V));
  vec3 S = cross(V, U);
  vec2 l = vLocal;
  float rr = vRad;
  if (kind < 0.5) {
    // oat flake: rotated ellipse with a slightly irregular rim
    float rot = seed * 6.2831;
    l = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * vLocal;
    l.x *= 0.8;
    l.y *= 1.22;
    float ang = atan(l.y, l.x);
    rr *= 1.0 + 0.07 * sin(ang * 5.0 + seed * 31.0) + 0.05 * sin(ang * 9.0 + seed * 17.0);
  }
  float d = length(l);
  float cov = 1.0 - smoothstep(rr - vPx * 0.6, rr + vPx * 0.6, d);
  float nut = clamp(nutrient * 0.5, 0.0, 1.0);
  float q = clamp(d / rr, 0.0, 1.0);
  float h = sqrt(1.0 - q * q);
  vec3 N = normalize((U * vLocal.x + S * vLocal.y) / max(d, 1e-5) * q + V * h);
  vec3 P = vC + V * rr * h;
  if (kind > 0.5) {
    // inoculum: the original plasmodium mass, a glowing golden blob with a soft halo
    float halo = exp(-max(d - rr, 0.0) / (rr * 0.45)) * (1.0 - cov) * clamp(1.0 - (d - rr) / (1.3 * rr), 0.0, 1.0);
    bool solid = cov >= 0.999;
    float a = max(cov, halo * 0.6);
#if OPAQUE
    if (!solid) discard;
    gl_FragDepth = fragDepth(P);
#else
    if (solid || a < 0.004) discard;
#endif
    vec3 col = cov > 0.0 ? shade(N, P, BUTTER, 1.0, 1.0) + GOLD * (0.4 + 0.9 * nutrient) * h : vec3(0.0);
    col += vec3(1.0, 0.7, 0.2) * halo * (0.5 + nutrient);
    col = fog(col, -P.z);
#if OPAQUE
    outColor = vec4(col, 1.0);
#else
    outColor = vec4(col * a, a);
#endif
    return;
  }
  float a = cov * fade;
  bool solid = cov >= 0.999 && fade >= 0.99;
#if OPAQUE
  if (!solid) discard;
  gl_FragDepth = fragDepth(P);
#else
  if (solid || a < 0.004) discard;
#endif
  // uneaten oat: pale, matte; engulfed: coated in glossy golden slime
  vec3 oat = vec3(0.62, 0.55, 0.42);
  vec3 col = mix(shade(N, P, oat, 0.15, 0.25) * 0.8, shade(N, P, GOLD, 0.9, 0.8), engulf);
  col += (vec3(1.0, 0.92, 0.66) * 1.6 + vec3(1.0, 0.6, 0.1) * 0.6) * nut * nut * (0.4 + 0.6 * h);
  col = fog(col, -P.z);
#if OPAQUE
  outColor = vec4(col, 1.0);
#else
  outColor = vec4(col * a, a);
#endif
}`;

export const PULSE_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aA; // x y z intensity
layout(location = 1) in vec4 aB; // dirX dirY dirZ hue
uniform vec2 uFog;
${VIEW}
${WOBBLE}
${BILLBOARD}
out vec2 vLocal;
out float vInt;
out float vHue;
void main() {
  vec3 c = (uView * vec4(aA.xyz + wobble(aA.xyz), 1.0)).xyz;
  vec3 dirV = (uView * vec4(aB.xyz, 0.0)).xyz;
  vec3 V = normalize(-c);
  vec3 u; vec3 s; float L;
  billboardBasis(V, length(dirV) > 0.0 ? dirV : vec3(1.0, 0.0, 0.0), u, s, L);
  // a comet seen head-on shortens its tail
  float tail = mix(1.6, 7.0, clamp(L * 1.2, 0.0, 1.0));
  float px = uPxScale * max(-c.z, 1e-3);
  float sz = max(1.5, 3.0 * px);
  // lift toward the camera so the comet is not buried inside its own tube
  c += V * (sz * 1.7 + 0.6);
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  float along = corner.x < 0.0 ? corner.x * sz * tail : corner.x * sz * 1.6;
  float across = corner.y * sz * 1.6;
  vLocal = vec2(along / sz, across / sz);
  vLocal.x = vLocal.x < 0.0 ? vLocal.x * 7.0 / tail : vLocal.x;
  float f = smoothstep(uFog.x, uFog.y, -c.z);
  vInt = aA.w * mix(1.0, 0.25, f);
  vHue = aB.w;
  gl_Position = uProj * vec4(c + u * along + s * across, 1.0);
}`;

export const PULSE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in float vInt;
in float vHue;
out vec4 outColor;
vec3 hue2rgb(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}
void main() {
  float tail = vLocal.x < 0.0 ? vLocal.x / 7.0 : vLocal.x / 1.0;
  float w = exp(-(vLocal.y * vLocal.y) * 1.6 * (1.0 + max(-vLocal.x, 0.0) * 0.25));
  float a = exp(-tail * tail * 3.0) * w;
  float head = exp(-dot(vLocal, vLocal) * 2.2);
  vec3 tint = mix(vec3(1.0, 0.93, 0.7), hue2rgb(vHue) * 0.6 + 0.4, 0.55);
  vec3 col = tint * (a * 0.55 + head * 1.4) * vInt;
  outColor = vec4(col, 0.0);
}`;

export const FULL_VS = /* glsl */ `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const DOWN_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel; // source texel size
uniform float uThreshold; // > 0 only for the first pass
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 o = uTexel;
  vec3 c = texture(uSrc, vUv).rgb * 4.0;
  c += texture(uSrc, vUv + vec2(-o.x, -o.y)).rgb;
  c += texture(uSrc, vUv + vec2( o.x, -o.y)).rgb;
  c += texture(uSrc, vUv + vec2(-o.x,  o.y)).rgb;
  c += texture(uSrc, vUv + vec2( o.x,  o.y)).rgb;
  c /= 8.0;
  if (uThreshold > 0.0) {
    float l = max(c.r, max(c.g, c.b));
    float k = max(l - uThreshold, 0.0) / max(l, 1e-4);
    c *= k;
  }
  outColor = vec4(c, 1.0);
}`;

export const UP_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uWeight;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 o = uTexel;
  vec3 c = texture(uSrc, vUv).rgb * 4.0;
  c += (texture(uSrc, vUv + vec2(-o.x, 0.0)).rgb + texture(uSrc, vUv + vec2(o.x, 0.0)).rgb +
        texture(uSrc, vUv + vec2(0.0, -o.y)).rgb + texture(uSrc, vUv + vec2(0.0, o.y)).rgb) * 2.0;
  c += texture(uSrc, vUv + vec2(-o.x, -o.y)).rgb + texture(uSrc, vUv + vec2(o.x, -o.y)).rgb +
       texture(uSrc, vUv + vec2(-o.x, o.y)).rgb + texture(uSrc, vUv + vec2(o.x, o.y)).rgb;
  outColor = vec4(c / 16.0 * uWeight, 1.0);
}`;

/**
 * Final pass: filmic tone map over the agar, vignette, grain. With a lens level > 0 (see lens.ts) it also draws the
 * microscope look at the edges of the frame, all as a function of the distance `dn` from the centre (0 centre .. 1 corner,
 * on the viewport ellipse; on wide screens it stays an ellipse so the mold is not cropped):
 *   level 1: warm dark falloff + rounded field stop (no extra texture reads)
 *   level 2: + radial R/B chromatic offset, rim glare crescent and a faint ghost of the bloom
 *   level 3: + edge defocus (the scene target's mip chain, sampled at a growing LOD) and static lens dust
 * Nothing moves scene geometry (G stays put; R/B shift by < 2 px at the far corners), so labels and picking stay aligned.
 * The expensive parts sit behind branches on `dn`, so the middle of the frame pays only for the vignette. Level 0 compiles
 * to the plain pre-lens pass.
 */
export function finalFs(level: 0 | 1 | 2 | 3): string {
  return /* glsl */ `#version 300 es
precision highp float;
#define LENS ${level}
uniform sampler2D uHdr;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uExposure; // scene brightness before tone mapping (1, lower in crowded views)
uniform float uTime;
uniform vec2 uAspect;
#if LENS > 0
uniform vec4 uLensA; // vignette, aperture, chroma, blur
uniform vec4 uLensB; // dust, glare, ghost response, x stretch of the eyepiece ellipse
#endif
in vec2 vUv;
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
#if LENS >= 3
vec4 hash4(vec2 p) { // sine-free hash (cheap)
  vec4 p4 = fract(vec4(p.xyxy) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}
// static dust: one speck per cell at most (centre and radius from the cell hash), so no neighbour lookups
float dust(vec2 g, float density, float rMin, float rMax, float ring) {
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  vec4 h = hash4(id);
  float on = step(1.0 - density, h.x);
  vec2 ctr = (h.yz - 0.5) * (0.9 - 2.0 * rMax);
  float rad = mix(rMin, rMax, h.w * h.w);
  float d = length(f - ctr) / rad;
  float disc = 1.0 - smoothstep(0.55, 1.0, d);
  float rim = smoothstep(0.55, 0.92, d) * (1.0 - smoothstep(0.92, 1.0, d));
  return on * mix(disc, 0.35 * disc + rim, ring) * (0.35 + 0.65 * h.x);
}
#endif
void main() {
  vec2 c = (vUv - 0.5) * uAspect;
  float r = length(c);
#if LENS == 0
  vec3 hdr = texture(uHdr, vUv).rgb;
  vec3 bloom = texture(uBloom, vUv).rgb;
#else
  vec2 q0 = vUv - 0.5;
  float sx = uLensB.w;
  float dn = length(vec2(q0.x * 2.0 * sx, q0.y * 2.0)) / length(vec2(sx, 1.0));
  vec3 bloom = texture(uBloom, vUv).rgb;
  vec3 hdr;
#if LENS >= 2
  if (dn < 0.42) {
    hdr = textureLod(uHdr, vUv, 0.0).rgb;
  } else {
    vec2 off = q0 * (uLensA.z * 0.0028 * dn * dn);
#if LENS >= 3
    float e = smoothstep(0.45, 1.0, dn);
    float lod = uLensA.w * 3.2 * e * e;
    lod += (hash(vUv * 733.0 + 0.37) - 0.5) * step(0.04, lod); // stochastic trilinear: the sampler picks the nearest mip, the dither blends the levels
    if (lod > 0.04) {
      // defocused: the two offset taps already blur by more than the offset, so G is their mean (2 trilinear reads, not 3)
      vec3 tr = textureLod(uHdr, vUv + off, lod).rgb;
      vec3 tb = textureLod(uHdr, vUv - off, lod).rgb;
      hdr = vec3(tr.r, 0.5 * (tr.g + tb.g), tb.b);
    } else {
      hdr = vec3(textureLod(uHdr, vUv + off, 0.0).r, textureLod(uHdr, vUv, 0.0).g, textureLod(uHdr, vUv - off, 0.0).b);
    }
#else
    hdr = vec3(textureLod(uHdr, vUv + off, 0.0).r, textureLod(uHdr, vUv, 0.0).g, textureLod(uHdr, vUv - off, 0.0).b);
#endif
  }
#else
  hdr = texture(uHdr, vUv).rgb;
#endif
#endif
  // agar medium: warm umber center falling off to near-black
  vec3 bg = mix(vec3(0.060, 0.043, 0.024), vec3(0.010, 0.007, 0.004), smoothstep(0.05, 0.95, r));
#if LENS > 0
  // the lit field of the eyepiece: a faint warm illumination that gives the vignette something to fall off from
  bg = mix(bg, mix(vec3(0.092, 0.066, 0.036), vec3(0.022, 0.016, 0.009), smoothstep(0.0, 0.95, dn)), uLensA.x);
#endif
  vec3 col = hdr * uExposure + bloom * uBloomStrength;
  col = vec3(1.0) - exp(-col * 1.25);          // soft filmic shoulder
  col = bg * (1.0 - col) + col;                 // mold over agar
  col *= 1.0 - 0.35 * smoothstep(0.45, 1.1, r); // vignette
#if LENS > 0
  // optical vignette: warm, never fully black (labels and chrome stay readable over it), plus the field stop near the corners
  float vg = uLensA.x * pow(smoothstep(0.3, 1.02, dn), 1.3);
  float stop = smoothstep(0.74, 0.9, dn);   // the field stop: the eyepiece circle (an ellipse on wide screens)
  float dark = clamp(vg * 0.55 + uLensA.y * stop * 0.5, 0.0, 0.9);
  col *= mix(vec3(1.0), vec3(0.45, 0.34, 0.22), dark);
#if LENS >= 2
  if (dn > 0.5) {
    // internal reflections: a ghost of the bright parts mirrored through the centre, a faint crescent along the rim and a
    // thin warm arc on the field stop
    vec3 gs = textureLod(uBloom, vec2(0.5) - q0 * 0.8, 0.0).rgb;
    float gm = smoothstep(0.3, 0.75, dn) * (1.0 - smoothstep(0.9, 1.05, dn));
    col += gs * gm * (0.045 * uLensB.y * uLensB.z) * vec3(0.55, 0.8, 1.0);
    vec2 qn = vec2(q0.x * sx, q0.y);
    float lobe = 0.5 + 0.5 * dot(qn, vec2(-0.737, 0.675)) / max(length(qn), 1e-4);
    lobe = lobe * lobe * lobe;
    float a1 = (dn - 0.74) / 0.07;
    float a2 = (dn - 0.9) / 0.018;
    col += lobe * exp(-a1 * a1) * (0.05 * uLensB.y) * vec3(1.0, 0.82, 0.55);
    col += exp(-a2 * a2) * (0.02 + 0.03 * lobe) * uLensB.y * uLensA.y * vec3(1.0, 0.84, 0.6);
#if LENS >= 3
    // dust on the glass: only near the rim, brighter where the bloom lights it
    float dm = smoothstep(0.5, 0.9, dn);
    vec2 g = q0 * vec2(uAspect.x / uAspect.y, 1.0);
    float dd = dust(g * 30.0, 0.09, 0.08, 0.22, 0.0) + 1.6 * dust(g * 9.0 + 17.0, 0.07, 0.12, 0.3, 1.0);
    float lit = clamp(dot(bloom, vec3(0.33)) * uBloomStrength * 1.5, 0.0, 1.0);
    col += dd * dm * uLensB.x * (0.03 + 0.12 * lit) * vec3(1.0, 0.88, 0.68);
#endif
  }
#endif
#endif
  col += (hash(vUv * 1024.0 + fract(uTime)) - 0.5) * 0.012; // grain (also kills banding)
  outColor = vec4(col, 1.0);
}`;
}

export const FINAL_FS = finalFs(0);

/**
 * Floating motes (spores / debris in the medium): one instanced quad per mote, no vertex data at all. Every mote's
 * position is a pure function of gl_InstanceID and time (hash -> spot in the scene box, slow rise with wrap-around and a
 * gentle swirl), so there is no CPU work or upload per frame. Motes glow faintly, brighter near the activity hot-spot
 * and when a commit flood passes their (straight-line) distance from the inoculum; near the camera they open up into
 * soft bokeh discs (macro lens), far ones sink into the depth fog.
 */
export const MOTE_VS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uFog;
uniform vec3 uBoxC;
uniform vec3 uBoxR;
uniform vec4 uHot;   // xyz hot-spot, w strength 0..1
uniform float uHotR;
uniform float uMotion;
${VIEW}
${WOBBLE}
${FLOOD}
out vec2 vLocal;
out vec3 vCol;
out float vSoft;
uint pcgHash(uint h) {
  h = h * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return (h >> 22u) ^ h;
}
float rnd(inout uint s) {
  s = pcgHash(s);
  return float(s) * (1.0 / 4294967295.0);
}
void main() {
  uint seed = uint(gl_InstanceID) * 2654435761u + 977u;
  float r1 = rnd(seed); float r2 = rnd(seed); float r3 = rnd(seed);
  float r4 = rnd(seed); float r5 = rnd(seed); float r6 = rnd(seed);
  float t = uTime;
  vec3 box = uBoxR * 1.25 + 30.0;
  float cyc = fract(r2 + t * (0.0035 + 0.006 * r4)); // slow rise through the box, wrapping
  vec3 p = uBoxC + (vec3(r1, cyc, r3) * 2.0 - 1.0) * box;
  p += vec3(sin(t * 0.13 + r5 * 6.283 + p.y * 0.02), 0.5 * sin(t * 0.11 + r6 * 6.283), cos(t * 0.12 + r4 * 6.283 + p.x * 0.02))
       * (4.0 + 7.0 * r6);
  float edge = smoothstep(0.0, 0.07, cyc) * smoothstep(1.0, 0.93, cyc);
  vec3 c = (uView * vec4(p, 1.0)).xyz;
  float depth = -c.z;
  if (depth < 1.0 || edge <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float px = uPxScale * depth;
  float sizePx = max(mix(0.3, 0.95, r5 * r5) / px, 0.9);
  // near the camera a mote blurs into a soft disc; its light spreads over the disc
  float near = clamp(1.0 - depth / (uFog.x * 0.8), 0.0, 1.0);
  float rPx = max(sizePx, near * near * 26.0);
  float spread = sizePx / rPx;
  float hd = length(p - uHot.xyz);
  float hot = uHot.w * exp(-hd * hd / (2.0 * uHotR * uHotR));
  vec4 fl = flood(length(p) * 1.3); // growth distance ~ 1.3 x the straight-line distance from the inoculum
  float I = ((0.045 + 0.08 * r6) * (1.0 + 6.0 * hot) + 0.9 * fl.a) * edge * mix(1.0, spread * 0.8 + 0.08, near);
  vec3 col = mix(vec3(1.0, 0.86, 0.6), fl.a > 1e-3 ? fl.rgb / fl.a : vec3(1.0), clamp(fl.a, 0.0, 1.0)) * I;
  // depth cue: far motes fade into the agar
  col *= mix(1.0, 0.12, smoothstep(uFog.x, uFog.y, depth));
  vCol = col;
  vSoft = smoothstep(2.5, 8.0, rPx);
  vec3 V = normalize(-c);
  vec3 ax = abs(V.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 u = normalize(cross(ax, V));
  vec3 s = cross(V, u);
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vLocal = corner * 1.4;
  gl_Position = uProj * vec4(c + (u * corner.x + s * corner.y) * rPx * px * 1.4, 1.0);
}`;

export const MOTE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec3 vCol;
in float vSoft;
out vec4 outColor;
void main() {
  float d = length(vLocal);
  if (d > 1.4) discard;
  float g = exp(-d * d * 2.6);
  // bokeh disc: flat with a slightly brighter rim
  float disc = (1.0 - smoothstep(0.85, 1.0, d)) * (0.75 + 0.25 * smoothstep(0.5, 0.95, d)) * 0.55;
  outColor = vec4(vCol * mix(g, disc, vSoft), 0.0);
}`;
