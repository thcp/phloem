// SPDX-License-Identifier: AGPL-3.0-only
import type { CommitEvent } from '../../model/events';
import { authorHue } from '../../model/rng';
import { FEATURED } from '../../web/featured';
import { densityBins, formatFullDate, timelineTicks } from '../../web/timeline';
import { TokenPanel } from '../tokenpanel';
import { sourceLink } from '../../web/source';
import { ICON, MARK } from './icons';
import './chrome.css';

/**
 * Viewer chrome: top bar (repo, names, share, authors, fullscreen), caption, timeline with dates and a change-size sparkline,
 * transport controls. Fades out when idle so the mold is the hero. Presentational: talks to the app through ChromeHandlers.
 * It keeps the call surface of the older `Shell` (src/ui/shell.ts) so main.ts could swap one for the other.
 */
export interface ChromeHandlers {
  onPlay(playing: boolean): void;
  onSeek(commit: number): void;
  onSpeed(speed: number): void;
  onStats(visible: boolean): void;
  onResetCamera(): void;
  onCycleLabels(): void;
  onPacing(pacing: 'even' | 'dates'): void;
  onCircuit(on: boolean): void;
  /** The "visualize another" button / Escape-less entry back to the landing card. */
  onOpenLanding(opener: HTMLElement): void;
  /** Called right before the link is copied: return the URL to share (the page refreshes its URL first). */
  onShare(): string;
  /** Load one of the featured repositories (the whole history). */
  onExample(repo: string): void;
  /** Re-fetch the current repository (only commits not cached cost requests). */
  onRefresh(): void;
  /** How many histories are saved on this device, and erase them. */
  savedCount(): Promise<number>;
  onClearSaved(): Promise<void>;
}

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16];
const IDLE_MS = 3500;
const SPARK_BINS = 160;

const hsl = (author: string): string => `hsl(${Math.round(authorHue(author) * 360)},62%,76%)`;

export class Chrome {
  readonly el: HTMLElement;
  readonly stats: HTMLElement;
  private q: <T extends HTMLElement>(s: string) => T;
  private playBtn: HTMLButtonElement;
  private scrub: HTMLInputElement;
  private nEl: HTMLElement;
  private totEl: HTMLElement;
  private dateEl: HTMLElement;
  private speedSel: HTMLSelectElement;
  private pacingBtn: HTMLButtonElement;
  private styleBtns: HTMLButtonElement[];
  private labelsBtn: HTMLButtonElement;
  private legendBtn: HTMLButtonElement;
  private legend: HTMLElement;
  private fsBtn: HTMLButtonElement;
  private shareBtn: HTMLButtonElement;
  private repoEl: HTMLElement;
  private branchEl: HTMLElement;
  private msg: HTMLElement;
  private meta: HTMLElement;
  private tip: HTMLElement;
  private ticksEl: HTMLElement;
  private spark: HTMLCanvasElement;
  private toast: HTMLElement;
  private pop: HTMLElement;
  private popOwner: HTMLElement | null = null;
  private tokenPanel = new TokenPanel();
  private tcDate: HTMLElement;
  private tcSub: HTMLElement;
  private tcLive: HTMLElement;
  private liveTimer = 0;
  private liveText = '';
  private refreshBtn: HTMLButtonElement;
  private toastTimer = 0;
  private idleTimer = 0;
  private hidden = false;
  private streaming = false;
  private waiting = false;
  private playing = true;
  private shownCommit = -2;
  private scrubbing = false;
  private commits: CommitEvent[] = [];
  private dates: number[] = [];
  private bins: number[] = [];
  private shareable = true;
  private shareNote = '';
  private legendAt = 0;
  private legendCount = -1;
  private sparkDrawnAt = '';

  constructor(
    root: HTMLElement,
    private h: ChromeHandlers,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'gm-chrome';
    this.el.innerHTML = `
<div class="gm-top">
  <button type="button" class="gm-ibtn gm-new" title="Visualize another repository">${MARK}<span class="gm-lbl gm-brandword">Phloem</span></button>
  <div class="gm-title"><span class="gm-repo"></span><span class="gm-branch"></span></div>
  <div class="gm-actions">
    <button type="button" class="gm-ibtn gm-names" aria-pressed="true" title="Name labels: all, active, off (L)">${ICON.names}<span class="gm-lbl">Names</span></button>
    <button type="button" class="gm-ibtn gm-share" title="Copy a link to this view">${ICON.share}<span class="gm-lbl">Share</span></button>
    <button type="button" class="gm-ibtn gm-legend-btn" aria-expanded="false" aria-controls="gm-legend" title="Authors">${ICON.people}<span class="gm-lbl">Authors</span></button>
    <button type="button" class="gm-ibtn gm-fs" aria-pressed="false" title="Fullscreen (F)" hidden>${ICON.expand}<span class="gm-lbl">Fullscreen</span></button>
  </div>
  <nav class="gm-links" aria-label="Repositories and storage">
    <button type="button" class="gm-link gm-ex-btn" aria-haspopup="dialog" aria-expanded="false">Featured</button>
    <button type="button" class="gm-link gm-tok-btn" aria-haspopup="dialog" aria-expanded="false">GitHub token</button>
    <button type="button" class="gm-link gm-refresh" hidden title="Fetch this repository again; commits already cached cost no requests">Refresh history</button>
    <button type="button" class="gm-link gm-clear" aria-haspopup="dialog" aria-expanded="false">Clear saved histories</button>
  </nav>
</div>
<div class="gm-pop" role="dialog" aria-label="" hidden></div>
<aside class="gm-tcard" aria-label="Timeline">
  <span class="gm-tc-label">Timeline</span>
  <div class="gm-tc-date" aria-hidden="true"></div>
  <div class="gm-tc-sub" aria-hidden="true"></div>
  <p class="gm-sr gm-tc-live" aria-live="polite"></p>
</aside>
<aside id="gm-legend" class="gm-legend" aria-label="Authors" hidden></aside>
<pre class="gm-stats" hidden></pre>
<div class="gm-caption" aria-live="polite"><p class="gm-msg"></p><div class="gm-meta"></div></div>
<div class="gm-bottom">
  <div class="gm-timeline">
    <canvas class="gm-spark" aria-hidden="true"></canvas>
    <input class="gm-scrub" type="range" min="0" max="0" step="1" value="0" aria-label="Commit" />
    <div class="gm-tip" aria-hidden="true" hidden></div>
    <div class="gm-ticks" aria-hidden="true"></div>
  </div>
  <div class="gm-controls">
    <button type="button" class="gm-play" aria-label="Pause">${ICON.pause}</button>
    <div class="gm-readout"><span class="gm-n"></span><span class="gm-tot"></span><span class="gm-date"></span></div>
    <span class="gm-grow"></span>
    <div class="gm-seg" role="radiogroup" aria-label="Visualization style" title="Visualization style. Press M to switch.">
      <button type="button" role="radio" aria-checked="true" data-style="organic">${ICON.organic}<span>Organic</span></button>
      <button type="button" role="radio" aria-checked="false" data-style="circuit">${ICON.circuit}<span>Circuit</span></button>
    </div>
    <button type="button" class="gm-pill gm-pacing" aria-pressed="false" title="Space commits by their real dates (long idle gaps are compressed)">By date</button>
    <label class="gm-speedwrap"><span class="gm-sr">Speed</span><select class="gm-speed">${SPEEDS.map((s) => `<option value="${s}"${s === 1 ? ' selected' : ''}>${s}×</option>`).join('')}</select></label>
  </div>
</div>
<div class="gm-toast" role="status"></div>`;
    this.el.querySelector('.gm-links')!.append(sourceLink('gm-link gm-src'));
    root.append(this.el);
    const q = <T extends HTMLElement>(s: string) => this.el.querySelector(s) as T;
    this.q = q;
    this.playBtn = q('.gm-play');
    this.scrub = q('.gm-scrub');
    this.nEl = q('.gm-n');
    this.totEl = q('.gm-tot');
    this.dateEl = q('.gm-date');
    this.speedSel = q('.gm-speed');
    this.pacingBtn = q('.gm-pacing');
    this.styleBtns = Array.from(this.el.querySelectorAll<HTMLButtonElement>('.gm-seg button'));
    this.labelsBtn = q('.gm-names');
    this.legendBtn = q('.gm-legend-btn');
    this.legend = q('.gm-legend');
    this.fsBtn = q('.gm-fs');
    this.shareBtn = q('.gm-share');
    this.repoEl = q('.gm-repo');
    this.branchEl = q('.gm-branch');
    this.msg = q('.gm-msg');
    this.meta = q('.gm-meta');
    this.tip = q('.gm-tip');
    this.ticksEl = q('.gm-ticks');
    this.spark = q('.gm-spark');
    this.toast = q('.gm-toast');
    this.stats = q('.gm-stats');
    this.pop = q('.gm-pop');
    this.tcDate = q('.gm-tc-date');
    this.tcSub = q('.gm-tc-sub');
    this.tcLive = q('.gm-tc-live');
    this.refreshBtn = q('.gm-refresh');
    q<HTMLButtonElement>('.gm-ex-btn').addEventListener('click', (e) => this.togglePop('examples', e.currentTarget as HTMLElement));
    q<HTMLButtonElement>('.gm-tok-btn').addEventListener('click', (e) => this.togglePop('token', e.currentTarget as HTMLElement));
    q<HTMLButtonElement>('.gm-clear').addEventListener('click', (e) => this.togglePop('clear', e.currentTarget as HTMLElement));
    this.refreshBtn.addEventListener('click', () => {
      this.closePop();
      h.onRefresh();
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.pop.hidden) return;
      const t = e.target as Node;
      if (!this.pop.contains(t) && !this.el.querySelector('.gm-links')!.contains(t)) this.closePop(false);
    });

    this.playBtn.addEventListener('click', () => this.setPlaying(!this.playing, true));
    this.scrub.addEventListener('input', () => {
      this.scrubbing = true;
      this.queueLive();
      this.setScrubVar();
      this.showTip(Number(this.scrub.value));
      h.onSeek(Number(this.scrub.value));
    });
    this.scrub.addEventListener('change', () => {
      this.scrubbing = false;
      this.queueLive();
      this.tip.hidden = true;
    });
    this.scrub.addEventListener('pointermove', (e) => {
      const r = this.scrub.getBoundingClientRect();
      const n = this.commits.length;
      if (n < 2 || r.width <= 0) return;
      this.showTip(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (n - 1)));
    });
    this.scrub.addEventListener('pointerleave', () => {
      if (!this.scrubbing) this.tip.hidden = true;
    });
    this.speedSel.addEventListener('change', () => h.onSpeed(Number(this.speedSel.value)));
    this.pacingBtn.addEventListener('click', () => h.onPacing(this.pacingBtn.getAttribute('aria-pressed') === 'true' ? 'even' : 'dates'));
    for (const b of this.styleBtns) {
      b.addEventListener('click', () => {
        const on = b.dataset.style === 'circuit';
        if (on !== this.circuit) h.onCircuit(on);
        b.blur(); // hand the keyboard back (Space, arrows, M)
      });
    }
    this.labelsBtn.addEventListener('click', () => h.onCycleLabels());
    this.shareBtn.addEventListener('click', () => void this.share());
    q<HTMLButtonElement>('.gm-new').addEventListener('click', (e) => h.onOpenLanding(e.currentTarget as HTMLButtonElement));
    this.legendBtn.addEventListener('click', () => this.setLegend(this.legend.hidden));
    if (document.fullscreenEnabled) {
      this.fsBtn.hidden = false;
      this.fsBtn.addEventListener('click', () => this.toggleFullscreen());
      document.addEventListener('fullscreenchange', () => {
        const on = !!document.fullscreenElement;
        this.fsBtn.setAttribute('aria-pressed', String(on));
        this.fsBtn.innerHTML = `${on ? ICON.collapse : ICON.expand}<span class="gm-lbl">${on ? 'Exit fullscreen' : 'Fullscreen'}</span>`;
        this.fsBtn.title = on ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
      });
    }

    // idle fade: any sign of life wakes the chrome; a few quiet seconds while playing hides it
    for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const) window.addEventListener(ev, () => this.wake(), { passive: true });
    this.el.addEventListener('focusin', () => this.wake());
    this.wake();

    new ResizeObserver(() => this.drawSpark(true)).observe(this.spark);
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  // ------------------------------------------------------------ state from the app
  setCommits(commits: CommitEvent[]): void {
    this.commits = commits;
    this.shownCommit = -2;
    this.rebuildTimeline();
    this.scrub.max = String(Math.max(0, commits.length - 1));
    this.scrub.value = '0';
    this.setScrubVar();
    this.legendCount = -1;
    this.updateLegend(true);
  }

  /** The commits array grew (streaming ingestion). */
  refreshCount(): void {
    const n = this.commits.length;
    this.scrub.max = String(Math.max(0, n - 1));
    this.writeCount(this.shownCommit);
    if (this.shownCommit >= 0) this.writeCard(this.shownCommit); // "commit i / n": n grew
    const now = performance.now();
    if (now - this.legendAt > 700) {
      this.legendAt = now;
      this.rebuildTimeline();
      this.updateLegend(false);
    }
  }

  setStreaming(streaming: boolean, waiting: boolean): void {
    if (streaming === this.streaming && waiting === this.waiting) return;
    const was = this.streaming;
    this.streaming = streaming;
    this.waiting = waiting;
    this.writeCount(this.shownCommit);
    if (was && !streaming) {
      this.rebuildTimeline();
      this.updateLegend(true);
    }
  }

  setPacing(p: 'even' | 'dates'): void {
    this.pacingBtn.setAttribute('aria-pressed', String(p === 'dates'));
  }

  get circuit(): boolean {
    return this.styleBtns.some((b) => b.dataset.style === 'circuit' && b.getAttribute('aria-checked') === 'true');
  }

  setCircuit(on: boolean): void {
    for (const b of this.styleBtns) b.setAttribute('aria-checked', String((b.dataset.style === 'circuit') === on));
  }

  setLabelMode(mode: string): void {
    this.q('.gm-names .gm-lbl').textContent = `Names: ${mode}`;
    this.labelsBtn.setAttribute('aria-pressed', String(mode !== 'off'));
    this.labelsBtn.title = `Name labels: ${mode}. Click or press L to change.`;
  }

  setSpeed(s: number): void {
    if (![...this.speedSel.options].some((o) => Number(o.value) === s)) {
      const opt = new Option(`${s}×`, String(s));
      const i = [...this.speedSel.options].findIndex((o) => Number(o.value) > s);
      this.speedSel.add(opt, i < 0 ? null : this.speedSel.options[i]);
    }
    this.speedSel.value = String(s);
  }

  get speed(): number {
    return Number(this.speedSel.value);
  }

  /** What is being shown. `repoHref` makes the title a link; `shareNote` explains why sharing is not available (local files). */
  setSource(label: string, o: { href?: string; branch?: string; shareable?: boolean; shareNote?: string; refreshable?: boolean } = {}): void {
    this.refreshBtn.hidden = !o.refreshable;
    // an <a> only when there is somewhere to go (a link without an href is not a link)
    const el = document.createElement(o.href ? 'a' : 'span');
    el.className = 'gm-repo';
    el.textContent = label;
    if (el instanceof HTMLAnchorElement && o.href) {
      el.href = o.href;
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
    }
    this.repoEl.replaceWith(el);
    this.repoEl = el;
    this.branchEl.textContent = o.branch ? `@${o.branch}` : '';
    this.shareable = o.shareable ?? true;
    this.shareNote = o.shareNote ?? '';
    this.shareBtn.setAttribute('aria-disabled', String(!this.shareable));
    document.title = label ? `${label} · Phloem` : 'Phloem';
  }

  /** Landing backdrop: no chrome at all, the mold only. */
  setBackdrop(on: boolean): void {
    this.el.classList.toggle('is-backdrop', on);
    if (!on) this.wake();
  }

  toggleStats(): void {
    const show = this.stats.hidden;
    this.stats.hidden = !show;
    this.h.onStats(show);
  }

  setPlaying(playing: boolean, notify: boolean): void {
    if (playing === this.playing && !notify) return;
    this.playing = playing;
    this.playBtn.innerHTML = playing ? ICON.pause : ICON.play;
    this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (notify) this.h.onPlay(playing);
    this.queueLive();
    this.wake();
  }

  /** The commit shown right now, as a 1-based number (0 = none yet). */
  get commitNumber(): number {
    return Math.max(0, this.shownCommit + 1);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Reflect sim progress. Cheap when nothing changed (called every frame). Returns true when the caption changed. */
  showCommit(index: number): boolean {
    if (index === this.shownCommit) return false;
    this.shownCommit = index;
    if (!this.scrubbing) this.scrub.value = String(Math.max(0, index));
    this.setScrubVar();
    this.writeCount(index);
    this.drawSpark(false);
    const c = index >= 0 ? this.commits[index] : undefined;
    if (!c) {
      this.msg.textContent = '';
      this.meta.textContent = '';
      this.dateEl.textContent = '';
      this.tcDate.textContent = '';
      this.tcSub.textContent = '';
      return true;
    }
    this.writeCard(index);
    this.msg.textContent = c.message;
    const date = formatFullDate(this.dates[index]) || c.date;
    this.dateEl.textContent = date;
    this.meta.replaceChildren();
    const dot = document.createElement('i');
    dot.className = 'gm-dot';
    dot.style.background = hsl(c.author);
    const b = document.createElement('b');
    b.textContent = c.author;
    this.meta.append(dot, b, ` ${date}, ${c.files.length} file${c.files.length === 1 ? '' : 's'}`);
    this.scrub.setAttribute('aria-valuetext', `Commit ${index + 1} of ${this.commits.length}, ${date}`);
    return true;
  }

  /** Rectangles labels should avoid: the caption and the top bar. Flat [x, y, w, h, ...] in CSS px. */
  obstacleRects(): number[] {
    const out: number[] = [];
    if (this.el.classList.contains('is-backdrop')) return out;
    const r = this.q('.gm-caption').getBoundingClientRect();
    if (r.width > 0) out.push(r.left - 8, r.top - 6, r.width + 16, r.height + 12);
    const t = this.q('.gm-top').getBoundingClientRect();
    if (t.width > 0) out.push(t.left, t.top, t.width, t.height);
    return out;
  }

  // ------------------------------------------------------------ internals
  /** The Timeline card: big date, weekday and commit position. The screen-reader copy is throttled and silent while playing. */
  private writeCard(index: number): void {
    const t = this.dates[index];
    const d = new Date(t);
    const ok = !Number.isNaN(d.getTime());
    const date = ok ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const weekday = ok ? d.toLocaleDateString('en-GB', { weekday: 'long' }) : '';
    const n = this.commits.length;
    const pos = `commit ${(index + 1).toLocaleString()} / ${n.toLocaleString()}${this.streaming ? '+' : ''}`;
    this.tcDate.textContent = date;
    this.tcSub.textContent = weekday ? `${weekday} · ${pos}` : pos;
    this.liveText = `${date}${weekday ? `, ${weekday}` : ''}, ${pos}`;
    this.queueLive();
  }

  private queueLive(): void {
    window.clearTimeout(this.liveTimer);
    if (this.playing && !this.scrubbing) return; // no running commentary during playback
    this.liveTimer = window.setTimeout(() => (this.tcLive.textContent = this.liveText), 800);
  }

  // ------------------------------------------------------------ popovers (examples, token, clear saved)
  private togglePop(kind: 'examples' | 'token' | 'clear', trigger: HTMLElement): void {
    if (!this.pop.hidden && this.popOwner === trigger) return this.closePop();
    this.closePop(false);
    this.popOwner = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    this.pop.replaceChildren();
    if (kind === 'examples') {
      this.pop.setAttribute('aria-label', 'Featured repositories');
      const p = document.createElement('p');
      p.className = 'gm-pop-lead';
      p.textContent = 'Prebuilt histories: the whole repository, instant, no GitHub requests.';
      const ul = document.createElement('ul');
      ul.className = 'gm-ex-list';
      for (const f of FEATURED) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'gm-ex-item';
        b.textContent = f.name;
        b.title = f.repo;
        b.addEventListener('click', () => {
          this.closePop(false);
          this.h.onExample(f.repo);
        });
        li.append(b);
        ul.append(li);
      }
      this.pop.append(p, ul);
    } else if (kind === 'token') {
      this.pop.setAttribute('aria-label', 'GitHub token');
      this.pop.append(this.tokenPanel.el);
    } else {
      this.pop.setAttribute('aria-label', 'Clear saved histories');
      const p = document.createElement('p');
      p.className = 'gm-pop-lead';
      p.textContent = 'Checking…';
      const row = document.createElement('div');
      row.className = 'gm-tp-row';
      this.pop.append(p, row);
      void this.h.savedCount().then((n) => {
        if (this.popOwner !== trigger) return;
        row.replaceChildren();
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'gm-btn';
        cancel.textContent = n === 0 ? 'Close' : 'Cancel';
        cancel.addEventListener('click', () => this.closePop());
        if (n === 0) {
          p.textContent = 'Nothing is saved on this device yet. Finished loads of public repositories are kept here so reopening them is instant.';
          row.append(cancel);
          cancel.focus();
          return;
        }
        p.textContent = `Remove ${n.toLocaleString()} saved ${n === 1 ? 'history' : 'histories'} and the cached commit details from this device? Reopening those repositories will use GitHub requests again. Your token is not affected.`;
        const ok = document.createElement('button');
        ok.type = 'button';
        ok.className = 'gm-btn is-primary';
        ok.textContent = 'Remove them';
        ok.addEventListener('click', () => {
          void this.h.onClearSaved().then(() => {
            this.closePop();
            this.say('Saved histories removed');
          });
        });
        row.append(ok, cancel);
        cancel.focus();
      });
    }
    this.pop.hidden = false;
    this.wake();
    (this.pop.querySelector('input, button') as HTMLElement | null)?.focus();
  }

  private closePop(restoreFocus = true): void {
    const owner = this.popOwner;
    this.pop.hidden = true;
    this.popOwner = null;
    owner?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) owner?.focus();
  }

  private writeCount(index: number): void {
    const n = this.commits.length;
    if (n === 0) {
      this.nEl.textContent = '';
      this.totEl.textContent = '';
      return;
    }
    this.nEl.textContent = String(Math.max(0, index + 1));
    this.totEl.textContent = ` / ${n.toLocaleString()}${this.streaming ? '+' : ''}${this.waiting ? ' …' : ''}`;
  }

  private setScrubVar(): void {
    const max = Math.max(1, Number(this.scrub.max));
    this.scrub.style.setProperty('--p', `${(100 * Number(this.scrub.value)) / max}%`);
  }

  private showTip(i: number): void {
    const n = this.commits.length;
    if (n === 0 || i < 0 || i >= n) return;
    const frac = n > 1 ? i / (n - 1) : 0;
    this.tip.hidden = false;
    this.tip.textContent = `${formatFullDate(this.dates[i])}  #${(i + 1).toLocaleString()}`;
    this.tip.style.setProperty('--x', `${frac * 100}%`);
    this.tip.style.setProperty('--shift', frac < 0.12 ? '0%' : frac > 0.88 ? '-100%' : '-50%');
  }

  private rebuildTimeline(): void {
    this.dates = this.commits.map((c) => Date.parse(c.date));
    this.bins = densityBins(this.commits.map((c) => c.files.length), Math.min(SPARK_BINS, Math.max(1, this.commits.length)));
    this.ticksEl.replaceChildren(
      ...timelineTicks(this.dates, 5).map((t) => {
        const s = document.createElement('span');
        s.textContent = t.label;
        s.style.setProperty('--x', `${t.frac * 100}%`);
        s.dataset.edge = t.frac === 0 ? 'start' : t.frac === 1 ? 'end' : 'mid';
        return s;
      }),
    );
    this.sparkDrawnAt = '';
    this.drawSpark(false);
  }

  private drawSpark(force: boolean): void {
    const cv = this.spark;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(cv.clientWidth * dpr);
    const h = Math.round(cv.clientHeight * dpr);
    if (w === 0 || h === 0) return;
    const n = this.commits.length;
    const key = `${w}x${h}|${this.bins.length}|${n}|${this.shownCommit}`;
    if (!force && key === this.sparkDrawnAt) return;
    this.sparkDrawnAt = key;
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const g = cv.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, h);
    const bins = this.bins.length;
    if (!bins) return;
    const played = n > 1 ? Math.max(0, this.shownCommit) / (n - 1) : 0;
    const bw = w / bins;
    for (let i = 0; i < bins; i++) {
      const v = this.bins[i];
      const bh = Math.max(2 * dpr, v * (h - 2 * dpr));
      g.fillStyle = (i + 0.5) / bins <= played ? 'rgba(246,197,81,0.78)' : 'rgba(230,196,119,0.26)';
      g.fillRect(Math.floor(i * bw) + dpr * 0.5, h - bh, Math.max(1, Math.floor(bw) - dpr), bh);
    }
  }

  private updateLegend(force: boolean): void {
    const n = this.commits.length;
    if (!force && n === this.legendCount) return;
    this.legendCount = n;
    const by = new Map<string, number>();
    for (const c of this.commits) by.set(c.author, (by.get(c.author) ?? 0) + 1);
    const all = [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = all.slice(0, 12);
    const ul = document.createElement('ul');
    for (const [name, count] of top) {
      const li = document.createElement('li');
      const dot = document.createElement('i');
      dot.className = 'gm-dot';
      dot.style.background = hsl(name);
      const nm = document.createElement('span');
      nm.className = 'gm-aname';
      nm.textContent = name;
      const ct = document.createElement('span');
      ct.className = 'gm-acount';
      ct.textContent = count.toLocaleString();
      li.append(dot, nm, ct);
      ul.append(li);
    }
    const head = document.createElement('p');
    head.className = 'gm-legend-head';
    head.textContent = `${all.length.toLocaleString()} author${all.length === 1 ? '' : 's'}`;
    const more = document.createElement('p');
    more.className = 'gm-legend-more';
    more.textContent = all.length > top.length ? `and ${(all.length - top.length).toLocaleString()} more` : '';
    more.hidden = !more.textContent;
    this.legend.replaceChildren(head, ul, more);
    this.q('.gm-legend-btn .gm-lbl').textContent = `Authors (${all.length.toLocaleString()})`;
  }

  private setLegend(open: boolean): void {
    this.legend.hidden = !open;
    this.legendBtn.setAttribute('aria-expanded', String(open));
    this.legendBtn.setAttribute('aria-pressed', String(open));
    this.wake();
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }

  private async share(): Promise<void> {
    if (!this.shareable) {
      this.say(this.shareNote || 'This view cannot be shared by link.');
      return;
    }
    const url = this.h.onShare();
    const touch = matchMedia('(pointer: coarse)').matches;
    if (touch && typeof navigator.share === 'function') {
      try {
        await navigator.share({ url, title: document.title });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      this.say('Link copied');
    } catch {
      this.say('Copy this link', url);
    }
  }

  /** Short message near the bottom; with `copy`, a selected read-only field for browsers that block the clipboard. */
  private say(text: string, copy?: string): void {
    window.clearTimeout(this.toastTimer);
    this.toast.replaceChildren(document.createTextNode(text));
    if (copy) {
      const inp = document.createElement('input');
      inp.readOnly = true;
      inp.value = copy;
      inp.setAttribute('aria-label', 'Link to this view');
      this.toast.append(inp);
      inp.focus();
      inp.select();
    }
    this.toast.classList.add('is-on');
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('is-on'), copy ? 12000 : 2400);
  }

  // ------------------------------------------------------------ idle fade
  private wake(): void {
    window.clearTimeout(this.idleTimer);
    if (this.el.classList.contains('is-idle')) {
      this.el.classList.remove('is-idle');
      document.documentElement.classList.remove('gm-idle');
    }
    if (this.hidden) return;
    this.idleTimer = window.setTimeout(() => this.maybeIdle(), IDLE_MS);
  }

  private maybeIdle(): void {
    const focusInside = this.el.contains(document.activeElement) && (document.activeElement as HTMLElement).matches?.(':focus-visible');
    // only while the mold is moving: a paused viewer keeps its controls, like a video player
    if (!this.playing || focusInside || !this.legend.hidden || !this.pop.hidden || this.toast.classList.contains('is-on')) {
      this.idleTimer = window.setTimeout(() => this.maybeIdle(), IDLE_MS);
      return;
    }
    this.el.classList.add('is-idle');
    document.documentElement.classList.add('gm-idle');
  }

  private setHidden(h: boolean): void {
    this.hidden = h;
    this.el.classList.toggle('is-hidden', h);
    if (!h) this.wake();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' && !this.pop.hidden) {
      this.closePop();
      return;
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) {
      if (!(e.target === this.scrub)) return;
    }
    if (document.querySelector('dialog[open]') || document.documentElement.classList.contains('gm-landing-open')) return;
    const k = e.key;
    if (e.code === 'Space') {
      if (e.target instanceof HTMLButtonElement) return; // let a focused button activate normally
      e.preventDefault();
      this.setPlaying(!this.playing, true);
    } else if (k === 'f' || k === 'F') this.toggleFullscreen();
    else if (k === 's' || k === 'S') this.toggleStats();
    else if (k === 'r' || k === 'R') this.h.onResetCamera();
    else if (k === 'l' || k === 'L') this.h.onCycleLabels();
    else if (k === 'm' || k === 'M') this.h.onCircuit(!this.circuit);
    else if (k === 'h' || k === 'H') this.setHidden(!this.hidden);
    else if (k === 'Escape' && !this.pop.hidden) this.closePop();
    else if (k === 'Escape' && !this.legend.hidden) this.setLegend(false);
    else if (e.target !== this.scrub && k === 'ArrowRight') this.h.onSeek(Math.min(this.commits.length - 1, Number(this.scrub.value) + 1));
    else if (e.target !== this.scrub && k === 'ArrowLeft') this.h.onSeek(Math.max(0, Number(this.scrub.value) - 1));
  }
}
