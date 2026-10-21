# Phloem architecture

Phloem replays a git history as a growing slime mold (*Physarum polycephalum*).
Folders are vein junctions, files are food sources, commits feed the food,
and tube thickness follows flux. It is a static, client-side Vite + TypeScript app.

```
CommitEvent[] ──► Simulation (Web Worker) ──Float32Array frame (transfer)──► Renderer (WebGL2, main thread)
   ▲                 tree → 3D layout → network → pulses                 impostor tubes (opaque + fringe) → bloom → screen
   │                                                                             ▲
 ingest/*          worker/protocol.ts  ◄── play / speed / seek ──  ui/chrome ───┘ orbit camera, stats
```

## Module boundaries

| Directory | Owns | Must not depend on |
|---|---|---|
| `src/model/` | `CommitEvent` types (`events.ts`), JSON validation (`parse.ts`), seeded RNG, the logical `FileTree` | DOM, sim, render |
| `src/ingest/` | Producing `CommitEvent[]`: bundled fixture, synthetic stress generator (`stress.ts`), URL selection (`source.ts`), `git log` parser (`gitlog.ts`, `filestream.ts`, `ingest.worker.ts`), GitHub REST client (`github.ts`, cache in `idbcache.ts`), load sessions (`session.ts`). See `docs/INGESTION.md` | sim, render, DOM |
| `src/sim/` | Pure simulation: `engine.ts` (timeline, logical state, pulses, frame packing), `network.ts` (vein graph, Tero flux, growth), `layout.ts`, `spatial.ts` (3D hash), `vec.ts` (cone directions), `frame.ts` (frame layout), `activity.ts` (visual activity signals: burst energy, flood shape, warmth/ghost constants) | DOM, WebGL |
| `src/worker/` | Worker entry (`sim.worker.ts`, a thin shell), `controller.ts` (the testable brain: playback, append, checkpoints, seek), message protocol; `client.ts` is the main-thread handle | render, UI |
| `src/render/` | WebGL2 renderer, shaders, perspective orbit camera, quality tiers + auto-downgrade governor (`quality.ts`), the pure auto-director camera logic (`director.ts`) | sim internals (reads only `frame.ts` and the pure constants/formulas in `activity.ts`) |
| `src/labels/` | Name labels + hover: id replica (`model.ts`), pure LOD/fade/collision logic (`select.ts`), camera abstraction (`view.ts`), 2D canvas layer (`layer.ts`) | sim internals (reads only `frame.ts`), WebGL |
| `src/ui/` | `chrome/` (viewer bar, timeline, status pill), `landing/` (the card), `webapp.ts` (page behaviour), `tokenpanel.ts`, `statusdom.ts`, `dropzone.ts` (drop a file anywhere), `theme.css` / `style.css`. There is one load flow: landing card -> status pill with progress / Cancel / Resume. (The ingestion agent's first dialog, `loader.ts` + `shell.ts` + `?loader`, was removed in the integration pass.) See `docs/WEB.md` | sim, render |
| `src/web/` | Pure logic of the public page: URL contract (`urlstate.ts`), request cost preview (`plan.ts`), timeline ticks (`timeline.ts`), status view model, token store, saved-history cache (`histcache.ts`), landing/engine bridge | sim, render |
| `src/entry.ts` | Page entry: the landing card and the drop zone first (tiny critical path), the engine (`src/main.ts`) lazily behind them | sim, render |
| `src/main.ts` | Engine wiring: renderer, sim client, loader, chrome, labels, camera input, rAF loop (capped by `?fps=`, default 100), perf counters, `window.__phloem` | |

`src/sim` runs unchanged in Node, which is what the unit tests and `npm run bench` use.

## Commit-event interface (the ingestion seam)

The only input is `CommitEvent[]`, **oldest first**, exactly the schema in
`fixtures/README.md` (`hash, author, email, date, message, files[{path, status A|M|D|R, added, removed, old_path?}]`).
`parseCommitEvents(unknown)` validates and normalizes it: it strips `./`, leading `/` and `//` from paths, maps `C`→`A` and `T`→`M`,
turns an `R` without `old_path` into `A`, and throws `CommitParseError` with a JSON path such as `$[3].files[2].status`.
Sources: bundled fixtures, the stress generator, an uploaded `git log` file or CommitEvent JSON, and the GitHub API (`docs/INGESTION.md`). Anything that can deliver commits over time
uses `client.load(first, options, streaming = true)`, then `client.append(batch)` for each further batch and `client.finish()` at the end (see below).

`FileTree.applyCommit` turns a commit into `TreeOp`s (`add`, `touch`, `remove`, `move`). It also handles history windows:
`M`/`R` on an unknown path behave like adds, `D` on an unknown path is ignored, and folders that become empty are removed upward.

## Simulation model

- **Time** is fixed ticks. Commit *i* lands at tick `i * ticksPerCommit` (default 45). Playback speed and seeking only change how many ticks run per wall-clock frame, so the state at a given tick depends only on the commits, the seed and the params. The RNG is mulberry32, and `Math.random` is never used. Seeking restores the nearest checkpoint and fast-forwards (see *Streaming, checkpoints, pacing*).
- **Space** is 3D, y up (the old 2D plane is x-y; z is depth from the default view).
- **Layout** (`layout.ts`). Each logical node gets a fixed 3D position when it first appears: a best-of-N candidate in an outward 3D cone around its parent's growth direction (area-uniform in the cone), scored by clearance. The RNG is seeded per path. Positions never move, except a renamed file's target. The volume is deliberately *oblate*: candidate directions get their z squashed (`rootFlat` 0.4 for top-level folders, `flat` 0.5 below) and the clearance metric weighs z by `clearZ` 0.55, so siblings prefer to separate sideways (visible) rather than hide behind each other. The result is a thick, branching coral fan: z spread is ~0.3-0.65 of the x-y spread (first10 ≈ 0.3, full stemdeck ≈ 0.4, 5k stress ≈ 0.65; asserted 0.2-0.9 in `tests/sim3d.test.ts`), neither a flat sheet nor an isotropic hairball.
- **Growth** (`network.ts`). Touching a file whose vein doesn't exist yet queues growth through its unreached ancestor folders. Each hop is a growth *tip* (unit 3D heading) that steers toward the target with a smooth meander and deposits a node every `segLen`. Steering rotates the heading toward the target by a fraction of the angle between them (a lerp-and-normalize would barely turn a tip facing away, since its rate goes like sin(angle), and such tips used to hit `maxTravel` and snap with a long straight edge); the meander is a slowly drifting 3D turn vector. Explorers leave at 0.45-1.35 rad from the heading with a random azimuth around it. It sprouts from the folder's existing vein nearest the target (`nearestOwned`), so files branch off veins instead of radiating from the folder. Tips spawn short *explorer* threads (the fine fan at the leading edge). Explorers that touch another vein (3D distance < `fuseDist`) fuse with it (anastomosis, which creates loops). Loops are rarer in 3D than in 2D (threads meet less often in a volume); an explorer "chemotaxis" toward nearby veins was tried and dropped: +60% step cost for ~30% more loops. Well-fed food and a little ambient foraging keep the fringe alive.
- **Flux** (Tero et al.). The root (inoculum) is the source. Sinks are food demand (`baseline + nutrient`) and growth tips. Pressures solve the weighted-Laplacian Kirchhoff system. Conductance then adapts as `dD/dt = a (f(|Q|) - D)` with a Hill function `f`. Unused tubes thin out, and once they drop below `pruneD`, leaf tubes and loop edges are pruned. Deleted files lose their demand and protection, so their veins wither back. Renamed files detach: the old vein withers, the food glides to its new site, and a new vein grows there.
- **Solver**. PCG on a series-reduced graph. Unbranched chains collapse to single conductances, which cuts ~48k nodes to ~16k junctions. The preconditioner is an exact O(n) solve on the growth spanning tree. The tree is kept close to a max-conductance tree by swapping in a loop edge whose conductance beats the weakest edge on its cycle. High-stretch loops are dissolved. Tree flux is exact. Loop flux is approximate, with a relative residual of ~1e-2 at 5k files (`lastResidual`). Above `solveEveryOtherAbove` junctions the solve runs every other tick.
- **Memory**. Structure-of-arrays typed arrays (`x y z` per node) with free lists. The hot loops don't allocate. Fixed nodes live in two 3D spatial hashes: a fine one (cell 1.5 × `fuseDist`) for fusion, and a coarse one (cell 24) for the long-range `nearestOwned` search, since a query costs (2r / cell)^3 cells in 3D. Every 240 ticks `compact()` renumbers nodes in DFS order for cache locality, and the engine remaps the indices it holds.
- **Authors** appear as comet pulses that travel from the inoculum along the parent chain to each touched file (at most 40 per commit). The colour is a gold tint mixed with a hue hashed from the author name.

## Worker protocol and frame

`worker/protocol.ts`: `load` (optionally `streaming`), `append`, `finish`, `options` (pacing / ticks per commit; rebuilds the sim and returns to the current commit), `frame`, `play`, `speed`, `seek` (settled state of commit *i*), `seekTick`; back: `ready`, `frame`, `info` (checkpoint stats), `error`.
Exactly one `Float32Array` circulates. The main thread hands it to the worker with a `frame` request. The worker advances by the wall-clock time since its last frame (capped at `3 × speed` ticks per frame, so it drops time rather than spiral), packs, and transfers it back. The main thread uploads it with `bufferSubData(srcOffset, length)` and returns it on the next rAF. Seeking runs on the worker's own event loop in 30 ms chunks, independent of the frame rate.

`sim/frame.ts` layout: a 56-float header (tick, commit, counts, 3D bbox `minX..maxZ`, worker timings, flags, activity signals), then the segments, food and pulses, each at a stride of 8 floats (32 bytes):

- segment `f32 x0 y0 z0 x1 y1 z1 | u16 r0 r1 | u8 alpha u8 emit u16 dist`. The last two slots are packed integers written through
  `Uint16Array`/`Uint8Array` views of the same buffer (`frameViews`; decode with `readSegment`): radii as unorm16 of `SEG_R_MAX`;
  `emit` = heat in the high nibble (growth tips, food arrival flare) | warmth in the low nibble (recent activity, below);
  `dist` = absolute growth distance of endpoint 0 from the inoculum as unorm16 of `header[H.distMax]` (a power of two ≥ 256, so it rarely
  changes; resolution ≤ 0.02 world units at 1024), which drives both the streaming phase and the flood fronts. So adding z and the
  effects did **not** grow the per-frame upload (still 32 B/segment, ~1.4 MB at 45k segments); the renderer reads them as normalized
  `UNSIGNED_SHORT`/`UNSIGNED_BYTE` attributes. The last `header[H.ghosts]` segments are **afterglow ghosts** (below), alpha < `GHOST_ALPHA`.
- food `x y z radius | nutrient engulf fade seedKind` (seedKind = seed + 2 × kind, kind 1 = inoculum); pulse `x y z intensity | dirX dirY dirZ hue`.

**No spoilers: unreached files are invisible.** `pack()` emits a food record only for a file whose vein tip has arrived (`Simulation.arrivedAt[id] >= 0`, stamped in `onArrive`; the inoculum is always record 0), so
a first commit with thousands of files draws no dots at all until the mold gets to them. Everything else that could reveal where an unreached file is follows the same rule: the **header bounding box**
(`H.minX..maxZ`, which feeds `Camera.follow`/`fitDist`, the director's establishing shot and the motes' scene box) covers only live network nodes, ghosts and *drawn* food, never unreached food, so the framing
does not reserve empty space and does not jump when food is reached; the hot-spot, pulses and floods were already built from growth tips, travelling pulses (which only target reached files) and growth distance; labels/hover
are gated by the anchor `reached` flag. A file renamed away stops being drawn (`arrivedAt` reset; its food glides invisibly) until the new vein arrives; a deleted file that had been reached keeps its record and fades out
(`fade` runs down); a deleted file that was never reached never appears. A fresh arrival glints for `ARRIVE_LIFE` = 40 ticks: radius +50 % and nutrient +1.5 decaying quadratically (the existing nutrient glow in the food shader, no shader
change), growing in over `ARRIVE_GROW` = 8 ticks through `fade`. `arrivedAt` is visual-only simulation state (never read by growth/flux/seeding, cloned by checkpoints), so growth is bit-identical to before and a seek shows the same
visible set as sequential play (`tests/food_gating.test.ts`). The anchor section still lists unreached files (position + `reached = 0`) because the label layer needs the unreached -> reached edge; nothing draws from it. The renderer does
not know the difference: `H.food` is simply smaller.

A static/dynamic split (upload node positions once, segments as index pairs) was considered and not done: fixed nodes never move, but
compaction renumbers them and radii/alpha/emission change every tick for every segment, so the dynamic half would still be ~16 B/segment
plus a texture fetch per vertex.

**Activity signals** (`sim/activity.ts`, visual only; deterministic like everything else in the sim, cloned by checkpoints):

- *Bursts*: each commit, when it lands, starts a flood wave with energy `burstEnergy(files)` = log1p(files) / log1p(150), capped at 1
  (1 file ≈ 0.14, 15 files ≈ 0.55, the 142-file commit ≈ 0.99). The header keeps the last 4: `H.bursts + k*BURST_STRIDE` =
  (landing tick, energy, author hue), newest first. The front is at growth distance `(tick - landing) * FLOOD_SPEED` (4.2 units/tick);
  `floodAt(d, front, energy, reach)` is the shape (sharp leading edge, long glowing wake, fading out by `reach` = `H.reach`, the
  largest live growth distance). The segment vertex shader evaluates the same formula, so the flood costs no per-segment frame data.
- *Warmth*: `Network.warm` per node, set to 1 by fresh growth and wherever an author pulse passes, decays ×0.999/tick (~15 commits to
  halve). Packed per segment (max of both ends) in the emit low nibble: active regions run warm, dormant ones cool.
- *Afterglow*: when `prune()` removes a vein whose slowly decaying peak radius (`Network.ePeak`) was ≥ `GHOST_MIN_R` (0.6, i.e. it
  thickened beyond a fresh growth tube; explorer hair leaves nothing), its endpoints go into a 2048-entry ring (`ghostPos/ghostR/ghostTick`).
  `pack()` appends ghosts younger than `GHOST_LIFE` (540 ticks) as segments with alpha `GHOST_ALPHA × (1-age/life)²` and a radius that
  spreads as they fade. They are rare in real histories (≤ ~35 at once in the full stemdeck history), so they cost nothing measurable.
- *Hot-spot* (for an auto-director camera): `H.hotX/Y/Z` = weighted centroid of the activity (growing tips weight 1, explorer tips 0.08,
  travelling author pulses 0.6 × fade), `H.hotW` = total weight (≈ number of growing tips + pulses; 0 = nothing happening),
  `H.hotR` = RMS radius of that activity around the centroid, `H.activity` = 0..1 overall level: `1 - exp(-hotW/24)` maxed with the
  strongest live flood (energy × remaining travel). Raw per frame (not smoothed; a camera should ease toward it, e.g. τ ≈ 1-2 s, and
  weight it by `activity`). Cost: one pass over tips + pulses (no per-segment work, no allocation).

**Anchor section (labels / picking).** After the pulses the frame carries one record per live file and folder: `id x y z reached`
(`ANCHOR_STRIDE`, field offsets in `frame.ts` `A`; `H.anchors` = count, `anchorOffset(f)`). `id` is the logical `FileTree` node id, the
position is the un-wobbled world position (files: the gliding food position; folders: the layout position), `reached` is 1 once the vein
got there. No worker message was added for labels or hover: names and paths come from `src/labels/model.ts`, a main-thread `FileTree`
replica that replays the same commits up to `header[H.commit]` (ids are deterministic and never reused). Seeking backwards resets and
replays. **Ingestion note:** when commits are appended or a checkpoint is loaded, keep the array the `LabelModel` reads (`labels.model.commits`)
in sync, or call `labels.setCommits(commits)` again; the replica is rebuilt lazily by `sync(header[H.commit])`.

## Streaming, checkpoints, pacing, big commits

All in `sim/schedule.ts`, `sim/snapshot.ts`, `worker/controller.ts` (and the `Simulation` hooks they use); tests in `tests/seek_append.test.ts`.

- **Schedule.** `sim.sched[i]` is the tick commit *i* lands on; it depends only on commits `0..i` (so it extends as commits are appended).
  `pacing: 'even'` (default) = `i * ticksPerCommit`. `pacing: 'dates'` = gaps follow author-date gaps, compressed logarithmically
  (`gap = tpc * clamp(0.3 + 0.9 log10(1 + hours), 0.3, 4)`; out-of-order dates count as 0 h). Not exposed in the UI (the simulation supports it; the viewer always uses even pace).
  Loaded (file / GitHub) histories get `ticksPerCommit = autoTicksPerCommit(n)` = clamp(18000 / n, 2, 45) so a 20k-commit replay is minutes, not hours;
  fixtures, `?stress=` and `?tpc=` keep their explicit values.
- **Append / streaming.** `load` with `streaming: true`, then `append`. While streaming the clock never enters `sim.horizon` =
  `sched[n-1] + max(applyTicks, minGap)` (no later commit can land earlier), so *the state at tick t does not depend on when commits arrived*
  (tested against all-at-once loading, in both pacing modes). Playback starts with the first batch and waits at the frontier (the bar shows `n / total+ …`);
  `finish` lets the timeline settle and end. The main thread mirrors each batch into the label replica with `labels.appendCommits` (pushes onto the shared
  array, registers authors; no replica reset) and the scrubber (`chrome.refreshCount`). Header flags: `H.streaming`, `H.waiting`.
- **Checkpoints.** `CheckpointStore` takes a deep copy (`cloneSimulation`: generic structural clone, typed arrays by memcpy, shared/cyclic references preserved, so new
  sim state is captured automatically; `commits` and `sched` are shared, which keeps snapshots valid across appends) at least every `interval` ticks (200; raised when a capture costs
  more than ~5 % of the compute it covers) while stepping. The `Network` solver scratch (diag/rhs/res/... , the arrays `allocNodes` already re-creates zeroed on growth) is left out
  and re-created on restore: that halves a snapshot. A seek (backward, or forward over more than one interval) restores a copy of the nearest earlier snapshot and steps the rest, which is
  bit-identical to sequential play (tested across a network compaction, with and without scratch). Memory per snapshot (lean): 2.8 MB at 120 commits of stemdeck, ~11 MB at 36k network nodes / 1.7k
  files, ~32 MB at 123k nodes / 15k files. Total is capped (320 MB, scaled by `navigator.deviceMemory`: 160-640 MB); over the cap the store drops snapshots greedily, always the one whose removal
  leaves the cheapest merged replay span (ticks x snapshot size as a cost proxy). Seek cost is therefore `ticks since the nearest snapshot x step ms`: a few seconds up to a few thousand commits,
  and tens of seconds to ~2 minutes for 20k commits / 15k files (see *Scale* in INGESTION.md); a forward seek into territory never simulated costs the full simulation. A capture costs
  ~50 ms at 10 MB and ~120-300 ms at 30 MB (one hitch per capture during playback). Stats overlay (`S`) shows count, size, interval, capture time.
- **Big commits.** A commit with more than `CHUNK_FILES` (300) files is applied 300 files per tick (the tree walks files in order, so slicing is exactly equivalent to a one-shot
  apply), and the schedule leaves the next commit at least that many ticks. Worst single tick for an 8.8k-file import went from 233 ms to ~50 ms.

## Labels

`src/labels/layer.ts` draws gource-style names on a 2D canvas (`#labels`, `pointer-events: none`) above the WebGL stage, sized
`clientSize x dpr` (dpr as the renderer). Per frame (`update`, cost shown in the stats overlay):

1. **Candidates** from the copied anchor/pulse sections (the sim buffer goes back to the worker before drawing). Files touched in the last
   ~6 s (wall clock, stamped by the replica when the commit lands) score by recency + a short flash; folders score by live-file count and
   depth and fade in with the projected subtree size (`folderLod`); in `all` mode, when zoomed in (`ambientFileLod`), nearby untouched files
   join as low-priority labels; authors get a label that follows the nearest of their travelling pulses. The hovered node is pinned.
2. **Greedy placement** (`LabelPlanner`): sort by score (+ hysteresis for labels already shown), try the previous of 8 slots around the
   anchor first, accept the first slot inside the viewport that is free of other labels and of UI obstacles (the commit caption). Caps: 90 labels in
   `all`, 40 in `active`.
3. **State**: per-key alpha (linear fade in 0.22 s / out 0.4 s) and an exponentially smoothed slot offset. Labels are anchored in world
   space and re-projected every frame with the same wobble as the shader (`wobbleAt`), so panning/zooming/wobble never makes them swim; only
   a slot change slides. Labels are pre-rendered into small cached bitmaps (halo + fill, snapped to device pixels) and blitted.

`LabelView` (`view.ts`) is the only place that knows the camera and the wobble formula. `View3D` (`view3d.ts`) is the one in use: it
projects through the orbit camera's view-projection matrix (with the shader's 3D wobble), returns the per-point perspective scale (far
labels get a smaller scale, so the zoom LOD curves fade them first) and, in `out[3]`, the same depth cue the renderer uses for fog, which
the layer uses to dim far-side labels and let them lose collisions. Points behind the near plane are dropped. There is no true occlusion
test (a label behind a dense vein stays visible, only dimmed by depth).
Hover picks the nearest anchor within ~11-20 css px (files before folders) from the same frame data, no protocol message.
Modes: `all`, `active`, `off` (`L` or the "names" button, `?labels=` URL param). Tooltip: full path, last touching commit message/author/hash.

## Rendering

The scene is drawn into an RGBA16F color target (RGBA8 if float targets are missing) with a 24-bit depth renderbuffer, then bloomed and tone-mapped.

1. **Opaque impostor pass** (depth test + write, no blending). One instanced quad per segment (4 vertices from `gl_VertexID`), built in
   view space on the plane through the segment midpoint that faces the camera, padded by the radius and 1.5 px. The fragment shader
   reconstructs the capsule analytically: distance to the axis gives coverage, a cylindrical normal (made perpendicular to the 3D axis, so
   tubes tilted toward the viewer shade correctly) or a spherical one on the end caps, and the true front-surface depth via `gl_FragDepth`
   (the cylinder lift is scaled by 1/cos(tilt) so the end spheres stay inscribed). Consecutive segments share endpoint spheres, so
   veins are smooth unions, and crossings are depth-correct. Only fully covered, fully opaque fragments are written here.
   Food (oat flakes, engulfed flakes, inoculum) are sphere impostors in the same pass.
2. **Translucent remainder pass** (depth test against pass 1, no depth write, premultiplied `ONE, ONE_MINUS_SRC_ALPHA`): the same
   instances with a second build of the fragment shader that keeps only what pass 1 discarded: the anti-aliased rims, sub-pixel threads
   (radius clamped to 0.7 px, faded by coverage) and fading/withering tubes. It does not write `gl_FragDepth`, so GPUs can early-reject
   fringe fragments hidden behind opaque veins, and sub-pixel threads take a cheap unlit path. Order among translucent fragments is not
   sorted (they are faint, thin and short; errors are invisible in practice). `renderer.fringe = false` skips this pass (quality knob).
3. **Glow**: author pulses as additive comet billboards, depth-tested (occluded by veins in front) and lifted toward the camera by their
   size so they are not buried in their own tube. Then the **motes** (spores drifting in the medium): `particles` instanced quads with no
   vertex data at all, additive, depth-tested.
4. **Bloom**: a thresholded 6-level downsample chain, then a tent upsample. **Final**: filmic shoulder, warm agar background, vignette, grain, and the microscope lens (below).

**Material** (`SHADE` in `shaders.ts`, view-space lights): golden albedo by thickness (ochre → gold → butter), wrapped diffuse, a tight
Blinn-Phong highlight plus a broad sheen (glossy wet tubes), a golden fresnel rim, an inner glow strongest at the tube core, white-hot
emission at growth tips and fed food, and the peristaltic brightness wave along the growth distance. Fine threads are dimmer than trunks.
**Effects** (`segVs`/`segFs` variants in `shaders.ts`, compiled lazily per effect set and cached; see `quality.ts`):

- *Cytoplasmic streaming*: per endpoint in the vertex shader, two peristaltic bands blended by tube thickness: trunks throb slowly with a
  long wavelength (0.6 rad/s), thin veins flicker quickly (2.9 rad/s). Blending two fixed bands rather than a per-edge frequency matters:
  neighbouring segments would otherwise drift out of phase over time and the vein would show seams. The crest pattern slides back and forth
  (`slosh`, shuttle streaming) with a slowly varying per-region phase, and a slow breathing tide (8 s) rolls outward from the inoculum.
  The values are interpolated linearly along the quad (corner value = mix(end0, end1, along/L)), so the fragment shader only reads a varying.
  On `high`, granules (2D value noise stretched along the flow, a few lanes across) slide back and forth inside the core with a slow net drift
  outward, masked to the endoplasm and faded out when the tube is under ~5 px wide. With `radiusPulse` the tube wall also contracts with the
  wave (3-8 %), breathes and swells by up to 22 % as a flood passes.
- *Commit floods*: `flood(d)` (4 bursts) per endpoint in the vertex shader; light pours through the core (`fl × (0.35 + 0.7 h)`), tinted 22 %
  toward the author's hue, soft-capped (`1.25 (1 - e^(-x/1.25))`) so stacked bursts never blow out. The renderer extrapolates the sim tick
  between frames while playing, so fronts glide even when a frame is late.
- *Translucent gel* (`gel`): Beer-Lambert through the chord `2 r h` of the tube: albedo goes from pale warm butter (thin gel: rims, threads)
  to dense amber (long path through a trunk's core); light transmitted near the silhouette glows back out (stronger toward a back light),
  the core keeps an inner glow, the fresnel rim is subtle. Still the same two passes; no extra target.
- *Colour by meaning*: warm (recently active) veins ×(1.1, 1.0, 0.84), dormant ×(0.8, 0.84, 0.82) (cooler, dimmer); withering tubes
  (alpha < 1 without heat) desaturate toward umber and darken by up to 45 %; growth tips flare white-hot with a slight flicker; author hue
  tints pulses and floods. Ghosts are drawn unlit in the translucent pass as soft, faint dried-slime trails.
- *Motes*: position = hash(gl_InstanceID) in the (smoothed) scene box, rising slowly with wrap-around plus a gentle swirl; brightness rises
  near the smoothed hot-spot and when a flood passes their straight-line distance (× 1.3 ≈ growth distance); near the camera they open into
  soft bokeh discs whose light is spread over the disc; depth-fogged.
- The opaque pass now discards fading tubes, ghosts and sub-pixel threads in the **vertex** shader (degenerate quad), since they never
  have solid pixels; this pays for part of the effects.

**Quality tiers** (`quality.ts`; `?quality=high|medium|low` pins one, default/`auto` starts at `high`):

| tier | streaming | radius pulse | gel | floods | ghosts | motes |
|---|---|---|---|---|---|---|
| high | bands + granules | yes | yes | yes | yes | 1800 |
| medium | bands | yes | yes | yes | yes | 600 |
| low | legacy single wave | no | no | yes (vertex only) | no | 0 |

`QualityGovernor` steps down one tier when, after a 3 s warm-up, the smoothed GPU time (EXT_disjoint_timer_query_webgl2) stays above
12 ms, or without a timer the smoothed frame interval stays above 1.45 × the display refresh (estimated as the smallest interval seen, so a
30 Hz display is not mistaken for overload) and above 22 ms, for 2.5 s. It never steps back up (an oscillating tier is worse than a stable
one); intervals > 1 s (hidden tab) are ignored. The stats overlay (S, or `?stats`) shows the tier and why it dropped. `prefers-reduced-motion` turns off
streaming/breathing amplitude and the motes and calms the wobble (floods and colour stay: they carry information).

**Relative cost** (SwiftShader in WSL, 960×600, same frame rendered per configuration, `tests/e2e/fx_cost.py`; min of interleaved rounds
on a shared, loaded machine, so expect ±5-10 % noise; `legacy` = the pre-effects shaders):

| configuration | full history, commit 320 + 50 ticks (7.8k segs) | 5k stress, settled (52k segs) |
|---|---|---|
| legacy (pre-effects shaders) | 350 ms (1.00) | 2663 ms (1.00) |
| low | 288 ms (0.82) | 2097 ms (0.79) |
| medium | 328 ms (0.94) | 2056 ms (0.77) |
| high | 337 ms (0.96) | 2035 ms (0.76) |
| low, translucent fringe off | 153 ms (0.44) | 828 ms (0.31) |

All tiers are cheaper than the legacy shaders because the opaque pass now culls never-solid instances in the vertex shader; on
SwiftShader the remaining cost is dominated by the translucent fringe pass. Increment of single effects over `low` (full-history scene,
24 interleaved rounds): motes 1800 ≈ +20 %, motes 600 ≈ +5 %, granular streaming ≈ +3 %; streaming bands, radius pulse, gel, ghosts
and floods are each below the noise floor (< ±5 %). On the 52k-segment scene no single effect is distinguishable from noise. high vs low
is thus ≈ +17 % on a light scene and ≈ 0 on a heavy one (budget: +35 %). Real GPUs have not been measured yet.

**Microscope lens** (`lens.ts`: pure tier mapping; `finalFs(level)` in `shaders.ts`; uniforms in `Renderer.render`). Always on, one look, **no user setting** (no URL parameter, key or button, nothing in share links);
only the quality tier and `prefers-reduced-motion` change what is drawn. It lives entirely in the final pass, which is compiled per level from one template (level 0 is the plain pre-lens pass, kept only as the
`renderer.lensEnabled = false` reference for cost measurements). Everything is a function of `dn`, the distance from the centre on the viewport ellipse normalised so the corners are 1; on near-square screens
the ellipse leans toward a circle (`x` stretched by `aspect^0.55`), on screens wider than ~2:1 it is the plain viewport ellipse, so the mold in the middle is never cropped:

- *Field and vignette*: a faint warm lit field (agar brightened toward the centre) so the falloff has something to fall from, a warm-tinted dark falloff (multiplier floor ~0.45/0.34/0.22 for R/G/B, never black, so labels and chrome
  stay readable) and a rounded **field stop** (`smoothstep(0.74, 0.9, dn)`) that darkens the corners and shows as a circle/ellipse arc.
- *Edge defocus* (high): the scene target's mip chain (`generateMipmap`, sampled through a separate sampler object so the bloom chain, which reads the same texture, is unchanged) at LOD
  `3.2 x smoothstep(0.45, 1, dn)^2`: the middle (about half the frame) is untouched and branches around the blur. The sampler picks the nearest mip and the LOD is dithered by +-0.5 with a hash (stochastic trilinear, hidden by the grain), which is
  cheaper than trilinear on software GL. The bloom chain itself cannot serve as the blur because its first level is thresholded.
- *Chromatic aberration* (medium+): R and B sampled at +/- `0.0028 x dn^2` of the offset from the centre (G stays put, so the luminance does not move; <= ~2 px at the far corners of 1280x800). Skipped for `dn < 0.42`.
  With the blur on, G is the mean of the two offset taps (2 reads instead of 3).
- *Glare* (medium+, behind `dn > 0.5`): a ghost of the bloom mirrored through the centre (so it follows bright floods and bursts; one extra tap), a crescent along the rim and a thin warm arc on the field stop. Static otherwise; under
  `prefers-reduced-motion` the ghost response is 0 (the crescent and arc are static anyway).
- *Dust* (high, behind `dn > 0.5`): two layers of static procedural specks/discs (one candidate per cell, sine-free hash, no neighbour lookups), only near the rim, lit a little by the local bloom.

**No geometric distortion.** Barrel/pincushion would move veins relative to the 2D label overlay (`labels/view3d.ts` projects through `Camera.project`) and to hover picking, which would then need the identical
mapping. The effect therefore moves nothing but the R/B channels by a couple of pixels, and the HTML chrome and labels sit above the canvas untouched. Tier mapping (`lensParams`): high = all of the above, medium = no blur and no dust,
low = vignette + field stop only (no extra texture reads). The governor stepping down a tier therefore also makes the lens cheaper. Screenshot/OG paths read the canvas as shown, so they include the lens.
Cost (SwiftShader, 960x600, full-history scene, min of 40 interleaved rounds, load average ~17 so +-5 %): high +5 to +6 % over `lensEnabled = false`, medium and low within noise (0 to -2 %).
Before the branch/dither optimisations the blur cost +15-20 % on high.

**Depth cue**: between `fogNear` and `fogFar` (the scene's bounding sphere as seen from the eye) colors desaturate toward umber and fade to
16 %, so the far side of the mold sinks into the agar. The shared sin-noise wobble is 3D now (x and y are the old 2D formula, so the
label layer's `wobbleAt` stays valid; `view3d.ts` adds z).

**Why impostors, not meshes.** A tessellated tube needs ≥ 8 sides × 2 rings per segment (≥ 16 vertices, 32 triangles), i.e. ~1.6 M
triangles at 50k segments, rebuilt or skinned every frame because radii change every tick, and still faceted up close. The impostor costs
4 vertices per segment per pass and is round at any zoom; the price is per-fragment math (~60 ALU) and `gl_FragDepth` in pass 1, which
disables early-z there. Overdraw is modest because pass 1 only writes covered pixels of thin quads. Measured under software GL
(SwiftShader in WSL, 960×600, 5k-file stress, 43k segments, synchronous `render()` + readback): 3D ≈ 3.0 s/frame vs the old 2D fields
renderer ≈ 1.75 s/frame (1.7×), of which the translucent pass is ~45 %. Real GPUs are ~2-3 orders of magnitude faster than SwiftShader on
this kind of work, so this is expected to hold 60 fps on an integrated GPU, but it has not been measured on one here.

**Camera** (`camera.ts`): perspective (38° vertical FOV) orbit around a target: yaw/pitch (pitch clamped to ±83°), distance, target.
Auto mode eases target and distance to fit the 3D bbox (an ellipsoid/box blend, orientation-aware, so orbiting re-frames smoothly; a
vertical lens shift centers the network in the band above the bottom UI). Orbiting keeps auto framing; pan or zoom switch to manual until
reset. Input deltas are integrated in `update()` with inertia (release velocity decays at e^-4.5t) and eased wheel zoom toward the
cursor (the point under the cursor stays fixed); pinch applies zoom immediately. (The old `O` turntable and `?orbit` were removed: the always-on director owns the azimuth. `Camera.autoRotate` remains in the class but nothing enables it.)
Near/far planes hug the scene's bounding sphere. `camera.project()` gives device px, view depth and px-per-unit for overlays.
The canvas is sized to `clientSize × min(devicePixelRatio, 2)` and checked every frame.

**Auto-director** (`director.ts`, always on, no switch; pure logic, no DOM, unit-tested in `tests/director.test.ts`). A cinematic mode that
drives the camera above from the frame-header activity signals (`H.hot*`, `H.activity`, `H.bursts`, `H.reach`, bbox). Per frame `readSignals(header)` -> `Director.step(dt, signals, camera, camera.fitDist)`,
called in `main.ts` between `camera.follow()` and `camera.update()`. `Camera.fitDist` is the "whole mold in frame" distance for the current orientation (`follow()` now computes it
even in manual mode). While the director has authority it sets `camera.auto = false` (it owns target + distance; `R` / double-click hands them back) and `camera.autoRotateSuppressed` (set for good in `main.ts`) silences the turntable.

- *Signals are conditioned, not trusted*: activity (rise 1.2 s, fall 2.5 s), burst drive (rise 0.5 s, fall 3 s), hot-spot centroid (tau 1.6 s, weighted by `hotW / (hotW + 3)`, held when `hotW` = 0) and hot radius (2 s) are
  low-passed with exact exponentials, so the path is frame-rate independent (tested at 30/60/144 fps).
- *Shots*: `follow = smoothstep(0.06, 0.4, activity) * (1 - 1.25 * burst)` blends the **establishing shot** (target = bbox centre, distance = `camera.fitDist`) into the **follow shot** (target = hot-spot, clamped to
  the bbox; distance = 3.6 x `hotR` + 16, between 0.42 and 0.95 of the establishing distance). A **burst** (`burstDrive`: `energy^3` shaped by how far its flood has travelled, `floodDuration(reach)`; the 142-file commit
  ~0.97, a 15-file commit 0.17, one file 0.003) pulls back to the establishing shot, widens by a further 12 %, lifts the elevation by 0.1 rad. **Calm growth** (`calm`, 25 s up / 3 s down, only while playing and no big
  burst) eases both shots in by up to 12 %. Paused / waiting / ended: activity is treated as 0 (relaxes to the establishing shot), the azimuth drifts at 35 %.
- *Orbit*: azimuth drift 0.05 rad/s (x0.7..1.2 by a 53 s sine, hard cap `MAX_YAW_RATE` 0.075 = 4.3 deg/s), elevation 0.36 +- 0.09 rad (43 s sine), no roll, never a cut. Motion is a critically damped spring per
  axis (target 0.9 rad/s natural frequency, log-distance 1.2, elevation 1.0) with speed limits (target 0.22 x distance per second, log-distance 0.6/s). Measured offline over the 142-file commit at 1280x800
  (`npm run director-trace`): fixed world points cross the screen at <= ~95 px/s (typically < 40) with smooth acceleration, so labels, which re-project every frame, stay readable and do not swim.
- *Safety*: the eye is kept outside the ellipsoid inscribed in the bbox (0.8 x half extents; `clearDistance`, applied to the goal and again to the sprung pose) and distance stays >= max(10, 0.18 x scene radius); an empty or
  tiny mold uses the same 60/60/30 minimum extents as the camera fit, and nothing happens until a frame with segments has arrived.
- *Hand-off*: `input()` (pointer down/move while dragging, wheel, pinch, double-click / `R` reset) drops `authority` (the time dilation applied to every spring) with tau 0.18 s, so the camera glides to a halt; a held
  pointer keeps it away; after `RESUME_DELAY` = 6 s of quiet (counted in frame `dt`, so a hidden tab does not count) authority rises with tau 1.2 s from rest, so it eases in without a lurch. The chrome button shows who holds the
  camera (`data-state`: `directing` filled dot, `user` ring, `standby`, `off`).
- *Seeks and loading*: a jump (`H.seeking`, tick going backwards, or forward by > 400 ticks, or the first frame) clears the activity filters and holds the follow shot off for 2 s (gain ramp), so the springs just carry the
  camera to the new establishing shot under the speed limits (no whiplash); the backdrop's loop re-seek uses the same path.
- *Reduced motion*: the director still runs, with every rate and time constant scaled by 0.35 (azimuth ~0.0175 rad/s). The landing backdrop's playback stays still under reduced motion (the grown mold, paused), so only that slow camera drift remains.
- Defaults: **always on**, in the viewer and the landing backdrop, with no way to turn it off from the site (no key, button or URL parameter; `?director` / `?orbit` in old links are ignored and dropped from the address bar). The hand-off above is what keeps the view explorable: input takes the camera at once, ~6 s of quiet gives it back.

Controls: left-drag = pan (parallel to the screen, scaled by distance), middle-drag = orbit, right-drag = rotate left/right around the vertical axis (context menu suppressed), wheel = zoom to cursor, double-click or `R` = reset + auto-fit,
Touch: one finger = orbit, two fingers = pinch zoom + pan, double-tap = reset.

## Running

```
npm install
npm run dev                  # http://localhost:5173  (?stress=5000&commits=120  ?seed=  ?tpc=  ?paused  ?stats  ?repo=owner/name[&branch=&max=&mode=]  ?landing  ?pacing=dates)
npm test                     # vitest: parser, tree builder, determinism, Kirchhoff balance, wither/rename
npm run bench -- 5000 120    # headless sim cost per tick (bundled, plain Node)
npm run scale -- 15000 20000 150 6   # parse + stream + checkpoint + seek check on a synthetic 20k-commit history
npm run synth-log -- out.log 15000 20000   # write a synthetic history as a git log file (for upload tests)
SCRIPT=tests/e2e/ingest_check.py npm run e2e   # (needs your own port: PORT=5199) upload / GitHub (mocked + real) end-to-end; args: stemdeck.log synth.log [--no-network]
npm run build && npm run preview
npm run e2e                  # Playwright screenshots + console check (needs .venv with playwright)
npm run e2e:perf             # Playwright stress perf (5k files)
# integration QA (docs/QA.md), against a PRODUCTION build on your own port (the CSP meta only exists there):
#   npm run build:e2e && npx vite preview --outDir dist-e2e --port 5299 --strictPort &   # the e2e build keeps window.__phloem; a normal build strips it
#   .venv/bin/python tests/e2e/web_check.py  http://127.0.0.1:5299/ OUT      # landing, loading, share link, saved histories, token, states
#   .venv/bin/python tests/e2e/qa_check.py   http://127.0.0.1:5299/ OUT      # input bindings, touch, labels, director, fps, quality, hostile data, a11y, CSP, drop, switching
#   .venv/bin/python tests/e2e/leak_check.py http://127.0.0.1:5299/ OUT A.log B.log   # A -> B -> demo cycles + long playback: heap, listeners, workers, GL objects
#   .venv/bin/python tests/e2e/migrate_check.py http://127.0.0.1:5299/             # one-time migration of the former "gitmold" storage names (details: tests/e2e/README.md)
SCRIPT=tests/e2e/orbit_check.py npm run e2e   # 3D: scripted mouse/touch controls + orbit screenshots (first10, full, 5k stress)
SCRIPT=tests/e2e/labels_check.py npm run e2e   # label screenshots, hover, mode cycling, labels-on/off cost
SCRIPT=tests/e2e/fx_check.py npm run e2e       # effects: streaming close-up sequence, the 142-file flood, 5k stress, tiers
SCRIPT=tests/e2e/fx_cost.py npm run e2e        # relative render cost per effect / tier (same frame, interleaved)
npm run director-trace -- 312 18 1 out.json    # offline auto-director: real sim + Camera + Director at 60 fps; prints the shot per 0.5 s + label-probe speed/acceleration
.venv/bin/python tests/e2e/director_check.py http://localhost:PORT/ screenshots [sequence frames handoff backdrop]   # director e2e (production build on your own port; `frames` replays TRACE=out.json)
```

URL: `?quality=high|medium|low|auto` (render tier, see Rendering). `?fps=N` caps the render loop (10-240, default 100 so a 144/240 Hz display does not burn power for nothing; `?fps=0` or `off` = uncapped; a 60 Hz display is never throttled). The stats overlay shows the cap.

Keys: Space play/pause, ←/→ previous/next commit, F fullscreen, S stats overlay (also `?stats`), R reset camera, H hide the chrome, L cycle name labels (all / active / off).
`window.__phloem` (a test hook; only in the dev server and the e2e build, `npm run build:e2e`; a normal production build strips it, see docs/WEB.md) exposes `header`, `perf`, `labels`, `setLabelMode`, `camera`, `director` (+ `manualDirector`, `directorStep(dt, n)` to drive it by hand), `renderer` (`setQuality`, `setEffects`, `effects`, `lensEnabled` (measurement switch), `lensState`, `reducedMotion`), `quality` (the governor), `web` (page behaviour: `status`, ...), `chrome`, `loader`, `client`, `commits`, `source`, `loadText`, `play`, `seek`, `seekTick` and `speed` for tests.
