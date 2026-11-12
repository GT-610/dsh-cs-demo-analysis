import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEconomy, buildRoundModel, classifyBuy, computePlayerStats,
  computeUtility, normalizeReason, parseWinnerSide, resolveRounds, roundAtTick,
} from '../src/analysis.ts';
import type { RoundRecord, TeamModel } from '../src/analysis.ts';
import type { EventRow, RosterEntry, SideNumber, StableTeam } from '../src/types.ts';
import { bestWeapon, equidistantIndices, sampleRows } from '../src/util.ts';

/** Read an array element the surrounding assertion already proved exists. */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`missing element at index ${index}`);
  return value;
}

/** A trimmed-down team model: only the members the caller reads. */
function fakeTeamModel(
  overrides: Partial<TeamModel> & { sideToStableTeam?: (round: number, side: SideNumber | null | undefined) => StableTeam | undefined },
): TeamModel {
  return {
    teamsByRound: new Map(),
    rosterBySteam: new Map(),
    teamOf: () => undefined,
    sideToStableTeam: () => undefined,
    ...overrides,
  } as TeamModel;
}

test('equidistantIndices keeps first and last', () => {
  assert.deepEqual(equidistantIndices(10, 3), [0, 4, 9]);
  assert.deepEqual(equidistantIndices(5, 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(equidistantIndices(0, 4), []);
});

test('sampleRows reports sampling without dropping row zero', () => {
  const rows = Array.from({ length: 10 }, (_, index) => index);
  const sampled = sampleRows(rows, 4);
  assert.equal(sampled.rows[0], 0);
  assert.equal(sampled.rows.length, 4);
  assert.equal(sampled.sampled, true);
  assert.equal(sampled.total, 10);
  assert.equal(sampleRows(rows, 20).sampled, false);
});

test('winners normalize across numeric and string demo shapes', () => {
  assert.equal(parseWinnerSide(3), 3);
  assert.equal(parseWinnerSide(2), 2);
  assert.equal(parseWinnerSide('CT'), 3);
  assert.equal(parseWinnerSide('T'), 2);
  assert.equal(parseWinnerSide('ct'), 3);
  assert.equal(parseWinnerSide(null), undefined);
  assert.equal(normalizeReason({ reason: 't_killed' }), 't_killed');
  assert.equal(normalizeReason({ reason: 9 }), '9');
  assert.equal(normalizeReason({}), null);
});

test('round model uses tick windows, not the demo counter', () => {
  // Professional demos: round_end counters are 1-based while round_start and
  // in-round events are 0-based. Mapping by counter shifts everything by one.
  const events: EventRow[] = [
    { event_name: 'round_start', tick: 1, total_rounds_played: 0, is_warmup_period: false },
    { event_name: 'round_freeze_end', tick: 1250, total_rounds_played: 0, is_warmup_period: false },
    { event_name: 'round_end', tick: 3048, total_rounds_played: 1, winner: 'CT', reason: 't_killed' },
    { event_name: 'round_start', tick: 3368, total_rounds_played: 1, is_warmup_period: false },
    { event_name: 'round_freeze_end', tick: 4648, total_rounds_played: 1, is_warmup_period: false },
    { event_name: 'round_end', tick: 7592, total_rounds_played: 2, winner: 'T', reason: 'ct_killed' },
    {
      event_name: 'player_death', tick: 2113, total_rounds_played: 0,
      attacker_steamid: 'a1', user_steamid: 'b1', attacker_name: 'a1', user_name: 'b1', weapon: 'ak47', headshot: true,
    },
  ];
  const model = buildRoundModel(events);
  assert.equal(model.rounds.length, 2);
  assert.deepEqual(
    { start: at(model.rounds, 0).start_tick, freeze: at(model.rounds, 0).freeze_tick, end: at(model.rounds, 0).end_tick },
    { start: 1, freeze: 1250, end: 3048 },
  );
  assert.equal(at(model.rounds, 0).winner_side, 3);
  assert.equal(at(model.rounds, 0).reason, 't_killed');
  assert.equal(at(model.rounds, 0).kills.length, 1, 'the 0-based death counter belongs to round 1');
  assert.equal(at(model.rounds, 1).winner_side, 2);
  assert.equal(roundAtTick(2113, model.rounds), 1);
  assert.equal(roundAtTick(4000, model.rounds), 2);
  assert.equal(roundAtTick(8000, model.rounds), undefined);
});

test('round model drops the tick-1 ghost and warmup rounds', () => {
  const ghost = buildRoundModel([
    { event_name: 'round_end', tick: 1, total_rounds_played: 0, winner: null, reason: null },
    { event_name: 'round_start', tick: 10, total_rounds_played: 0, is_warmup_period: false },
    { event_name: 'round_end', tick: 1000, total_rounds_played: 1, winner: 'T', reason: 'ct_killed' },
  ]);
  assert.equal(ghost.rounds.length, 1);
  assert.equal(at(ghost.rounds, 0).round, 1);

  const warmup = buildRoundModel([
    { event_name: 'round_start', tick: 65, total_rounds_played: 0, is_warmup_period: true },
    { event_name: 'round_end', tick: 8971, total_rounds_played: 0, winner: 'T', reason: 'ct_killed' },
    { event_name: 'round_start', tick: 9419, total_rounds_played: 1, is_warmup_period: false },
    { event_name: 'round_end', tick: 15232, total_rounds_played: 1, winner: 'CT', reason: 't_killed' },
  ]);
  assert.equal(warmup.rounds.length, 1);
  assert.equal(at(warmup.rounds, 0).start_tick, 9419);
  assert.equal(roundAtTick(3086, warmup.rounds), undefined, 'warmup tick is outside every competitive window');
});

test('buy classification follows the freeze-end thresholds', () => {
  assert.equal(classifyBuy(1500), 'eco');
  assert.equal(classifyBuy(2500), 'semi-buy');
  assert.equal(classifyBuy(4000), 'force-buy');
  assert.equal(classifyBuy(5000), 'full-buy');
});

test('resolved rounds carry stable winners and the running score', () => {
  const model = buildRoundModel([
    { event_name: 'round_start', tick: 0, total_rounds_played: 0 },
    { event_name: 'round_end', tick: 1000, total_rounds_played: 1, winner: 'CT', reason: 't_killed' },
    { event_name: 'round_start', tick: 1100, total_rounds_played: 1 },
    { event_name: 'round_end', tick: 2000, total_rounds_played: 2, winner: 'T', reason: 'ct_killed' },
  ]);
  const teamModel = fakeTeamModel({ sideToStableTeam: (_round, side) => (side === 3 ? 'A' : 'B') });
  const { rounds } = resolveRounds(model, teamModel);
  assert.equal(at(rounds, 0).winner_team, 'A');
  assert.deepEqual(at(rounds, 0).score, { A: 1, B: 0 });
  assert.deepEqual(at(rounds, 1).score, { A: 1, B: 1 });
  assert.equal(at(rounds, 1).winner_side, 'T');
});

test('economy uses per-round spend and labels pistol rounds', () => {
  const model = buildRoundModel([
    { event_name: 'round_start', tick: 0, total_rounds_played: 0 },
    { event_name: 'round_freeze_end', tick: 500, total_rounds_played: 0 },
    { event_name: 'round_end', tick: 1000, total_rounds_played: 1, winner: 'CT', reason: 't_killed' },
    { event_name: 'round_start', tick: 1100, total_rounds_played: 1 },
    { event_name: 'round_freeze_end', tick: 1500, total_rounds_played: 1 },
    { event_name: 'round_end', tick: 2000, total_rounds_played: 2, winner: 'T', reason: 'ct_killed' },
  ]);
  const teams = new Map<string, SideNumber>([['a1', 3], ['b1', 2]]);
  const rows = [
    { tick: 500, steamid: 'a1', team_num: 3, balance: 100, current_equip_value: 800, start_balance: 800, cash_spent_this_round: 650, total_cash_spent: 650 },
    { tick: 500, steamid: 'b1', team_num: 2, balance: 200, current_equip_value: 400, start_balance: 800, cash_spent_this_round: 600, total_cash_spent: 600 },
    { tick: 1500, steamid: 'a1', team_num: 3, balance: 300, current_equip_value: 5000, start_balance: 4000, cash_spent_this_round: 3700, total_cash_spent: 4350 },
  ];
  const teamModel = fakeTeamModel({
    sideToStableTeam: (_round, side) => (side === 3 ? 'A' : 'B'),
    teamOf: (steamid) => teams.get(steamid),
    teamsByRound: new Map([[1, teams]]),
  });
  const economy = buildEconomy(rows, teamModel, model);
  assert.equal(economy.length, 2);
  assert.equal(at(economy, 0).pistol_round, true);
  assert.equal(at(economy, 0).ct.cash_spent_this_round, 650);
  assert.equal(at(economy, 0).t.cash_spent_this_round, 600);
  assert.equal(at(economy, 1).pistol_round, false);
  assert.equal(at(economy, 1).ct.cash_spent_match_cumulative, 4350);
});

test('player stats count kills, trades, and KAST', () => {
  const roster: RosterEntry[] = [
    { name: 'a1', steamid: 'a1', team_number: 3, stable_team: 'A', initial_side: 'CT', team_source: 'spawn' },
    { name: 'a2', steamid: 'a2', team_number: 3, stable_team: 'A', initial_side: 'CT', team_source: 'spawn' },
    { name: 'b1', steamid: 'b1', team_number: 2, stable_team: 'B', initial_side: 'T', team_source: 'spawn' },
    { name: 'b2', steamid: 'b2', team_number: 2, stable_team: 'B', initial_side: 'T', team_source: 'spawn' },
  ];
  const teams = new Map<string, SideNumber>([['a1', 3], ['a2', 3], ['b1', 2], ['b2', 2]]);
  const teamModel = fakeTeamModel({
    rosterBySteam: new Map(roster.map((player): [string, RosterEntry] => [player.steamid, player])),
    teamsByRound: new Map([[1, teams]]),
    sideToStableTeam: (_round, side) => (side === 3 ? 'A' : 'B'),
    teamOf: (steamid) => teams.get(steamid),
  });
  const roundRecords: RoundRecord[] = [{
    round: 1, start_tick: 0, end_tick: 1000, freeze_tick: 500, winner_side: 3, winner_team: 'A', reason: 't_killed', reason_code: null,
    score: { A: 0, B: 0 },
    kills: [
      { tick: 100, attacker: 'a1', attacker_name: 'a1', victim: 'b1', victim_name: 'b1', assister: null, weapon: 'ak47', headshot: true },
      { tick: 200, attacker: 'b2', attacker_name: 'b2', victim: 'a1', victim_name: 'a1', assister: null, weapon: 'm4a1', headshot: false },
      { tick: 260, attacker: 'a2', attacker_name: 'a2', victim: 'b2', victim_name: 'b2', assister: null, weapon: 'ak47', headshot: false },
    ],
  }];
  const model = { rounds: roundRecords };
  const { rounds } = resolveRounds(model, teamModel);
  const result = computePlayerStats({ roster, rounds, events: [], teamModel, model });
  const a1 = result.players.find((player) => player.steamid === 'a1');
  const b1 = result.players.find((player) => player.steamid === 'b1');
  assert.ok(a1);
  assert.ok(b1);
  assert.equal(a1.kills, 1);
  assert.equal(a1.deaths, 1);
  assert.equal(a1.traded_deaths, 1, 'a2 traded the killer');
  assert.equal(a1.kast, 100);
  assert.equal(b1.deaths, 1);
  assert.equal(b1.traded_deaths, 1, 'b2 avenged b1');
  assert.equal(result.teams.A.rounds_won, 1);
  assert.equal(result.flash_data_available, false);
  assert.equal(a1.enemies_flashed, null);
});

test('utility deduplicates detonations and reports missing flash data', () => {
  const roster: RosterEntry[] = [
    { name: 'a1', steamid: 'a1', team_number: 3, stable_team: 'A', initial_side: 'CT', team_source: 'spawn' },
    { name: 'b1', steamid: 'b1', team_number: 2, stable_team: 'B', initial_side: 'T', team_source: 'spawn' },
  ];
  const teamModel: Pick<TeamModel, 'rosterBySteam' | 'teamOf'> = {
    rosterBySteam: new Map(roster.map((player): [string, RosterEntry] => [player.steamid, player])),
    teamOf: (steamid) => (steamid === 'a1' ? 3 : 2),
  };
  const model = {
    rounds: [{ round: 1, start_tick: 0, end_tick: 1000, winner_side: 3 }],
    flashDataAvailable: false,
  };
  const events: EventRow[] = [
    { event_name: 'smokegrenade_detonate', tick: 100, entityid: 7, user_steamid: 'a1', user_name: 'a1' },
    { event_name: 'smokegrenade_detonate', tick: 101, entityid: 7, user_steamid: 'a1', user_name: 'a1' },
    { event_name: 'hegrenade_detonate', tick: 200, entityid: 8, user_steamid: 'a1', user_name: 'a1' },
    { event_name: 'player_hurt', tick: 200, attacker_steamid: 'a1', user_steamid: 'b1', weapon: 'hegrenade', dmg_health: 40 },
    { event_name: 'player_blind', tick: 200, attacker_steamid: 'a1', user_steamid: 'b1', blind_duration: 2 },
  ];
  const result = computeUtility({ roster, events, model, teamModel });
  const a1 = result.players.find((player) => player.steamid === 'a1');
  assert.ok(a1);
  assert.equal(a1.smokes, 1);
  assert.equal(a1.he_grenades, 1);
  assert.equal(a1.enemies_flashed, null);
  assert.equal(a1.utility_damage, 40);
  assert.equal(result.flash_data_available, false);
});

test('bestWeapon ignores held utilities and prefers the strongest gun', () => {
  assert.equal(bestWeapon(['Butterfly Knife', 'Smoke Grenade']), null);
  assert.equal(bestWeapon(['Karambit', 'Glock-18']), 'Glock-18');
  assert.equal(bestWeapon(['AK-47', 'Glock-18', 'Flashbang']), 'AK-47');
  assert.equal(bestWeapon(['AWP', 'AK-47']), 'AWP');
  assert.equal(bestWeapon(['M4A1-S', 'Desert Eagle', 'Smoke Grenade']), 'M4A1-S');
});
