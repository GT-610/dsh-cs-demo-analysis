import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoParser } from '../src/parser.js';
import { DemoStore } from '../src/demo-store.js';
import { createTools } from '../src/tools.js';

const demoPath = process.env.CS2_DEMO;
const skip = demoPath === undefined ? 'set CS2_DEMO to an absolute .dem path to run integration coverage' : false;

const ctx = { workingDirectory: { ensure: async () => process.cwd() } };

function tools() {
  const parser = new DemoParser();
  const store = new DemoStore(ctx, parser);
  const map = Object.fromEntries(createTools(store).map((definition) => [definition.name, definition]));
  return { parser, map };
}

test('reports a clear error for a missing demo', { skip }, async () => {
  const { parser, map } = tools();
  try {
    await assert.rejects(
      map.cs2_demo_header.execute({ demo: '/definitely/not/here.dem' }, { signal: new AbortController().signal }),
      /Demo not found/,
    );
  } finally {
    await parser.dispose();
  }
});

test('parses header, roster, rounds, economy, and stats', { skip }, async () => {
  const { parser, map } = tools();
  const exec = { signal: new AbortController().signal };
  try {
    const header = await map.cs2_demo_header.execute({ demo: demoPath }, exec);
    assert.match(String(header.data.demo_file_stamp), /^PBDEMS2/);
    assert.equal(typeof header.data.map_name, 'string');

    const roster = await map.cs2_list_players.execute({ demo: demoPath }, exec);
    assert.equal(roster.data.length, 10);
    for (const player of roster.data) {
      assert.match(player.steamid, /^\d+$/);
      assert.ok(player.stable_team === 'A' || player.stable_team === 'B');
    }

    const rounds = await map.cs2_round_summary.execute({ demo: demoPath }, exec);
    assert.ok(rounds.data.length > 0);
    assert.equal(rounds.data[0].round, 1);
    assert.ok(typeof rounds.data[0].t_buy === 'string' || rounds.data[0].t_buy === null);
    assert.equal(typeof rounds.data[0].kill_count, 'number');
    assert.ok(rounds.data.every((round) => round.winner_team === 'A' || round.winner_team === 'B'));
    assert.equal(rounds.data.at(-1).score_a + rounds.data.at(-1).score_b, rounds.data.length);

    const economy = await map.cs2_economy.execute({ demo: demoPath }, exec);
    assert.ok(economy.data.length > 0);
    assert.ok(economy.data[0].pistol_round);
    assert.equal(typeof economy.data[0].ct.cash_spent_this_round, 'number');
    assert.equal(typeof economy.data[0].ct.cash_spent_match_cumulative, 'number');

    const stats = await map.cs2_player_stats.execute({ demo: demoPath }, exec);
    assert.equal(stats.data.players.length, 10);
    const totalKills = stats.data.players.reduce((sum, player) => sum + player.kills, 0);
    assert.ok(totalKills > 0);
    assert.ok(stats.data.players.every((player) => player.rounds > 0));
    assert.equal(stats.data.teams.A.rounds_won + stats.data.teams.B.rounds_won, stats.data.rounds_analyzed);
    assert.equal(typeof stats.data.flash_data_available, 'boolean');
  } finally {
    await parser.dispose();
  }
});

test('query tools bound and mark sampled rows', { skip }, async () => {
  const { parser, map } = tools();
  const exec = { signal: new AbortController().signal };
  try {
    const deaths = await map.cs2_query_events.execute({
      demo: demoPath,
      event_names: ['player_death'],
      limit: 5,
    }, exec);
    assert.equal(deaths.data.length, 5);
    assert.equal(deaths.meta.sampled, true);
    assert.ok(deaths.data.every((row) => row.round !== null));

    const ticks = await map.cs2_query_ticks.execute({
      demo: demoPath,
      props: ['X', 'Y', 'health', 'active_weapon_name'],
      limit: 10,
    }, exec);
    assert.ok(ticks.data.length > 0);
    assert.ok(ticks.data.every((row) => typeof row.X === 'number'));
    assert.ok(ticks.data.every((row) => 'best_weapon' in row));
    assert.ok(ticks.data.every((row) => !('inventory' in row)));

    const grenades = await map.cs2_query_grenades.execute({ demo: demoPath, limit: 5 }, exec);
    assert.ok(grenades.data.length > 0);
    assert.ok(grenades.data.every((grenade) => typeof grenade.round === 'number'));

    const positions = await map.cs2_positions.execute({ demo: demoPath, round: 1, step_seconds: 4 }, exec);
    assert.equal(positions.data.map, 'de_mirage');
    assert.equal(positions.data.players.length, 10);
    assert.ok(positions.data.places.length > 0);
    assert.ok(positions.data.places.every((place) => typeof place.place === 'string'));
    assert.ok(positions.data.players.every((player) => Array.isArray(player.places)));

    const rowPositions = await map.cs2_positions.execute({ demo: demoPath, round: 1, format: 'rows', limit: 5 }, exec);
    assert.ok(rowPositions.data.length > 0);
    assert.ok(rowPositions.data.every((row) => typeof row.place === 'string' && typeof row.x === 'number'));

    const ranged = await map.cs2_query_events.execute({
      demo: demoPath,
      event_names: ['player_death'],
      rounds: [1, 2],
      limit: 200,
    }, exec);
    assert.ok(ranged.data.length > 0);
    assert.ok(ranged.data.every((row) => row.round === 1 || row.round === 2));

    const overview = await map.cs2_map_overview.execute({ demo: demoPath, step_seconds: 8 }, exec);
    assert.equal(overview.data.map, 'de_mirage');
    assert.ok(overview.data.place_catalog.length > 3);
    assert.ok(Array.isArray(overview.data.bomb_targets));
  } finally {
    await parser.dispose();
  }
});
