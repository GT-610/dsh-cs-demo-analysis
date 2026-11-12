import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregatePositions, buildRoundWindows, sampleWindowTicks } from '../src/spatial.ts';
import { roundAtTick } from '../src/analysis.ts';
import type { PositionRow, RosterEntry, RoundTickWindow } from '../src/types.ts';

/** Read an array element the surrounding assertion already proved exists. */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`missing element at index ${index}`);
  return value;
}

const rounds: RoundTickWindow[] = [
  { round: 1, start_tick: 1000, freeze_tick: 2000, end_tick: 5000 },
  { round: 2, start_tick: 6000, freeze_tick: 7000, end_tick: 9000 },
];

test('round windows use freeze-end as the live start', () => {
  const windows = buildRoundWindows(rounds);
  assert.equal(windows.length, 2);
  assert.deepEqual(at(windows, 0), { round: 1, start: 1000, freeze: 2000, end: 5000, liveStart: 2000 });
});

test('tick sampling stays inside live play and respects the cap', () => {
  const windows = buildRoundWindows(rounds);
  const sampled = sampleWindowTicks(windows, 10);
  assert.equal(sampled.step, 640);
  assert.deepEqual(sampled.ticks, [2000, 2640, 3280, 3920, 4560, 7000, 7640, 8280, 8920]);

  const capped = sampleWindowTicks(windows, 1, 4);
  assert.ok(capped.ticks.length <= 4);
  assert.ok(capped.step > 64);
});

test('roundAtTick finds the containing round only', () => {
  assert.equal(roundAtTick(2500, rounds), 1);
  assert.equal(roundAtTick(5500, rounds), undefined);
  assert.equal(roundAtTick(7500, rounds), 2);
});

test('positions aggregate places, teams, and bomb zones', () => {
  const roster: RosterEntry[] = [
    { name: 'a1', steamid: 'a1', team_number: 3, stable_team: 'A', initial_side: 'CT', team_source: 'spawn' },
    { name: 'b1', steamid: 'b1', team_number: 2, stable_team: 'B', initial_side: 'T', team_source: 'spawn' },
  ];
  const rows: PositionRow[] = [
    { round: 1, tick: 100, steamid: 'a1', name: 'a1', team_num: 3, x: 100, y: 100, place: 'Truck', bomb_zone: false },
    { round: 1, tick: 200, steamid: 'a1', name: 'a1', team_num: 3, x: 300, y: 100, place: 'Truck', bomb_zone: true },
    { round: 1, tick: 200, steamid: 'b1', name: 'b1', team_num: 2, x: -100, y: -100, place: 'Middle', bomb_zone: false },
  ];
  const result = aggregatePositions(rows, roster, { cellUnits: 100, topCells: 5 });
  assert.equal(result.players.length, 2);
  const a1 = result.players.find((player) => player.steamid === 'a1');
  const truck = result.places.find((place) => place.place === 'Truck');
  const teamA = result.teams.A;
  const teamB = result.teams.B;
  assert.ok(a1);
  assert.ok(truck);
  assert.ok(teamA);
  assert.ok(teamB);
  assert.ok(result.bounds);
  assert.equal(a1.samples, 2);
  assert.equal(at(a1.places, 0).place, 'Truck');
  assert.equal(at(a1.places, 0).share, 100);
  assert.equal(a1.distance_units, 200);
  assert.equal(truck.bomb_zone_samples, 1);
  assert.equal(teamA.samples, 2);
  assert.equal(at(teamB.places, 0).place, 'Middle');
  assert.deepEqual(result.rounds, [1]);
  assert.equal(result.bounds.min_x, -100);
  assert.equal(result.bounds.max_x, 300);
});

test('positions handle an empty sample set', () => {
  const result = aggregatePositions([], [], {});
  assert.deepEqual(result.players, []);
  assert.deepEqual(result.places, []);
  assert.equal(result.bounds, null);
});
