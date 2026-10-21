// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { CROWD_OFF, crowdLevels } from '../src/render/crowd';

describe('crowdLevels', () => {
  it('changes nothing for a small or empty view', () => {
    expect(crowdLevels(0, 0, 100, 100, 5, 1400, 850)).toEqual(CROWD_OFF);
    const c = crowdLevels(300, 40, 400, 300, 3, 1400, 850);
    expect(c.thread).toBeCloseTo(1, 5);
    expect(c.radius).toBeCloseTo(1, 5);
    expect(c.exposure).toBeCloseTo(1, 5);
    expect(c.food).toBe(1);
  });

  it('thins and dims a crowded view, and stays within 0..1', () => {
    const c = crowdLevels(95000, 7000, 700, 800, 1, 1400, 850);
    expect(c.thread).toBeLessThan(0.3);
    expect(c.radius).toBeLessThan(0.8);
    expect(c.exposure).toBeLessThan(0.9);
    expect(c.bloom).toBeLessThan(0.7);
    for (const v of Object.values(c)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('hides file dots when files are a few pixels apart and shows them when zoomed in', () => {
    const far = crowdLevels(5000, 5000, 600, 600, 0.5, 1400, 850);
    const near = crowdLevels(5000, 5000, 600, 600, 4, 1400, 850);
    expect(far.food).toBe(0);
    expect(near.food).toBeGreaterThan(far.food);
  });

  it('only counts what is visible: zooming into a big network is less crowded than seeing all of it', () => {
    const all = crowdLevels(90000, 7000, 700, 800, 1, 1400, 850);
    const part = crowdLevels(90000 * 0.05, 7000 * 0.05, 700, 800, 6, 1400, 850);
    expect(part.thread).toBeGreaterThan(all.thread);
  });
});
