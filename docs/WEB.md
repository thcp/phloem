# The public web page

A static site: anyone opens it, enters a public GitHub repository and watches the history grow. Everything runs in the browser; the only
server it talks to is `api.github.com`.

## What the visitor sees

1. **Landing card** (`src/ui/landing/`). Paints first from a tiny critical path (`src/entry.ts`, the landing, `theme.css`, one font; ~39 KB gzip in total).
   The engine (`src/main.ts`) loads behind it at idle or on the first interaction, then the bundled StemDeck history grows behind the card (the backdrop only; there is no demo button),
   blown up 1.55x so veins sweep past it. Reduced motion: the grown mold, still, no card animation.
   Repository field (accepts `owner/name`, a github.com URL, `owner/name@branch`, `.../tree/branch`), the **Featured** cards (the only examples: stemdeck, netbattle and Encore Karaoke, prebuilt, instant, no GitHub requests), a History selector
   (default **All available (within your quota)**; optional narrowing to the latest 100 / 200 / 500 / 1,000 / 3,000) with a live cost line, a GitHub token disclosure, and "Upload a git log instead" (exact command, copy button, file picker; dropping a file anywhere also works: `src/ui/dropzone.ts`, installed by the page entry, so it works on the card and in the viewer).
2. **Viewer chrome** (`src/ui/chrome/`). Top bar: brand (back to the card), repository (link to GitHub), Authors, Fullscreen (F). Tools row: Featured (the same three repositories, by display name), GitHub token,
   Refresh history, Clear saved histories. Timeline card (date, weekday, commit N / total). Caption of the current commit. Bottom: change-size sparkline with date ticks over the scrubber
   (hover shows the date), play/pause, counter, NAMES (Off / Active / All, `L`), VIEW (Organic / Circuit, `M`), speed. It fades after 3.5 s of playback without input (`H` hides it entirely; a paused viewer keeps its controls).
   Mouse: left-drag pan, middle-drag orbit, wheel zoom, right-drag rotate left/right around the vertical axis, double-click reset.
   Keys: Space, Left/Right, F fullscreen, S stats, R reset camera, L names, H hide chrome.
   **Cinematic camera** (`src/render/director.ts`, see ARCHITECTURE.md *Camera*): **always on**, from the first frame, in the viewer and behind the landing card. It has no switch: no button, key or URL parameter (the old `C`, `O` and `?orbit` / `?director` were removed; old links still open and the parameters are dropped from the address bar). Any camera input (drag, wheel, touch, reset) hands the camera to you at once; after about 6 s without input it eases back in, so you can always explore. Under `prefers-reduced-motion` it still runs, at 35 % of every rate.
3. **Loading, empty and error states** (`src/ui/chrome/status.ts`, `src/web/statusview.ts`, `src/ui/statusdom.ts`). Nothing on screen yet: a centred loader with progress and Cancel. Mold growing: a pill under the
   top bar (progress, requests used and left, notes about sampling). Rate limit: the reset time, Resume ("Try again now" once the reset passed) and "Add a token". Failure with nothing loaded:
   the landing card returns with the explanation (404 hints at private repositories). No WebGL 2: a full-page message.

## URL contract

All parameters are optional and the URL is kept up to date with `history.replaceState` (every 600 ms and on page hide) so copying the address bar, or pressing Share, reproduces the view.
Parsing and serialization live in `src/web/urlstate.ts` (pure, tested in `tests/web.test.ts`); `?repo=` parsing reuses `parseRepoInput` from the ingest layer.

| Parameter | Meaning |
|---|---|
| `repo=owner/name` | GitHub repository. Also accepts a github.com URL, `owner/name@branch`, `owner/name/tree/branch`. Written back as `owner/name`. |
| `branch=name` | Branch (default: the repository's default branch). |
| `max=N` or `max=all` | Window: the most recent N first-parent commits. **Default: `all`**, i.e. everything the quota allows (the default is omitted from shared links). Without a token the window is capped at 1,000, with one at 20,000 (`all` means that cap); a repository that does not fit the hourly quota commit by commit is shown as evenly spaced snapshots, and the card says so before you start. |
| `mode=auto\|commits\|snapshots` | GitHub detail mode, see `docs/INGESTION.md` (default `auto`). |
| `t=N` | Start position: **commit number N, 1-based, as the counter shows it, within the loaded window.** It is applied as soon as N commits have arrived (or the last one if the load ends shorter). Not a timestamp: the window can be sampled snapshots, so dates are not a stable key. |
| `labels=all\|active\|off` | Name labels. Default `active`. |
| `quality=auto\|high\|medium\|low` | Render quality (`auto` lets the governor step down). |
| `speed=X` | Playback speed multiplier, 0.1 to 32 (default 1). |
| `demo` | **Dev / test only**: the bundled StemDeck history, no network (the landing page has no link to it; the e2e suites use it). |
| `fps=N` | Cap on the render loop, 10 to 240 (default 100; `0` / `off` = uncapped). The stats overlay (`S`, or `?stats`) shows it. Not written back to the shared URL. |

Unknown parameters are preserved (`stats`, `seed`, `tpc`, `paused`, `fps`, `fixture=`, `stress=`). Dev/test parameters that select a history or mode (`fixture`, `stress`, `paused`, `stats`) skip the landing card.
There is a single load flow (landing card, status pill, drop zone); the first loading dialog and its `?loader` switch were removed.
A URL with no history parameter shows the landing card; an unparseable `repo=` shows it with an explanation. The token is never part of a URL.

## GitHub token

Optional. Typing a token keeps it in memory only. **Save on this device** (an explicit opt-in) writes it to `localStorage`; **Remove saved token** erases it. The panel exists on the
landing card and as a popover in the viewer (`src/ui/tokenpanel.ts`, state in `src/web/token.ts`). The token is sent only as `Authorization: Bearer` to `https://api.github.com`
(`src/ingest/github.ts` builds every request URL from a fixed base; the CSP `connect-src` enforces the same). There is no relay or proxy: Phloem talks to GitHub straight from the browser
(isomorphic-git style git relays were evaluated and rejected, see `docs/INGESTION.md`). Advice shown to users: a fine-grained token with read access to **Public repositories** only.

## Saved histories

When a GitHub load completes for a **public** repository, the finished `CommitEvent[]` is stored in IndexedDB (`phloem-histories`, `src/web/histcache.ts`) with repo, branch, window, mode, commit count and fetch time.
Opening the same repository again (same branch, same or smaller window; for sampled snapshots the same window) is instant and spends no API quota; a pill says it was opened from a saved copy and when it was fetched.
Private repositories are never written. **Refresh history** re-fetches the current repository; the ingest layer's per-commit cache (`src/ingest/idbcache.ts`) means only commits it has not seen cost requests
(the listing still costs one request per 100 commits; it cannot append to an existing history because `GithubIngest` has no "since" option, which would be the next ingestion improvement).
**Clear saved histories** asks for confirmation inside the page and wipes both caches. It reads the repository's private flag and the resolved branch from the loader's ingest session
(`webapp.ts: saveCurrent` via `Loader.githubInfo`); with no session info, nothing is saved (fail closed).

## Featured repositories

`src/web/featured.ts` matches a request (`?repo=`, the landing input or cards, the Featured menu) against `featured.config.json` (owner/name case-insensitive; branch absent or equal to the configured one). A match is served by a same-origin
`fetch` of `featured/<owner>__<repo>.json` (resolved against `document.baseURI`, so it works with `base: './'`; allowed by `connect-src 'self'`), parsed by `parseCommitEvents`, checked against `featured/index.json`'s commit count
and opened like a saved history: zero GitHub requests. `max=N` shows the most recent N commits of the prebuilt history (`all` = everything, which is the default for every repository, featured or not), `t=N` works as usual.
The viewer title and the status pill use the display name ("netbattle", not `thcp/netbattle`). The pill says "Opened the prebuilt history of ..., generated <date>"; **Refresh history** bypasses the prebuilt file and fetches from GitHub. Any fetch or validation failure falls back to the normal GitHub path.
Prebuilt histories are never written to the saved histories. The landing card shows a Featured section (display name, commit count, date range, "instant"; the numbers come from `index.json`, absent numbers just mean it could not be fetched).
Generation, privacy rules and the weekly workflow: `docs/INGESTION.md`. Tests: `tests/featured.test.ts`, `tests/e2e/featured_check.py`.

## Repository autocomplete

The landing card's field is an ARIA combobox (`role=combobox`, listbox, `aria-activedescendant`; Up/Down, Enter, Escape, mouse and touch). Choosing a suggestion only fills `owner/name` and focuses the field; it never submits. Logic without DOM: `src/web/suggest.ts` (tests: `tests/suggest.test.ts`).
Order: featured repositories, then saved histories (`listHistories()` in `histcache.ts`, read from IndexedDB on first typing), then GitHub. The GitHub part is one request, sent through `GithubApi` (same headers, the saved token as `Authorization`, only `api.github.com`):
`GET https://api.github.com/search/repositories?q=<text>&per_page=6`, only for text of 3 to 100 characters with no `/ @ # :` and no `github.com`, after a 300 ms pause; the previous request is aborted and stale answers are ignored.
Any failure (403, 429, network, odd body) is silent: the local list stays and searching pauses for 60 s (unauthenticated search allows about 10 requests a minute). Suggestion text is set with `textContent`; styles are CSS classes only. No CSP change.

## Content Security Policy

`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self' https://audio.stemdeck.app; connect-src 'self' https://api.github.com; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'`
(+ `frame-ancestors 'none'` where headers are possible). No inline script or style anywhere (the build sets `assetsInlineLimit: 0`; JS sets styles through the CSSOM, which CSP allows).
The build injects it as a `<meta>` tag (so hosts that cannot set headers enforce it too; dev server excluded for HMR) and `public/_headers` repeats it as a header;
`tests/web.test.ts` checks the two are identical, and `tests/e2e/web_check.py` fails on any `securitypolicyviolation` event.

## Deploying

The host is **Cloudflare Pages**, at https://phloem.stemdeck.app and https://phloem.thales.sh; the exact steps (create the project, environment variables, domains, music origins) are in **`docs/DEPLOY.md`**.
The build is relative-path (`base: './'`), so the same `dist/` also works on a root domain or under a sub-path.

| Variable | Effect |
|---|---|
| `SITE_URL` | Canonical origin+path for `og:url`, `og:image`, `canonical` (crawlers need absolute URLs). Default `https://phloem.stemdeck.app/`; set it to the empty string to omit `canonical` / `og:url` (relative `og:image`). |
| `VITE_SOURCE_URL` | Target of the "Source code (AGPL-3.0)" links (landing footer, viewer tools row). AGPL-3.0 section 13 requires a hosted, modified version to offer its users the corresponding source. Default `https://github.com/thcp/phloem`; a fork that hosts a modified version sets its own. |
| `PHLOEM_BASE` | Optional absolute public path (default `./`). |
| `VITE_EXPOSE_TEST_HOOKS=1` / `--mode e2e` | Builds the `window.__phloem` test hook in (see below). Never set it for a production deployment. |

`public/_headers` sets the security headers (the same CSP as the `<meta>` tag, `nosniff`, referrer, permissions and COOP policies), `max-age=31536000, immutable` for the hashed `/assets/*`,
`max-age=3600` for `/featured/*` and a day for icons, favicon and manifest. No rewrites or redirects: there are no routes. `tests/web.test.ts` checks the file.
CI (`.github/workflows/ci.yml`) type-checks, tests and builds on every push and pull request; it deploys nothing.

**Other hosts (short).** Any static host works: build with `npm run build` and publish `dist/`, and set `SITE_URL`. Netlify and Cloudflare Pages read `public/_headers` as-is (same CSP, caching, nosniff, referrer policy).
GitHub Pages cannot set headers; the CSP then comes from the `<meta>` tag only (no `frame-ancestors`), and under a project path (`/phloem/`) the relative base keeps working but `SITE_URL` must include the path. There is no Pages workflow any more.

**Test hook.** `window.__phloem` (the Playwright checks poll it) can reach the in-memory GitHub token through `web`, so it is compiled out of normal builds: `src/main.ts` installs it only when `import.meta.env.DEV`, `MODE === 'e2e'` or `VITE_EXPOSE_TEST_HOOKS === '1'`
(build-time constants, so the object is tree-shaken away otherwise). `npm run build:e2e` builds into `dist-e2e/` with it; `npm run build` ends with `scripts/check-dist.mjs`, which fails if the hook (or a placeholder URL) is in `dist/`. See `tests/e2e/README.md`.

**Data saved under the former name.** The app used to be called gitmold. On every page load `src/web/migrate.ts` (called first thing from `src/entry.ts`) moves, once, `localStorage` `gitmold.ghtoken.saved` to `phloem.ghtoken.saved`, copies the IndexedDB databases `gitmold-histories` and `gitmold-cache` into `phloem-histories` and `phloem-cache`, and then removes the old keys and databases.
Existing new-name data wins; with blocked storage, no IndexedDB or any failure nothing is lost and the page is unaffected (it retries next load). Unit-tested with mocks (`tests/migrate.test.ts`) and in a browser (`tests/e2e/migrate_check.py`).
Fonts: Fraunces (SIL OFL 1.1), subset and self-hosted, see `src/ui/fonts/README.md`.

## Performance (production build, gzip)

Critical path of the landing: `index.html` 1.0 KB + entry/landing JS 14.1 KB + CSS 3.3 KB + Fraunces 21.3 KB = about 40 KB. Deferred: engine 47.6 KB + CSS 4.1 KB + sim worker 17.1 KB + ingest worker 4.0 KB, and the 38.2 KB StemDeck demo chunk
(fetched when the backdrop or `?demo` needs it). `og.png` (about 430 KB) is only fetched by crawlers.

## Testing

`npm test` (vitest, includes `tests/web.test.ts`: URL contract, cost estimate, timeline helpers, status view model, saved-history rules, deployment config).
`tests/e2e/web_check.py` (Playwright, e2e build on your own port; `tests/e2e/README.md`) covers landing, loading, viewing, error states, the share-link round trip, token and saved-history flows, idle fade, phone layout, reduced motion and no-WebGL.
`tests/e2e/qa_check.py` and `tests/e2e/leak_check.py` cover the integrated app (input bindings, touch, labels, director, fps cap, quality tiers, hostile data, keyboard access, CSP, drag-and-drop, switching histories, leaks); see `docs/QA.md`.
`scripts/web-assets.py` regenerates the icons and `public/og.png`.
