// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent } from '../model/events';
import { FileTree, NodeKind, type TreeOp } from '../model/tree';
import { Rng, authorHue } from '../model/rng';
import { CIRCUIT_LAYOUT, Layout } from './layout';
import { CIRCUIT_NETWORK, E_ALIVE, N_ALIVE, N_TIP, Network, type NetworkParams, type Tip } from './network';
import { CHUNK_FILES, applyTicks, extendSchedule, minGapTicks, type Pacing } from './schedule';
import { ANCHOR_STRIDE, BURST_STRIDE, FOOD_STRIDE, H, HEADER, PULSE_STRIDE, SEG_R_MAX, SEG_STRIDE, frameViews } from './frame';
import { BURSTS, FLOOD_SPEED, FLOOD_WAKE, GHOST_ALPHA, GHOST_LIFE, burstEnergy } from './activity';
import { GHOST_CAP } from './network';

/**
 * Simulation = commit timeline + logical tree + physical network + pulses.
 * Pure TypeScript, no DOM: runs in the worker and in unit tests.
 *
 * Time is measured in fixed ticks. Commit i is applied at tick i*ticksPerCommit,
 * so state(tick) depends only on (commits, seed, params): playback speed and
 * seeking only change how many ticks are run per wall-clock frame.
 */
export interface SimOptions {
  seed: number;
  ticksPerCommit: number;
  /** `even`: commit i lands at i * ticksPerCommit. `dates`: gaps follow the real commit dates, compressed (see schedule.ts). */
  pacing: Pacing;
  maxPulsesPerCommit: number;
  baselineDemand: number;
  /** Compact network memory every 240 ticks once it has this many nodes. */
  compactMinNodes: number;
  /** Ambient explorer spawns per reached file per tick. */
  ambientForaging: number;
  network: Partial<NetworkParams>;
  /** Circuit board mode: flat, grid-snapped pads, traces routed at 45/90 degrees (see network.ts `circuit`). */
  circuit: boolean;
}

export const DEFAULT_SIM_OPTIONS: SimOptions = {
  seed: 1,
  ticksPerCommit: 45,
  pacing: 'even',
  maxPulsesPerCommit: 40,
  baselineDemand: 0.05,
  ambientForaging: 0.004,
  compactMinNodes: 4000,
  network: {},
  circuit: false,
};

/** Arrival glint of a food the vein tip just reached: lifetime in ticks, grow-in ticks, extra glow (nutrient units). */
const ARRIVE_LIFE = 40;
const ARRIVE_GROW = 8;
const ARRIVE_GLOW = 1.5;

const UNREACHED = 0;
const QUEUED = 1;
const GROWING = 2;
const REACHED = 3;

class Pulse {
  active = false;
  path = new Int32Array(64);
  len = 0;
  seg = 0;
  along = 0; // distance along current segment
  speed = 3;
  delay = 0;
  hue = 0;
  target = -1; // logical id
  dirX = 0;
  dirY = 0;
  dirZ = 0;
  px = 0;
  py = 0;
  pz = 0;
  fadeOut = 0;
  listed = false;
}

export class Simulation {
  readonly opts: SimOptions;
  readonly tree = new FileTree();
  readonly net: Network;
  readonly layout: Layout;
  readonly rng: Rng;
  tick = 0;
  nextCommit = 0;
  private ops: TreeOp[] = [];
  // logical state, indexed by tree node id
  private state: number[] = [REACHED];
  private phys: number[] = [];
  private tipOf: (Tip | null)[] = [null];
  private waiting: number[][] = [[]];
  private nutrient: number[] = [0];
  private engulf: number[] = [1];
  private fade: number[] = [1];
  private fx: number[] = [0];
  private fy: number[] = [0];
  private fz: number[] = [0];
  private pendingHue: number[] = [-1];
  /**
   * Tick at which the vein first reached each node (-1 = not now). Visual only, never read by the growth or flux code:
   * the frame packer draws a file's food only once this is set (an unreached file is invisible), and uses the age
   * for the arrival glint. Reset when a file is renamed away; kept for deleted files so a food that was seen fades out.
   */
  private arrivedAt: number[] = [-1];
  private foodIds: number[] = [];
  private dirIds: number[] = [];
  private pulses: Pulse[] = [];
  private freePulses: Pulse[] = [];
  private rootGlow = 0;
  /** Ring of the last BURSTS commit bursts (visual only, see sim/activity.ts): landing tick, energy, author hue. */
  private burstTick = new Float64Array(BURSTS);
  private burstE = new Float64Array(BURSTS);
  private burstHue = new Float64Array(BURSTS);
  private burstHead = 0;
  private touchedScratch: number[] = [];
  /** Landing tick of each commit (append-only, derived from `commits`; shared by snapshots). */
  readonly sched: number[] = [];
  private times: number[] = [];
  /**
   * True while more commits may still be appended. The clock then never passes `horizon`, which keeps the state at a
   * given tick independent of when commits arrived (see `horizon`).
   */
  streaming = false;

  constructor(readonly commits: CommitEvent[], opts: Partial<SimOptions> = {}) {
    this.opts = { ...DEFAULT_SIM_OPTIONS, ...opts };
    this.rng = new Rng(this.opts.seed);
    this.net = new Network(this.opts.circuit ? { ...CIRCUIT_NETWORK, ...this.opts.network, circuit: true } : this.opts.network);
    this.layout = new Layout(this.opts.seed, this.opts.circuit ? CIRCUIT_LAYOUT : undefined);
    this.phys.push(this.net.root);
  }

  /** Append commits (oldest first). Safe at any time: the state at a tick never depends on when they arrived. */
  append(more: readonly CommitEvent[]): void {
    for (const c of more) this.commits.push(c);
    this.syncSchedule();
  }

  /** Extend the schedule to the commits array (call after something else pushed to it). */
  syncSchedule(): void {
    if (this.sched.length < this.commits.length) {
      extendSchedule(this.commits, this.sched, this.times, this.opts.pacing, this.opts.ticksPerCommit);
    }
  }

  /** Tick at which commit `i` lands; `landing(n)` is the end of the last commit's slot. */
  landing(i: number): number {
    this.syncSchedule();
    const n = this.commits.length;
    if (n === 0) return 0;
    return i < n ? this.sched[i] : this.sched[n - 1] + Math.max(applyTicks(this.commits[n - 1]), this.opts.ticksPerCommit);
  }

  get totalTicks(): number {
    return this.landing(this.commits.length);
  }

  /**
   * First tick the clock must not enter while streaming: a commit appended later could land as early as
   * `sched[n-1] + minGap`. Infinity once the history is complete.
   */
  get horizon(): number {
    if (!this.streaming) return Infinity;
    this.syncSchedule();
    const n = this.commits.length;
    if (n === 0) return 0;
    return this.sched[n - 1] + Math.max(applyTicks(this.commits[n - 1]), minGapTicks(this.opts.pacing, this.opts.ticksPerCommit));
  }

  /** Tick of the settled state of commit `c`: just before commit `c + 1` lands (capped by the horizon while streaming). */
  settledTick(c: number): number {
    return Math.min(this.landing(c + 1) - 1, this.horizon - 1);
  }

  /** Index of the last applied commit (-1 if none). */
  get commitIndex(): number {
    return this.nextCommit - 1;
  }

  private ensureLogical(id: number): void {
    while (this.state.length <= id) {
      this.state.push(UNREACHED);
      this.phys.push(-1);
      this.tipOf.push(null);
      this.waiting.push([]);
      this.nutrient.push(0);
      this.engulf.push(0);
      this.fade.push(0);
      this.fx.push(0);
      this.fy.push(0);
      this.fz.push(0);
      this.pendingHue.push(-1);
      this.arrivedAt.push(-1);
    }
  }

  static authorHue(author: string): number {
    return authorHue(author);
  }

  // ------------------------------------------------------------ commits
  /** Index of a commit whose files are still being applied over several ticks (-1 = none), and how many are done. */
  private partial = -1;
  private partialAt = 0;

  private startCommit(index: number): void {
    this.recordBurst(index);
    this.touchedScratch.length = 0;
    this.partialAt = 0;
    this.partial = index;
    this.continueCommit();
  }

  /** Apply the next slice (at most CHUNK_FILES files) of the commit in progress; finish it with the author pulses. */
  private continueCommit(): void {
    const index = this.partial;
    const c = this.commits[index];
    const from = this.partialAt;
    const to = Math.min(c.files.length, from + CHUNK_FILES);
    const ops = this.ops;
    ops.length = 0;
    // the tree walks files strictly in order, so applying slices equals applying the whole commit
    this.tree.applyCommit(from === 0 && to === c.files.length ? c : { ...c, files: c.files.slice(from, to) }, ops);
    const touched = this.touchedScratch;
    for (const op of ops) {
      switch (op.op) {
        case 'add': {
          this.ensureLogical(op.id);
          const n = this.tree.get(op.id);
          this.layout.place(op.id, op.parent, op.kind, n.depth, n.path);
          this.fx[op.id] = this.layout.x[op.id];
          this.fy[op.id] = this.layout.y[op.id];
          this.fz[op.id] = this.layout.z[op.id];
          if (op.kind === NodeKind.File) this.foodIds.push(op.id);
          else this.dirIds.push(op.id);
          break;
        }
        case 'touch':
          this.nutrient[op.id] += 1 + 0.3 * Math.log1p(op.weight);
          this.requestReach(op.id);
          touched.push(op.id);
          break;
        case 'remove':
          this.kill(op.id);
          break;
        case 'move':
          this.move(op.id, op.fromParent, op.toParent);
          break;
      }
    }
    this.partialAt = to;
    if (to < c.files.length) return;
    this.partial = -1;
    // author pulses: travel from the inoculum along the veins to touched files
    const hue = Simulation.authorHue(c.author);
    const n = Math.min(touched.length, this.opts.maxPulsesPerCommit);
    for (let k = 0; k < n; k++) {
      const id = touched[Math.floor((k * touched.length) / n)];
      if (!this.tree.get(id).alive) continue;
      if (this.state[id] === REACHED) this.spawnPulse(id, hue, this.rng.int(18));
      else this.pendingHue[id] = hue;
    }
    this.rootGlow = 1;
  }

  /** A commit lands: start its flood burst (energy by commit size, see `burstEnergy`). */
  private recordBurst(index: number): void {
    const c = this.commits[index];
    const e = burstEnergy(c.files.length);
    if (e <= 0) return;
    const k = this.burstHead;
    this.burstHead = (k + 1) % BURSTS;
    this.burstTick[k] = this.tick;
    this.burstE[k] = e;
    this.burstHue[k] = Simulation.authorHue(c.author);
  }

  private requestReach(id: number): void {
    const node = this.tree.get(id);
    if (!node.alive || this.state[id] !== UNREACHED) return;
    const par = node.parent;
    if (this.state[par] === REACHED) this.startGrowth(id);
    else {
      this.state[id] = QUEUED;
      this.waiting[par].push(id);
      this.requestReach(par);
    }
  }

  private startGrowth(id: number): void {
    const par = this.tree.get(id).parent;
    const tx = this.layout.x[id];
    const ty = this.layout.y[id];
    const tz = this.layout.z[id];
    const from = this.net.nearestOwned(this.phys[par], par, tx, ty, tz);
    this.tipOf[id] = this.net.spawnGrowth(from, tx, ty, tz, id, par, this.rng);
    this.state[id] = GROWING;
  }

  private onArrive(id: number, node: number): void {
    if (this.state[id] !== GROWING || !this.tree.get(id).alive) {
      this.net.setProtected(node, false);
      return;
    }
    this.state[id] = REACHED;
    this.arrivedAt[id] = this.tick;
    this.phys[id] = node;
    this.tipOf[id] = null;
    const w = this.waiting[id];
    for (let k = 0; k < w.length; k++) {
      const c = w[k];
      const cn = this.tree.get(c);
      if (cn.alive && cn.parent === id && this.state[c] === QUEUED) this.startGrowth(c);
    }
    w.length = 0;
    if (this.pendingHue[id] >= 0) {
      this.spawnPulse(id, this.pendingHue[id], 0);
      this.pendingHue[id] = -1;
    }
  }

  private detachPhysical(id: number): void {
    if (this.state[id] === REACHED) {
      const p = this.phys[id];
      this.net.setProtected(p, false);
      this.net.demand[p] = 0;
    } else if (this.state[id] === GROWING && this.tipOf[id]) {
      this.net.cancelTip(this.tipOf[id]!);
    }
    this.tipOf[id] = null;
    this.phys[id] = -1;
    this.state[id] = UNREACHED;
  }

  private kill(id: number): void {
    this.detachPhysical(id);
    this.layout.release(id);
    this.pendingHue[id] = -1;
  }

  private move(id: number, from: number, to: number): void {
    if (from === to) return;
    this.detachPhysical(id);
    this.layout.release(id);
    const n = this.tree.get(id);
    this.layout.place(id, to, NodeKind.File, n.depth, n.path);
    // fx/fy/fz keep the old position: the food glides to its new site
    this.arrivedAt[id] = -1; // ...but it is not drawn until the new vein gets there (no spoiling the new site)
  }

  // ------------------------------------------------------------ pulses
  private spawnPulse(id: number, hue: number, delay: number): void {
    const target = this.phys[id];
    if (target < 0) return;
    // count chain length
    let len = 0;
    for (let v = target; v >= 0; v = this.net.parent[v]) len++;
    if (len < 2) return;
    const p = this.freePulses.pop() ?? new Pulse();
    if (!p.listed) {
      this.pulses.push(p);
      p.listed = true;
    }
    if (p.path.length < len) p.path = new Int32Array(len * 2);
    let k = len - 1;
    for (let v = target; v >= 0; v = this.net.parent[v]) p.path[k--] = v;
    p.active = true;
    p.len = len;
    p.seg = 0;
    p.along = 0;
    p.delay = delay;
    p.hue = hue;
    p.target = id;
    p.fadeOut = 1;
    const total = this.net.dist[target];
    p.speed = Math.max(2.6, total / 70);
    p.px = this.net.x[p.path[0]];
    p.py = this.net.y[p.path[0]];
    p.pz = this.net.z[p.path[0]];
  }

  private updatePulses(): void {
    const net = this.net;
    for (let i = 0; i < this.pulses.length; i++) {
      const p = this.pulses[i];
      if (!p.active) continue;
      if (p.delay > 0) {
        p.delay--;
        continue;
      }
      if (this.state[p.target] !== REACHED) {
        this.releasePulse(p);
        continue;
      }
      let move = p.speed;
      while (move > 0 && p.seg < p.len - 1) {
        const a = p.path[p.seg];
        const b = p.path[p.seg + 1];
        if (!(net.nflags[a] & N_ALIVE) || !(net.nflags[b] & N_ALIVE)) {
          p.seg = p.len;
          break;
        }
        const dx = net.x[b] - net.x[a];
        const dy = net.y[b] - net.y[a];
        const dz = net.z[b] - net.z[a];
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (p.along + move < l) {
          p.along += move;
          move = 0;
          const t = p.along / l;
          p.px = net.x[a] + dx * t;
          p.py = net.y[a] + dy * t;
          p.pz = net.z[a] + dz * t;
          p.dirX = dx / l;
          p.dirY = dy / l;
          p.dirZ = dz / l;
        } else {
          move -= l - p.along;
          p.along = 0;
          p.seg++;
          net.warm[b] = 1; // the pulse leaves a warm trail
          p.px = net.x[b];
          p.py = net.y[b];
          p.pz = net.z[b];
        }
      }
      if (p.seg >= p.len - 1) {
        // arrived: the food flares up, the pulse fades
        if (p.fadeOut === 1) {
          const v = this.phys[p.target];
          if (v >= 0) net.heat[v] = 1;
        }
        p.fadeOut -= 0.12;
        if (p.fadeOut <= 0) this.releasePulse(p);
      }
    }
  }

  private releasePulse(p: Pulse): void {
    p.active = false;
    this.freePulses.push(p);
    // compact when many are free
    if (this.freePulses.length > 64 && this.freePulses.length > this.pulses.length / 2) {
      let w = 0;
      for (let i = 0; i < this.pulses.length; i++) {
        const q = this.pulses[i];
        if (q.active) this.pulses[w++] = q;
        else q.listed = false;
      }
      this.pulses.length = w;
    }
  }

  // ------------------------------------------------------------ step
  step(): void {
    if (this.sched.length < this.commits.length) this.syncSchedule();
    if (this.partial >= 0) this.continueCommit();
    while (this.partial < 0 && this.nextCommit < this.commits.length && this.tick >= this.sched[this.nextCommit]) {
      this.startCommit(this.nextCommit++);
    }
    const net = this.net;
    const base = this.opts.baselineDemand;
    const ids = this.foodIds;
    let w = 0;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      const alive = this.tree.get(id).alive;
      this.nutrient[id] *= 0.986;
      if (alive) {
        this.fade[id] = Math.min(1, this.fade[id] + 0.04);
        if (this.state[id] === REACHED) {
          const v = this.phys[id];
          const nu = this.nutrient[id];
          net.demand[v] = base + nu;
          this.engulf[id] = Math.min(1, this.engulf[id] + 0.03);
          // foraging fringe: well-fed food keeps sending out fine exploratory threads
          if (nu > 0.25 && this.rng.next() < 0.03 * Math.min(nu, 2)) {
            const L = this.layout;
            net.spawnExplorerCone(v, L.dx[id], L.dy[id], L.dz[id], 0, 1.4, 1, this.rng);
          }
        } else this.engulf[id] = Math.max(0, this.engulf[id] - 0.02);
      } else {
        this.fade[id] -= 1 / 120;
        this.engulf[id] = Math.max(0, this.engulf[id] - 0.01);
      }
      this.fx[id] += (this.layout.x[id] - this.fx[id]) * 0.05;
      this.fy[id] += (this.layout.y[id] - this.fy[id]) * 0.05;
      this.fz[id] += (this.layout.z[id] - this.fz[id]) * 0.05;
      if (alive || this.fade[id] > 0) ids[w++] = id;
    }
    ids.length = w;
    // periodic memory compaction (deterministic schedule)
    if (this.tick % 240 === 120 && net.nodeCount > this.opts.compactMinNodes) this.compactNetwork();
    // ambient foraging: a few fine threads keep probing outward from random food,
    // so the settled network keeps a living fringe
    const reached = this.reachedFood(ids);
    if (reached > 0) {
      let budget = reached * this.opts.ambientForaging;
      while (budget > 0) {
        if (this.rng.next() < budget) {
          const id = ids[this.rng.int(ids.length)];
          if (this.state[id] === REACHED) {
            const L = this.layout;
            net.spawnExplorerCone(this.phys[id], L.dx[id], L.dy[id], L.dz[id], 0, 1.6, 1, this.rng);
          }
        }
        budget -= 1;
      }
    }
    net.step(this.rng);
    for (let k = 0; k < net.arrivedCount; k++) this.onArrive(net.arrivedTarget[k], net.arrivedNode[k]);
    this.updatePulses();
    this.rootGlow *= 0.97;
    this.tick++;
  }

  private reachedCount = 0;
  private reachedFood(ids: number[]): number {
    // recount cheaply every 30 ticks (only used to scale ambient foraging)
    if (this.tick % 30 === 0) {
      let n = 0;
      for (let k = 0; k < ids.length; k++) if (this.state[ids[k]] === REACHED) n++;
      this.reachedCount = n;
    }
    return this.reachedCount;
  }

  compactions = 0;
  private compactNetwork(): void {
    this.compactions++;
    const map = this.net.compact();
    const phys = this.phys;
    for (let id = 0; id < phys.length; id++) if (phys[id] >= 0) phys[id] = map[phys[id]];
    for (const p of this.pulses) {
      if (!p.active) continue;
      for (let k = 0; k < p.len; k++) {
        const v = p.path[k];
        p.path[k] = v >= 0 && v < map.length ? map[v] : -1;
        if (p.path[k] < 0) p.active = false;
      }
      if (!p.active) this.freePulses.push(p);
    }
  }

  /** Upper bound of floats needed by pack(). */
  packCapacity(): number {
    return HEADER + (this.net.edgeCount + GHOST_CAP) * SEG_STRIDE + (this.foodIds.length + 1) * FOOD_STRIDE + this.pulses.length * PULSE_STRIDE +
      (this.foodIds.length + this.dirIds.length) * ANCHOR_STRIDE;
  }

  /** Write the render frame into `out` (must have packCapacity() floats). */
  pack(out: Float32Array): void {
    const net = this.net;
    const p = net.p;
    const nTop = net.nodeTop;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    const { u16, u8 } = frameViews(out);
    // Hoist typed arrays and imported constants into locals: imported bindings
    // can compile to property loads (e.g. under vite-node), which is ~10x slower.
    const ALIVE = N_ALIVE;
    const EALIVE = E_ALIVE;
    const TIP = N_TIP;
    const STRIDE = SEG_STRIDE;
    const nodeR = net.nodeR;
    const nflags = net.nflags;
    const nx = net.x;
    const ny = net.y;
    const nz = net.z;
    const heat = net.heat;
    const dist = net.dist;
    const eflags = net.eflags;
    const ea = net.ea;
    const eb = net.eb;
    const eD = net.eD;
    const eR = net.eR;
    const eQ = net.eQ;
    for (let i = 0; i < nTop; i++) {
      nodeR[i] = 0;
      if (!(nflags[i] & ALIVE)) continue;
      const x = nx[i];
      const y = ny[i];
      const z = nz[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const eTop = net.edgeTop;
    for (let e = 0; e < eTop; e++) {
      if (!(eflags[e] & EALIVE)) continue;
      const r = eR[e];
      const a = ea[e];
      const b = eb[e];
      if (r > nodeR[a]) nodeR[a] = r;
      if (r > nodeR[b]) nodeR[b] = r;
    }
    // segments
    let o = HEADER;
    let segs = 0;
    const pruneD = p.pruneD;
    const invFade = 1 / 0.04;
    const rq = 65535 / SEG_R_MAX;
    // growth distance quantization range: a power of two, so it changes rarely
    let maxDist = 0;
    for (let i = 0; i < nTop; i++) if (nflags[i] & ALIVE && dist[i] > maxDist) maxDist = dist[i];
    let distMax = 256;
    while (distMax < maxDist) distMax *= 2;
    const dq = 65535 / distMax;
    const warm = net.warm;
    for (let e = 0; e < eTop; e++) {
      if (!(eflags[e] & EALIVE)) continue;
      const a = ea[e];
      const b = eb[e];
      const re = eR[e];
      const fa = nflags[a];
      const fb = nflags[b];
      let ra = nodeR[a] * 0.55;
      if (ra > re * 2.2) ra = re * 2.2;
      if (ra < re) ra = re;
      let rb = nodeR[b] * 0.55;
      if (rb > re * 2.2) rb = re * 2.2;
      if (rb < re) rb = re;
      if (fb & TIP) rb = re * 0.75;
      if (fa & TIP) ra = re * 0.75;
      // tubes without flux (explorers, withering) fade as they lose conductance
      let alpha = 1;
      const q = eQ[e];
      if (q < 1e-4 && q > -1e-4 && !(fb & TIP)) {
        let t = (eD[e] - pruneD) * invFade;
        if (t > 1) t = 1;
        else if (t < 0) t = 0;
        alpha = t * 0.8 + 0.2;
      }
      const ha = heat[a];
      const hb = heat[b];
      let emit = ha > hb ? ha : hb;
      if (emit > 1) emit = 1;
      const wa = warm[a];
      const wb = warm[b];
      let wm = wa > wb ? wa : wb;
      if (wm > 1) wm = 1;
      out[o] = nx[a];
      out[o + 1] = ny[a];
      out[o + 2] = nz[a];
      out[o + 3] = nx[b];
      out[o + 4] = ny[b];
      out[o + 5] = nz[b];
      const h6 = (o + 6) * 2;
      const qa = ra * rq + 0.5;
      const qb = rb * rq + 0.5;
      u16[h6] = qa > 65535 ? 65535 : qa;
      u16[h6 + 1] = qb > 65535 ? 65535 : qb;
      const b7 = (o + 7) * 4;
      u8[b7] = alpha * 255 + 0.5;
      // heat (high nibble) | warmth (low nibble), see activity.ts packEmit
      u8[b7 + 1] = (((emit * 15 + 0.5) | 0) << 4) | ((wm * 15 + 0.5) | 0);
      const dq16 = dist[a] * dq + 0.5;
      u16[h6 + 3] = dq16 > 65535 ? 65535 : dq16;
      o += STRIDE;
      segs++;
    }
    // afterglow: fading ghosts of recently pruned veins, at the end of the segment section
    let ghosts = 0;
    {
      const gp = net.ghostPos;
      const gR = net.ghostR;
      const gT = net.ghostTick;
      const now = net.ticks;
      const life = GHOST_LIFE;
      const ga = GHOST_ALPHA * 255;
      for (let g = 0; g < GHOST_CAP; g++) {
        const age = now - gT[g];
        if (age < 0 || age >= life) continue;
        const k = 1 - age / life;
        const a8 = ga * k * k;
        if (a8 < 1) continue;
        const go = g * 6;
        for (let j = 0; j < 6; j++) out[o + j] = gp[go + j];
        for (let j = 0; j < 6; j += 3) {
          const x = gp[go + j];
          const y = gp[go + j + 1];
          const z = gp[go + j + 2];
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
        // the slime trail spreads a little as it fades
        let qr = gR[g] * (0.85 + 0.6 * (1 - k)) * rq + 0.5;
        if (qr > 65535) qr = 65535;
        const h6 = (o + 6) * 2;
        u16[h6] = qr;
        u16[h6 + 1] = qr;
        const b7 = (o + 7) * 4;
        u8[b7] = a8;
        u8[b7 + 1] = 0;
        u16[h6 + 3] = 0;
        o += STRIDE;
        segs++;
        ghosts++;
      }
    }
    // food (oat flakes, reached files only) + inoculum
    let food = 0;
    out[o] = 0;
    out[o + 1] = 0;
    out[o + 2] = 0;
    out[o + 3] = 3.4;
    out[o + 4] = this.rootGlow;
    out[o + 5] = 1;
    out[o + 6] = 1;
    out[o + 7] = 0.5 + 2;
    o += FOOD_STRIDE;
    food++;
    // Only files the mold has reached are drawn (and counted in the bounding box): an unreached file is invisible, so
    // neither the dots nor the camera fit may reveal where it will be. Arrival glint = a short pop (see ARRIVE_LIFE).
    const nowTick = this.tick;
    for (let k = 0; k < this.foodIds.length; k++) {
      const id = this.foodIds[k];
      const at = this.arrivedAt[id];
      if (at < 0) continue;
      const x = this.fx[id];
      const y = this.fy[id];
      const z = this.fz[id];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      const nu = this.nutrient[id];
      const age = nowTick - at;
      let g = 1 - age / ARRIVE_LIFE;
      g = g > 0 ? g * g : 0;
      let appear = (age + 1) / ARRIVE_GROW;
      if (appear > 1) appear = 1;
      const fd = Math.max(0, this.fade[id]);
      out[o] = x;
      out[o + 1] = y;
      out[o + 2] = z;
      out[o + 3] = (1.1 + Math.min(1.2, nu * 0.35)) * (1 + 0.5 * g);
      out[o + 4] = nu + ARRIVE_GLOW * g;
      out[o + 5] = this.engulf[id];
      out[o + 6] = fd < appear ? fd : appear;
      out[o + 7] = (id * 0.6180339887) % 1;
      o += FOOD_STRIDE;
      food++;
    }
    // pulses
    let pulses = 0;
    for (let i = 0; i < this.pulses.length; i++) {
      const pu = this.pulses[i];
      if (!pu.active || pu.delay > 0) continue;
      out[o] = pu.px;
      out[o + 1] = pu.py;
      out[o + 2] = pu.pz;
      out[o + 3] = pu.fadeOut;
      out[o + 4] = pu.dirX;
      out[o + 5] = pu.dirY;
      out[o + 6] = pu.dirZ;
      out[o + 7] = pu.hue;
      o += PULSE_STRIDE;
      pulses++;
    }
    // anchors: live files + folders with their ids, for the label layer / hover picking
    let anchors = 0;
    const tree = this.tree;
    for (let k = 0; k < this.foodIds.length; k++) {
      const id = this.foodIds[k];
      if (!tree.get(id).alive) continue;
      out[o] = id;
      out[o + 1] = this.fx[id];
      out[o + 2] = this.fy[id];
      out[o + 3] = this.fz[id];
      out[o + 4] = this.state[id] === REACHED ? 1 : 0;
      o += ANCHOR_STRIDE;
      anchors++;
    }
    {
      const dirs = this.dirIds;
      let w = 0;
      for (let k = 0; k < dirs.length; k++) {
        const id = dirs[k];
        if (!tree.get(id).alive) continue;
        dirs[w++] = id;
        out[o] = id;
        out[o + 1] = this.layout.x[id];
        out[o + 2] = this.layout.y[id];
        out[o + 3] = this.layout.z[id];
        out[o + 4] = this.state[id] === REACHED ? 1 : 0;
        o += ANCHOR_STRIDE;
        anchors++;
      }
      dirs.length = w;
    }
    if (minX > maxX) {
      minX = minY = minZ = -50;
      maxX = maxY = maxZ = 50;
    }
    out[H.tick] = this.tick;
    out[H.commit] = this.commitIndex;
    out[H.segs] = segs;
    out[H.food] = food;
    out[H.pulses] = pulses;
    out[H.anchors] = anchors;
    out[H.minX] = minX;
    out[H.minY] = minY;
    out[H.maxX] = maxX;
    out[H.maxY] = maxY;
    out[H.minZ] = minZ;
    out[H.maxZ] = maxZ;
    out[H.nodes] = net.nodeCount;
    out[H.edges] = net.edgeCount;
    out[H.totalCommits] = this.commits.length;
    out[H.growthTips] = net.growthTipCount;
    out[H.explorers] = net.explorerCount;
    out[H.cgIters] = net.lastCgIters;
    out[H.ticksPerCommit] = this.opts.ticksPerCommit;
    out[H.liveFiles] = this.tree.liveFileCount;
    out[H.distMax] = distMax;
    out[H.reach] = maxDist;
    out[H.ghosts] = ghosts;
    this.packActivity(out, maxDist);
  }

  /** Header activity signals: hot-spot of growth tips + travelling pulses, overall activity, recent bursts. */
  private packActivity(out: Float32Array, reach: number): void {
    const net = this.net;
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let sq = 0;
    const tips = net.tips;
    const nx = net.x;
    const ny = net.y;
    const nz = net.z;
    // pass 0: weighted centroid; pass 1: spread around it (no closures: pack runs every frame)
    for (let pass = 0; pass < 2; pass++) {
      const cx = sw > 0 ? sx / sw : 0;
      const cy = sw > 0 ? sy / sw : 0;
      const cz = sw > 0 ? sz / sw : 0;
      const n = tips.length + this.pulses.length;
      for (let i = 0; i < n; i++) {
        let x: number;
        let y: number;
        let z: number;
        let w: number;
        if (i < tips.length) {
          const t = tips[i];
          if (!t.active || t.node < 0) continue;
          x = nx[t.node];
          y = ny[t.node];
          z = nz[t.node];
          w = t.explorer ? 0.08 : 1;
        } else {
          const pu = this.pulses[i - tips.length];
          if (!pu.active || pu.delay > 0) continue;
          x = pu.px;
          y = pu.py;
          z = pu.pz;
          w = 0.6 * pu.fadeOut;
        }
        if (pass === 0) {
          sw += w;
          sx += w * x;
          sy += w * y;
          sz += w * z;
        } else sq += w * ((x - cx) * (x - cx) + (y - cy) * (y - cy) + (z - cz) * (z - cz));
      }
    }
    out[H.hotX] = sw > 0 ? sx / sw : 0;
    out[H.hotY] = sw > 0 ? sy / sw : 0;
    out[H.hotZ] = sw > 0 ? sz / sw : 0;
    out[H.hotW] = sw;
    out[H.hotR] = sw > 0 ? Math.sqrt(sq / sw) : 0;
    let act = 1 - Math.exp(-sw / 24);
    const span = Math.max(reach, 60) + 2 * FLOOD_WAKE;
    for (let k = 0; k < BURSTS; k++) {
      // newest first
      const j = (this.burstHead - 1 - k + 2 * BURSTS) % BURSTS;
      const o = H.bursts + k * BURST_STRIDE;
      out[o] = this.burstTick[j];
      out[o + 1] = this.burstE[j];
      out[o + 2] = this.burstHue[j];
      const left = 1 - ((this.tick - this.burstTick[j]) * FLOOD_SPEED) / span;
      if (this.burstE[j] > 0 && left > 0 && left <= 1 && this.burstE[j] * left > act) act = this.burstE[j] * left;
    }
    out[H.activity] = act;
  }
}
