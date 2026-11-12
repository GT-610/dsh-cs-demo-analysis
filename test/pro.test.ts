import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DemoParser } from '../src/parser.ts';
import { DemoStore } from '../src/demo-store.ts';
import { createTools } from '../src/tools.ts';
import type { DemoStoreContext, ToolDefinition, ToolExec } from '../src/types.ts';

const demoDir = process.env.CS2_PRO_DEMO_DIR;
const skip = demoDir === undefined
  ? 'set CS2_PRO_DEMO_DIR to a directory of professional .dem files to run this coverage'
  : false;

/** A tool payload as the test reads it. */
interface ToolResult {
  data: any;
  meta: Record<string, any>;
}

test('professional demos keep round numbering, scores, and bomb labels aligned', { skip }, async () => {
  if (demoDir === undefined) throw new Error('CS2_PRO_DEMO_DIR is required for this test');
  const files = readdirSync(demoDir).filter((file) => file.toLowerCase().endsWith('.dem'));
  assert.ok(files.length > 0, 'the demo directory should contain at least one .dem file');

  const parser = new DemoParser();
  const ctx: DemoStoreContext = { workingDirectory: { ensure: async () => process.cwd() } };
  const store = new DemoStore(ctx, parser);
  const byName = new Map(createTools(store).map((definition): [string, ToolDefinition] => [definition.name, definition]));
  const run = async (name: string, params: Record<string, unknown>, exec: ToolExec): Promise<ToolResult> => {
    const definition = byName.get(name);
    if (definition === undefined) throw new Error(`unknown tool: ${name}`);
    return await definition.execute(params, exec) as ToolResult;
  };
  const exec: ToolExec = { signal: new AbortController().signal };

  try {
    for (const file of files) {
      const demo = join(demoDir, file);
      const summary = await run('cs2_round_summary', { demo }, exec);
      const count = summary.data.length;
      assert.ok(count >= 10, `${file}: expected a real match, got ${count} rounds`);
      assert.equal(summary.data[0].start_tick, 1, `${file}: the first round should start at tick 1`);
      for (const [index, round] of summary.data.entries()) {
        assert.equal(round.round, index + 1, `${file}: round numbering has a gap`);
      }
      assert.equal(
        summary.data.at(-1).score_a + summary.data.at(-1).score_b,
        count,
        `${file}: every round must be won by exactly one team`,
      );

      const deaths = await run('cs2_query_events', {
        demo,
        event_names: ['player_death'],
        limit: 500,
      }, exec);
      assert.ok(deaths.data.length > 0, `${file}: no deaths parsed`);
      assert.ok(deaths.data.every((row: any) => row.round >= 1 && row.round <= count), `${file}: a death landed outside the round windows`);

      const plants = await run('cs2_query_events', {
        demo,
        event_names: ['bomb_planted'],
        limit: 50,
      }, exec);
      assert.ok(plants.data.every((row: any) => row.round >= 1 && row.round <= count), `${file}: a plant landed outside the round windows`);
      assert.ok(plants.data.every((row: any) => row.site_label === 'A' || row.site_label === 'B' || row.site_label === null), `${file}: site labels are not normalized`);

      const stats = await run('cs2_player_stats', { demo }, exec);
      assert.equal(stats.data.rounds_analyzed, count, `${file}: stats use a different round count`);
      assert.equal(
        stats.data.teams.A.rounds_won + stats.data.teams.B.rounds_won,
        count,
        `${file}: team win totals must add up to the round count`,
      );

      const economy = await run('cs2_economy', { demo }, exec);
      assert.ok(economy.data.length >= count - 1, `${file}: economy lost more than one round`);
      assert.equal(economy.data[0].pistol_round, true, `${file}: the first round must be a pistol round`);

      const positions = await run('cs2_positions', { demo, round: 1, step_seconds: 8 }, exec);
      assert.equal(positions.data.players.length, 10, `${file}: positions should cover both teams`);
    }
  } finally {
    await parser.dispose();
  }
});
