// SPDX-License-Identifier: AGPL-3.0-only
import { NodeKind, ROOT_ID } from '../model/tree';
import { Rng, hashString } from '../model/rng';
import { SpatialHash } from './spatial';
import { coneDir } from './vec';

/**
 * Deterministic, incremental 3D placement of logical nodes (folders, files).
 * Positions are fixed once assigned (veins already grown toward them never
 * have to move). Each new node samples candidates in an outward 3D cone around
 * its parent's growth direction and keeps the one with the most clearance from
 * already placed nodes.
 *
 * Shape: the volume is deliberately oblate. Candidate directions have their z
 * component squashed (`rootFlat` for top-level folders, `flat` below), so the
 * mold grows as a thick, branching coral fan rather than a flat sheet (z = 0)
 * or an isotropic hairball (a sphere looks the same from every side and hides
 * the folder structure behind itself).
 */
export interface LayoutParams {
  folderDist: [number, number];
  fileBase: number;
  fileSpread: number;
  /** File shell radius grows as slot^fileExp (2D used 0.5; 3D packs volume, ~1/3..1/2). */
  fileExp: number;
  candidates: number;
  /** z squash of top-level folder directions (1 = isotropic sphere, 0 = flat disc). */
  rootFlat: number;
  /** z squash of deeper folder/file directions. */
  flat: number;
  /**
   * Weight of z in the clearance metric. < 1 means depth separation counts less
   * than separation in the x-y plane, so siblings spread sideways (visible from
   * the default view) instead of hiding behind each other.
   */
  clearZ: number;
  /** Circuit mode: flat (z = 0), in-plane directions, nodes snapped to a `grid` pitch (0 = free). */
  circuit: boolean;
  grid: number;
}

export const DEFAULT_LAYOUT: LayoutParams = {
  folderDist: [60, 95],
  fileBase: 9,
  fileSpread: 5.6,
  fileExp: 0.44,
  candidates: 16,
  rootFlat: 0.4,
  flat: 0.5,
  clearZ: 0.55,
  circuit: false,
  grid: 0,
};

/** Circuit board layout: a flat plane, pads on a regular grid. */
export const CIRCUIT_LAYOUT: LayoutParams = { ...DEFAULT_LAYOUT, fileExp: 0.5, rootFlat: 0, flat: 0, circuit: true, grid: 5 };

export class Layout {
  x: number[] = [0];
  y: number[] = [0];
  z: number[] = [0];
  /** Unit growth direction (parent -> node). */
  dx: number[] = [1];
  dy: number[] = [0];
  dz: number[] = [0];
  /** Number of files ever placed under each folder (drives file shell radius). */
  private fileSlots: number[] = [0];
  private folderSlots: number[] = [0];
  private grid = new SpatialHash(20, 15, 1024);
  private q = new Int32Array(1024);
  private d = new Float64Array(3);

  constructor(private seed: number, private p: LayoutParams = DEFAULT_LAYOUT) {
    this.grid.insert(ROOT_ID, 0, 0, 0);
  }

  private clearance(px: number, py: number, pz: number, r: number, skip: number): number {
    const n = this.grid.query(px, py, pz, r, this.q);
    let best = r * r;
    for (let k = 0; k < n; k++) {
      const id = this.q[k];
      if (id === skip) continue;
      const dx = this.x[id] - px;
      const dy = this.y[id] - py;
      const dz = (this.z[id] - pz) * this.p.clearZ;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
  }

  /** Place node `id` under `parent`. `path` seeds its private RNG. */
  place(id: number, parent: number, kind: NodeKind, depth: number, path: string): void {
    const rng = new Rng(hashString(path, this.seed));
    const p = this.p;
    const px = this.x[parent];
    const py = this.y[parent];
    const pz = this.z[parent];
    const isRoot = parent === ROOT_ID;
    let spread: number;
    let r0: number;
    let r1: number;
    let clearR: number;
    let flat = p.flat;
    if (kind === NodeKind.Folder) {
      const slot = this.folderSlots[parent]++;
      const s = 1 / (1 + 0.1 * Math.max(0, depth - 1));
      r0 = p.folderDist[0] * s;
      r1 = p.folderDist[1] * s;
      spread = isRoot ? Math.PI : Math.min(1.5, 0.8 + 0.12 * slot);
      clearR = 70 * s;
      if (isRoot) flat = p.rootFlat;
    } else {
      const slot = this.fileSlots[parent]++;
      const ring = p.fileBase + p.fileSpread * Math.pow(slot + 1, p.fileExp);
      r0 = ring * 0.85;
      r1 = ring * 1.15;
      spread = isRoot ? Math.PI : 2.3;
      clearR = 14;
    }
    // root children: any direction (squashed); others: cone around the parent's direction
    const bx = isRoot ? 1 : this.dx[parent];
    const by = isRoot ? 0 : this.dy[parent];
    const bz = isRoot ? 0 : this.dz[parent];
    const d = this.d;
    const G = p.grid;
    let best = -Infinity;
    let ox = px + bx * r0;
    let oy = py + by * r0;
    let oz = pz + bz * r0;
    for (let c = 0; c < p.candidates; c++) {
      let dev: number;
      if (p.circuit) {
        // in-plane: rotate the parent's direction by a uniform angle (any angle for root children)
        const a = isRoot ? rng.range(-Math.PI, Math.PI) : rng.range(-spread, spread);
        dev = Math.abs(a);
        d[0] = bx * Math.cos(a) - by * Math.sin(a);
        d[1] = bx * Math.sin(a) + by * Math.cos(a);
        d[2] = 0;
      } else if (isRoot) {
        // uniform on the sphere
        const u = rng.range(-1, 1);
        const phi = rng.next() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        d[0] = s * Math.cos(phi);
        d[1] = s * Math.sin(phi);
        d[2] = u;
        dev = 0;
      } else {
        // area-uniform within the cone (cos theta uniform), so wide cones fill their solid angle
        const ct = 1 - rng.next() * (1 - Math.cos(spread));
        dev = Math.acos(ct);
        coneDir(bx, by, bz, dev, rng.next() * Math.PI * 2, d);
      }
      d[2] *= flat;
      const l = 1 / Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
      const r = rng.range(r0, r1);
      let cx = px + d[0] * l * r;
      let cy = py + d[1] * l * r;
      const cz = pz + d[2] * l * r;
      if (G > 0) {
        cx = Math.round(cx / G) * G;
        cy = Math.round(cy / G) * G;
      }
      const cl = this.clearance(cx, cy, cz, clearR, parent);
      const score = cl - (dev / Math.PI) * clearR * 0.35;
      if (score > best) {
        best = score;
        ox = cx;
        oy = cy;
        oz = cz;
      }
    }
    this.set(id, ox, oy, oz, px, py, pz);
  }

  private set(id: number, x: number, y: number, z: number, px: number, py: number, pz: number): void {
    while (this.x.length <= id) {
      this.x.push(0);
      this.y.push(0);
      this.z.push(0);
      this.dx.push(1);
      this.dy.push(0);
      this.dz.push(0);
      this.fileSlots.push(0);
      this.folderSlots.push(0);
    }
    this.x[id] = x;
    this.y[id] = y;
    this.z[id] = z;
    const ex = x - px;
    const ey = y - py;
    const ez = z - pz;
    const l = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
    this.dx[id] = ex / l;
    this.dy[id] = ey / l;
    this.dz[id] = ez / l;
    this.grid.insert(id, x, y, z);
  }

  /** Forget a node (dead nodes stop blocking space). */
  release(id: number): void {
    this.grid.remove(id);
  }
}
