// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Tiny allocation-free 3D direction helpers for the sim (results go into a
 * caller-owned scratch array).
 */

/**
 * Unit vector at polar angle `theta` from the unit axis (bx,by,bz), rotated by
 * azimuth `phi` around it. Writes into out[0..2].
 */
export function coneDir(bx: number, by: number, bz: number, theta: number, phi: number, out: Float64Array): void {
  // orthonormal basis (u, v) perpendicular to b
  let ux: number;
  let uy: number;
  let uz: number;
  if (bz < 0.9 && bz > -0.9) {
    // u = normalize(b x Z)
    ux = by;
    uy = -bx;
    uz = 0;
  } else {
    // u = normalize(b x X)
    ux = 0;
    uy = bz;
    uz = -by;
  }
  const ul = 1 / Math.sqrt(ux * ux + uy * uy + uz * uz);
  ux *= ul;
  uy *= ul;
  uz *= ul;
  // v = b x u
  const vx = by * uz - bz * uy;
  const vy = bz * ux - bx * uz;
  const vz = bx * uy - by * ux;
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  const cp = Math.cos(phi) * s;
  const sp = Math.sin(phi) * s;
  out[0] = bx * c + ux * cp + vx * sp;
  out[1] = by * c + uy * cp + vy * sp;
  out[2] = bz * c + uz * cp + vz * sp;
}

/** Normalize out[0..2] in place; falls back to (1,0,0) for a zero vector. Returns the old length. */
export function normalize3(out: Float64Array): number {
  const l = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
  if (l < 1e-12) {
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
    return 0;
  }
  const k = 1 / l;
  out[0] *= k;
  out[1] *= k;
  out[2] *= k;
  return l;
}

const SQ = Math.SQRT1_2;

/** Snap out[0..1] to the nearest of the 8 octilinear unit directions (0/45/90 degrees); out[2] = 0. */
export function snap8(out: Float64Array): void {
  const a = Math.round(Math.atan2(out[1], out[0]) / (Math.PI / 4));
  const k = ((a % 8) + 8) % 8;
  const c = [1, SQ, 0, -SQ, -1, -SQ, 0, SQ];
  const s = [0, SQ, 1, SQ, 0, -SQ, -1, -SQ];
  out[0] = c[k];
  out[1] = s[k];
  out[2] = 0;
}
