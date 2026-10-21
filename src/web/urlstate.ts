// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The shareable URL contract of the public web page (documented in docs/WEB.md). Pure functions, no DOM, so they are unit-tested.
 *
 *   ?repo=owner/name        GitHub repository (also accepts a github.com URL, owner/name@branch, .../tree/branch)
 *   &branch=name            branch (default: the repository's default branch)
 *   &max=N | all            window: the most recent N first-parent commits (default: all that the quota allows)
 *   &t=N                    start position: commit NUMBER N (1-based, as the counter shows it) within the loaded window
 *   &labels=all|active|off  name labels
 *   &quality=auto|high|medium|low
 *   &view=circuit           flat circuit board view (default: 3D)
 *   &speed=X                playback speed multiplier (0.1 .. 32)
 *   &mode=auto|commits|snapshots   GitHub detail mode (see docs/INGESTION.md)
 *   ?demo                   the bundled StemDeck history (no network)
 *
 * Unknown parameters (`stats`, `seed`, `pacing`, `fixture`, ...) are preserved when the URL is rewritten.
 */
import { parseRepoInput, type RepoRef } from '../ingest/github';

/** Every repository starts with its whole history: 'all available within the quota' (never a silent 200). */
export const DEFAULT_MAX: MaxSetting = 'all';
export const MAX_WITH_TOKEN = 20000;
/** Without a token the 60 requests/hour budget cannot even list more than this many commits and still have requests left for detail. */
export const MAX_ANONYMOUS = 1000;

export type MaxSetting = number | 'all';
export type LabelModeParam = 'all' | 'active' | 'off';
export type QualityParam = 'auto' | 'high' | 'medium' | 'low';
export type DetailMode = 'auto' | 'commits' | 'snapshots';

export interface ViewerParams {
  /** Parsed repository (with `branch`), or null. */
  repo: RepoRef | null;
  /** The raw `repo` value when present but unparseable (to pre-fill the form and explain). */
  badRepo: string | null;
  max: MaxSetting;
  t: number | null;
  labels: LabelModeParam | null;
  quality: QualityParam | null;
  speed: number | null;
  mode: DetailMode | null;
  demo: boolean;
  circuit: boolean;
}

export const SPEED_MIN = 0.1;
export const SPEED_MAX = 32;

function positiveInt(s: string | null): number | null {
  if (s === null || !/^\d+$/.test(s.trim())) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export function parseMax(s: string | null): MaxSetting {
  if (s !== null && s.trim().toLowerCase() === 'all') return 'all';
  const n = positiveInt(s);
  return n !== null && n >= 1 ? Math.min(n, 1_000_000) : DEFAULT_MAX;
}

export function parseViewerParams(search: string): ViewerParams {
  const q = new URLSearchParams(search);
  const raw = q.get('repo');
  let repo: RepoRef | null = null;
  let badRepo: string | null = null;
  if (raw !== null && raw.trim() !== '') {
    repo = parseRepoInput(raw, q.get('branch') ?? undefined);
    if (!repo) badRepo = raw;
  }
  const t = positiveInt(q.get('t'));
  const labels = q.get('labels');
  const quality = q.get('quality');
  const speed = Number(q.get('speed'));
  const mode = q.get('mode');
  return {
    repo,
    badRepo,
    max: parseMax(q.get('max')),
    t,
    labels: labels === 'all' || labels === 'active' || labels === 'off' ? labels : null,
    quality: quality === 'auto' || quality === 'high' || quality === 'medium' || quality === 'low' ? quality : null,
    speed: Number.isFinite(speed) && speed > 0 ? Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed)) : null,
    mode: mode === 'auto' || mode === 'commits' || mode === 'snapshots' ? mode : null,
    demo: q.has('demo'),
    circuit: q.get('view') === 'circuit',
  };
}

const DEV_VIEWER_KEYS = ['fixture', 'stress', 'paused', 'stats'];

/**
 * True when the visitor should see the landing page: nothing in the URL asks for a specific history.
 * (`repo` that fails to parse still lands on the landing page, with an explanation.)
 */
export function wantsLanding(search: string): boolean {
  const q = new URLSearchParams(search);
  const p = parseViewerParams(search);
  if (p.repo || p.demo) return false;
  // development / test parameters that select a history or a mode without a repo: show the viewer, as before the landing page existed
  return !DEV_VIEWER_KEYS.some((k) => q.has(k));
}

/** Resolve the window size to a number of commits, applying the budget policy for unauthenticated use. */
export function resolveMax(max: MaxSetting, hasToken: boolean): { max: number; capped: boolean } {
  const cap = hasToken ? MAX_WITH_TOKEN : MAX_ANONYMOUS;
  const want = max === 'all' ? cap : max;
  return { max: Math.min(want, cap), capped: max !== 'all' && want > cap };
}

// ---------------------------------------------------------------- serialization
export type ParamPatch = Record<string, string | number | boolean | null | undefined>;

function enc(s: string): string {
  // keep the URL readable: owner/name and owner/name@branch are legal as-is in a query string
  return encodeURIComponent(s).replace(/%2F/gi, '/').replace(/%40/g, '@').replace(/%3A/gi, ':');
}

/** Parameters in the order a shared link should show them; anything else keeps its place after these. */
const ORDER = ['repo', 'demo', 'branch', 'max', 'mode', 't', 'labels', 'quality', 'speed', 'view'];

/**
 * Apply a patch to a query string: `null`/`undefined`/`false` removes a key, `true` writes a bare flag (`demo`), anything else
 * writes `key=value`. Keys not mentioned are preserved (including their order and bare-flag form).
 */
export function patchSearch(search: string, patch: ParamPatch): string {
  const entries: Array<[string, string | null]> = [];
  for (const part of search.replace(/^\?/, '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, ' '));
    const raw = i < 0 ? null : part.slice(i + 1);
    entries.push([k, raw]); // keep the raw (already encoded) value
  }
  const out = new Map<string, string | null>();
  for (const [k, v] of entries) if (!out.has(k)) out.set(k, v);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === false) out.delete(k);
    else if (v === true) out.set(k, null);
    else out.set(k, enc(String(v)));
  }
  const keys = [...out.keys()];
  keys.sort((a, b) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    if (ia < 0 && ib < 0) return 0; // stable: unknown keys keep their relative order
    if (ia < 0) return 1;
    if (ib < 0) return -1;
    return ia - ib;
  });
  const s = keys.map((k) => (out.get(k) === null ? enc(k) : `${enc(k)}=${out.get(k)}`)).join('&');
  return s ? `?${s}` : '';
}

/** What the viewer currently shows, as URL state. Defaults are omitted so shared links stay short. */
export interface ViewerState {
  repo?: RepoRef | null;
  max?: MaxSetting;
  mode?: DetailMode | null;
  /** 1-based number of the commit currently shown (0 = nothing yet). */
  commitNumber?: number;
  labels?: LabelModeParam;
  quality?: QualityParam | null;
  speed?: number;
  demo?: boolean;
  circuit?: boolean;
}

export function stateToPatch(s: ViewerState): ParamPatch {
  const p: ParamPatch = {};
  if ('repo' in s) {
    p.repo = s.repo ? `${s.repo.owner}/${s.repo.repo}` : null;
    p.branch = s.repo?.branch ?? null;
  }
  if ('max' in s) p.max = s.max === undefined || s.max === DEFAULT_MAX ? null : s.max;
  if ('mode' in s) p.mode = s.mode && s.mode !== 'auto' ? s.mode : null;
  if ('commitNumber' in s) p.t = s.commitNumber && s.commitNumber > 0 ? s.commitNumber : null;
  if ('labels' in s) p.labels = s.labels && s.labels !== 'active' ? s.labels : null;
  if ('quality' in s) p.quality = s.quality && s.quality !== 'auto' ? s.quality : null;
  if ('speed' in s) p.speed = s.speed && Math.abs(s.speed - 1) > 1e-6 ? Number(s.speed.toFixed(2)) : null;
  // retired parameters (`?orbit`, `?director`: the cinematic camera is always on now): drop them from old shared links when the URL is rewritten
  p.orbit = null;
  p.director = null;
  if ('circuit' in s) p.view = s.circuit ? 'circuit' : null;
  if ('demo' in s) p.demo = s.demo ? true : null;
  return p;
}

/** Convenience: the new query string for `search` after applying viewer state. */
export function withState(search: string, s: ViewerState): string {
  return patchSearch(search, stateToPatch(s));
}
