// SPDX-License-Identifier: AGPL-3.0-only
import { BURST_STRIDE, FOOD_STRIDE, H, HEADER, PULSE_STRIDE, SEG_R_MAX, SEG_STRIDE } from '../sim/frame';
import { BURSTS, FLOOD_SPEED, floodDuration } from '../sim/activity';
import type { Camera } from './camera';
import { type Effects, type QualityTier, tierEffects } from './quality';
import { CROWD_OFF, type Crowd, crowdLevels } from './crowd';
import { LENS_OFF, type LensParams, lensParams } from './lens';
import {
  DOWN_FS, FOOD_VS, FULL_VS, MOTE_FS, MOTE_VS, PULSE_FS, PULSE_VS, UP_FS, finalFs, foodFs, segFs, segVs,
} from './shaders';

/**
 * WebGL2 renderer (3D).
 *
 *  1. scene pass into an RGBA16F color target + 24-bit depth renderbuffer:
 *     a. opaque: instanced capsule impostors (tubes) and food spheres write
 *        fully covered fragments with analytic normal + gl_FragDepth;
 *     b. translucent: the same instances again, drawing only anti-aliased rims,
 *        sub-pixel threads and fading tubes, premultiplied-alpha blended,
 *        depth-tested against (a) without writing depth;
 *     c. glow: author pulses, additive, depth-tested (occluded by veins in front);
 *     d. motes: instanced spores drifting in the medium, additive, depth-tested (no vertex data).
 *  2. bloom: thresholded downsample chain + tent upsample
 *  3. final: tone map, agar background, vignette, grain -> canvas; with the microscope lens (lens.ts) also edge defocus
 *     (mips of the scene target), chromatic aberration, dust and glare in the same pass
 *
 * Instance data is uploaded straight from the worker's frame with
 * bufferSubData(srcOffset, length): no per-frame allocations.
 *
 * Visual effects (streaming, gel, floods, ghosts, motes) are compile-time variants of the segment shaders plus the
 * mote pass, selected by `setQuality` / `setEffects` (see quality.ts). Shader variants are compiled lazily and cached.
 */

interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  depth: WebGLRenderbuffer | null;
  w: number;
  h: number;
}

interface Prog {
  p: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

const BLOOM_LEVELS = 6;
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const SEG_UNIFORMS = ['uView', 'uProj', 'uPxScale', 'uTime', 'uWobble', 'uFog', 'uRMax', 'uDistMax', 'uReach', 'uMotion', 'uBurst', 'uThreadLod', 'uRadiusLod', 'uFoodLod'];
/** Bloom swell at the peak of a beat: +30%. */
const PULSE_BLOOM = 0.3;
const FINAL_UNIFORMS = ['uHdr', 'uBloom', 'uBloomStrength', 'uExposure', 'uTime', 'uAspect', 'uLensA', 'uLensB'];
const MOTE_UNIFORMS = [...SEG_UNIFORMS, 'uBoxC', 'uBoxR', 'uHot', 'uHotR'];

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  /** [opaque pass, translucent pass] for the current effects; variants cached by `variantKey`. */
  private segProg: [Prog, Prog];
  private segCache = new Map<number, [Prog, Prog]>();
  private moteProg: Prog;
  private fx: Effects = tierEffects('high');
  /** Current quality tier (the last `setQuality`; `setEffects` may have changed single effects since). */
  tier: QualityTier = 'high';
  /** prefers-reduced-motion: no streaming/breathing amplitude, no motes, calmer wobble. */
  private reduced = false;
  private legacy = false;
  private foodProg: [Prog, Prog];
  private pulseProg: Prog;
  private downProg: Prog;
  private upProg: Prog;
  /** Final-pass programs per lens level (0 = plain), compiled lazily. */
  private finalProgs: (Prog | null)[] = [null, null, null, null];
  /** Sampler with trilinear mips for the scene target (edge defocus); the target's own filter stays LINEAR for the bloom chain. */
  private mipSampler: WebGLSampler;
  /**
   * Microscope lens (lens.ts): always on in the app. This switch exists only for cost measurements and tests; nothing in the UI,
   * URL or keyboard reaches it.
   */
  lensEnabled = true;
  private lensKey = '';
  private lensCache: LensParams = LENS_OFF;
  private segVao: WebGLVertexArrayObject;
  private foodVao: WebGLVertexArrayObject;
  private pulseVao: WebGLVertexArrayObject;
  private emptyVao: WebGLVertexArrayObject;
  private segBuf: WebGLBuffer;
  private foodBuf: WebGLBuffer;
  private pulseBuf: WebGLBuffer;
  private segCap = 0;
  private foodCap = 0;
  private pulseCap = 0;
  private segCount = 0;
  private ghostCount = 0;
  /** Copy of the last frame header (activity signals, bursts, bbox). */
  private hdrCopy = new Float32Array(HEADER);
  private haveHeader = false;
  private burstU = new Float32Array(BURSTS * 4);
  private hot = new Float32Array(5); // smoothed x y z strength radius
  private box = new Float32Array(6); // smoothed center xyz, half extents xyz
  private lastRenderTime = -1;
  private frameDt = 0;
  private frameTime = -1; // render time at which the current frame's tick was current
  private foodCount = 0;
  private pulseCount = 0;
  private hdr: Target | null = null;
  private bloom: Target[] = [];
  private fmt: { internal: number; type: number };
  width = 0;
  height = 0;
  bloomStrength = 0.6;
  /** Music beat, 0..1 (src/util/beat.ts). Swells the bloom; the caller keeps it 0 under reduced motion. */
  pulse = 0;
  /**
   * Draw the translucent remainder pass (anti-aliased rims, sub-pixel threads,
   * fading tubes). Off = opaque cores only: cheaper, but aliased and the fine
   * explorer fringe disappears. A quality knob for weak GPUs.
   */
  fringe = true;
  wobble = 0.55;
  /** Crowded-view detail factors (crowd.ts), eased toward their targets every frame. */
  private crowd: Crowd = { ...CROWD_OFF };
  private crowdGoal: Crowd = { ...CROWD_OFF };
  /** Turn the level-of-detail for crowded views off (tests, comparisons). */
  crowdLod = true;
  readonly floatTargets: boolean;
  /** GPU time of the last measured frame in ms (EXT_disjoint_timer_query_webgl2), -1 if unavailable. */
  gpuMs = -1;
  /** Increments whenever a new GPU timer result arrives. */
  gpuSamples = 0;
  private timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private query: WebGLQuery | null = null;
  private queryPending = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_color_buffer_half_float');
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (this.timerExt) this.query = gl.createQuery();
    this.fmt = this.floatTargets
      ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT }
      : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };

    const uni = SEG_UNIFORMS;
    this.segProg = this.segPrograms();
    this.moteProg = this.program(MOTE_VS, MOTE_FS, MOTE_UNIFORMS);
    this.foodProg = [this.program(FOOD_VS, foodFs(true), uni), this.program(FOOD_VS, foodFs(false), uni)];
    this.pulseProg = this.program(PULSE_VS, PULSE_FS, uni);
    this.downProg = this.program(FULL_VS, DOWN_FS, ['uSrc', 'uTexel', 'uThreshold']);
    this.upProg = this.program(FULL_VS, UP_FS, ['uSrc', 'uTexel', 'uWeight']);
    this.finalProgs[0] = this.program(FULL_VS, finalFs(0), FINAL_UNIFORMS);
    this.mipSampler = gl.createSampler()!;
    gl.samplerParameteri(this.mipSampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
    gl.samplerParameteri(this.mipSampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.mipSampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.mipSampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.segBuf = gl.createBuffer()!;
    this.foodBuf = gl.createBuffer()!;
    this.pulseBuf = gl.createBuffer()!;
    this.segVao = this.segmentVao(this.segBuf);
    this.foodVao = this.instancedVao(this.foodBuf, FOOD_STRIDE);
    this.pulseVao = this.instancedVao(this.pulseBuf, PULSE_STRIDE);
    this.emptyVao = gl.createVertexArray()!;
  }

  // ------------------------------------------------------------ quality
  /** Switch to a quality tier's effect set (see quality.ts). */
  setQuality(t: QualityTier): void {
    this.tier = t;
    this.fx = tierEffects(t);
    this.segProg = this.segPrograms();
  }

  /** Override single effects (tests, cost measurements). */
  setEffects(e: Partial<Effects>): void {
    this.fx = { ...this.fx, ...e };
    this.segProg = this.segPrograms();
  }

  get effects(): Readonly<Effects> {
    return this.fx;
  }

  // ------------------------------------------------------------ lens
  /** The lens parameters drawn this frame (tier and motion preference; all zero with `lensEnabled = false`). */
  get lensState(): Readonly<LensParams> {
    if (!this.lensEnabled) return LENS_OFF;
    const key = this.tier + (this.reduced ? '/r' : '');
    if (this.lensKey !== key) {
      this.lensKey = key;
      this.lensCache = lensParams(this.tier, this.reduced);
    }
    return this.lensCache;
  }

  private finalProgram(level: number): Prog {
    return (this.finalProgs[level] ??= this.program(FULL_VS, finalFs(level as 0 | 1 | 2 | 3), FINAL_UNIFORMS));
  }

  /** Measurement only: shade like the pre-effects renderer (see SegVariant.legacy); combine with setQuality('low'). */
  set legacyShading(v: boolean) {
    this.legacy = v;
    this.segProg = this.segPrograms();
  }

  /** prefers-reduced-motion: streaming/breathing amplitude and motes off, calmer wobble. */
  set reducedMotion(v: boolean) {
    this.reduced = v;
    this.wobble = this.flat ? 0.08 : v ? 0.2 : 0.55;
  }

  /** Circuit view: nearly rigid traces (the 3D wobble would bend the straight legs). */
  private flat = false;
  setFlat(v: boolean): void {
    this.flat = v;
    this.reducedMotion = this.reduced;
  }

  get reducedMotion(): boolean {
    return this.reduced;
  }

  private segPrograms(): [Prog, Prog] {
    const fx = this.fx;
    const key = fx.streaming | (fx.radiusPulse ? 4 : 0) | (fx.gel ? 8 : 0) | (fx.flood ? 16 : 0) | (this.legacy ? 32 : 0);
    let p = this.segCache.get(key);
    if (!p) {
      const v = { opaque: true, streaming: fx.streaming, radiusPulse: fx.radiusPulse, gel: fx.gel, flood: fx.flood, legacy: this.legacy };
      const o = { ...v, opaque: false };
      p = [this.program(segVs(v), segFs(v), SEG_UNIFORMS), this.program(segVs(o), segFs(o), SEG_UNIFORMS)];
      this.segCache.set(key, p);
    }
    return p;
  }

  private program(vs: string, fs: string, uniforms: string[]): Prog {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(`shader compile failed: ${gl.getShaderInfoLog(s)}`);
      }
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link failed: ${gl.getProgramInfoLog(p)}`);
    const u: Record<string, WebGLUniformLocation | null> = {};
    for (const name of uniforms) u[name] = gl.getUniformLocation(p, name);
    return { p, u };
  }

  private instancedVao(buf: WebGLBuffer, stride: number): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, 4 * stride * 16, gl.DYNAMIC_DRAW);
    for (let i = 0; i < 2; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, stride * 4, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  /** Segment records: f32 p0.xyz p1.xyz | unorm16 r0 r1 | unorm8 alpha emit | unorm16 phase (see sim/frame.ts). */
  private segmentVao(buf: WebGLBuffer): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, 4 * SEG_STRIDE * 16, gl.DYNAMIC_DRAW);
    const stride = SEG_STRIDE * 4;
    const attr = (loc: number, size: number, type: number, norm: boolean, offset: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, norm, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(0, 3, gl.FLOAT, false, 0);
    attr(1, 3, gl.FLOAT, false, 12);
    attr(2, 2, gl.UNSIGNED_SHORT, true, 24);
    attr(3, 2, gl.UNSIGNED_BYTE, true, 28);
    attr(4, 1, gl.UNSIGNED_SHORT, true, 30);
    gl.bindVertexArray(null);
    return vao;
  }

  private makeTarget(w: number, h: number, withDepth = false): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.fmt.internal, w, h, 0, gl.RGBA, this.fmt.type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let depth: WebGLRenderbuffer | null = null;
    if (withDepth) {
      depth = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, depth, w, h };
  }

  private freeTarget(t: Target | null): void {
    if (!t) return;
    this.gl.deleteFramebuffer(t.fb);
    this.gl.deleteTexture(t.tex);
    if (t.depth) this.gl.deleteRenderbuffer(t.depth);
  }

  /** Resize drawing buffer (device pixels) and render targets. */
  resize(w: number, h: number): void {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.freeTarget(this.hdr);
    for (const b of this.bloom) this.freeTarget(b);
    this.hdr = this.makeTarget(w, h, true);
    this.bloom = [];
    let bw = w >> 1;
    let bh = h >> 1;
    for (let i = 0; i < BLOOM_LEVELS && bw >= 2 && bh >= 2; i++) {
      this.bloom.push(this.makeTarget(bw, bh));
      bw >>= 1;
      bh >>= 1;
    }
  }

  private uploadSection(buf: WebGLBuffer, frame: Float32Array, offset: number, count: number, stride: number, cap: number): number {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    if (count > cap) {
      cap = Math.max(count, Math.ceil(cap * 1.5), 256);
      gl.bufferData(gl.ARRAY_BUFFER, cap * stride * 4, gl.DYNAMIC_DRAW);
    }
    if (count > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, frame, offset, count * stride);
    return cap;
  }

  /** Copy instance data out of a worker frame (the frame can be handed back right after). */
  upload(frame: Float32Array): void {
    const segs = frame[H.segs];
    const food = frame[H.food];
    const pulses = frame[H.pulses];
    let o = HEADER;
    this.segCap = this.uploadSection(this.segBuf, frame, o, segs, SEG_STRIDE, this.segCap);
    o += segs * SEG_STRIDE;
    this.foodCap = this.uploadSection(this.foodBuf, frame, o, food, FOOD_STRIDE, this.foodCap);
    o += food * FOOD_STRIDE;
    this.pulseCap = this.uploadSection(this.pulseBuf, frame, o, pulses, PULSE_STRIDE, this.pulseCap);
    this.segCount = segs;
    this.ghostCount = Math.min(segs, frame[H.ghosts] | 0);
    this.foodCount = food;
    this.pulseCount = pulses;
    const hc = this.hdrCopy;
    for (let i = 0; i < HEADER; i++) hc[i] = frame[i];
    this.frameTime = -1;
    if (!this.haveHeader) {
      this.haveHeader = true;
      this.hot[0] = hc[H.hotX];
      this.hot[1] = hc[H.hotY];
      this.hot[2] = hc[H.hotZ];
      this.box[0] = (hc[H.minX] + hc[H.maxX]) / 2;
      this.box[1] = (hc[H.minY] + hc[H.maxY]) / 2;
      this.box[2] = (hc[H.minZ] + hc[H.maxZ]) / 2;
      this.box[3] = (hc[H.maxX] - hc[H.minX]) / 2;
      this.box[4] = (hc[H.maxY] - hc[H.minY]) / 2;
      this.box[5] = (hc[H.maxZ] - hc[H.minZ]) / 2;
    }
  }

  /**
   * Per-render activity uniforms: flood fronts from the header's burst list (sim tick extrapolated between frames
   * while playing, so the wave glides even when a frame arrives late) and smoothed hot-spot / scene box.
   */
  private updateActivity(time: number): void {
    const hc = this.hdrCopy;
    if (this.frameTime < 0) this.frameTime = time;
    const dt = this.lastRenderTime >= 0 ? Math.min(0.1, Math.max(0, time - this.lastRenderTime)) : 0;
    this.lastRenderTime = time;
    this.frameDt = dt;
    const speed = hc[H.playing] > 0 ? hc[H.speed] : 0;
    const extra = Math.min(Math.max(0, time - this.frameTime) * 60 * speed, 3 * speed);
    const tick = hc[H.tick] + extra;
    const reach = hc[H.reach];
    const life = floodDuration(reach);
    const bu = this.burstU;
    for (let k = 0; k < BURSTS; k++) {
      const o = H.bursts + k * BURST_STRIDE;
      const age = tick - hc[o];
      const live = this.fx.flood && hc[o + 1] > 0 && age >= 0 && age < life;
      bu[k * 4] = live ? age * FLOOD_SPEED : -1;
      bu[k * 4 + 1] = live ? hc[o + 1] : 0;
      bu[k * 4 + 2] = hc[o + 2];
      bu[k * 4 + 3] = 0;
    }
    // smoothed hot-spot (strength from the activity weight) and scene box for the motes
    const kf = 1 - Math.exp(-dt * 1.5);
    const h = this.hot;
    const w = hc[H.hotW];
    if (w > 0) {
      h[0] += (hc[H.hotX] - h[0]) * kf;
      h[1] += (hc[H.hotY] - h[1]) * kf;
      h[2] += (hc[H.hotZ] - h[2]) * kf;
    }
    h[3] += (1 - Math.exp(-w / 12) - h[3]) * kf;
    h[4] += (Math.max(25, hc[H.hotR]) - h[4]) * kf;
    const b = this.box;
    b[0] += ((hc[H.minX] + hc[H.maxX]) / 2 - b[0]) * kf;
    b[1] += ((hc[H.minY] + hc[H.maxY]) / 2 - b[1]) * kf;
    b[2] += ((hc[H.minZ] + hc[H.maxZ]) / 2 - b[2]) * kf;
    b[3] += ((hc[H.maxX] - hc[H.minX]) / 2 - b[3]) * kf;
    b[4] += ((hc[H.maxY] - hc[H.minY]) / 2 - b[4]) * kf;
    b[5] += ((hc[H.maxZ] - hc[H.minZ]) / 2 - b[5]) * kf;
  }

  /** Ease the crowded-view factors toward what this frame's content and zoom ask for (about 0.4 s), so detail never pops. */
  private updateCrowd(cam: Camera): void {
    const hc = this.hdrCopy;
    const goal = this.crowdGoal;
    if (this.crowdLod) {
      crowdLevels(hc[H.segs], hc[H.liveFiles], hc[H.maxX] - hc[H.minX], hc[H.maxY] - hc[H.minY], cam.zoom, this.width, this.height, goal);
    } else Object.assign(goal, CROWD_OFF);
    const c = this.crowd;
    const k = this.frameDt > 0 ? 1 - Math.exp(-this.frameDt / 0.4) : 1;
    c.thread += (goal.thread - c.thread) * k;
    c.radius += (goal.radius - c.radius) * k;
    c.food += (goal.food - c.food) * k;
    c.exposure += (goal.exposure - c.exposure) * k;
    c.bloom += (goal.bloom - c.bloom) * k;
  }

  private setView(prog: Prog, cam: Camera, time: number): void {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.uniformMatrix4fv(prog.u.uView, false, cam.view);
    gl.uniformMatrix4fv(prog.u.uProj, false, cam.proj);
    gl.uniform1f(prog.u.uPxScale, 1 / cam.focal);
    gl.uniform1f(prog.u.uTime, time);
    gl.uniform1f(prog.u.uWobble, this.wobble);
    gl.uniform2f(prog.u.uFog, cam.fogNear, cam.fogFar);
    gl.uniform1f(prog.u.uRMax, SEG_R_MAX);
    gl.uniform1f(prog.u.uDistMax, this.hdrCopy[H.distMax] || 256);
    gl.uniform1f(prog.u.uReach, this.hdrCopy[H.reach]);
    gl.uniform1f(prog.u.uMotion, this.reduced ? 0 : 1);
    gl.uniform1f(prog.u.uThreadLod, this.crowd.thread);
    gl.uniform1f(prog.u.uRadiusLod, this.crowd.radius);
    gl.uniform1f(prog.u.uFoodLod, this.crowd.food);
    gl.uniform4fv(prog.u.uBurst, this.burstU);
  }

  private bindTarget(t: Target | null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    gl.viewport(0, 0, t ? t.w : this.width, t ? t.h : this.height);
  }

  /** Draw tubes + food for one impostor pass (0 opaque, 1 translucent remainder). */
  private drawImpostors(cam: Camera, time: number, pass: number): void {
    const gl = this.gl;
    // ghosts sit at the end of the segment section: drop them by drawing fewer instances
    const segs = this.fx.ghosts ? this.segCount : this.segCount - this.ghostCount;
    if (segs > 0) {
      this.setView(this.segProg[pass], cam, time);
      gl.bindVertexArray(this.segVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, segs);
    }
    if (this.foodCount > 0) {
      this.setView(this.foodProg[pass], cam, time);
      gl.bindVertexArray(this.foodVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.foodCount);
    }
  }

  /** Render a frame; `cam.update()` must have run for this viewport. */
  render(cam: Camera, time: number): void {
    const gl = this.gl;
    const hdr = this.hdr;
    if (!hdr) return;
    const timing = this.beginTimer();
    this.updateActivity(time);
    this.updateCrowd(cam);
    const lens = this.lensState;

    // 1. scene
    this.bindTarget(hdr);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);
    this.drawImpostors(cam, time, 0);
    // translucent remainder: blended over the opaque scene, no depth writes
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (this.fringe) this.drawImpostors(cam, time, 1);
    if (this.pulseCount > 0) {
      gl.blendFunc(gl.ONE, gl.ONE);
      this.setView(this.pulseProg, cam, time);
      gl.bindVertexArray(this.pulseVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.pulseCount);
    }
    const motes = this.reduced ? 0 : this.fx.particles;
    if (motes > 0) {
      gl.blendFunc(gl.ONE, gl.ONE);
      const mp = this.moteProg;
      this.setView(mp, cam, time);
      const b = this.box;
      const h = this.hot;
      gl.uniform3f(mp.u.uBoxC, b[0], b[1], b[2]);
      gl.uniform3f(mp.u.uBoxR, b[3], b[4], b[5]);
      gl.uniform4f(mp.u.uHot, h[0], h[1], h[2], h[3]);
      gl.uniform1f(mp.u.uHotR, h[4]);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, motes);
    }
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(true);

    // 3. bloom (the scene target's mips first when the lens defocuses the edges)
    if (lens.level >= 3 && lens.blur > 0) {
      gl.bindTexture(gl.TEXTURE_2D, hdr.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    gl.bindVertexArray(this.emptyVao);
    gl.useProgram(this.downProg.p);
    gl.uniform1i(this.downProg.u.uSrc, 0);
    let src: Target = hdr;
    for (let i = 0; i < this.bloom.length; i++) {
      const dst = this.bloom[i];
      this.bindTarget(dst);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(this.downProg.u.uTexel, 1 / src.w, 1 / src.h);
      gl.uniform1f(this.downProg.u.uThreshold, i === 0 ? 0.5 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      src = dst;
    }
    gl.useProgram(this.upProg.p);
    gl.uniform1i(this.upProg.u.uSrc, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = this.bloom.length - 1; i > 0; i--) {
      const s = this.bloom[i];
      this.bindTarget(this.bloom[i - 1]);
      gl.bindTexture(gl.TEXTURE_2D, s.tex);
      gl.uniform2f(this.upProg.u.uTexel, 1 / s.w, 1 / s.h);
      gl.uniform1f(this.upProg.u.uWeight, 0.8);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);

    // 4. final
    this.bindTarget(null);
    const fp = this.finalProgram(lens.level);
    gl.useProgram(fp.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, hdr.tex);
    const mips = lens.level >= 3 && lens.blur > 0;
    if (mips) gl.bindSampler(0, this.mipSampler);
    gl.uniform1i(fp.u.uHdr, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloom.length ? this.bloom[0].tex : hdr.tex);
    gl.uniform1i(fp.u.uBloom, 1);
    gl.uniform1f(fp.u.uBloomStrength, this.bloomStrength * this.crowd.bloom * (1 + PULSE_BLOOM * this.pulse));
    gl.uniform1f(fp.u.uExposure, this.crowd.exposure);
    gl.uniform1f(fp.u.uTime, time);
    const m = Math.max(this.width, this.height);
    gl.uniform2f(fp.u.uAspect, this.width / m, this.height / m);
    if (lens.level > 0) {
      gl.uniform4f(fp.u.uLensA, lens.vignette, lens.aperture, lens.chroma, mips ? lens.blur : 0);
      const asp = this.width / this.height;
      // eyepiece shape: leans toward a circle on near-square screens, stays the viewport ellipse on wide ones (see finalFs)
      const sx = 1 + (Math.pow(asp, 0.55) - 1) * lens.aperture * (1 - smoothstep(1.35, 2, asp));
      gl.uniform4f(fp.u.uLensB, lens.dust, lens.glare, lens.response, sx);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (mips) gl.bindSampler(0, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
    if (timing) gl.endQuery(this.timerExt!.TIME_ELAPSED_EXT);
  }

  /** Start a GPU timer query if none is in flight; harvest the previous one. */
  private beginTimer(): boolean {
    const ext = this.timerExt;
    const q = this.query;
    if (!ext || !q) return false;
    const gl = this.gl;
    if (this.queryPending) {
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return false;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      if (!disjoint) {
        this.gpuMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        this.gpuSamples++;
      }
      this.queryPending = false;
    }
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    this.queryPending = true;
    return true;
  }
}
