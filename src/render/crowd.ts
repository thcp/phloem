// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Level of detail for crowded views (very large repositories, or any view zoomed far out).
 *
 * Pure function of what is on screen: how many tube segments and files the frame holds and how many device pixels the
 * network's bounding box covers. It returns 0..1 factors the renderer eases and feeds to the shaders:
 *   thread   : opacity of the finest threads (explorer hair); falls to ~0.1 when crowded
 *   food     : size of the file dots; 0 when the average spacing between files is only a few pixels
 *   radius   : tube thickness; thinned when crowded so parallel traces separate into lanes instead of merging
 *   exposure : scene brightness before tone mapping, so overlapping tubes do not clip to a flat yellow block
 *   bloom    : bloom strength
 * An empty or small view returns all ones (nothing changes).
 */
export interface Crowd {
  thread: number;
  radius: number;
  food: number;
  exposure: number;
  bloom: number;
}

export const CROWD_OFF: Readonly<Crowd> = { thread: 1, radius: 1, food: 1, exposure: 1, bloom: 1 };

/** Segments per 20x20 px cell below which the view is not crowded, and above which it is fully crowded. */
const DENS_LO = 1;
const DENS_HI = 8;
/** Average file spacing (px) below which dots start to fade, and above which they are fully drawn. */
const SPACE_LO = 5;
const SPACE_HI = 12;

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function crowdLevels(
  segs: number,
  files: number,
  bboxW: number,
  bboxH: number,
  zoom: number,
  vw: number,
  vh: number,
  out: Crowd = { thread: 1, radius: 1, food: 1, exposure: 1, bloom: 1 },
): Crowd {
  if (segs <= 0 || vw <= 0 || vh <= 0 || zoom <= 0) return Object.assign(out, CROWD_OFF);
  // device pixels the network covers, clipped to the viewport (a zoomed-in view only counts what is visible)
  const areaPx = Math.max(400, Math.min(bboxW * zoom, vw) * Math.min(bboxH * zoom, vh));
  const dens = segs / (areaPx / 400);
  const crowd = smooth(DENS_LO, DENS_HI, dens);
  const spacingPx = Math.sqrt(areaPx / Math.max(1, files));
  out.thread = 1 - 0.85 * crowd;
  out.radius = 1 - 0.28 * crowd;
  out.food = files > 0 ? smooth(SPACE_LO, SPACE_HI, spacingPx) : 1;
  out.exposure = 1 - 0.18 * crowd;
  out.bloom = 1 - 0.4 * crowd;
  return out;
}
