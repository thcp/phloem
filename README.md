# Phloem

**Watch a git history grow like a slime mold.**

Paste the address of a public GitHub repository and Phloem replays its history in 3D, right in your browser. Folders become junctions, files become food, and every commit feeds the network. The paths that get used a lot grow thick, like the veins of a real slime mold (*Physarum polycephalum*).

**Try it: https://phloem.stemdeck.app**

Inspired by ["Mould redesigns Tokyo subway in 28 hours"](https://www.domusweb.it/en/sustainable-cities/2024/12/04/mould-redesigns-tokyo-subway-28-hours.html) (Domus, December 2024).

![Phloem landing card over the growing StemDeck history](docs/img/landing.jpg)

![A repository's history grown as a network, with names, timeline and authors](docs/img/viewer.jpg)

<p>
  <img src="docs/img/closeup.jpg" alt="Close-up of the veins under the microscope lens" width="49%" />
  <img src="docs/img/phone.jpg" alt="Phloem on a phone" width="22%" />
</p>

## What you can do

- **Open any public repository.** Type `owner/name` (it suggests as you type) or paste a GitHub link. Featured repositories open instantly.
- **Open a `git log` file** instead. Drop it anywhere on the page. It never leaves your computer.
- **Watch it grow.** A camera follows the action on its own. Grab the view whenever you want and it hands control to you, then eases back in after a few quiet seconds.
- **Read the story.** Turn on names to see who touched what, and use the timeline to jump to any commit.
- **Play some music.** There is a small player at the bottom right, and it starts when you load a repository. The glow pulses with the beat.
- **Share a moment.** The address always holds the repository and the commit you are on.

## Controls

| Mouse | Touch |
|---|---|
| Left-drag: pan | One finger: orbit |
| Middle-drag: orbit | Two fingers: pinch to zoom, drag to pan |
| Right-drag: spin left and right | Double-tap: reset |
| Wheel: zoom | |
| Double-click or `R`: reset the camera | |

Keys: `Space` play or pause, `←` and `→` previous or next commit, `L` names (all, active, off), `F` fullscreen, `S` frame stats, `H` hide the controls.

## Run it yourself

You need Node 20 or newer.

```
npm install
npm run dev          # http://localhost:5173
npm test             # unit tests
npm run build        # type-check and production build into dist/
npm run preview      # serve dist/
```

Two things to know when you run it locally:

- **No music on localhost.** The tracks are protected on purpose: only phloem.stemdeck.app may load them, so the player will say "Music unavailable" on your machine.
- **`?demo`** opens the bundled StemDeck history with no network at all. It only works in development and tests.

## URL parameters

`?repo=owner/name&branch=&max=all&t=120&labels=active&quality=auto&speed=1`

`max` defaults to `all`, which means everything your GitHub quota allows. `t` is the commit number to start at. There are a few more (`mode`, `fps`); the full table is in [docs/WEB.md](docs/WEB.md).

## Featured repositories

The repositories listed in `src/web/featured.config.json` open instantly from prebuilt histories in `public/featured/`, with no GitHub requests. To refresh them run `npm run featured` (you need `gh` and git; public repositories only, and author emails are stripped). Details are in [docs/INGESTION.md](docs/INGESTION.md).

## Privacy

Everything runs in your browser. There is no backend, no analytics and no cookies.

- **GitHub:** the only requests are the ones you start (loading a repository, or typing in the box, which asks GitHub's search for suggestions after a short pause). They go straight from your browser to `api.github.com`.
- **Token:** a GitHub token is optional. It stays in memory unless you press "Save on this device" (then it lives in `localStorage`, and you can remove it). It is only sent to `api.github.com` and never goes into a URL.
- **Saved histories:** finished loads of public repositories are kept in your browser so they reopen instantly. "Clear saved histories" removes them.
- **Music:** the tracks load from `audio.stemdeck.app` when you press play or load a repository.

## Under the hood

A static Vite and TypeScript app. The simulation runs in a Web Worker and the renderer is WebGL2. It is deployed on Cloudflare Pages, and the music sits in a Cloudflare R2 bucket in the EU.

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces fit together
- [docs/WEB.md](docs/WEB.md): URL parameters, security headers, environment variables
- [docs/DEPLOY.md](docs/DEPLOY.md): deploying it yourself
- [docs/QA.md](docs/QA.md): what was tested, known gaps, a manual checklist
- [tests/e2e/README.md](tests/e2e/README.md): the browser checks (Playwright, Python)

## License and credits

Phloem is free software under the GNU Affero General Public License, version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE). If you run a modified version as a network service, you must offer its users the source. The page links to it ("Source code (AGPL-3.0)"); a fork sets `VITE_SOURCE_URL` at build time to its own address.

- **The music is not under the AGPL.** It is all rights reserved and it is not part of this repository.
- **Font:** Fraunces, © The Fraunces Project Authors, used under the SIL Open Font License 1.1 (`src/ui/fonts/OFL.txt`).
- **Dependencies:** development dependencies are MIT, ISC, BSD-3-Clause or Apache-2.0, and none of them ships in the page.
- **Demo data:** the bundled StemDeck demo and the featured histories are commit metadata only (names, dates, subjects, file paths, no emails) from public repositories.
