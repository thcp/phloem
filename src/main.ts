// SPDX-License-Identifier: AGPL-3.0-only
import './ui/style.css';
import { initialSource } from './ingest/source';
import { Loader, type Sink } from './ingest/session';
import { LABEL_MODES, LabelLayer, type LabelMode } from './labels/layer';
import { LabelModel } from './labels/model';
import { View3D } from './labels/view3d';
import type { CommitEvent } from './model/events';
import { Camera } from './render/camera';
import { Director, createSignals, readSignals } from './render/director';
import { Renderer } from './render/renderer';
import { QualityGovernor, parseQuality } from './render/quality';
import { H, HEADER } from './sim/frame';
import { autoTicksPerCommit, type Pacing } from './sim/schedule';
import { Chrome } from './ui/chrome/chrome';
import { showFatal } from './ui/chrome/fatal';
import { WebApp } from './ui/webapp';
import { bridge } from './web/bridge';
import { SimClient } from './worker/client';
import { beatState } from './util/beat';
import { createFrameLimiter, parseMaxFps } from './util/frameLimiter';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const appRoot = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

const fatal = showFatal;

let renderer: Renderer;
try {
  renderer = new Renderer(canvas);
} catch (e) {
  fatal(e instanceof Error ? e.message : String(e));
  throw e;
}
// render quality: ?quality=high|medium|low pins a tier, otherwise start high and step down when over budget
const quality = new QualityGovernor(parseQuality(params.get('quality')));
renderer.setQuality(quality.tier);
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
renderer.reducedMotion = !!reducedMotion?.matches;
reducedMotion?.addEventListener?.('change', (e) => ((renderer.reducedMotion = e.matches), (director.reduced = e.matches)));
const camera = new Camera();
// Cinematic auto-director (render/director.ts): always on, from the first frame, in the viewer and behind the landing card. There is no switch.
// Any user input hands the camera over at once and it eases back in after a few quiet seconds (see userInput); under prefers-reduced-motion
// it still runs, at 35 % of every rate. It owns the azimuth, so the old turntable (`O`, `?orbit`) is permanently suppressed and was removed.
const director = new Director();
director.setEnabled(true);
director.reduced = renderer.reducedMotion;
camera.autoRotateSuppressed = true;
const dirSig = createSignals();
/** Any user camera input hands the camera to the user; the director eases back in after DIRECTOR.RESUME_DELAY s of quiet. */
const userInput = (): void => director.input();
const client = new SimClient();
const header = new Float32Array(HEADER);
let haveFrame = false;
let statsOn = params.has('stats');

const labels = new LabelLayer(canvas, new LabelModel());
const labelView = new View3D();
const mode0 = params.get('labels');
if (mode0 && (LABEL_MODES as string[]).includes(mode0)) labels.setMode(mode0 as LabelMode);
function setLabelMode(m: LabelMode): void {
  labels.setMode(m);
  shell.setLabelMode(m);
}

// ---------------------------------------------------------------- history lifecycle
// `commits` is the single array shared with the shell and the label replica. Ingestion appends to it through `labels.appendCommits`
// (the one place that pushes) and mirrors the same batch to the sim worker.
let commits: CommitEvent[] = [];
let sourceLabel = '';
const seed = Number(params.get('seed')) || 1;
const tpcParam = Number(params.get('tpc')) || undefined;
let pacing: Pacing = params.get('pacing') === 'dates' ? 'dates' : 'even';
let circuit = params.get('view') === 'circuit';
camera.flat = circuit;
renderer.setFlat(circuit);

/** Switch between the 3D slime mold and the flat circuit board. The sim restarts at the current commit with the other layout. */
function setCircuit(on: boolean): void {
  if (on === circuit) return;
  circuit = on;
  camera.flat = on;
  renderer.setFlat(on);
  camera.reset();
  shell.setCircuit(on);
  client.setOptions({ circuit: on });
  web.syncUrl();
}

function beginHistory(label: string, first: CommitEvent[], o: { estimate: number; auto: boolean; streaming: boolean }): void {
  commits = first.slice();
  sourceLabel = label;
  haveFrame = false;
  header.fill(0);
  header[H.commit] = -1;
  camera.reset();
  shell.setCommits(commits);
  shell.setPacing(pacing);
  shell.setStreaming(o.streaming, false);
  labels.setCommits(commits);
  const tpc = tpcParam ?? (o.auto ? autoTicksPerCommit(o.estimate || first.length) : undefined);
  client.load(first, { seed, pacing, circuit, ...(tpc ? { ticksPerCommit: tpc } : {}) }, o.streaming);
  if (!params.has('paused')) shell.setPlaying(true, true);
  if (import.meta.env.DEV || import.meta.env.MODE === 'e2e' || import.meta.env.VITE_EXPOSE_TEST_HOOKS === '1') {
    const hook = (window as unknown as Record<string, Record<string, unknown>>).__phloem;
    if (hook) hook.source = label;
  }
}

function appendHistory(batch: CommitEvent[]): void {
  labels.appendCommits(batch);
  shell.refreshCount();
  client.append(batch);
}

const sink: Sink = {
  begin: (label, first, estimate) => beginHistory(label, first, { estimate, auto: true, streaming: true }),
  append: appendHistory,
  end: () => client.finish(),
};

let web: WebApp;
const loader = new Loader(sink, (s) => web.onStatus(s));

const shell = new Chrome(appRoot, {
  onPlay: (p) => {
    // pressing play at the end replays from the start
    if (p && header[H.ended] === 1) client.seekTick(0);
    client.setPlaying(p);
  },
  onSeek: (c) => client.seek(c),
  onSpeed: (s) => client.setSpeed(s),
  onStats: (v) => (statsOn = v),
  onResetCamera: () => (userInput(), camera.reset()),
  onSetLabels: (m) => setLabelMode(m),
  onCycleLabels: () => setLabelMode(LABEL_MODES[(LABEL_MODES.indexOf(labels.mode) + 1) % LABEL_MODES.length]),
  onOpenLanding: () => bridge.landing?.show({ overlay: true }),
  onShare: () => web.syncUrl(),
  onExample: (repo) => web.loadExample(repo),
  onRefresh: () => web.refresh(),
  savedCount: () => web.savedCount(),
  onClearSaved: () => web.clearSaved(),
  onCircuit: (on) => setCircuit(on),
  onPacing: (p) => {
    pacing = p;
    client.setOptions({ pacing: p });
  },
});
shell.setLabelMode(labels.mode);
shell.setPacing(pacing);
shell.setCircuit(circuit);
if (statsOn) shell.toggleStats();
client.onError = (m) => fatal(`Simulation error: ${m}`);

// What to show first (landing card + backdrop, ?repo=, ?demo, or the ?fixture= / ?stress= dev sources) is decided by WebApp; see docs/WEB.md.
web = new WebApp({
  loader,
  client,
  chrome: shell,
  header,
  camera,
  labels,
  setLabelMode: (m) => setLabelMode(m),
  commits: () => commits,
  demoSource: () => initialSource(new URLSearchParams()),
  initialSource: () => initialSource(params),
  beginHistory: (src) => beginHistory(src.label, src.commits, { estimate: src.commits.length, auto: src.auto ?? false, streaming: false }),
});
await web.start();
if (params.has('paused')) {
  shell.setPlaying(false, true);
}

// ---------------------------------------------------------------- input
// Mouse: left-drag = pan, middle-drag = orbit, right-drag = rotate left/right around the vertical axis (no tilt), wheel = zoom to cursor,
// double-click = reset + auto-fit. Touch: one finger = orbit, two fingers = pinch zoom + pan,
// double-tap = reset. Key O toggles the slow auto-rotation (R resets, via the shell).
type Drag = { x: number; y: number; pan: boolean; spin: boolean };
const pointers = new Map<number, Drag>();
let lastTap = { t: 0, x: 0, y: 0 };
let tapStart = { t: 0, x: 0, y: 0, moved: false };
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
// middle button: no browser autoscroll
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 1) e.preventDefault();
});
canvas.addEventListener('auxclick', (e) => {
  if (e.button === 1) e.preventDefault();
});
canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 1) e.preventDefault();
  if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1 && e.button !== 2) return; // other buttons: inert
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // synthetic or already-released pointers cannot be captured; dragging still works inside the canvas
  }
  userInput();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, pan: e.pointerType === 'mouse' && e.button === 0, spin: e.pointerType === 'mouse' && e.button === 2 });
  camera.dragging = true;
  labels.setDragging(true);
  if (pointers.size === 1) tapStart = { t: performance.now(), x: e.clientX, y: e.clientY, moved: false };
  else tapStart.moved = true;
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (e.pointerType !== 'touch') labels.setPointer(e.clientX, e.clientY, true);
  if (!p) return;
  userInput();
  const dpr = renderer.width / canvas.clientWidth;
  const dx = (e.clientX - p.x) * dpr;
  const dy = (e.clientY - p.y) * dpr;
  if (Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) > 8) tapStart.moved = true;
  if (pointers.size === 1) {
    if (p.pan) camera.pan(dx, dy);
    else if (p.spin) camera.orbit(dx, 0); // right-drag: yaw only, the tilt stays where it is
    else camera.orbit(dx, dy);
  } else if (pointers.size === 2) {
    // pinch: zoom around the midpoint of the two pointers; moving the midpoint pans
    let ox = 0;
    let oy = 0;
    for (const [id, q] of pointers) if (id !== e.pointerId) ((ox = q.x), (oy = q.y));
    const before = Math.hypot(p.x - ox, p.y - oy);
    const after = Math.hypot(e.clientX - ox, e.clientY - oy);
    camera.pan(dx / 2, dy / 2);
    if (before > 0) camera.zoomNow(((ox + e.clientX) / 2) * dpr, ((oy + e.clientY) / 2) * dpr, after / before);
  }
  p.x = e.clientX;
  p.y = e.clientY;
});
const endPointer = (e: PointerEvent) => {
  if (!pointers.delete(e.pointerId)) return;
  if (pointers.size === 0) {
    camera.dragging = false;
    labels.setDragging(false);
    // double-tap (touch) resets the camera, like double-click
    const now = performance.now();
    if (e.pointerType === 'touch' && e.type === 'pointerup' && !tapStart.moved && now - tapStart.t < 300) {
      if (now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        userInput();
        camera.reset();
        lastTap.t = 0;
      } else lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  }
};
canvas.addEventListener('pointerleave', (e) => {
  if (e.pointerType !== 'touch') labels.setPointer(0, 0, false);
});
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    userInput();
    const dpr = renderer.width / canvas.clientWidth;
    // pixel-mode wheels report ~100 per notch; trackpads report small deltas
    const k = e.deltaMode === 1 ? 0.05 : 0.0015;
    camera.zoomAt(e.offsetX * dpr, e.offsetY * dpr, Math.exp(-e.deltaY * k), renderer.width, renderer.height);
  },
  { passive: false },
);
canvas.addEventListener('dblclick', () => (userInput(), camera.reset()));

// ---------------------------------------------------------------- stats
const perf = {
  fps: 0, // frames counted over a 0.5 s window
  frames: 0,
  windowStart: 0,
  frameMs: 0, // CPU time spent in our rAF callback (upload + GL submission + labels)
  labelMs: 0, // of which: label planning + 2D drawing
  frameRawMs: 0, // last frame's callback time (not smoothed)
  uploadMs: 0,
  last: 0,
  statsAt: 0,
};

/** Keep name labels off the commit caption (re-measured only when the caption changes or the window resizes). */
function updateObstacles(): void {
  labels.setObstacles(shell.obstacleRects());
}
window.addEventListener('resize', updateObstacles);

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (w !== renderer.width || h !== renderer.height) renderer.resize(w, h);
  camera.bottomInset = 132 * dpr;
}

function writeStats(now: number): void {
  if (!statsOn || now - perf.statsAt < 250) return;
  perf.statsAt = now;
  shell.stats.textContent =
    `${perf.fps.toFixed(0)} fps   frame ${perf.frameMs.toFixed(2)} ms   upload ${perf.uploadMs.toFixed(2)} ms` +
    `   gpu ${renderer.gpuMs >= 0 ? `${renderer.gpuMs.toFixed(2)} ms` : 'n/a'}\n` +
    `sim ${header[H.stepMs].toFixed(2)} ms/tick   pack ${header[H.packMs].toFixed(2)} ms   ticks/frame ${header[H.ticksThisFrame]}\n` +
    `segments ${header[H.segs]}   food ${header[H.food]}   pulses ${header[H.pulses]}\n` +
    `nodes ${header[H.nodes]}   tips ${header[H.growthTips]}   explorers ${header[H.explorers]}   cg ${header[H.cgIters]}\n` +
    `labels ${labels.mode} ${labels.stats.drawn}/${labels.stats.candidates}   ${labels.stats.ms.toFixed(2)} ms (+${labels.stats.intakeMs.toFixed(2)} intake)\n` +
    `files ${header[H.liveFiles]}   tick ${header[H.tick]}   ${renderer.width}×${renderer.height}${renderer.floatTargets ? '' : '   (8-bit targets)'}` +
    `\nfps cap ${limiter.maxFps > 0 ? limiter.maxFps : 'off'}` +
    `\nquality ${quality.label}${renderer.reducedMotion ? '   reduced motion' : ''}` +
    (client.checkpoints
      ? `\ncheckpoints ${client.checkpoints.count} × ${(client.checkpoints.bytes / Math.max(1, client.checkpoints.count) / 1048576).toFixed(1)} MB   every ${client.checkpoints.interval} ticks   capture ${client.checkpoints.lastCaptureMs.toFixed(0)} ms`
      : '');
}

function followBbox(dt: number): void {
  camera.follow(
    header[H.minX], header[H.minY], header[H.minZ], header[H.maxX], header[H.maxY], header[H.maxZ],
    renderer.width, renderer.height, dt,
  );
}

/** Tests: step the director by hand (`__phloem.directorStep`) instead of from the rAF loop. */
let manualDirector = false;

const limiter = createFrameLimiter(parseMaxFps(params.get('fps')));

function frame(now: number): void {
  if (!limiter.shouldRender(now)) {
    requestAnimationFrame(frame);
    return;
  }
  const t0 = performance.now();
  const qt = quality.frame(now, renderer.gpuMs, renderer.gpuSamples);
  if (qt) renderer.setQuality(qt);
  const dt = perf.last ? Math.min(0.1, (now - perf.last) / 1000) : 1 / 60;
  perf.last = now;
  perf.frames++;
  if (now - perf.windowStart >= 500) {
    if (perf.windowStart > 0) perf.fps = (perf.frames * 1000) / (now - perf.windowStart);
    perf.windowStart = now;
    perf.frames = 0;
  }
  resize();
  const f = client.take();
  if (f) {
    const u0 = performance.now();
    renderer.upload(f);
    perf.uploadMs = perf.uploadMs * 0.9 + (performance.now() - u0) * 0.1;
    for (let i = 0; i < HEADER; i++) header[i] = f[i];
    labels.onFrame(f, now / 1000);
    if (!haveFrame) {
      haveFrame = true;
      followBbox(1);
      camera.snap();
    }
    if (shell.showCommit(header[H.commit])) updateObstacles();
    shell.setStreaming(header[H.streaming] === 1, header[H.waiting] === 1);
    if (header[H.ended] === 1) shell.setPlaying(false, false);
  }
  client.pump(f);
  if (haveFrame) followBbox(dt);
  director.held = camera.dragging;
  if (haveFrame && !manualDirector) {
    director.step(dt, readSignals(header, dirSig), camera, camera.fitDist);
    if (director.authority > 0) camera.auto = false; // the director owns target and distance; reset() hands them back
  }
  camera.update(renderer.width, renderer.height, dt);
  renderer.pulse = renderer.reducedMotion ? 0 : beatState.level;
  renderer.render(camera, now / 1000);
  const ldpr = renderer.width / Math.max(1, canvas.clientWidth);
  labelView.begin(camera, renderer.width, renderer.height, ldpr, renderer.wobble, now / 1000);
  labels.update(now / 1000, dt, labelView, ldpr, 70);
  perf.labelMs = labels.stats.ms;
  perf.frameRawMs = performance.now() - t0;
  perf.frameMs = perf.frameMs * 0.9 + perf.frameRawMs * 0.1;
  writeStats(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Debug/test hook (used by the Playwright checks). It reaches the in-memory GitHub token through `web`, so it only exists in the dev
// server, in `vite build --mode e2e` (npm run build:e2e) and when VITE_EXPOSE_TEST_HOOKS=1; the condition is a build-time constant, so a
// normal production build drops the whole object (scripts/check-dist.mjs fails the build if it ever ships).
if (import.meta.env.DEV || import.meta.env.MODE === 'e2e' || import.meta.env.VITE_EXPOSE_TEST_HOOKS === '1') (window as unknown as Record<string, unknown>).__phloem = {
  header,
  perf,
  camera,
  director,
  /** Test hooks: freeze the rAF-driven director and advance it with a chosen dt (no rendering). */
  set manualDirector(v: boolean) {
    manualDirector = v;
  },
  directorStep: (dt: number, n = 1) => {
    for (let i = 0; i < n; i++) {
      followBbox(dt);
      director.step(dt, readSignals(header, dirSig), camera, camera.fitDist);
      if (director.authority > 0) camera.auto = false;
      camera.update(renderer.width, renderer.height, dt);
    }
  },
  renderer,
  quality,
  labels,
  setLabelMode,
  /** Run one label plan+draw step at wall time `nowSec` (label cost benchmarks). */
  labelFrame: (nowSec: number, dt: number) => {
    const d = renderer.width / Math.max(1, canvas.clientWidth);
    labelView.begin(camera, renderer.width, renderer.height, d, renderer.wobble, nowSec);
    labels.update(nowSec, dt, labelView, d, 70);
  },
  source: sourceLabel,
  loader,
  web,
  chrome: shell,
  client,
  get commits() {
    return commits;
  },
  /** Load pasted/generated git log or JSON text through the same path as an upload (tests). */
  loadText: (text: string, name = 'pasted.log') => loader.loadFile({ text, name }),
  play: (p: boolean) => shell.setPlaying(p, true),
  seek: (c: number) => client.seek(c),
  seekTick: (t: number) => client.seekTick(t),
  speed: (s: number) => client.setSpeed(s),
};
