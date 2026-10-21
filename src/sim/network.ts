// SPDX-License-Identifier: AGPL-3.0-only
import { Rng } from '../model/rng';
import { SpatialHash } from './spatial';
import { coneDir, snap8 } from './vec';
import { GHOST_MIN_R, WARM_DECAY } from './activity';

/**
 * Physical vein network of the slime mold.
 *
 * - Nodes/edges are stored as structure-of-arrays in typed arrays with free
 *   lists, so the hot loops (flux solve, adaptation, packing) never allocate.
 * - Every node except the root has a growth parent; parent edges form a
 *   spanning tree. Extra "loop" edges come from anastomosis (fusion).
 * - Flux follows Tero et al. (2007/2010): Kirchhoff pressure solve with the
 *   root as source and food/tips as sinks, then dD/dt = a (f(|Q|) - D).
 *   The Poisson system is solved with PCG preconditioned by an exact solve on
 *   the growth tree (O(N)); with few loop edges this converges in a handful
 *   of iterations, warm-started from the previous tick.
 */

export const N_ALIVE = 1;
export const N_PROTECTED = 2; // live file/folder anchor or root: never pruned
export const N_TIP = 4; // moving growth/explorer tip

export const E_ALIVE = 1;
export const E_TREE = 2; // growth parent edge (child's parentEdge)
export const E_LOOP = 4; // anastomosis edge

/** Fusion only closes local cycles (tree distance between endpoints, in hops). */
const LOOP_MIN_HOPS = 8;
const LOOP_MAX_HOPS = 40;
/** Loops whose stretch (g_loop * tree-path resistance) exceeds this are dissolved. */
const MAX_LOOP_STRETCH = 40;
/** Afterglow ring capacity (pruned veins remembered for the renderer). */
export const GHOST_CAP = 2048;
/** Per-tick decay of an edge's remembered peak radius. */
const PEAK_DECAY = 0.9995;
const WARM_DECAY_L = WARM_DECAY;
const SQ = Math.SQRT1_2;

export interface NetworkParams {
  segLen: number;
  tipSpeed: number;
  tipWander: number;
  tipDemand: number;
  explorerSegLen: number;
  explorerSpeed: number;
  explorerRate: number; // per growth tip per tick
  explorerBranchRate: number; // per explorer per tick
  explorerMax: number;
  explorerLen: [number, number];
  fuseDist: number;
  fuseProbGrowth: number;
  fuseProbExplorer: number;
  D0: number;
  adapt: number; // a in dD/dt = a (f - D)
  mu: number; // Hill exponent of f(Q)
  qrefK: number; // Qref = qrefK * totalDemand^qrefGamma
  qrefGamma: number;
  pruneD: number;
  heatDecay: number;
  cgIters: number;
  /** Junction count above which the pressure solve runs every other tick. */
  solveEveryOtherAbove: number;
  rMin: number; // world radius of the thinnest tube
  rScale: number; // radius = rMin + rScale * sqrt(D)
  /**
   * Circuit mode: growth tips follow octilinear routes (straight and 45 degree legs with sharp bends, no meander or
   * corner smoothing), explorers keep to the 8 directions and turn by 45 degrees. Everything stays in the z = 0 plane.
   */
  circuit: boolean;
}

export const DEFAULT_NETWORK_PARAMS: NetworkParams = {
  segLen: 5.5,
  tipSpeed: 2.2,
  tipWander: 0.1,
  tipDemand: 0.3,
  explorerSegLen: 3.4,
  explorerSpeed: 1.0,
  explorerRate: 0.3,
  explorerBranchRate: 0.06,
  explorerMax: 1500,
  explorerLen: [8, 36],
  fuseDist: 3.6,
  fuseProbGrowth: 0.35,
  fuseProbExplorer: 0.8,
  D0: 0.1,
  adapt: 0.025,
  mu: 2,
  qrefK: 0.15,
  qrefGamma: 0.5,
  pruneD: 0.005,
  heatDecay: 0.92,
  cgIters: 5,
  solveEveryOtherAbove: 8000,
  rMin: 0.14,
  rScale: 1.6,
  circuit: false,
};

/** Overrides for circuit mode: calmer fringe, so traces read as traces. */
export const CIRCUIT_NETWORK: Partial<NetworkParams> = { explorerRate: 0.12, explorerBranchRate: 0.04, explorerLen: [8, 30] };

export class Tip {
  active = false;
  node = -1; // moving tip node
  prev = -1; // last fixed node
  /** Unit heading. */
  hx = 1;
  hy = 0;
  hz = 0;
  tx = 0;
  ty = 0;
  tz = 0;
  target = -1; // logical id for growth tips, -1 for explorers
  explorer = false;
  gen = 0;
  travel = 0;
  maxTravel = 0;
  startDist = 1;
  deposits = 0;
  fuseCooldown = 0;
  owner = -1;
  /** Slowly drifting meander (added to the heading each tick). */
  mx = 0;
  my = 0;
  mz = 0;
  /** Circuit route: waypoints (x,y pairs, the last is the target), their count and the one being approached. */
  way = new Float64Array(6);
  nWay = 0;
  iWay = 0;
  listed = false; // currently referenced from Network.tips
}

export class Network {
  readonly p: NetworkParams;
  // ---- nodes
  nodeCap = 0;
  nodeTop = 0; // high-water mark of used slots
  nodeCount = 0;
  x!: Float32Array;
  y!: Float32Array;
  z!: Float32Array;
  heat!: Float32Array;
  /** Recent activity (visual only): 1 on fresh growth and where author pulses pass, decays by WARM_DECAY per tick. */
  warm!: Float32Array;
  dist!: Float32Array;
  demand!: Float32Array;
  nodeR!: Float32Array;
  parent!: Int32Array;
  parentEdge!: Int32Array;
  firstChild!: Int32Array;
  /** Logical folder whose territory this node belongs to (-1 unknown). */
  owner!: Int32Array;
  nextSib!: Int32Array;
  deg!: Int32Array;
  nflags!: Uint8Array;
  private mark!: Int32Array; // stamp for LCA searches
  private markHops!: Int32Array;
  private stamp = 0;
  private pathA = new Int32Array(128);
  private pathB = new Int32Array(128);
  private pathALen = 0;
  private pathBLen = 0;
  swaps = 0;
  private tickCount = 0;
  pr!: Float64Array; // pressure (warm start)
  private diag!: Float64Array;
  private rhs!: Float64Array;
  private res!: Float64Array;
  private zz!: Float64Array;
  private dd!: Float64Array;
  private qq!: Float64Array;
  private jx!: Float64Array;
  private jIdx!: Int32Array;
  private jNode!: Int32Array;
  private jPar!: Int32Array;
  private jC!: Float64Array;
  private loopDeg!: Int32Array;
  private la!: Int32Array;
  private lb!: Int32Array;
  private lg!: Float64Array;
  private loopCount = 0;
  junctions = 0;
  /** Relative Kirchhoff residual after the last solve (|r| / |b|). */
  lastResidual = 0;
  private freeNodes: number[] = [];
  // ---- edges
  edgeCap = 0;
  edgeTop = 0;
  edgeCount = 0;
  ea!: Int32Array;
  eb!: Int32Array;
  elen!: Float32Array;
  eD!: Float32Array;
  eQ!: Float32Array;
  /** Render radius, updated with D every tick. */
  eR!: Float32Array;
  /** Slowly decaying peak of eR (visual only: the width of the afterglow ghost when the tube is pruned). */
  ePeak!: Float32Array;
  eflags!: Uint8Array;
  private eg!: Float64Array;
  private freeEdges: number[] = [];
  // ---- topology order for the tree preconditioner
  private order!: Int32Array;
  private orderLen = 0;
  private orderDirty = true;
  private stack!: Int32Array;
  // ---- tips
  readonly tips: Tip[] = [];
  private freeTips: Tip[] = [];
  explorerCount = 0;
  growthTipCount = 0;
  // ---- misc
  readonly grid: SpatialHash;
  /** Coarse hash of the same fixed nodes, for long-range nearestOwned() searches. */
  private coarse = new SpatialHash(24, 15, 1024);
  private q = new Int32Array(4096);
  private qBig = new Int32Array(16384);
  private dir = new Float64Array(3);
  readonly root: number;
  /** Arrivals recorded during step(): logical target id and node index. */
  arrivedTarget = new Int32Array(64);
  arrivedNode = new Int32Array(64);
  arrivedCount = 0;
  /**
   * Afterglow ring (visual only): the last GHOST_CAP pruned veins (peak radius >= GHOST_MIN_R) as
   * x0 y0 z0 x1 y1 z1 in `ghostPos`, peak radius in `ghostR`, prune tick (network tick count) in `ghostTick`.
   */
  readonly ghostPos = new Float32Array(GHOST_CAP * 6);
  readonly ghostR = new Float32Array(GHOST_CAP);
  readonly ghostTick = new Int32Array(GHOST_CAP).fill(-1 << 30);
  ghostHead = 0;
  totalDemand = 0;
  qref = 1;
  lastCgIters = 0;

  constructor(params: Partial<NetworkParams> = {}) {
    this.p = { ...DEFAULT_NETWORK_PARAMS, ...params };
    this.allocNodes(1024);
    this.allocEdges(1024);
    this.grid = new SpatialHash(this.p.fuseDist * 1.5, 16, 1024);
    this.root = this.addNode(0, 0, 0, -1, N_ALIVE | N_PROTECTED);
    this.heat[this.root] = 1;
  }

  // ------------------------------------------------------------ storage
  private allocNodes(cap: number): void {
    const n = this.nodeCap;
    const f32 = (a: Float32Array | undefined) => {
      const b = new Float32Array(cap);
      if (a) b.set(a.subarray(0, n));
      return b;
    };
    const f64 = (a: Float64Array | undefined) => {
      const b = new Float64Array(cap);
      if (a) b.set(a.subarray(0, n));
      return b;
    };
    const i32 = (a: Int32Array | undefined) => {
      const b = new Int32Array(cap).fill(-1);
      if (a) b.set(a.subarray(0, n));
      return b;
    };
    this.x = f32(this.x);
    this.y = f32(this.y);
    this.z = f32(this.z);
    this.heat = f32(this.heat);
    this.warm = f32(this.warm);
    this.dist = f32(this.dist);
    this.demand = f32(this.demand);
    this.nodeR = f32(this.nodeR);
    this.parent = i32(this.parent);
    this.parentEdge = i32(this.parentEdge);
    this.firstChild = i32(this.firstChild);
    this.owner = i32(this.owner);
    this.nextSib = i32(this.nextSib);
    const mark = new Int32Array(cap);
    if (this.mark) mark.set(this.mark.subarray(0, n));
    this.mark = mark;
    this.markHops = new Int32Array(cap);
    const deg = new Int32Array(cap);
    if (this.deg) deg.set(this.deg.subarray(0, n));
    this.deg = deg;
    const fl = new Uint8Array(cap);
    if (this.nflags) fl.set(this.nflags.subarray(0, n));
    this.nflags = fl;
    this.pr = f64(this.pr);
    this.diag = new Float64Array(cap);
    this.rhs = new Float64Array(cap);
    this.res = new Float64Array(cap);
    this.zz = new Float64Array(cap);
    this.dd = new Float64Array(cap);
    this.qq = new Float64Array(cap);
    this.jx = new Float64Array(cap);
    this.jIdx = new Int32Array(cap);
    this.jNode = new Int32Array(cap);
    this.jPar = new Int32Array(cap);
    this.jC = new Float64Array(cap);
    this.loopDeg = new Int32Array(cap);
    this.order = new Int32Array(cap);
    this.stack = new Int32Array(cap);
    this.nodeCap = cap;
    this.orderDirty = true;
  }

  private allocEdges(cap: number): void {
    const n = this.edgeCap;
    const i32 = (a: Int32Array | undefined) => {
      const b = new Int32Array(cap).fill(-1);
      if (a) b.set(a.subarray(0, n));
      return b;
    };
    const f32 = (a: Float32Array | undefined) => {
      const b = new Float32Array(cap);
      if (a) b.set(a.subarray(0, n));
      return b;
    };
    this.ea = i32(this.ea);
    this.eb = i32(this.eb);
    this.elen = f32(this.elen);
    this.eD = f32(this.eD);
    this.eQ = f32(this.eQ);
    this.eR = f32(this.eR);
    this.ePeak = f32(this.ePeak);
    const fl = new Uint8Array(cap);
    if (this.eflags) fl.set(this.eflags.subarray(0, n));
    this.eflags = fl;
    const g = new Float64Array(cap);
    if (this.eg) g.set(this.eg.subarray(0, n));
    this.eg = g;
    this.la = new Int32Array(cap);
    this.lb = new Int32Array(cap);
    this.lg = new Float64Array(cap);
    this.edgeCap = cap;
  }

  addNode(x: number, y: number, z: number, parent: number, flags: number, owner = -1): number {
    let i: number;
    if (this.freeNodes.length > 0) i = this.freeNodes.pop()!;
    else {
      if (this.nodeTop >= this.nodeCap) this.allocNodes(this.nodeCap * 2);
      i = this.nodeTop++;
    }
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.heat[i] = 1;
    this.warm[i] = 1;
    this.demand[i] = 0;
    this.nodeR[i] = 0;
    this.parent[i] = parent;
    this.parentEdge[i] = -1;
    this.firstChild[i] = -1;
    this.nextSib[i] = -1;
    this.deg[i] = 0;
    this.nflags[i] = flags | N_ALIVE;
    this.owner[i] = owner;
    this.pr[i] = parent >= 0 ? this.pr[parent] : 0;
    this.dist[i] = parent >= 0 ? this.dist[parent] : 0;
    if (parent >= 0) {
      this.nextSib[i] = this.firstChild[parent];
      this.firstChild[parent] = i;
    }
    this.nodeCount++;
    this.orderDirty = true;
    return i;
  }

  private removeNode(i: number): void {
    const par = this.parent[i];
    if (par >= 0) {
      // unlink from parent's child list
      let c = this.firstChild[par];
      if (c === i) this.firstChild[par] = this.nextSib[i];
      else {
        while (c >= 0 && this.nextSib[c] !== i) c = this.nextSib[c];
        if (c >= 0) this.nextSib[c] = this.nextSib[i];
      }
    }
    // Orphaned children (should not happen: only leaves are removed) get re-parented.
    for (let c = this.firstChild[i]; c >= 0; ) {
      const nx = this.nextSib[c];
      this.parent[c] = -1;
      c = nx;
    }
    this.grid.remove(i);
    this.coarse.remove(i);
    this.nflags[i] = 0;
    this.parent[i] = -1;
    this.firstChild[i] = -1;
    this.nextSib[i] = -1;
    this.pr[i] = 0;
    this.demand[i] = 0;
    this.freeNodes.push(i);
    this.nodeCount--;
    this.orderDirty = true;
  }

  addEdge(a: number, b: number, D: number, flags: number): number {
    let e: number;
    if (this.freeEdges.length > 0) e = this.freeEdges.pop()!;
    else {
      if (this.edgeTop >= this.edgeCap) this.allocEdges(this.edgeCap * 2);
      e = this.edgeTop++;
    }
    this.ea[e] = a;
    this.eb[e] = b;
    const dx = this.x[b] - this.x[a];
    const dy = this.y[b] - this.y[a];
    const dz = this.z[b] - this.z[a];
    this.elen[e] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.eD[e] = D;
    this.eQ[e] = 0;
    this.eR[e] = this.radiusOf(D);
    this.ePeak[e] = this.eR[e];
    this.eflags[e] = flags | E_ALIVE;
    this.deg[a]++;
    this.deg[b]++;
    this.edgeCount++;
    return e;
  }

  private removeEdge(e: number): void {
    this.deg[this.ea[e]]--;
    this.deg[this.eb[e]]--;
    this.eflags[e] = 0;
    this.eD[e] = 0;
    this.eg[e] = 0;
    this.freeEdges.push(e);
    this.edgeCount--;
  }

  /** Create a child node attached by a tree edge. */
  private grow(from: number, x: number, y: number, z: number, D: number, flags: number, owner: number): number {
    const n = this.addNode(x, y, z, from, flags, owner);
    const e = this.addEdge(from, n, D, E_TREE);
    this.parentEdge[n] = e;
    return n;
  }

  /**
   * Renumber nodes in DFS order (parents before children, chains contiguous)
   * and edges by child node, then loops. Removes free-list fragmentation so the
   * hot loops walk memory nearly sequentially. Returns the old->new node map
   * (callers holding node indices must remap) and invalidates nothing else.
   */
  compact(): Int32Array {
    if (this.orderDirty) this.rebuildOrder();
    const n = this.orderLen;
    const order = this.order;
    const map = new Int32Array(this.nodeTop).fill(-1);
    for (let k = 0; k < n; k++) map[order[k]] = k;
    const emap = new Int32Array(this.edgeTop).fill(-1);
    let ne = 0;
    for (let k = 1; k < n; k++) emap[this.parentEdge[order[k]]] = ne++;
    for (let e = 0; e < this.edgeTop; e++) if (this.eflags[e] & E_ALIVE && emap[e] < 0) emap[e] = ne++;

    const permF32 = (a: Float32Array) => {
      const b = new Float32Array(a.length);
      for (let k = 0; k < n; k++) b[k] = a[order[k]];
      return b;
    };
    const permF64 = (a: Float64Array) => {
      const b = new Float64Array(a.length);
      for (let k = 0; k < n; k++) b[k] = a[order[k]];
      return b;
    };
    this.x = permF32(this.x);
    this.y = permF32(this.y);
    this.z = permF32(this.z);
    this.heat = permF32(this.heat);
    this.warm = permF32(this.warm);
    this.dist = permF32(this.dist);
    this.demand = permF32(this.demand);
    this.nodeR = permF32(this.nodeR);
    this.pr = permF64(this.pr);
    const parent = new Int32Array(this.nodeCap).fill(-1);
    const parentEdge = new Int32Array(this.nodeCap).fill(-1);
    const owner = new Int32Array(this.nodeCap).fill(-1);
    const deg = new Int32Array(this.nodeCap);
    const fl = new Uint8Array(this.nodeCap);
    for (let k = 0; k < n; k++) {
      const v = order[k];
      parent[k] = this.parent[v] >= 0 ? map[this.parent[v]] : -1;
      parentEdge[k] = this.parentEdge[v] >= 0 ? emap[this.parentEdge[v]] : -1;
      owner[k] = this.owner[v];
      deg[k] = this.deg[v];
      fl[k] = this.nflags[v];
    }
    this.parent = parent;
    this.parentEdge = parentEdge;
    this.owner = owner;
    this.deg = deg;
    this.nflags = fl;
    this.firstChild.fill(-1);
    this.nextSib.fill(-1);
    for (let k = n - 1; k >= 1; k--) this.linkChild(parent[k], k);
    this.mark.fill(0);

    const ea = new Int32Array(this.edgeCap).fill(-1);
    const eb = new Int32Array(this.edgeCap).fill(-1);
    const elen = new Float32Array(this.edgeCap);
    const eD = new Float32Array(this.edgeCap);
    const eQ = new Float32Array(this.edgeCap);
    const eR = new Float32Array(this.edgeCap);
    const ePeak = new Float32Array(this.edgeCap);
    const efl = new Uint8Array(this.edgeCap);
    const eg = new Float64Array(this.edgeCap);
    for (let e = 0; e < this.edgeTop; e++) {
      const k = emap[e];
      if (k < 0) continue;
      ea[k] = map[this.ea[e]];
      eb[k] = map[this.eb[e]];
      elen[k] = this.elen[e];
      eD[k] = this.eD[e];
      eQ[k] = this.eQ[e];
      eR[k] = this.eR[e];
      ePeak[k] = this.ePeak[e];
      efl[k] = this.eflags[e];
      eg[k] = this.eg[e];
    }
    this.ea = ea;
    this.eb = eb;
    this.elen = elen;
    this.eD = eD;
    this.eQ = eQ;
    this.eR = eR;
    this.ePeak = ePeak;
    this.eflags = efl;
    this.eg = eg;

    this.nodeTop = n;
    this.edgeTop = ne;
    this.freeNodes.length = 0;
    this.freeEdges.length = 0;
    for (let k = 0; k < n; k++) order[k] = k;
    this.orderDirty = false;
    this.grid.clear();
    this.coarse.clear();
    for (let k = 0; k < n; k++) if (!(fl[k] & N_TIP)) this.index(k);
    for (const t of this.tips) {
      if (!t.active) continue;
      t.node = map[t.node];
      t.prev = map[t.prev];
    }
    return map;
  }

  /** Fraction of node slots below the high-water mark that are free. */
  get fragmentation(): number {
    return this.nodeTop > 0 ? 1 - this.nodeCount / this.nodeTop : 0;
  }

  // ------------------------------------------------------------ tips
  private takeTip(): Tip {
    const t = this.freeTips.pop() ?? new Tip();
    if (!t.listed) {
      this.tips.push(t);
      t.listed = true;
    }
    t.active = true;
    return t;
  }

  /** Insert a fixed node into both spatial hashes (re-inserting is cheap when it stays in its cell). */
  private index(i: number): void {
    const x = this.x[i];
    const y = this.y[i];
    const z = this.z[i];
    this.grid.insert(i, x, y, z);
    this.coarse.insert(i, x, y, z);
  }

  /** Start a growth tip from physical node `from` toward (tx,ty,tz) for logical target. */
  spawnGrowth(from: number, tx: number, ty: number, tz: number, target: number, owner: number, rng: Rng): Tip {
    const t = this.takeTip();
    const fx = this.x[from];
    const fy = this.y[from];
    const fz = this.z[from];
    t.owner = owner;
    t.node = this.grow(from, fx, fy, fz, this.p.D0, N_TIP, owner);
    t.prev = from;
    t.tx = tx;
    t.ty = ty;
    t.tz = tz;
    t.target = target;
    t.explorer = false;
    t.gen = 0;
    t.travel = 0;
    t.deposits = 0;
    t.fuseCooldown = 3;
    const dx = tx - fx;
    const dy = ty - fy;
    const dz = tz - fz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    t.startDist = Math.max(1, d);
    t.maxTravel = t.startDist * 3 + 50;
    const inv = d > 1e-6 ? 1 / d : 0;
    if (this.p.circuit) {
      this.routeCircuit(t, fx, fy, tx, ty, rng);
      t.startDist = Math.max(1, Math.abs(dx) + Math.abs(dy));
      t.maxTravel = t.startDist * 2 + 60;
      t.hz = 0;
      t.mx = t.my = t.mz = 0;
      this.growthTipCount++;
      return t;
    }
    // leave at an angle (up to 0.7 rad) so sibling veins fan out instead of overlapping
    const dir = this.dir;
    coneDir(inv ? dx * inv : 1, inv ? dy * inv : 0, inv ? dz * inv : 0, rng.next() * 0.7, rng.next() * Math.PI * 2, dir);
    t.hx = dir[0];
    t.hy = dir[1];
    t.hz = dir[2];
    t.mx = t.my = t.mz = 0;
    this.growthTipCount++;
    return t;
  }

  /**
   * Octilinear route from (fx,fy) to (tx,ty): diagonal first, straight first, or straight-diagonal-straight (random).
   * Every leg is along one of the 8 directions, so the bends are 45 or 90 degrees. Sets the tip's heading to the first leg.
   */
  private routeCircuit(t: Tip, fx: number, fy: number, tx: number, ty: number, rng: Rng): void {
    const dx = tx - fx;
    const dy = ty - fy;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const sx = dx < 0 ? -1 : 1;
    const sy = dy < 0 ? -1 : 1;
    const m = Math.min(ax, ay);
    const s = Math.abs(ax - ay);
    const w = t.way;
    let n = 0;
    if (m > 1e-3 && s > 1e-3) {
      const style = rng.next();
      const alongX = ax > ay;
      if (style < 0.34) {
        // diagonal, then straight
        w[n++] = fx + sx * m;
        w[n++] = fy + sy * m;
      } else if (style < 0.67) {
        // straight, then diagonal
        w[n++] = alongX ? fx + sx * s : fx;
        w[n++] = alongX ? fy : fy + sy * s;
      } else {
        // straight, diagonal, straight
        const s1 = s * rng.range(0.25, 0.75);
        const x1 = alongX ? fx + sx * s1 : fx;
        const y1 = alongX ? fy : fy + sy * s1;
        w[n++] = x1;
        w[n++] = y1;
        w[n++] = x1 + sx * m;
        w[n++] = y1 + sy * m;
      }
    }
    w[n++] = tx;
    w[n++] = ty;
    t.nWay = n >> 1;
    t.iWay = 0;
    this.aimCircuit(t, fx, fy);
  }

  /** Point the tip's heading at its current waypoint (exactly octilinear by construction). */
  private aimCircuit(t: Tip, x: number, y: number): void {
    const wx = t.way[t.iWay * 2] - x;
    const wy = t.way[t.iWay * 2 + 1] - y;
    const l = Math.hypot(wx, wy);
    if (l < 1e-6) return;
    t.hx = wx / l;
    t.hy = wy / l;
    t.hz = 0;
  }

  /** Fine exploratory branch along unit heading h: no food target, no flux, withers unless it gets used. */
  spawnExplorer(from: number, hx: number, hy: number, hz: number, gen: number, rng: Rng): void {
    if (this.explorerCount >= this.p.explorerMax) return;
    const t = this.takeTip();
    t.owner = this.owner[from];
    t.node = this.grow(from, this.x[from], this.y[from], this.z[from], this.p.D0 * 0.6, N_TIP, t.owner);
    t.prev = from;
    t.target = -1;
    t.explorer = true;
    t.gen = gen;
    t.travel = 0;
    t.deposits = 0;
    t.fuseCooldown = 4;
    t.maxTravel = rng.range(this.p.explorerLen[0], this.p.explorerLen[1]) / (1 + gen * 0.5);
    t.hx = hx;
    t.hy = hy;
    t.hz = hz;
    if (this.p.circuit) {
      this.dir[0] = hx;
      this.dir[1] = hy;
      snap8(this.dir);
      t.hx = this.dir[0];
      t.hy = this.dir[1];
      t.hz = 0;
    }
    t.mx = t.my = t.mz = 0;
    this.explorerCount++;
  }

  /** Explorer leaving at a polar angle in [a0, a1] (random azimuth) from unit axis b. */
  spawnExplorerCone(from: number, bx: number, by: number, bz: number, a0: number, a1: number, gen: number, rng: Rng): void {
    if (this.explorerCount >= this.p.explorerMax) return;
    const dir = this.dir;
    coneDir(bx, by, bz, rng.range(a0, a1), rng.next() * Math.PI * 2, dir);
    this.spawnExplorer(from, dir[0], dir[1], dir[2], gen, rng);
  }

  private releaseTip(t: Tip): void {
    if (t.explorer) this.explorerCount--;
    else this.growthTipCount--;
    t.active = false;
    t.target = -1;
    this.freeTips.push(t);
  }

  /** Stop a growth tip (target died/moved). Its vein becomes a dead end and withers. */
  cancelTip(t: Tip): void {
    if (!t.active) return;
    this.nflags[t.node] &= ~N_TIP;
    this.index(t.node);
    this.releaseTip(t);
  }

  /**
   * Best node to sprout a new vein toward (tx,ty,tz): the node owned by `owner`
   * (or the anchor itself) closest to the target. Makes files branch off
   * existing veins in their folder's territory instead of all radiating
   * from the folder node.
   */
  nearestOwned(anchor: number, owner: number, tx: number, ty: number, tz: number): number {
    let dx = this.x[anchor] - tx;
    let dy = this.y[anchor] - ty;
    let dz = this.z[anchor] - tz;
    const d0 = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const r = Math.min(d0, 80);
    let best = anchor;
    let bestD2 = d0 * d0 * 0.8;
    const q = this.qBig;
    const cnt = this.coarse.query(tx, ty, tz, r, q);
    for (let k = 0; k < cnt; k++) {
      const m = q[k];
      const f = this.nflags[m];
      if (!(f & N_ALIVE) || f & N_TIP || this.owner[m] !== owner) continue;
      dx = this.x[m] - tx;
      dy = this.y[m] - ty;
      dz = this.z[m] - tz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = m;
      }
    }
    return best;
  }

  setProtected(node: number, on: boolean): void {
    if (node < 0 || !(this.nflags[node] & N_ALIVE)) return;
    if (on) this.nflags[node] |= N_PROTECTED;
    else this.nflags[node] &= ~N_PROTECTED;
  }

  /**
   * Tree path between a and b through their lowest common ancestor, if each
   * side is within maxHops. Fills pathA (a .. below LCA) and pathB likewise.
   * Returns total hops, or -1 if not local.
   */
  private treePath(a: number, b: number, maxHops: number): number {
    const st = ++this.stamp;
    let v = a;
    for (let k = 0; k <= maxHops && v >= 0; k++) {
      this.mark[v] = st;
      this.markHops[v] = k;
      v = this.parent[v];
    }
    v = b;
    let lca = -1;
    let hb = 0;
    for (; hb <= maxHops && v >= 0; hb++) {
      if (this.mark[v] === st) {
        lca = v;
        break;
      }
      v = this.parent[v];
    }
    if (lca < 0) return -1;
    const ha = this.markHops[lca];
    const need = Math.max(ha, hb) + 1;
    if (this.pathA.length < need) {
      let cap = this.pathA.length;
      while (cap < need) cap *= 2;
      this.pathA = new Int32Array(cap);
      this.pathB = new Int32Array(cap);
    }
    this.pathALen = 0;
    for (v = a; v !== lca; v = this.parent[v]) this.pathA[this.pathALen++] = v;
    this.pathBLen = 0;
    for (v = b; v !== lca; v = this.parent[v]) this.pathB[this.pathBLen++] = v;
    return ha + hb;
  }

  private unlinkChild(par: number, c: number): void {
    let k = this.firstChild[par];
    if (k === c) this.firstChild[par] = this.nextSib[c];
    else {
      while (k >= 0 && this.nextSib[k] !== c) k = this.nextSib[k];
      if (k >= 0) this.nextSib[k] = this.nextSib[c];
    }
    this.nextSib[c] = -1;
  }

  private linkChild(par: number, c: number): void {
    this.nextSib[c] = this.firstChild[par];
    this.firstChild[par] = c;
  }

  /**
   * Keep the growth tree close to a maximum-conductance spanning tree: if a
   * loop edge conducts better than the weakest tree edge on its cycle, swap
   * them (re-parenting the chain in between). This keeps the tree
   * preconditioner effective as Tero dynamics shift flow onto loops, and
   * lets the weak side of a cycle be pruned.
   */
  private rebalanceLoops(): void {
    const g = this.eg;
    for (let e = 0; e < this.edgeTop; e++) {
      if (!(this.eflags[e] & E_LOOP)) continue;
      const a = this.ea[e];
      const b = this.eb[e];
      if (this.treePath(a, b, 1 << 20) < 0) continue;
      let weakNode = -1;
      let weakG = Infinity;
      let onA = true;
      for (let k = 0; k < this.pathALen; k++) {
        const v = this.pathA[k];
        const gv = g[this.parentEdge[v]];
        if (gv < weakG && !(this.nflags[v] & N_TIP)) {
          weakG = gv;
          weakNode = v;
          onA = true;
        }
      }
      for (let k = 0; k < this.pathBLen; k++) {
        const v = this.pathB[k];
        const gv = g[this.parentEdge[v]];
        if (gv < weakG && !(this.nflags[v] & N_TIP)) {
          weakG = gv;
          weakNode = v;
          onA = false;
        }
      }
      if (weakNode < 0 || g[e] <= weakG * 1.3) {
        // Not worth swapping. If the cycle is long relative to the loop's
        // conductance (high stretch), dissolve the loop: it would carry little
        // flow anyway, and it is what makes the tree preconditioner slow.
        let R = 0;
        for (let k = 0; k < this.pathALen; k++) R += 1 / g[this.parentEdge[this.pathA[k]]];
        for (let k = 0; k < this.pathBLen; k++) R += 1 / g[this.parentEdge[this.pathB[k]]];
        if (g[e] * R > MAX_LOOP_STRETCH) this.removeEdge(e);
        continue;
      }
      // re-root the chain [start .. weakNode] under the other endpoint via e
      const start = onA ? a : b;
      const other = onA ? b : a;
      let prevNode = other;
      let prevEdge = e;
      let v = start;
      for (;;) {
        const oldParent = this.parent[v];
        const oldEdge = this.parentEdge[v];
        this.unlinkChild(oldParent, v);
        this.parent[v] = prevNode;
        this.parentEdge[v] = prevEdge;
        this.linkChild(prevNode, v);
        this.dist[v] = this.dist[prevNode] + this.elen[prevEdge];
        if (v === weakNode) {
          this.eflags[oldEdge] = (this.eflags[oldEdge] & ~E_TREE) | E_LOOP;
          break;
        }
        prevNode = v;
        prevEdge = oldEdge;
        v = oldParent;
      }
      this.eflags[e] = (this.eflags[e] & ~E_LOOP) | E_TREE;
      this.orderDirty = true;
      this.swaps++;
    }
  }

  /** Try to fuse fixed node n with a nearby vein; returns true if a loop edge was added. */
  private tryFuse(n: number, prob: number, rng: Rng): boolean {
    const r = this.p.fuseDist;
    const nx = this.x[n];
    const ny = this.y[n];
    const nz = this.z[n];
    const cnt = this.grid.query(nx, ny, nz, r, this.q);
    let best = -1;
    let bestD = r * r;
    for (let k = 0; k < cnt; k++) {
      const m = this.q[k];
      if (m === n || !(this.nflags[m] & N_ALIVE) || this.nflags[m] & N_TIP) continue;
      const dx = this.x[m] - nx;
      const dy = this.y[m] - ny;
      const dz = this.z[m] - nz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= bestD) continue;
      const hops = this.treePath(n, m, LOOP_MAX_HOPS);
      if (hops < LOOP_MIN_HOPS) continue; // too trivial, or not local (-1)
      best = m;
      bestD = d2;
    }
    if (best < 0 || rng.next() >= prob) return false;
    const pe = this.parentEdge[n];
    const D = pe >= 0 ? this.eD[pe] * 0.8 : this.p.D0;
    this.addEdge(n, best, D, E_LOOP);
    return true;
  }

  private deposit(t: Tip, rng: Rng): boolean {
    const fixed = t.node;
    this.nflags[fixed] &= ~N_TIP;
    this.index(fixed);
    if (!this.p.circuit) this.smoothCorner(fixed, 0.5);
    t.deposits++;
    let fused = false;
    if (t.fuseCooldown > 0) t.fuseCooldown--;
    else if (this.tryFuse(fixed, t.explorer ? this.p.fuseProbExplorer : this.p.fuseProbGrowth, rng)) {
      fused = true;
      t.fuseCooldown = t.explorer ? 1000 : 8;
    }
    if (t.explorer && fused) {
      this.releaseTip(t);
      return false;
    }
    const pe = this.parentEdge[fixed];
    const D = pe >= 0 ? this.eD[pe] : this.p.D0;
    t.node = this.grow(fixed, this.x[fixed], this.y[fixed], this.z[fixed], D, N_TIP, t.owner);
    t.prev = fixed;
    return true;
  }

  private advanceTips(rng: Rng): void {
    const p = this.p;
    this.arrivedCount = 0;
    // iterate over a snapshot length: tips spawned this tick start moving next tick
    const n = this.tips.length;
    for (let i = 0; i < n; i++) {
      const t = this.tips[i];
      if (!t.active) continue;
      const node = t.node;
      const x = this.x[node];
      const y = this.y[node];
      const z = this.z[node];
      let speed: number;
      let segLen: number;
      let hx = t.hx;
      let hy = t.hy;
      let hz = t.hz;
      if (!t.explorer) {
        const dx = t.tx - x;
        const dy = t.ty - y;
        const dz = t.tz - z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        speed = p.tipSpeed;
        segLen = p.segLen;
        if (p.circuit && t.iWay < t.nWay - 1 && t.travel <= t.maxTravel) {
          // corner of the route: pin the node on it, fix it there (a sharp bend) and turn onto the next leg
          const wx = t.way[t.iWay * 2];
          const wy = t.way[t.iWay * 2 + 1];
          if (Math.hypot(wx - x, wy - y) <= speed * 1.05) {
            this.x[node] = wx;
            this.y[node] = wy;
            const pe0 = this.parentEdge[node];
            this.updateEdgeLen(pe0);
            this.dist[node] = this.dist[t.prev] + this.elen[pe0];
            t.iWay++;
            this.deposit(t, rng);
            this.aimCircuit(t, wx, wy);
            continue;
          }
        }
        if (dist <= speed * 1.05 || t.travel > t.maxTravel) {
          // arrive: snap onto the food / folder site
          this.x[node] = t.tx;
          this.y[node] = t.ty;
          this.z[node] = t.tz;
          this.updateEdgeLen(this.parentEdge[node]);
          this.nflags[node] = (this.nflags[node] & ~N_TIP) | N_PROTECTED;
          this.index(node);
          this.heat[node] = 1;
          if (this.arrivedCount >= this.arrivedTarget.length) {
            const a = new Int32Array(this.arrivedTarget.length * 2);
            a.set(this.arrivedTarget);
            this.arrivedTarget = a;
            const b = new Int32Array(this.arrivedNode.length * 2);
            b.set(this.arrivedNode);
            this.arrivedNode = b;
          }
          this.arrivedTarget[this.arrivedCount] = t.target;
          this.arrivedNode[this.arrivedCount++] = node;
          this.releaseTip(t);
          continue;
        }
        if (p.circuit) {
          // follow the route: head straight at the current waypoint (octilinear by construction), no meander
          this.aimCircuit(t, x, y);
          hx = t.hx;
          hy = t.hy;
          hz = 0;
          if (rng.next() < p.explorerRate) this.spawnExplorerCone(t.prev, hx, hy, hz, 0.45, 1.35, 1, rng);
        } else {
        const inv = 1 / dist;
        const prog = 1 - Math.min(1, dist / t.startDist);
        let steer = 0.05 + 0.35 * prog * prog;
        if (dist < segLen * 2.5) steer = 0.6;
        // smooth 3D meander: slowly drifting turn vector + small jitter
        const w = p.tipWander * 0.5;
        t.mx = t.mx * 0.9 + rng.sym(w);
        t.my = t.my * 0.9 + rng.sym(w);
        t.mz = t.mz * 0.9 + rng.sym(w);
        // rotate the heading toward the target by `steer` of the angle between them
        // (a plain lerp would barely turn a tip that faces away: its rate goes like sin(angle))
        const ux = dx * inv;
        const uy = dy * inv;
        const uz = dz * inv;
        let c = hx * ux + hy * uy + hz * uz;
        if (c > 1) c = 1;
        else if (c < -1) c = -1;
        const ang = Math.acos(c);
        if (ang > 1e-6) {
          let px = ux - hx * c;
          let py = uy - hy * c;
          let pz = uz - hz * c;
          let pl = Math.sqrt(px * px + py * py + pz * pz);
          if (pl < 1e-6) {
            // facing exactly away: turn through any perpendicular
            coneDir(hx, hy, hz, Math.PI / 2, 0, this.dir);
            px = this.dir[0];
            py = this.dir[1];
            pz = this.dir[2];
            pl = 1;
          }
          const a = ang * steer;
          const ca = Math.cos(a);
          const sa = Math.sin(a) / pl;
          hx = hx * ca + px * sa;
          hy = hy * ca + py * sa;
          hz = hz * ca + pz * sa;
        }
        hx += t.mx;
        hy += t.my;
        hz += t.mz;
        const hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
        if (hl < 1e-3) {
          hx = dx * inv;
          hy = dy * inv;
          hz = dz * inv;
        } else {
          hx /= hl;
          hy /= hl;
          hz /= hl;
        }
        t.hx = hx;
        t.hy = hy;
        t.hz = hz;
        // fan of fine exploratory branches behind the leading edge
        if (rng.next() < p.explorerRate) this.spawnExplorerCone(t.prev, hx, hy, hz, 0.45, 1.35, 1, rng);
        }
      } else {
        speed = p.explorerSpeed;
        segLen = p.explorerSegLen;
        if (t.travel >= t.maxTravel) {
          this.nflags[node] &= ~N_TIP;
          this.index(node);
          this.releaseTip(t);
          continue;
        }
        const w = 0.16 * 0.577; // per-axis jitter, same rms turn as the 2D walk
        if (!p.circuit) {
          t.mx = t.mx * 0.75 + rng.sym(w);
          t.my = t.my * 0.75 + rng.sym(w);
          t.mz = t.mz * 0.75 + rng.sym(w);
          hx += t.mx;
          hy += t.my;
          hz += t.mz;
        }
        const hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
        if (p.circuit) {
          hx = t.hx;
          hy = t.hy;
          hz = 0;
        } else if (hl > 1e-3) {
          t.hx = hx /= hl;
          t.hy = hy /= hl;
          t.hz = hz /= hl;
        } else {
          hx = t.hx;
          hy = t.hy;
          hz = t.hz;
        }
        if (t.gen < 3 && rng.next() < p.explorerBranchRate) this.spawnExplorerCone(t.prev, hx, hy, hz, 0.5, 1.2, t.gen + 1, rng);
      }
      const nx = x + hx * speed;
      const ny = y + hy * speed;
      const nz = z + hz * speed;
      this.x[node] = nx;
      this.y[node] = ny;
      this.z[node] = nz;
      t.travel += speed;
      this.heat[node] = 1;
      const pe = this.parentEdge[node];
      this.updateEdgeLen(pe);
      this.dist[node] = this.dist[t.prev] + this.elen[pe];
      if (this.elen[pe] >= segLen && this.deposit(t, rng) && p.circuit && t.explorer && rng.next() < 0.3) {
        // explorers wander by turning 45 degrees at the nodes they fix
        const s = rng.next() < 0.5 ? SQ : -SQ;
        this.dir[0] = t.hx * SQ - t.hy * s;
        this.dir[1] = t.hx * s + t.hy * SQ;
        snap8(this.dir);
        t.hx = this.dir[0];
        t.hy = this.dir[1];
      }
    }
    // compact the active tip list occasionally (no per-tick allocation)
    if (this.tips.length > 64 && this.freeTips.length > this.tips.length / 2) {
      let w = 0;
      for (let i = 0; i < this.tips.length; i++) {
        const t = this.tips[i];
        if (t.active) this.tips[w++] = t;
        else t.listed = false;
      }
      this.tips.length = w;
    }
  }

  private updateEdgeLen(e: number): void {
    if (e < 0) return;
    const a = this.ea[e];
    const b = this.eb[e];
    const dx = this.x[b] - this.x[a];
    const dy = this.y[b] - this.y[a];
    const dz = this.z[b] - this.z[a];
    this.elen[e] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // ------------------------------------------------------------ flux solve
  private rebuildOrder(): void {
    // iterative DFS from root: parents always precede children
    let sp = 0;
    let len = 0;
    this.stack[sp++] = this.root;
    while (sp > 0) {
      const v = this.stack[--sp];
      this.order[len++] = v;
      for (let c = this.firstChild[v]; c >= 0; c = this.nextSib[c]) this.stack[sp++] = c;
    }
    this.orderLen = len;
    this.orderDirty = false;
  }

  /**
   * Series-reduce the network: junctions are the root, tips, food/folder
   * anchors, loop endpoints and every node without exactly one tree child.
   * Each unbranched chain between a junction and its nearest junction
   * ancestor collapses to one conductance 1/sum(1/g). Returns junction count.
   * Junction indices follow DFS pre-order, so parents precede children.
   */
  private buildReduced(): number {
    const order = this.order;
    const n = this.orderLen;
    const par = this.parent;
    const pe = this.parentEdge;
    const g = this.eg;
    const jIdx = this.jIdx;
    const loopDeg = this.loopDeg;
    for (let k = 0; k < n; k++) loopDeg[order[k]] = 0;
    for (let e = 0; e < this.edgeTop; e++) {
      if (this.eflags[e] & E_LOOP) {
        loopDeg[this.ea[e]]++;
        loopDeg[this.eb[e]]++;
      }
    }
    let m = 0;
    for (let k = 0; k < n; k++) {
      const v = order[k];
      const fc = this.firstChild[v];
      const single = fc >= 0 && this.nextSib[fc] < 0;
      if (k === 0 || !single || loopDeg[v] > 0 || this.demand[v] > 0 || this.nflags[v] & (N_TIP | N_PROTECTED)) {
        jIdx[v] = m;
        this.jNode[m++] = v;
      } else jIdx[v] = -1;
    }
    for (let j = 1; j < m; j++) {
      let v = this.jNode[j];
      let R = 0;
      for (;;) {
        R += 1 / g[pe[v]];
        v = par[v];
        if (jIdx[v] >= 0) break;
      }
      this.jPar[j] = jIdx[v];
      this.jC[j] = 1 / R;
    }
    let nl = 0;
    for (let e = 0; e < this.edgeTop; e++) {
      if (!(this.eflags[e] & E_LOOP)) continue;
      this.la[nl] = jIdx[this.ea[e]];
      this.lb[nl] = jIdx[this.eb[e]];
      this.lg[nl++] = g[e];
    }
    this.loopCount = nl;
    return m;
  }

  /** z = M^{-1} r with M the reduced tree Laplacian (root grounded): exact O(m). */
  private treeSolve(r: Float64Array, z: Float64Array, m: number): void {
    const jp = this.jPar;
    const jc = this.jC;
    for (let j = 0; j < m; j++) z[j] = r[j];
    for (let j = m - 1; j >= 1; j--) z[jp[j]] += z[j];
    z[0] = 0;
    for (let j = 1; j < m; j++) z[j] = z[jp[j]] + z[j] / jc[j];
  }

  /** y = A x on the reduced graph (Laplacian + eps, root row removed). */
  private matvec(xv: Float64Array, yv: Float64Array, m: number): void {
    const diag = this.diag;
    const jp = this.jPar;
    const jc = this.jC;
    for (let j = 0; j < m; j++) yv[j] = diag[j] * xv[j];
    for (let j = 1; j < m; j++) {
      const c = jc[j];
      const p = jp[j];
      yv[j] -= c * xv[p];
      yv[p] -= c * xv[j];
    }
    const la = this.la;
    const lb = this.lb;
    const lg = this.lg;
    for (let k = 0; k < this.loopCount; k++) {
      const a = la[k];
      const b = lb[k];
      yv[a] -= lg[k] * xv[b];
      yv[b] -= lg[k] * xv[a];
    }
    yv[0] = 0;
  }

  private solveFlux(): void {
    const p = this.p;
    const eTop = this.edgeTop;
    const eps = 1e-9;
    if (this.orderDirty) this.rebuildOrder();
    for (let e = 0; e < eTop; e++) {
      if (!(this.eflags[e] & E_ALIVE)) {
        this.eg[e] = 0;
        continue;
      }
      const l = this.elen[e] > 0.5 ? this.elen[e] : 0.5;
      this.eg[e] = this.eD[e] / l + 1e-7;
    }
    const m = this.buildReduced();
    const diag = this.diag;
    const rhs = this.rhs;
    const jNode = this.jNode;
    let total = 0;
    for (let j = 0; j < m; j++) {
      const d = this.demand[jNode[j]];
      rhs[j] = -d;
      total += d;
      diag[j] = eps;
    }
    for (let k = 0; k < this.tips.length; k++) {
      const t = this.tips[k];
      if (!t.active || t.explorer) continue;
      rhs[this.jIdx[t.node]] -= p.tipDemand;
      total += p.tipDemand;
    }
    rhs[0] = 0;
    this.totalDemand = total;
    for (let j = 1; j < m; j++) {
      diag[j] += this.jC[j];
      diag[this.jPar[j]] += this.jC[j];
    }
    for (let k = 0; k < this.loopCount; k++) {
      diag[this.la[k]] += this.lg[k];
      diag[this.lb[k]] += this.lg[k];
    }
    diag[0] = 1;

    // PCG on the reduced system, warm-started from last tick's pressures
    const xv = this.jx;
    const r = this.res;
    const z = this.zz;
    const d = this.dd;
    const q = this.qq;
    for (let j = 0; j < m; j++) xv[j] = this.pr[jNode[j]];
    xv[0] = 0;
    this.matvec(xv, q, m);
    let rr0 = 0;
    for (let j = 0; j < m; j++) {
      r[j] = rhs[j] - q[j];
      rr0 += rhs[j] * rhs[j];
    }
    r[0] = 0;
    this.treeSolve(r, z, m);
    let rz = 0;
    for (let j = 0; j < m; j++) {
      d[j] = z[j];
      rz += r[j] * z[j];
    }
    let it = 0;
    const tol = 1e-9 * (rr0 + 1e-12); // ~3e-5 relative residual
    for (; it < p.cgIters; it++) {
      let rr = 0;
      for (let j = 0; j < m; j++) rr += r[j] * r[j];
      if (rr <= tol || rz <= 0) break;
      this.matvec(d, q, m);
      let dq = 0;
      for (let j = 0; j < m; j++) dq += d[j] * q[j];
      if (dq <= 0) break;
      const alpha = rz / dq;
      for (let j = 0; j < m; j++) {
        xv[j] += alpha * d[j];
        r[j] -= alpha * q[j];
      }
      r[0] = 0;
      this.treeSolve(r, z, m);
      let rzNew = 0;
      for (let j = 0; j < m; j++) rzNew += r[j] * z[j];
      const beta = rzNew / rz;
      rz = rzNew;
      for (let j = 0; j < m; j++) d[j] = z[j] + beta * d[j];
    }
    this.lastCgIters = it;
    this.junctions = m;
    let rr = 0;
    for (let j = 0; j < m; j++) rr += r[j] * r[j];
    this.lastResidual = Math.sqrt(rr / (rr0 + 1e-30));

    // expand: junction pressures, then exact interior pressures along each chain
    const pr = this.pr;
    const par = this.parent;
    const pe = this.parentEdge;
    const g = this.eg;
    pr[jNode[0]] = 0;
    for (let j = 1; j < m; j++) {
      const Q = (xv[this.jPar[j]] - xv[j]) * this.jC[j]; // flow from parent junction down the chain
      let v = jNode[j];
      let pv = xv[j];
      pr[v] = pv;
      for (;;) {
        pv += Q / g[pe[v]];
        v = par[v];
        if (this.jIdx[v] >= 0) break;
        pr[v] = pv;
      }
    }
  }

  /**
   * One-time corner smoothing when a node is deposited: its parent moves part
   * way toward the midpoint of its own parent and the new node. Removes the
   * polyline kinks of growth while keeping the low-frequency meander.
   */
  private smoothCorner(v: number, k: number): void {
    const p = this.parent[v];
    if (p < 0) return;
    const fp = this.nflags[p];
    if (fp & (N_TIP | N_PROTECTED) || this.deg[p] !== 2) return;
    const g = this.parent[p];
    if (g < 0) return;
    const mx = (this.x[g] + this.x[v]) * 0.5;
    const my = (this.y[g] + this.y[v]) * 0.5;
    const mz = (this.z[g] + this.z[v]) * 0.5;
    this.x[p] += (mx - this.x[p]) * k;
    this.y[p] += (my - this.y[p]) * k;
    this.z[p] += (mz - this.z[p]) * k;
    this.updateEdgeLen(this.parentEdge[p]);
    this.updateEdgeLen(this.parentEdge[v]);
    this.index(p);
  }

  // ------------------------------------------------------------ main step
  step(rng: Rng): void {
    const p = this.p;
    this.advanceTips(rng);
    const tick = this.tickCount++;
    if ((tick & 3) === 0) this.rebalanceLoops();
    // Large networks re-solve pressures every other tick (D adapts slowly; the
    // previous Q is reused in between). Deterministic: depends only on tick.
    const solveNow = this.junctions < this.p.solveEveryOtherAbove || (tick & 1) === 0;
    if (solveNow) this.solveFlux();
    // flux + adaptation (Tero): dD/dt = a (f(|Q|) - D), f Hill-type saturating
    const qref = p.qrefK * Math.pow(Math.max(this.totalDemand, 1), p.qrefGamma);
    this.qref = qref;
    const invQ = 1 / qref;
    const eTop = this.edgeTop;
    const xv = this.pr;
    const mu = p.mu;
    const rMin = p.rMin;
    const rScale = p.rScale;
    for (let e = 0; e < eTop; e++) {
      if (!(this.eflags[e] & E_ALIVE)) continue;
      let Q = this.eQ[e];
      if (solveNow) {
        Q = this.eg[e] * (xv[this.ea[e]] - xv[this.eb[e]]);
        this.eQ[e] = Q;
      }
      const x = Math.abs(Q) * invQ;
      const s = mu === 2 ? x * x : Math.pow(x, mu);
      const D = this.eD[e] + p.adapt * (s / (1 + s) - this.eD[e]);
      this.eD[e] = D;
      const r = rMin + rScale * Math.sqrt(D);
      this.eR[e] = r;
      const pk = this.ePeak[e] * PEAK_DECAY;
      this.ePeak[e] = r > pk ? r : pk;
    }
    // heat decay (leading-edge glow)
    const hd = p.heatDecay;
    const warm = this.warm;
    for (let i = 0; i < this.nodeTop; i++) {
      if (this.nflags[i] & N_TIP) this.heat[i] = 1;
      else this.heat[i] *= hd;
      warm[i] *= WARM_DECAY_L;
    }
    this.prune();
  }

  private prune(): void {
    const thr = this.p.pruneD;
    for (let e = 0; e < this.edgeTop; e++) {
      const f = this.eflags[e];
      if (!(f & E_ALIVE) || this.eD[e] >= thr) continue;
      if (f & E_LOOP) {
        this.recordGhost(e);
        this.removeEdge(e);
        continue;
      }
      // tree edge: remove only if child is an unprotected, non-tip leaf
      const a = this.ea[e];
      const b = this.eb[e];
      const child = this.parentEdge[b] === e ? b : a;
      if (this.deg[child] === 1 && !(this.nflags[child] & (N_PROTECTED | N_TIP))) {
        this.recordGhost(e);
        this.removeEdge(e);
        this.removeNode(child);
      }
    }
  }

  /** Remember a pruned vein for the afterglow (thin explorer threads leave none). */
  private recordGhost(e: number): void {
    const r = this.ePeak[e];
    if (r < GHOST_MIN_R) return;
    const g = this.ghostHead;
    this.ghostHead = (g + 1) % GHOST_CAP;
    const a = this.ea[e];
    const b = this.eb[e];
    const o = g * 6;
    const gp = this.ghostPos;
    gp[o] = this.x[a];
    gp[o + 1] = this.y[a];
    gp[o + 2] = this.z[a];
    gp[o + 3] = this.x[b];
    gp[o + 4] = this.y[b];
    gp[o + 5] = this.z[b];
    this.ghostR[g] = r;
    this.ghostTick[g] = this.tickCount;
  }

  /** Network ticks stepped so far (the clock of `ghostTick`). */
  get ticks(): number {
    return this.tickCount;
  }

  radiusOf(D: number): number {
    return this.p.rMin + this.p.rScale * Math.sqrt(D > 0 ? D : 0);
  }
}

