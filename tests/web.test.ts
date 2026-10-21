// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { estimatePlan, exactCommitsThatFit } from '../src/web/plan';
import { densityBins, formatSpanDate, timelineTicks } from '../src/web/timeline';
import {
  DEFAULT_MAX,
  MAX_ANONYMOUS,
  MAX_WITH_TOKEN,
  parseMax,
  parseViewerParams,
  patchSearch,
  resolveMax,
  stateToPatch,
  wantsLanding,
  withState,
} from '../src/web/urlstate';

describe('parseViewerParams', () => {
  it('parses the full contract', () => {
    const p = parseViewerParams('?repo=expressjs/express&branch=4.x&max=500&t=120&labels=active&quality=low&speed=2&mode=snapshots');
    expect(p.repo).toEqual({ owner: 'expressjs', repo: 'express', branch: '4.x' });
    expect(p).toMatchObject({ max: 500, t: 120, labels: 'active', quality: 'low', speed: 2, mode: 'snapshots', demo: false });
  });
  it('accepts URLs and @branch spellings in repo=', () => {
    expect(parseViewerParams('?repo=https%3A%2F%2Fgithub.com%2Fpallets%2Fflask').repo).toEqual({ owner: 'pallets', repo: 'flask' });
    expect(parseViewerParams('?repo=pallets/flask@2.3.x').repo).toEqual({ owner: 'pallets', repo: 'flask', branch: '2.3.x' });
    expect(parseViewerParams('?repo=pallets/flask&branch=main').repo?.branch).toBe('main');
  });
  it('is lenient: bad values become null/defaults', () => {
    const p = parseViewerParams('?repo=not a repo&max=-3&t=abc&labels=loud&quality=ultra&speed=-1&mode=x');
    expect(p.repo).toBeNull();
    expect(p.badRepo).toBe('not a repo');
    expect(p).toMatchObject({ max: DEFAULT_MAX, t: null, labels: null, quality: null, speed: null, mode: null });
  });
  it('clamps speed', () => {
    expect(parseViewerParams('?speed=1000').speed).toBe(32);
    expect(parseViewerParams('?speed=0.001').speed).toBe(0.1);
  });
  it('max accepts all and plain integers only', () => {
    expect(parseMax('all')).toBe('all');
    expect(parseMax('ALL')).toBe('all');
    expect(parseMax('3000')).toBe(3000);
    expect(parseMax('12.5')).toBe(DEFAULT_MAX);
    expect(parseMax('0')).toBe(DEFAULT_MAX);
    expect(parseMax(null)).toBe(DEFAULT_MAX);
  });
});

describe('wantsLanding', () => {
  it('shows the landing page only when the URL asks for no specific history', () => {
    expect(wantsLanding('')).toBe(true);
    expect(wantsLanding('?landing')).toBe(true);
    expect(wantsLanding('?repo=a/b')).toBe(false);
    expect(wantsLanding('?demo')).toBe(false);
    expect(wantsLanding('?stress=500')).toBe(false);
    expect(wantsLanding('?paused')).toBe(false); // dev/test parameters keep the viewer
    expect(wantsLanding('?loader')).toBe(true); // the old dialog is gone: an unknown parameter does not skip the landing
    expect(wantsLanding('?speed=2&labels=off')).toBe(true);
    expect(wantsLanding('?fixture=stemdeck-first10')).toBe(false);
    expect(wantsLanding('?repo=garbage')).toBe(true); // explained on the landing page
  });
});

describe('resolveMax', () => {
  it('caps anonymous windows and lets tokens go further', () => {
    expect(resolveMax(200, false)).toEqual({ max: 200, capped: false });
    expect(resolveMax(3000, false)).toEqual({ max: MAX_ANONYMOUS, capped: true });
    expect(resolveMax('all', false)).toEqual({ max: MAX_ANONYMOUS, capped: false });
    expect(resolveMax(3000, true)).toEqual({ max: 3000, capped: false });
    expect(resolveMax('all', true).max).toBe(MAX_WITH_TOKEN);
    expect(resolveMax(10_000_000, true).capped).toBe(true);
  });
});

describe('patchSearch / withState', () => {
  it('round-trips a state through the parser and keeps the URL readable', () => {
    const s = withState('', { repo: { owner: 'a', repo: 'b', branch: 'feat/x' }, max: 1000, commitNumber: 42, labels: 'off', speed: 2 });
    expect(s).toBe('?repo=a/b&branch=feat/x&max=1000&t=42&labels=off&speed=2');
    expect(parseViewerParams(s)).toMatchObject({ repo: { owner: 'a', repo: 'b', branch: 'feat/x' }, max: 1000, t: 42, labels: 'off', speed: 2 });
  });
  it('omits defaults', () => {
    expect(withState('?repo=a/b&labels=off&speed=2', { labels: 'active', speed: 1, max: DEFAULT_MAX, commitNumber: 0 })).toBe('?repo=a/b');
  });
  it('preserves unknown parameters and their order, and puts known ones first', () => {
    expect(patchSearch('?stats&seed=3&repo=a/b', { t: 5 })).toBe('?repo=a/b&t=5&stats&seed=3');
    expect(patchSearch('?seed=3', { speed: 2.5 })).toBe('?speed=2.5&seed=3');
  });
  it('removes keys with null/false and updates in place', () => {
    expect(patchSearch('?repo=a/b&t=5&demo', { t: 9, demo: false })).toBe('?repo=a/b&t=9');
    expect(patchSearch('?x=1', { x: null })).toBe('');
  });
  it('encodes awkward values', () => {
    expect(patchSearch('', { branch: 'a b&c' })).toBe('?branch=a%20b%26c');
    expect(stateToPatch({ repo: null })).toMatchObject({ repo: null, branch: null });
  });
  it('rounds speed and drops a speed of 1', () => {
    expect(stateToPatch({ speed: 1.23456 }).speed).toBe(1.23);
    expect(stateToPatch({ speed: 1 }).speed).toBeNull();
  });
});

describe('estimatePlan', () => {
  it('small windows fit the anonymous quota commit by commit', () => {
    const e = estimatePlan(40, false);
    expect(e).toMatchObject({ mode: 'commits', requests: 42, quota: 60 });
  });
  it('anonymous windows beyond ~57 commits fall back to snapshots', () => {
    const e = estimatePlan(200, false);
    expect(e.mode).toBe('snapshots');
    expect(e.samples).toBeGreaterThan(40);
    expect(e.requests).toBeLessThanOrEqual(60);
    expect(e.summary).toMatch(/token/);
  });
  it('a token makes a few hundred commits exact', () => {
    expect(estimatePlan(500, true)).toMatchObject({ mode: 'commits', requests: 506 });
  });
  it("'all' (the default) explains what the quota allows and never silently picks a number", () => {
    const anon = estimatePlan('all', false);
    expect(anon.window).toBe(1000);
    expect(anon.short).toMatch(/All available within your quota/);
    expect(anon.short).toMatch(/every commit up to 56/);
    expect(anon.short).toMatch(/token/);
    expect(anon.requests).toBeLessThanOrEqual(60);
    expect(exactCommitsThatFit(60)).toBe(56);
    expect(estimatePlan('all', true).short).not.toMatch(/token/);
  });
  it('very large token windows sample, and the cap is stated', () => {
    const e = estimatePlan('all', true);
    expect(e.mode).toBe('snapshots');
    expect(e.window).toBe(MAX_WITH_TOKEN);
    expect(estimatePlan(3000, false).capped).toBe(true);
    expect(estimatePlan(3000, false).summary).toMatch(/Capped/);
  });
});

describe('timeline helpers', () => {
  const day = 86_400_000;
  const t0 = Date.UTC(2024, 0, 1);
  it('label precision follows the span', () => {
    expect(formatSpanDate(t0, 5 * 365 * day)).toBe('2024');
    expect(formatSpanDate(t0, 200 * day)).toBe('Jan 2024');
    expect(formatSpanDate(t0, 10 * day)).toBe('Jan 1');
  });
  it('ticks are evenly spaced by index, deduplicated and bounded', () => {
    const dates = Array.from({ length: 101 }, (_, i) => t0 + i * 3 * day);
    const ticks = timelineTicks(dates, 5);
    expect(ticks[0]).toEqual({ frac: 0, label: 'Jan 2024' });
    expect(ticks.at(-1)!.frac).toBe(1);
    expect(ticks.length).toBeLessThanOrEqual(5);
    const same = timelineTicks(Array.from({ length: 10 }, () => t0), 4);
    expect(same.length).toBeLessThanOrEqual(1);
    expect(timelineTicks([t0], 4)).toEqual([]);
    expect(timelineTicks([NaN, NaN, NaN], 4)).toEqual([]);
  });
  it('density bins are normalized and log scaled', () => {
    const b = densityBins([1, 1, 100, 1], 4);
    expect(Math.max(...b)).toBe(1);
    expect(b[0]).toBeGreaterThan(0);
    expect(b[0]).toBeLessThan(0.2);
    expect(densityBins([], 4)).toEqual([]);
    expect(densityBins([5, 5], 8).length).toBe(8);
  });
});

import { describeStatus } from '../src/web/statusview';
import type { LoadStatus } from '../src/ingest/session';

describe('describeStatus', () => {
  const st = (o: Partial<LoadStatus>): LoadStatus => ({ state: 'running', message: 'm', delivered: 0, ...o });
  it('running is cancellable and blocking until something is shown', () => {
    const v = describeStatus(st({ fraction: 0.5, detail: 'd' }));
    expect(v).toMatchObject({ tone: 'busy', blocking: true, fraction: 0.5, actions: ['cancel'] });
    expect(describeStatus(st({ delivered: 5 })).blocking).toBe(false);
  });
  it('rate limit: offers resume/token, labels a reset that has passed', () => {
    const v = describeStatus(st({ state: 'rate-limited', canResume: true, resetAt: 1000, delivered: 10 }), { hasToken: false, now: 2000 });
    expect(v.actions).toEqual(['resume', 'token', 'dismiss']);
    expect(v.resumeLabel).toBe('Try again now');
    expect(describeStatus(st({ state: 'rate-limited', canResume: true, resetAt: 5000 }), { hasToken: true, now: 2000 }).actions).toEqual(['resume', 'open']);
  });
  it('errors on an empty load send you back to the form; private/token errors offer a token', () => {
    const v = describeStatus(st({ state: 'error', message: 'Not found. If it is private, add a token.' }));
    expect(v.tone).toBe('error');
    expect(v.actions).toEqual(['token', 'open']);
    expect(describeStatus(st({ state: 'error', message: 'Network down', canResume: true, delivered: 3 })).actions).toEqual(['resume', 'dismiss']);
  });
});

import { age, evictions, historyKey, MAX_SAVED, reuse, type SavedHistory } from '../src/web/histcache';

describe('saved histories', () => {
  const mk = (over: Partial<SavedHistory>): SavedHistory => ({
    key: 'a/b@main', repo: 'a/b', branch: 'main', max: 200, mode: 'commits', fetchedAt: 0, count: 200,
    commits: Array.from({ length: 200 }, (_, i) => ({ hash: String(i), author: 'x', email: '', date: '', message: '', files: [] })), ...over,
  });
  it('keys ignore case and keep the branch', () => {
    expect(historyKey('Express', 'JS', 'Main')).toBe('express/js@main');
    expect(historyKey('a', 'b', undefined)).toBe('a/b@');
  });
  it('commit-mode entries serve smaller or equal windows by slicing the newest commits', () => {
    const h = mk({});
    expect(reuse(h, 50)!.map((c) => c.hash)[0]).toBe('150');
    expect(reuse(h, 200)!.length).toBe(200);
    expect(reuse(h, 500)).toBeNull(); // the window was cut at 200: more exists
  });
  it('a short history (whole repo) serves any larger window', () => {
    const h = mk({ max: 200, count: 30, commits: mk({}).commits.slice(0, 30) });
    expect(reuse(h, 1000)!.length).toBe(30);
  });
  it('snapshot entries only serve the same window', () => {
    const h = mk({ mode: 'snapshots', max: 200, count: 55 });
    expect(reuse(h, 200)).toBe(h.commits);
    expect(reuse(h, 100)).toBeNull();
  });
  it('keeps only the newest MAX_SAVED histories', () => {
    const metas = Array.from({ length: MAX_SAVED + 3 }, (_, i) => ({ key: `k${i}`, fetchedAt: 1000 + i }));
    const drop = evictions(metas);
    expect(drop).toEqual(['k2', 'k1', 'k0']);
    expect(evictions(metas.slice(0, 5))).toEqual([]);
  });

  it('age is human', () => {
    expect(age(1000, 1000 + 20_000)).toBe('just now');
    expect(age(0, 10 * 60_000)).toBe('10 min ago');
    expect(age(0, 3 * 3_600_000)).toBe('3 h ago');
    expect(age(0, 5 * 86_400_000)).toBe('5 days ago');
  });
});

import { readFileSync } from 'node:fs';
import { CSP, DEFAULT_SITE_URL } from '../vite.config';
import { DEFAULT_SOURCE_URL } from '../src/web/source';

describe('deployment config', () => {
  it('public/_headers carries the same CSP as the build (plus frame-ancestors, which a meta tag cannot express)', () => {
    const headers = readFileSync('public/_headers', 'utf8');
    const line = /Content-Security-Policy: (.+)/.exec(headers)![1];
    expect(line).toBe(`${CSP}; frame-ancestors 'none'`);
  });
  it('the CSP allows only this origin and api.github.com', () => {
    expect(CSP).toContain("connect-src 'self' https://api.github.com");
    expect(CSP).not.toMatch(/unsafe-/);
    expect(CSP).toContain("script-src 'self'");
  });
  it('_headers: immutable hashed assets, short cache for featured, no overlapping Cache-Control rules', () => {
    const headers = readFileSync('public/_headers', 'utf8');
    expect(headers).toMatch(/\/assets\/\*\n  Cache-Control: public, max-age=31536000, immutable/);
    expect(headers).toMatch(/\/featured\/\*\n  Cache-Control: public, max-age=3600/);
    // the catch-all block sets security headers only: Cache-Control per path would be merged by Pages
    const catchAll = /^\/\*\n((?:  .+\n)+)/m.exec(headers)![1];
    expect(catchAll).not.toMatch(/Cache-Control/);
  });
  it('defaults: the public site and source repository', () => {
    expect(DEFAULT_SITE_URL).toBe('https://phloem.thales.sh/');
    expect(DEFAULT_SOURCE_URL).toBe('https://github.com/thcp/phloem');
  });
});
