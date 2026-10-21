# QA: integration pass (roadmap step 6)

> Historical note: this document was written while the app was still called gitmold. Names, hooks and storage keys below were updated to Phloem; the last section, *Rename and publication prep*, is the current state.

Six features were built concurrently in one tree (3D engine, labels, ingestion, public page, visual effects and quality tiers, auto-director,
mouse rebinding, 100 fps cap, reached-gated labels). This is the first review of the combined result: what was checked, what broke, what is
still open, and what you should look at yourself. Nothing was deployed or pushed.

Everything below ran against a **production build** (`vite build`, served by `vite preview` on a private port) in headless Chromium with
**software GL (SwiftShader, no GPU)**, so correctness and cost *ratios* are meaningful and absolute frame times are not.
Firefox, Safari, real touch hardware and any real GPU have **not** been tested.

## What was tested

| Layer | How | Result |
|---|---|---|
| Types, unit tests, build | `npx tsc --noEmit`, `npm test` (vitest; 17 files, 220 tests after the rename pass), `npm run build` | green (see the run log at the end) |
| Landing, loading, share link, saved histories, token, states, phone, reduced motion, no WebGL | `tests/e2e/web_check.py` (mocked `api.github.com`) | all pass (incl. Featured, default window, no demo/chips) |
| Uploads (real `git log` of the StemDeck clone, synthetic log, junk), mocked GitHub: rate limit mid-way + Resume, 404, Cancel + Resume, token never in a URL | `tests/e2e/ingest_check.py` (ported to the landing/pill flow) | all pass |
| Mouse bindings, touch, labels (cycle, hover, reached-gating), director, `?fps=`, quality tiers, reduced motion, hostile data, keyboard access, CSP, drop zone, switching histories mid-load | `tests/e2e/qa_check.py` | all pass |
| Leaks: load A -> B -> demo x4, then 90 s of playback at 16x | `tests/e2e/leak_check.py` | flat (below) |
| Earlier feature suites | `visual_check.py`, `orbit_check.py`, `labels_check.py`, `labels_reached_check.py` | pass, except `orbit_check` "double-tap resets" (see Known gaps) |
| Console / CSP | every scenario above records `securitypolicyviolation` events and console errors/warnings; `qa_check` also refuses any request that would leave the origin | zero violations, zero errors, zero stray requests |

How to run them: `docs/ARCHITECTURE.md` (*Running*). All of them poll `window.__phloem` instead of sleeping, because a software-GL frame takes 0.2-3 s.

## Defects found and fixed

| # | Severity | What | Fix |
|---|---|---|---|
| 1 | medium | Two load UIs existed side by side: the ingestion agent's dialog + status strip (`ui/loader.ts`, `loader.css`, `shell.ts`, `?loader`) and the page agent's landing card + status pill. The old one was constructed on every page load (hidden dialog, strip, window drag-and-drop handlers) and also owned drag-and-drop. | Removed. One flow: landing card -> status pill (progress, Cancel, Resume, rate-limit and error states) with drop-anywhere in the new `ui/dropzone.ts` (installed by the page entry, so it also works before the engine has loaded). `?loader` is gone; the ingestion e2e scripts were ported and pass. Nothing was lost: cancel/resume, rate-limit states, upload, token and saved histories all remain (they were already implemented in the new flow). |
| 2 | medium | The git log parser was quadratic on a file with no line breaks (96 MB took 24 s of CPU and unbounded memory; any hostile or binary file could freeze the ingest worker). | Lines over 1 MiB are skipped (counted as one unrecognised line); parsing resumes at the next newline. Test added. |
| 3 | medium | No upper bound on commits per upload (a 1M-commit log is ~6 GB in the tab). | Reading stops at 250,000 commits and the status says so (suggests `-n` / `--since`). Test added. |
| 4 | low | `box-sizing: border-box` lived in the engine's CSS, which loads *after* the landing card paints: the card was laid out without it until the engine chunk arrived. | Moved to `theme.css`. |
| 5 | low | The loading/rate-limit pill sat on top of the "Examples" link in the tools row. | Pill moved below the row. |
| 6 | low | The timeline card kept the old total ("commit 1 / 4") while a history was still streaming in. | Refreshed on every append. |
| 7 | low | The "no commits found" message said the command was "shown above"; on the landing card it is under "Upload a git log instead". | Text fixed. |
| 8 | low | `src/util/frameLimiter.test.ts` was outside vitest's `tests/**` include, so the 100 fps cap tests never ran. | Moved to `tests/frameLimiter.test.ts` (they pass). |
| 9 | low | Saved histories (IndexedDB) grew without bound as you open more repositories. | Only the 12 most recently fetched are kept (`MAX_SAVED`). Test added. |
| 10 | low | Empty `<link rel="canonical" href="">` and `og:url` when `SITE_URL` is not set. | The tags are omitted unless `SITE_URL` is set. |
| 11 | low | `public/_headers` had overlapping `Cache-Control` rules; hosts that merge matching rules (Cloudflare Pages) would join the conflicting values for `/assets/*`. | No overlaps any more. |
| 12 | low | The Pages workflow only ran on `main`; this repository's branch is `master`. | Triggers on both. |
| 13 | - | (withdrawn) a change to use event timestamps for double-tap was reverted: it did not hold up under CDP-synthesised touch events. | none |
| 14 | hygiene | Unused devDependency `vite-node`; scratch `scripts/_pack2.ts`; a read of a retired `sessionStorage` token key; ~130 lines of dead CSS in `style.css`. | Removed. |
| 15 | docs | `F` was documented as the stats overlay in `ARCHITECTURE.md`; it is **fullscreen** (stats is `S` or `?stats`). `?fps=` was undocumented. Several modules were described by their old names. | Docs updated. |

## Performance (software GL, a shared machine with load average 9-13, so read the numbers as pessimistic)

| Path | Main thread (rAF callback, includes GL submission + buffer upload + labels) | Worker | Notes |
|---|---|---|---|
| Full StemDeck history, ~4.5k segments, 16x playback | 0.7-1.6 ms/frame (upload 0.07 ms, labels 0.5 ms) | step 0.5-0.8 ms/tick, pack 0.3-0.5 ms | 90 s of playback: no growth |
| 5k-file stress, 52k segments, settled | 9.8 ms/frame (upload 3.1 ms for 1.7 MB, labels 1.9 ms `all` / 1.5 `active` / 0.7 `off`) | step 9-13 ms/tick, pack 5.8 ms; fast-forward 9.7 ms/tick end to end | SwiftShader needs 3.6 s per frame here, which says nothing about a GPU |
| 20,000-commit / 46.8 MB git log uploaded | first commits on screen after 5.4 s, all parsed and appended after 10.7 s; long tasks 7 (max 2.9 s, all software-GL frames); main-thread JS heap 52 MB | | the same file loaded in 0.26 s / 4.5 s on a quiet machine (`INGESTION.md`) |

A real-GPU number is the one thing this pass could not produce; see the checklist.

## Leaks

`leak_check.py`: 4 cycles of upload (StemDeck log, 336 commits) -> upload (synthetic 400 commits / 3000 files) -> demo, then 90 s of playback at 16x with all labels on.
Sampled after a forced GC each time:

| Metric | First sample | After 4 cycles + playback |
|---|---|---|
| Main-thread JS heap | 2.7 MB | 4.1 MB (flat from cycle 2 on) |
| DOM nodes | 600 | 612 |
| Event listeners | 83 | 94 (constant after the first load) |
| Web Workers alive (CDP targets and a `Worker` constructor/terminate counter) | 1 | 1 (the sim worker; the ingest worker is terminated after every file) |
| Live WebGL objects (programs, shaders, buffers, VAOs, textures, framebuffers, renderbuffers, counted by wrapping create/delete) | 11 / 22 / 3 / 4 / 7 / 7 / 1 | identical |
| Label state arrays | grow to the largest id space seen, then stay | |

Switching repositories does dispose the old state: the loader is stopped (`Loader.stop` terminates the ingest worker and aborts requests), the sim worker's
`load` replaces the simulation and clears its checkpoints, the label model and camera are reset, and `qa_check` `switch` shows that an abandoned GitHub load
neither requests anything further nor touches the new history.
IndexedDB: file uploads write nothing; GitHub loads write one saved history per repository (now capped at 12) plus one record per commit in the per-commit cache.
**The per-commit cache (`phloem-cache`, formerly `gitmold-cache`) has no cap**; it only grows with the number of distinct public commits you load (about 1-2 KB each) and "Clear saved histories" empties it.

## Security pass

* **Token.** In memory unless you press "Save on this device" (then `localStorage` under one key); "Remove saved token" erases memory and storage (tested). Sent only as
  `Authorization: Bearer` to `https://api.github.com` (every request URL is built from a fixed base, and the CSP `connect-src` allows nothing else); never in a URL or the
  share link (tested, also against the mocked API's request log); not logged (the only `console.error` calls print `GithubError`s, which carry no request details) and not in
  error text (unit-tested). `window.__phloem` (the test hook) reached the in-memory token through `web` and used to ship in production builds. **It is now compiled out**: it exists only in the dev server, in
  `npm run build:e2e` (`--mode e2e`) and with `VITE_EXPOSE_TEST_HOOKS=1`; `npm run build` runs `scripts/check-dist.mjs`, which fails if the hook is in `dist/` (see *Rename and publication prep*).
* **XSS.** `innerHTML` is used only for static templates. Repository, author, commit message, file path, error text and `?repo=` are set with `textContent` or drawn on a canvas.
  `qa_check hostile` loads a crafted log (`<img onerror>`, `<script>`, `<iframe src=javascript:>`, `<svg onload>` in author, message and path) and a JSON file, hovers the labels and
  opens the legend and tooltip: nothing executes, no element is injected, the strings appear as text. The CSP (`script-src 'self'`, no inline script or style) is a second wall.
* **Prototype pollution.** Parsing builds fresh objects field by field (`parseCommitEvents`); the tree and label model use `Map`s; paths named `__proto__`, `constructor` and a JSON
  `__proto__` key leave `Object.prototype` untouched (tested).
* **Resource exhaustion.** Fixed: the quadratic single-line case and the unbounded commit count (defects 2, 3). Still possible, self-inflicted only: a file with an absurd number of
  file lines in one commit (memory), and a multi-hundred-megabyte JSON (`JSON.parse` fails with a readable error). Both run in the ingest worker, so the page stays responsive and Cancel works.
* **Links and navigation.** The two external links (the repository on GitHub in the viewer title, the token-creation page) use `target="_blank" rel="noopener noreferrer"`. The repository
  link is built from the validated `owner/name` (`[A-Za-z0-9-]` / `[A-Za-z0-9._-]`), and no URL parameter drives a navigation, so there is no open redirect.
* **Network.** `qa_check` refuses every request outside the origin and reports it: none were made by any scenario. There is no analytics, cookie or third-party font.

## Deploy configuration (reviewed, not deployed)

* The primary host is Cloudflare Pages (`docs/DEPLOY.md`). The CSP is identical in `index.html` (meta, build only) and `public/_headers` (unit-tested); the build under it runs with zero violations: module scripts and Web Workers
  (`worker-src 'self'`), the self-hosted font (`font-src 'self'`, preloaded with `crossorigin`), IndexedDB (not governed by CSP), the lazy demo chunk, `api.github.com` (mocked in tests).
* Served from a **sub-path** (relative base, `SITE_URL` set) the app runs with zero errors; canonical / `og:*` tags are absolute then (default `SITE_URL` is https://phloem.thales.sh/).
* Favicon (svg + 32 px), apple-touch icon, 192/512 icons, manifest and the 1200x630 `og.png` all exist and are referenced relatively.
* `public/_headers`: the same CSP and security headers, immutable one-year caching for `/assets/*`, one hour for `/featured/*`, a day for icons/manifest, no overlapping `Cache-Control` rules (defect 11), no redirects or rewrites (`tests/web.test.ts`). Not verified on a real Cloudflare Pages deployment.
* `.github/workflows/ci.yml` (type-check, tests, build on push / pull request) replaced the GitHub Pages deploy workflow; `featured.yml` is manual-only.
* `screenshots/` (119 MB) is git-ignored; the README images are a small optimized set in `docs/img/`.
* The footer and the viewer's tools row carry a "Source code (AGPL-3.0)" link driven by `VITE_SOURCE_URL` (default https://github.com/thcp/phloem).

## Requested changes made during this pass

* **The auto-director is always on**, from the first frame, in the viewer and behind the landing card: the `C` key, the Director button and state dot, `?director` / `?director=0` (and their write-back to share links) were removed. `O` and `?orbit` (the turntable, permanently suppressed by the director) were removed too. Retained on purpose: any pointer, wheel or touch input takes the camera immediately and it comes back after ~6 s of quiet, otherwise nobody could explore. `prefers-reduced-motion` keeps the director **on** at 35 % of every rate (the landing backdrop's playback stays still: grown mold, paused). Old links with `?orbit` / `?director` still open and the parameters are dropped from the address bar. Tests updated: `tests/director.test.ts`, `tests/web.test.ts`, `director_check.py`, `qa_check.py`, `web_check.py`, `orbit_check.py`.
* **Default window is `all`** for every repository (landing selector, `?repo=` without `&max=`, featured/menu loads); the default is omitted from share links and nothing picks 200 silently. The card's cost line is now explicit: "All available within your quota: every commit up to 56, then 47 evenly spaced snapshots of the last 1,000 (60 requests an hour without a token)". The no-token cap (1,000 / 20,000 with a token), partial results and Resume are unchanged.
* **No demo button, no example chips.** The landing offers only the two Featured cards (stemdeck, netbattle) plus the repository field and the upload; the top-bar menu is now "Featured" with the same two entries by display name (`netbattle`, also in the title and status pill). `?demo` survives as a dev/test parameter (documented as such); the bundled history is the landing backdrop. `src/web/examples.ts` is gone.
* **`featured.yml`** no longer commits weekly for nothing: an unchanged repository (same head, commit count and byte size) keeps its previous `generatedAt` (`stableEntry`, unit-tested), so the regenerated `index.json` is byte-identical. Config only; not run.
* **License: AGPL-3.0-only** (SPDX `AGPL-3.0-only`; the canonical `agpl-3.0.txt` from gnu.org, 661 lines / 34,523 bytes, sections 0-17, section 13 and the END OF TERMS marker verified, installed unmodified as `LICENSE`). `package.json` `"license": "AGPL-3.0-only"`; `// SPDX-License-Identifier: AGPL-3.0-only` (CSS: block comment, scripts: `#`) heads every source, script and test file (97 files; fixtures, JSON, fonts and public assets untouched); the README names the notice holder `Phloem contributors` (replace with a name if you want one). `VITE_SOURCE_URL` now defaults to the public repository (https://github.com/thcp/phloem); the placeholder and its build warning are gone. Fraunces (SIL OFL 1.1) keeps its full license text next to the font (`src/ui/fonts/OFL.txt`, served as `OFL-Fraunces.txt`) and a README credit. Dependencies: the lock file has 104 packages, **all development-only (nothing is bundled into the page)**: MIT 99, Apache-2.0 2 (typescript, expect-type), ISC 2, BSD-3-Clause 1: all AGPL-compatible. The StemDeck fixtures are history data of the StemDeck repository (author emails blanked): confirm you may ship them.

## Known gaps (not fixed)

* **No real-GPU measurement.** Everything about frame rate on actual hardware is untested; use the checklist below.
* Chromium only; Firefox and Safari (including `EXT_disjoint_timer_query` absence, which only affects the quality governor) are untested. Touch was emulated (CDP touch events), not tried on a device.
* `orbit_check.py` "double-tap resets" fails under software GL on the 5k scene because frames take seconds and the script waits a frame between taps; `qa_check` touch passes with a light scene.
* Scrubbing far into a never-simulated 20k-commit history costs minutes (`INGESTION.md`, *Scale*); unchanged.
* `GithubIngest` cannot append to a saved history ("Refresh" re-lists everything; cached commit details keep it cheap).
* The per-commit IndexedDB cache is unbounded (above).
* The landing page's critical path includes the GitHub client (the landing imports `parseRepoInput` from the module that also holds the whole ingest client): about 14 KB gzip for the entry chunk. Splitting it is possible and has not been done.
* Another agent was editing the tree (microscope lens: `render/lens.ts`, `renderer.ts`, `shaders.ts`, `chrome.ts`, ...) while this pass ran. The lens was **not** part of this review beyond the final regression runs.

## Manual checklist

Run `npm run build && npm run preview` (or `npm run dev`) and open the page in the browser and on the GPU you care about.

1. **Frame rate on a real GPU.** Open `/?demo&stats` (dev-only bundled history; or press **S** in any view; `F` is fullscreen). The overlay shows `fps`, `frame` (main-thread ms), `upload`, `gpu` (ms, when the browser exposes `EXT_disjoint_timer_query_webgl2`, otherwise `n/a`), `sim ms/tick`, the quality tier and `fps cap 100`. Let it play at 1x and 4x with names on, then
   load `/?stress=5000&commits=120&tpc=20&stats` and watch the tier: it should stay `high` on a decent GPU and may step down to `medium` / `low` on an integrated one (the overlay says why). Compare with `?fps=0` (uncapped) and `?quality=low` / `high`. On a 60 Hz display `fps` should read about 60; on 144/240 Hz it should read about 72-100 with the cap and more with `?fps=0`.
2. Landing: the card appears at once, the mold grows behind it; the two Featured cards (stemdeck, netbattle: instant, prebuilt), the History selector (default All available; the cost line changes with it) and the token disclosure work; there is no demo button and no example chips.
3. Upload: run the command shown under "Upload a git log instead" in a clone, then choose the file **and** drop it on the page (both). Try a junk file (clear error on the card).
4. GitHub (real): any small public repository (a handful of requests). Then a repository with more history without a token: expect the snapshot estimate; press Cancel mid-way, then Resume. Exhaust the quota if you can: the pill should name the reset time and offer Resume / "Add a token".
5. Token: add one in the popover, "Save on this device", reload (it is remembered), "Remove saved token" (gone). Check the address bar never contains it.
6. Share: press Share, open the link in a private window: same repository, position (`t=`), labels, speed.
7. Saved histories: reopen a finished repository (instant, "opened from a saved copy"), "Refresh history", then "Clear saved histories" and confirm.
8. Mouse: left-drag pans, middle-drag orbits, right does nothing and shows no menu, wheel zooms to the cursor, double-click and `R` reset. The cinematic camera is always on and has no switch: touching the view hands it to you at once and it eases back in after ~6 s of quiet; `O` and `C` do nothing. Touch device: one finger orbits, two pinch and pan, double-tap resets.
9. Labels: `L` cycles all / active / off; hover a file for the tooltip; early in a history no name should appear on empty space (names only for veins that have grown there).
10. Phone width (400 px): no horizontal scroll, controls are 44 px targets, the card and the pill fit.
11. Keyboard only: Tab through the card and the viewer, Escape closes popovers, the legend and the card, focus returns to where it came from, the scrubber moves with the arrow keys.
12. Reduced motion (OS setting): the landing mold is still, no turntable, calmer streaming, no motes.
13. Disable WebGL 2 (or use a very old browser): a readable full-page message, not a blank page.
14. DevTools console on every path above: no errors, no CSP messages.

## Rename and publication prep (gitmold -> Phloem)

Local-only pass: nothing was committed, pushed or deployed.

* **Rename.** Title, landing and viewer text, fatal-error text, manifest, Open Graph / Twitter tags, `robots.txt`, alt texts, README and docs, SPDX/copyright holder ("Phloem contributors"), env knobs (`PHLOEM_BASE`, `PHLOEM_TMP`), upload file name (`phloem.log`), scripts and e2e names. `LICENSE` untouched. CSS class prefix `gm-` and the font family name `Fraunces GM` are internal and were kept.
* **Storage migration** (`src/web/migrate.ts`, run first from `src/entry.ts`): `localStorage` `gitmold.ghtoken.saved` -> `phloem.ghtoken.saved`; `sessionStorage` `gitmold.ghtoken` removed; IndexedDB `gitmold-histories` -> `phloem-histories` and `gitmold-cache` -> `phloem-cache` (records copied, existing new records win, the old database is deleted only after a successful copy). No-op without old data (the probe aborts the upgrade so it never creates an old database), safe with blocked storage or no IndexedDB, retried on the next load after a failure. Tests: `tests/migrate.test.ts` (mocked storage and an in-memory IndexedDB backend: moves, no-ops, new wins, quota failure keeps old data, blocked storage, no IndexedDB, throwing backend) and `tests/e2e/migrate_check.py` (real browser: seeded old keys and databases are moved, old ones gone, second load is a no-op, fresh profile creates no old database, console clean).
* **Test hook hardening.** `window.__phloem` only when `import.meta.env.DEV`, `MODE === 'e2e'` or `VITE_EXPOSE_TEST_HOOKS === '1'`. `npm run build:e2e` builds `dist-e2e/` with it (all e2e scripts and docs updated to use it; dev-server scripts via `scripts/shots.sh`, which now uses its own `scripts/with-server.py`). `npm run build` ends with `scripts/check-dist.mjs`: the normal bundle contains no `__phloem`, the e2e bundle does.
* **Privacy scan.** No tokens, keys, local paths, hostnames or personal emails in the files that would be committed (test fixtures use obviously fake tokens such as `ghp_FAKE`). The two bundled fixtures (`fixtures/*.json`, also shipped in the demo chunk) carried 317 + 9 GitHub noreply author emails; they are blanked and a unit test guards it.
* **Checks run** (e2e build on a private port, software GL): see the run log below.

## Run log

Rename and publication pass (local, e2e build served on a private port, software GL): `npx tsc --noEmit` clean; `npm test` 220 tests in 17 files green; `npm run build` clean (and `check-dist` confirms no `__phloem` and no placeholder URL in `dist/`); `npm run build:e2e` clean (hook present);
against the e2e build `migrate_check.py`, `web_check.py`, `featured_check.py`, `director_check.py handoff backdrop` and `qa_check.py` all pass with zero CSP violations, console errors and stray requests. One earlier `web_check` run failed "round trip: starts at the shared position" (a timing assertion under a loaded software-GL machine); it passed on the rerun against the final build.
Known, pre-existing and unrelated: on a page *reload* headless Chromium logs a "preloaded font not used within a few seconds" warning for the Fraunces preload.
Earlier pass: `qa_check.py`, `web_check.py`, `ingest_check.py --no-network` and `director_check.py handoff backdrop` passed against the production build.
