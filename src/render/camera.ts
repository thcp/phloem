// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Perspective orbit camera (y up).
 *
 * State: a target point, a distance and yaw/pitch angles. The eye sits at
 * target + dist * (cos(pitch) sin(yaw), sin(pitch), cos(pitch) cos(yaw)).
 *
 * - Auto mode eases target and distance so the network's 3D bounding box fits
 *   the usable viewport (above `bottomInset`). Orbiting keeps auto framing on;
 *   panning or zooming switches to manual until reset().
 * - Input goes through orbit()/pan()/zoomAt() as pixel deltas; update() turns
 *   the deltas into smooth motion with inertia (drag velocity keeps spinning
 *   and decays after release; wheel zoom is eased).
 * - The projection has a vertical lens shift so the target sits at the center
 *   of the usable band (the UI chrome covers the bottom of the canvas).
 *
 * Matrices are column-major Float32Arrays, ready for uniformMatrix4fv.
 */
export const DEFAULT_YAW = -0.55;
export const DEFAULT_PITCH = 0.38;
const PITCH_LIMIT = 1.45;
const ORBIT_RAD_PER_PX = 0.0055;
const AUTO_ROTATE_RAD_PER_S = 0.12;

export class Camera {
  // orbit state
  tx = 0;
  ty = 0;
  tz = 0;
  dist = 300;
  yaw = DEFAULT_YAW;
  pitch = DEFAULT_PITCH;
  readonly fovY = (38 * Math.PI) / 180;
  /** Follow the network bbox (target + distance). */
  auto = true;
  /** Slow turntable rotation (toggled with `O`). */
  autoRotate = false;
  /** The auto-director owns the azimuth while it is on: the turntable stands still (render/director.ts). */
  autoRotateSuppressed = false;
  /** Circuit view: straight down onto the x-y plane. Orbit input is ignored and yaw / pitch are held at 0. */
  flat = false;
  /** Device pixels at the bottom covered by UI chrome; auto-fit keeps the network above it. */
  bottomInset = 0;

  // derived each update()
  readonly view = new Float32Array(16);
  readonly proj = new Float32Array(16);
  readonly viewProj = new Float32Array(16);
  /** Eye position (world). */
  readonly eye = new Float32Array(3);
  /** Camera basis in world space. */
  readonly right = new Float32Array(3);
  readonly up = new Float32Array(3);
  readonly fwd = new Float32Array(3);
  width = 1;
  height = 1;
  near = 1;
  far = 1000;
  /** Device px per world unit at view depth 1 (focal length in px). */
  focal = 1;
  /** View-space depth range of the depth cue (fog start, fog end). */
  fogNear = 0;
  fogFar = 1;
  /** Vertical lens shift in NDC (target projects to y = shift). */
  shift = 0;

  // scene bounds (bounding sphere of the last bbox)
  private sx = 0;
  private sy = 0;
  private sz = 0;
  private sr = 100;
  // auto-fit goal
  private gx = 0;
  private gy = 0;
  private gz = 0;
  private gDist = 300;
  // input accumulators and inertia
  private dYaw = 0;
  private dPitch = 0;
  private dPanX = 0;
  private dPanY = 0;
  private vYaw = 0;
  private vPitch = 0;
  private vPanX = 0;
  private vPanY = 0;
  private zoomLog = 0; // pending log-zoom (eased)
  private zoomPx = 0;
  private zoomPy = 0;
  /** True while a pointer drag is in progress (no inertia integration). */
  dragging = false;

  /** px per world unit at the target distance (2D-camera compatible). */
  get zoom(): number {
    return this.focal / this.dist;
  }

  /** Distance at which the whole mold fits for the current orientation (computed by follow() even in manual mode; the auto-director's establishing shot). */
  get fitDist(): number {
    return this.gDist;
  }

  /** Bounding sphere radius of the scene (world units). */
  get sceneRadius(): number {
    return this.sr;
  }

  /** Feed the network bbox; in auto mode, ease toward framing it. */
  follow(
    minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
    vw: number, vh: number, dt: number,
  ): void {
    this.sx = (minX + maxX) / 2;
    this.sy = (minY + maxY) / 2;
    this.sz = (minZ + maxZ) / 2;
    const ex = Math.max(maxX - minX, 60) / 2;
    const ey = Math.max(maxY - minY, 60) / 2;
    const ez = Math.max(maxZ - minZ, 30) / 2;
    this.sr = Math.sqrt(ex * ex + ey * ey + ez * ez);
    this.width = vw;
    this.height = vh;
    this.basis();
    // Fit (mostly) the ellipsoid inscribed in the bbox (the box corners are
    // largely empty for an organic network): its half-extent along a unit axis a is |diag(e) a|.
    // Orientation aware, so orbiting re-frames smoothly.
    const usable = Math.max(vh - this.bottomInset, vh * 0.5);
    const tanY = Math.tan(this.fovY / 2) * (usable / vh) * 0.9;
    const tanX = Math.tan(this.fovY / 2) * (vw / vh) * 0.9;
    const r = this.right;
    const u = this.up;
    const f = this.fwd;
    // blend toward the full box extent: food and fringe do reach into the corners
    const ext = (ax: number, ay: number, az: number) =>
      0.65 * Math.hypot(ex * ax, ey * ay, ez * az) + 0.35 * (ex * Math.abs(ax) + ey * Math.abs(ay) + ez * Math.abs(az));
    const hx = ext(r[0], r[1], r[2]);
    const hy = ext(u[0], u[1], u[2]);
    const hz = ext(f[0], f[1], f[2]);
    // the near half of the volume is closer to the eye and looks bigger: back off by part of the depth extent
    const need = Math.max(hx / tanX, hy / tanY) + hz * 0.6;
    this.gx = this.sx;
    this.gy = this.sy;
    this.gz = this.sz;
    this.gDist = Math.max(need, 40);
    if (!this.auto) return;
    const k = 1 - Math.exp(-dt * 1.6);
    this.tx += (this.gx - this.tx) * k;
    this.ty += (this.gy - this.ty) * k;
    this.tz += (this.gz - this.tz) * k;
    // ease distance in log space so zooming out is as smooth as zooming in
    this.dist = Math.exp(Math.log(this.dist) + (Math.log(this.gDist) - Math.log(this.dist)) * k);
  }

  snap(): void {
    if (!this.auto) return;
    this.tx = this.gx;
    this.ty = this.gy;
    this.tz = this.gz;
    this.dist = this.gDist;
  }

  /** Orbit by a device-pixel drag delta. Keeps auto framing on. */
  orbit(dxPx: number, dyPx: number): void {
    if (this.flat) return;
    const s = ORBIT_RAD_PER_PX * (1000 / Math.max(500, Math.min(this.width, this.height * 1.6)));
    this.dYaw -= dxPx * s;
    this.dPitch += dyPx * s;
  }

  /** Pan by a device-pixel delta (screen y down): the scene follows the pointer. */
  pan(dxPx: number, dyPx: number): void {
    this.auto = false;
    const w = this.dist / this.focal;
    this.dPanX -= dxPx * w;
    this.dPanY += dyPx * w;
  }

  /** Zoom by `factor` (> 1 = closer) toward device pixel (px, py) from the top-left; eased. */
  zoomAt(px: number, py: number, factor: number, vw: number, vh: number): void {
    this.auto = false;
    this.width = vw;
    this.height = vh;
    this.zoomLog += Math.log(factor);
    this.zoomPx = px;
    this.zoomPy = py;
  }

  /** Immediate zoom step (pinch): no easing, so fingers stay glued to the content. */
  zoomNow(px: number, py: number, factor: number): void {
    this.auto = false;
    this.applyZoom(px, py, factor);
  }

  private applyZoom(px: number, py: number, factor: number): void {
    const f = Math.min(Math.max(factor, 0.2), 5);
    const d0 = this.dist;
    const minD = Math.max(2, this.sr * 0.01);
    const maxD = this.sr * 12 + 200;
    const d1 = Math.min(Math.max(d0 / f, minD), maxD);
    // keep the point under the cursor (on the plane through the target) fixed
    const ox = (px - this.width / 2) / this.focal;
    const oy = -(py - this.height / 2) / this.focal - (this.shift * (this.height / 2)) / this.focal;
    const s = d0 - d1;
    this.basis();
    this.tx += (this.right[0] * ox + this.up[0] * oy) * s;
    this.ty += (this.right[1] * ox + this.up[1] * oy) * s;
    this.tz += (this.right[2] * ox + this.up[2] * oy) * s;
    this.dist = d1;
  }

  reset(): void {
    this.auto = true;
    this.yaw = this.flat ? 0 : DEFAULT_YAW;
    this.pitch = this.flat ? 0 : DEFAULT_PITCH;
    this.vYaw = this.vPitch = this.vPanX = this.vPanY = 0;
    this.dYaw = this.dPitch = this.dPanX = this.dPanY = 0;
    this.zoomLog = 0;
  }

  /** Is the camera still moving on its own (inertia / easing)? */
  get moving(): boolean {
    return Math.abs(this.vYaw) + Math.abs(this.vPitch) > 1e-3 || Math.abs(this.zoomLog) > 1e-3 || (this.autoRotate && !this.autoRotateSuppressed);
  }

  /** Integrate input + inertia and rebuild the matrices. Call once per frame. */
  update(vw: number, vh: number, dt: number): void {
    this.width = vw;
    this.height = vh;
    this.focal = vh / 2 / Math.tan(this.fovY / 2);
    const idt = dt > 1e-4 ? 1 / dt : 60;
    if (this.dragging) {
      // follow the pointer exactly; remember its velocity for the release
      const a = 0.5;
      this.vYaw = this.vYaw * (1 - a) + this.dYaw * idt * a;
      this.vPitch = this.vPitch * (1 - a) + this.dPitch * idt * a;
      this.vPanX = this.vPanX * (1 - a) + this.dPanX * idt * a;
      this.vPanY = this.vPanY * (1 - a) + this.dPanY * idt * a;
      this.yaw += this.dYaw;
      this.pitch += this.dPitch;
      this.panWorld(this.dPanX, this.dPanY);
    } else {
      this.yaw += this.dYaw + this.vYaw * dt;
      this.pitch += this.dPitch + this.vPitch * dt;
      this.panWorld(this.dPanX + this.vPanX * dt, this.dPanY + this.vPanY * dt);
      const decay = Math.exp(-dt * 4.5);
      this.vYaw *= decay;
      this.vPitch *= decay;
      this.vPanX *= decay;
      this.vPanY *= decay;
      if (this.autoRotate && !this.autoRotateSuppressed) this.yaw += AUTO_ROTATE_RAD_PER_S * dt;
    }
    this.dYaw = this.dPitch = this.dPanX = this.dPanY = 0;
    if (this.flat) {
      this.yaw = this.pitch = this.vYaw = this.vPitch = 0;
    }
    if (this.pitch > PITCH_LIMIT) {
      this.pitch = PITCH_LIMIT;
      this.vPitch = 0;
    } else if (this.pitch < -PITCH_LIMIT) {
      this.pitch = -PITCH_LIMIT;
      this.vPitch = 0;
    }
    if (this.yaw > Math.PI * 4 || this.yaw < -Math.PI * 4) this.yaw %= Math.PI * 2;
    if (this.zoomLog !== 0) {
      const k = 1 - Math.exp(-dt * 14);
      let step = this.zoomLog * k;
      if (Math.abs(this.zoomLog) < 1e-4) step = this.zoomLog;
      this.zoomLog -= step;
      this.applyZoom(this.zoomPx, this.zoomPy, Math.exp(step));
    }
    this.matrices();
  }

  /** Pan pending world offsets along the camera's right/up axes. */
  private panWorld(ax: number, ay: number): void {
    if (ax === 0 && ay === 0) return;
    this.basis();
    this.tx += this.right[0] * ax + this.up[0] * ay;
    this.ty += this.right[1] * ax + this.up[1] * ay;
    this.tz += this.right[2] * ax + this.up[2] * ay;
  }

  private basis(): void {
    const cp = Math.cos(this.pitch);
    // direction from target to eye
    const bx = cp * Math.sin(this.yaw);
    const by = Math.sin(this.pitch);
    const bz = cp * Math.cos(this.yaw);
    const f = this.fwd;
    f[0] = -bx;
    f[1] = -by;
    f[2] = -bz;
    // right = normalize(fwd x worldUp)
    let rx = -f[2];
    let rz = f[0];
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl;
    rz /= rl;
    const r = this.right;
    r[0] = rx;
    r[1] = 0;
    r[2] = rz;
    // up = right x fwd
    const u = this.up;
    u[0] = r[1] * f[2] - r[2] * f[1];
    u[1] = r[2] * f[0] - r[0] * f[2];
    u[2] = r[0] * f[1] - r[1] * f[0];
  }

  private matrices(): void {
    this.basis();
    const r = this.right;
    const u = this.up;
    const f = this.fwd;
    const e = this.eye;
    e[0] = this.tx - f[0] * this.dist;
    e[1] = this.ty - f[1] * this.dist;
    e[2] = this.tz - f[2] * this.dist;
    const v = this.view;
    v[0] = r[0]; v[4] = r[1]; v[8] = r[2]; v[12] = -(r[0] * e[0] + r[1] * e[1] + r[2] * e[2]);
    v[1] = u[0]; v[5] = u[1]; v[9] = u[2]; v[13] = -(u[0] * e[0] + u[1] * e[1] + u[2] * e[2]);
    v[2] = -f[0]; v[6] = -f[1]; v[10] = -f[2]; v[14] = f[0] * e[0] + f[1] * e[1] + f[2] * e[2];
    v[3] = 0; v[7] = 0; v[11] = 0; v[15] = 1;
    // depth range around the scene's bounding sphere (as seen from the eye)
    const dx = this.sx - e[0];
    const dy = this.sy - e[1];
    const dz = this.sz - e[2];
    const centerDepth = dx * f[0] + dy * f[1] + dz * f[2];
    const R = this.sr * 1.15 + 10;
    this.far = Math.max(centerDepth + R, 10);
    this.near = Math.max(this.far * 0.002, centerDepth - R, 0.5);
    this.fogNear = centerDepth - this.sr * 0.55;
    this.fogFar = centerDepth + this.sr * 1.1;
    const usable = Math.max(this.height - this.bottomInset, this.height * 0.5);
    this.shift = (this.height - usable) / this.height; // NDC: center of the usable band
    const t = 1 / Math.tan(this.fovY / 2);
    const aspect = this.width / this.height;
    const n = this.near;
    const fa = this.far;
    const p = this.proj;
    p.fill(0);
    p[0] = t / aspect;
    p[5] = t;
    p[10] = -(fa + n) / (fa - n);
    p[11] = -1;
    p[14] = (-2 * fa * n) / (fa - n);
    // lens shift: y_ndc = t * y / (-z) + shift, so the target sits mid-way up the usable band
    p[9] = -this.shift;
    mul(this.viewProj, p, v);
  }

  /**
   * Project a world point. out[0], out[1] = device px from the top-left,
   * out[2] = view depth (world units, > 0 in front), out[3] = device px per world unit at that depth.
   * Returns false behind the near plane.
   */
  project(x: number, y: number, z: number, out: Float32Array | number[]): boolean {
    const m = this.viewProj;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    out[2] = cw;
    if (cw < this.near * 0.5) return false;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[0] = (cx / cw * 0.5 + 0.5) * this.width;
    out[1] = (0.5 - (cy / cw) * 0.5) * this.height;
    out[3] = this.focal / cw;
    return true;
  }
}

/** out = a * b (column-major 4x4). */
function mul(out: Float32Array, a: Float32Array, b: Float32Array): void {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
  }
}
