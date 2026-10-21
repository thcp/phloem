// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCommitEvents } from '../src/model/parse';
import { Simulation } from '../src/sim/engine';
import { E_ALIVE, E_LOOP } from '../src/sim/network';

const fixture = parseCommitEvents(JSON.parse(readFileSync(new URL('../fixtures/stemdeck-first10.json', import.meta.url), 'utf8')));

function grow(circuit: boolean): Simulation {
  const sim = new Simulation(fixture, { circuit });
  for (let i = 0; i < 1500; i++) sim.step();
  return sim;
}

describe('circuit mode', () => {
  it('stays in the z = 0 plane', () => {
    const net = grow(true).net;
    for (let i = 0; i < net.nodeTop; i++) expect(net.z[i]).toBe(0);
  });

  it('routes almost every trace along the 8 octilinear directions', () => {
    const net = grow(true).net;
    let total = 0;
    let off = 0;
    for (let e = 0; e < net.edgeTop; e++) {
      if (!(net.eflags[e] & E_ALIVE) || net.eflags[e] & E_LOOP) continue;
      const dx = net.x[net.eb[e]] - net.x[net.ea[e]];
      const dy = net.y[net.eb[e]] - net.y[net.ea[e]];
      if (Math.hypot(dx, dy) < 1.5) continue; // arrival snaps and tip stubs
      total++;
      const a = Math.abs(Math.atan2(dy, dx)) % (Math.PI / 4);
      if (Math.min(a, Math.PI / 4 - a) > 0.03) off++;
    }
    expect(total).toBeGreaterThan(50);
    expect(off / total).toBeLessThan(0.05);
  });

  it('is deterministic and leaves the default mode untouched', () => {
    const a = grow(true).net;
    const b = grow(true).net;
    expect(Array.from(a.x.subarray(0, a.nodeTop))).toEqual(Array.from(b.x.subarray(0, b.nodeTop)));
    const flat = grow(false).net;
    let anyZ = false;
    for (let i = 0; i < flat.nodeTop; i++) if (flat.z[i] !== 0) anyZ = true;
    expect(anyZ).toBe(true);
  });
});
