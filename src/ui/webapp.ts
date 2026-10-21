// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The public web page's behaviour, kept apart from the engine wiring in main.ts: which history to show first, the landing backdrop,
 * the shareable URL (written back with history.replaceState while you watch), load status presentation and the hand-off to the
 * landing card (src/web/bridge.ts). See docs/WEB.md for the URL contract.
 */
import type { Loader, GithubRequest, LoadStatus } from '../ingest/session';
import type { CommitEvent } from '../model/events';
import { H } from '../sim/frame';
import type { SimClient } from '../worker/client';
import { bridge, type AppApi } from '../web/bridge';
import { describeStatus, type StatusAction } from '../web/statusview';
import { clearDetailCache } from '../ingest/idbcache';
import { parseRepoInput } from '../ingest/github';
import { age, clearHistories, getHistory, historyKey, listHistories, putHistory, reuse } from '../web/histcache';
import { describeStats, featuredWindow, fetchFeatured, generatedDay, loadFeaturedIndex, matchFeatured, type FeaturedEntry } from '../web/featured';
import { getToken } from '../web/token';
import {
  patchSearch,
  parseViewerParams,
  resolveMax,
  stateToPatch,
  wantsLanding,
  type LabelModeParam,
  type MaxSetting,
  type ViewerParams,
} from '../web/urlstate';
import type { Chrome } from './chrome/chrome';
import { StatusPill } from './chrome/status';

export interface WebContext {
  loader: Loader;
  client: SimClient;
  chrome: Chrome;
  header: Float32Array;
  camera: { snap(): void };
  labels: { mode: string };
  setLabelMode(m: LabelModeParam): void;
  commits(): CommitEvent[];
  /** The bundled StemDeck history (a lazy chunk, fetched on demand). */
  demoSource(): Promise<HistorySource>;
  /** The development / test sources of main.ts (?fixture=, ?stress=). */
  initialSource(): Promise<HistorySource>;
  /** Replace the displayed history with a complete, already-loaded one. */
  beginHistory(s: HistorySource): void;
}

export interface HistorySource {
  label: string;
  commits: CommitEvent[];
  /** Pick ticks-per-commit from the length (as loaded histories do); fixtures keep their explicit pacing. */
  auto?: boolean;
}

/** URL keys that belong to a particular history; cleared when another history replaces it. */
const CLEAR_SOURCE = { repo: null, branch: null, max: null, mode: null, t: null, demo: null } as const;

const BACKDROP_SPEED = 4;
const BACKDROP_START = 0.18; // fraction of the demo history to skip
const SYNC_MS = 600;

type Source =
  | { kind: 'none' }
  | { kind: 'github'; req: GithubRequest; max: MaxSetting }
  | { kind: 'demo' }
  | { kind: 'file'; name: string }
  | { kind: 'dev' };

export class WebApp implements AppApi {
  private src: Source = { kind: 'none' };
  private backdrop = false;
  private params: ViewerParams;
  private pendingT: number | null = null;
  private savedLabels: LabelModeParam = 'active';
  private endedTicks = 0;
  private started = false;
  private snapIn = 0;
  private fromCache = false;
  private savedGen = -1;
  /** Bumped by every load request; a slow lazy chunk that finishes after a newer request must not replace it. */
  private gen = 0;
  private lastStatus: LoadStatus | null = null;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private pill: StatusPill;

  constructor(private ctx: WebContext) {
    this.params = parseViewerParams(location.search);
    this.pill = new StatusPill(document.body, (a) => this.onAction(a));
  }

  // ------------------------------------------------------------ start
  async start(): Promise<void> {
    const p = this.params;
    if (p.labels) this.savedLabels = p.labels;
    if (p.speed) {
      this.ctx.client.setSpeed(p.speed);
      this.ctx.chrome.setSpeed(p.speed);
    }
    window.setInterval(() => this.tick(), SYNC_MS);
    window.addEventListener('pagehide', () => this.syncUrl());
    bridge.provideApp(this); // the landing card can hand over a request from now on; later loads win over the backdrop below

    if (p.repo) {
      this.pendingT = p.t;
      this.loadGithub(
        { repo: p.repo, token: getToken(), maxCommits: resolveMax(p.max, !!getToken()).max, mode: p.mode ?? 'auto' },
        p.max,
        false,
      );
    } else if (p.demo) {
      this.pendingT = p.t;
      await this.loadDemo(false);
    } else if (wantsLanding(location.search)) {
      const gen = ++this.gen;
      this.setBackdrop(true);
      const s = await this.ctx.demoSource();
      if (gen === this.gen) this.ctx.beginHistory(s);
    } else {
      // ?fixture= / ?stress= (development and tests)
      const gen = ++this.gen;
      this.src = { kind: 'dev' };
      this.pendingT = p.t;
      const s = await this.ctx.initialSource();
      if (gen !== this.gen) return;
      this.ctx.chrome.setSource(s.label, { shareable: true });
      this.ctx.beginHistory(s);
    }
  }

  // ------------------------------------------------------------ AppApi
  loadGithub(req: GithubRequest, max: MaxSetting = req.maxCommits, pushUrl = true, force = false): void {
    const name = `${req.repo.owner}/${req.repo.repo}`;
    const shown = matchFeatured(req.repo)?.name ?? name; // featured repositories are shown by their display name ("netbattle"), others as owner/name
    const gen = ++this.gen;
    this.src = { kind: 'github', req, max };
    this.lastStatus = null;
    this.fromCache = false;
    this.ctx.chrome.setSource(shown, { href: `https://github.com/${name}`, branch: req.repo.branch, shareable: true, refreshable: true });
    if (pushUrl) {
      this.pendingT = null;
      this.replaceUrl(patchSearch(location.search, { ...CLEAR_SOURCE, ...stateToPatch({ repo: req.repo, max, mode: req.mode }) }));
    }
    // A saved history opens instantly and spends no quota; otherwise the previous history stays up (as backdrop, if it was one)
    // until the first commits arrive; see onStatus.
    const viaGithub = (): void => {
      void (force ? Promise.resolve(null) : getHistory(historyKey(req.repo.owner, req.repo.repo, req.repo.branch))).then((saved) => {
        if (gen !== this.gen) return;
        const commits = saved ? reuse(saved, req.maxCommits) : null;
        if (saved && commits && commits.length > 0) {
          this.openSaved(name, saved.fetchedAt, commits);
          return;
        }
        this.ctx.loader.loadGithub(req).catch((e) => console.error(e));
      });
    };
    // A featured repository (src/web/featured.ts) is served from a prebuilt static file with no GitHub request; "Refresh history"
    // (force) and any failure of the fetch take the GitHub path above.
    const feat = force ? null : matchFeatured(req.repo);
    if (feat) void this.loadFeatured(feat, shown, max, gen).then((ok) => ok || gen !== this.gen || viaGithub());
    else viaGithub();
  }

  /** Show the prebuilt history of a featured repository. Resolves false (nothing shown) when it cannot be fetched or is stale. */
  private async loadFeatured(feat: FeaturedEntry, name: string, max: MaxSetting, gen: number): Promise<boolean> {
    this.onStatus({ state: 'running', message: `Loading the prebuilt history of ${name}…`, detail: 'No GitHub requests are used.', delivered: 0 });
    try {
      const index = await loadFeaturedIndex();
      const stats = index.find((s) => s.repo.toLowerCase() === feat.repo.toLowerCase());
      const { commits } = await fetchFeatured(feat, { stats });
      if (gen !== this.gen) return true; // superseded: someone else owns the screen now
      const shown = featuredWindow(commits, max);
      this.fromCache = true; // a prebuilt history is never written to the saved histories
      this.ctx.loader.stop();
      this.setBackdrop(false);
      this.ctx.beginHistory({ label: name, commits: shown, auto: true });
      const day = generatedDay(stats);
      this.onStatus({
        state: 'done',
        message: `Opened the prebuilt history of ${name}${day ? `, generated ${day}` : ''}.`,
        detail: `${describeStats(stats) || `${commits.length.toLocaleString()} commits`}${shown.length < commits.length ? `; showing the latest ${shown.length.toLocaleString()}` : ''}. No GitHub requests were used.`,
        notes: ['Use “Refresh history” to fetch the latest commits from GitHub.'],
        delivered: shown.length,
      });
      return true;
    } catch (e) {
      console.warn('featured history unavailable, falling back to GitHub:', e);
      this.pill.hide();
      return false;
    }
  }

  private openSaved(name: string, fetchedAt: number, commits: CommitEvent[]): void {
    this.fromCache = true;
    this.ctx.loader.stop();
    this.setBackdrop(false);
    this.ctx.beginHistory({ label: name, commits, auto: true });
    this.onStatus({
      state: 'done',
      message: `Opened the saved history of ${name}.`,
      detail: `${commits.length.toLocaleString()} commits, fetched ${age(fetchedAt)}. No GitHub requests were used.`,
      notes: ['Use “Refresh history” to check for newer commits.'],
      delivered: commits.length,
    });
  }

  /** Re-fetch the current repository. Commit details already cached by the ingest layer cost no requests, so only new commits are paid for. */
  refresh(): void {
    if (this.src.kind !== 'github') return;
    const { req, max } = this.src;
    this.pendingT = null;
    this.loadGithub({ ...req, token: getToken() }, max, false, true);
  }

  loadExample(repo: string): void {
    const ref = parseRepoInput(repo);
    if (!ref) return;
    const token = getToken();
    this.loadGithub({ repo: ref, token, maxCommits: resolveMax('all', !!token).max, mode: 'auto' }, 'all'); // the whole history, like every load by default
  }

  async savedCount(): Promise<number> {
    return (await listHistories()).length;
  }

  /** Forget every saved history and the per-commit cache of the ingest layer. */
  async clearSaved(): Promise<void> {
    await Promise.all([clearHistories(), clearDetailCache()]);
  }

  /** Keep a finished public load for next time. Reads the ingest session through the loader (it is the only holder of the repo's private flag). */
  private saveCurrent(s: LoadStatus): void {
    if (this.src.kind !== 'github' || this.fromCache || this.savedGen === this.gen) return;
    const ing = this.ctx.loader.githubInfo;
    if (!ing || ing.isPrivate) return; // private repositories are never written to disk; no session info means we cannot tell
    const commits = this.ctx.commits();
    if (commits.length === 0 || commits.length !== s.delivered) return;
    this.savedGen = this.gen;
    const { req } = this.src;
    const mode = ing.mode ?? (/snapshot/i.test(s.message) ? 'snapshots' : 'commits');
    void putHistory({
      key: historyKey(req.repo.owner, req.repo.repo, req.repo.branch),
      repo: `${req.repo.owner}/${req.repo.repo}`,
      branch: ing.branch,
      max: req.maxCommits,
      mode,
      fetchedAt: Date.now(),
      count: commits.length,
      commits: commits.slice(),
    });
  }

  loadFile(file: File): void {
    this.gen++;
    this.src = { kind: 'file', name: file.name };
    this.pendingT = null;
    this.ctx.chrome.setSource(file.name, { shareable: false, shareNote: 'This history comes from a file on your computer, so a link cannot reproduce it. Share the repository link instead.' });
    this.replaceUrl(patchSearch(location.search, CLEAR_SOURCE));
    this.ctx.loader.loadFile({ file, name: file.name });
  }

  async loadDemo(pushUrl = true): Promise<void> {
    const gen = ++this.gen;
    this.src = { kind: 'demo' };
    this.ctx.loader.stop();
    this.pill.hide();
    this.ctx.chrome.setSource('StemDeck', { branch: 'demo', shareable: true });
    if (pushUrl) {
      this.pendingT = null;
      this.replaceUrl(patchSearch(location.search, { ...CLEAR_SOURCE, demo: true }));
    }
    const s = await this.ctx.demoSource();
    if (gen !== this.gen) return;
    this.setBackdrop(false);
    this.ctx.beginHistory(s);
  }

  retry(): void {
    if (this.src.kind === 'github') this.loadGithub(this.src.req, this.src.max);
  }
  cancel(): void {
    this.ctx.loader.cancel();
  }
  resume(): void {
    this.ctx.loader.resume();
  }

  /** Landing backdrop: the mold alone, filmed by the auto-director (always on), looping. */
  setBackdrop(on: boolean): void {
    if (on === this.backdrop) return;
    const c = this.ctx;
    this.backdrop = on;
    c.chrome.setBackdrop(on);
    document.documentElement.classList.toggle('gm-backdrop', on);
    if (on) {
      this.savedLabels = (c.labels.mode as LabelModeParam) ?? 'active';
      c.setLabelMode('off');
      c.client.setSpeed(BACKDROP_SPEED);
      this.started = false;
      this.endedTicks = 0;
      this.pill.hide();
    } else {
      c.setLabelMode(this.savedLabels);
      c.client.setSpeed(c.chrome.speed);
    }
  }

  // ------------------------------------------------------------ status
  /** Wired as the Loader's status callback. */
  onStatus(s: LoadStatus): void {
    this.lastStatus = s;
    if (s.state === 'done') this.saveCurrent(s);
    const v = describeStatus(s, { hasToken: !!getToken() });
    if (v.blocking && (v.tone === 'error' || v.tone === 'warn')) {
      // nothing loaded: the failure belongs on the card, where the next attempt starts
      this.pill.hide();
      bridge.landing?.show({ status: s, overlay: !this.backdrop });
      return;
    }
    if (!v.blocking && this.backdrop) this.setBackdrop(false);
    this.pill.set(v);
  }

  private onAction(a: StatusAction): void {
    if (a === 'cancel') this.cancel();
    else if (a === 'resume') this.resume();
    else if (a === 'token') bridge.landing?.show({ overlay: true, focusToken: true });
    else if (a === 'open') bridge.landing?.show({ overlay: true });
    else this.pill.hide();
  }

  // ------------------------------------------------------------ URL + housekeeping
  private tick(): void {
    if (this.backdrop) return this.tickBackdrop();
    this.applyPendingT();
    this.syncUrl();
  }

  private tickBackdrop(): void {
    const c = this.ctx;
    const h = c.header;
    const n = c.commits().length;
    if (n === 0 || h[H.commit] < 0) return; // no frame yet
    // Skip the empty first moments: start with a mold that already has some body, and loop from there.
    const start = Math.min(n - 1, Math.round(n * BACKDROP_START));
    if (!this.started) {
      this.started = true;
      c.client.seek(this.reduced ? n - 1 : start);
      this.snapIn = 2; // after a jump the framing should not have to crawl from the old bounding box
      if (this.reduced) c.chrome.setPlaying(false, true); // no motion for people who asked for none: the grown mold, still
      return;
    }
    if (this.snapIn > 0 && --this.snapIn === 0) c.camera.snap();
    if (this.reduced) return;
    if (h[H.ended] === 1) {
      if (++this.endedTicks >= 6) {
        this.endedTicks = 0;
        c.client.seek(start);
        this.snapIn = 2;
        c.client.setPlaying(true);
        c.chrome.setPlaying(true, false);
      }
    } else this.endedTicks = 0;
  }

  /** `t=N`: jump to commit number N once that many commits have arrived (or the load ended with fewer: go to the last). */
  private applyPendingT(): void {
    const t = this.pendingT;
    if (t === null) return;
    const n = this.ctx.commits().length;
    const done = !this.ctx.loader.active;
    if (n === 0 || (n < t && !done)) return;
    this.pendingT = null;
    const target = Math.min(t, n);
    if (target > 0) this.ctx.client.seek(target - 1);
  }

  private replaceUrl(search: string): void {
    if (search === location.search) return;
    try {
      history.replaceState(null, '', location.pathname + search + location.hash);
    } catch {
      /* sandboxed or blocked: sharing still works through the copied URL */
    }
  }

  /** Write what is on screen into the address bar so that copying it reproduces the view. */
  syncUrl(): string {
    const c = this.ctx;
    if (this.backdrop || this.src.kind === 'none' || this.src.kind === 'file') return location.href;
    const patch = stateToPatch({
      labels: c.labels.mode as LabelModeParam,
      speed: c.chrome.speed,
      circuit: c.chrome.circuit,
      // clamped: a stale frame of the previous history can briefly report a commit number past the new, shorter one
      ...(this.pendingT === null ? { commitNumber: Math.min(c.chrome.commitNumber, c.commits().length) } : {}),
    });
    this.replaceUrl(patchSearch(location.search, patch));
    return location.href;
  }

  get status(): LoadStatus | null {
    return this.lastStatus;
  }
}
