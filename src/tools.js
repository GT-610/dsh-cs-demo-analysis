/**
 * Model-facing tools for the CS2 demo analysis mode.
 *
 * Every tool is evidence-first: it returns bounded measurements plus metadata
 * that says whether rows were sampled or truncated. No tool guesses a demo
 * path, invents coordinates, or summarizes tactics for the model.
 */

import { readdir, stat as fsStat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  MAX_EVENT_NAMES, MAX_EVENT_ROWS, MAX_PROPERTIES, MAX_REQUESTED_TICKS,
  MAX_SERIALIZED_ROWS_BYTES, MAX_STEAM_IDS, MAX_TICK_ROWS,
} from './constants.js';
import { buildEconomy, buildRoundModel, buildTeamModel, computePlayerStats, computeUtility, resolveRounds, roundAtTick } from './analysis.js';
import { textRender } from './render.js';
import { aggregatePositions, buildRoundWindows, sampleWindowTicks } from './spatial.js';
import { bestWeapon, clampInt, equidistantIndices, num, sampleRows, str } from './util.js';

const DEMO_PARAM = {
  type: 'string',
  description: 'Path to the .dem file. Absolute, or relative to the session workspace.',
};

const LIMIT_PARAM = {
  type: 'integer',
  description: 'Maximum rows to return. Larger results are evenly sampled and marked sampled=true.',
};

function tool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: textRender,
    },
    execute: definition.execute,
  };
}

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

function optionalStringArray(value, name, { max, pattern } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings.`);
  if (value.length > (max ?? 64)) throw new Error(`${name} accepts at most ${max ?? 64} entries.`);
  const entries = value.map((entry) => requireString(entry, `${name} entry`));
  if (pattern !== undefined) {
    for (const entry of entries) {
      if (!pattern.test(entry)) throw new Error(`${name} entry "${entry}" has an invalid name.`);
    }
  }
  return [...new Set(entries)];
}

function optionalIntArray(value, name, { max, min = 0 } = {}) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of integers.`);
  if (value.length === 0) return undefined;
  if (value.length > (max ?? MAX_REQUESTED_TICKS)) throw new Error(`${name} accepts at most ${max ?? MAX_REQUESTED_TICKS} entries.`);
  return [...new Set(value.map((entry) => {
    const parsed = num(entry);
    if (parsed === undefined || !Number.isInteger(parsed) || parsed < min) {
      throw new Error(`${name} must contain integers >= ${min}.`);
    }
    return parsed;
  }))];
}

function boundRows(rows, limit) {
  const total = rows.length;
  let sampled = false;
  let picked = rows;
  if (limit < total) {
    picked = sampleRows(rows, limit).rows;
    sampled = true;
  }
  let serialized = JSON.stringify(picked).length;
  while (serialized > MAX_SERIALIZED_ROWS_BYTES && picked.length > 1) {
    picked = sampleRows(picked, Math.ceil(picked.length / 2)).rows;
    sampled = true;
    serialized = JSON.stringify(picked).length;
  }
  return {
    rows: picked,
    meta: {
      row_count: picked.length,
      original_row_count: total,
      truncated: picked.length < total,
      sampled,
    },
  };
}

function matchesWhere(row, where) {
  if (where === undefined || where === null) return true;
  if (typeof where !== 'object' || Array.isArray(where)) throw new Error('where must be an object of field/value pairs.');
  for (const [field, expected] of Object.entries(where)) {
    if (expected === undefined || expected === null) continue;
    if (!['string', 'number', 'boolean'].includes(typeof expected)) {
      throw new Error(`where.${field} must be a string, number, or boolean.`);
    }
    const actual = row[field];
    if (typeof expected === 'boolean') {
      if (actual !== expected) return false;
    } else if (typeof expected === 'number') {
      if (num(actual) !== expected) return false;
    } else if (String(actual ?? '') !== expected) {
      return false;
    }
  }
  return true;
}

async function collectDemos(directory, limit) {
  const found = [];
  const queue = [{ path: directory, depth: 0 }];
  while (queue.length > 0 && found.length < limit) {
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= limit) break;
      if (entry.name.startsWith('.')) continue;
      const candidate = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 2 && entry.name !== 'node_modules') queue.push({ path: candidate, depth: current.depth + 1 });
      } else if (/\.dem$/i.test(entry.name)) {
        try {
          const info = await fsStat(candidate);
          found.push({ path: candidate, size_bytes: info.size, modified: info.mtime.toISOString() });
        } catch {
          // unreadable file: omit it
        }
      }
    }
  }
  return found;
}


function resolvePlayerFilter(roster, values) {
  if (values === undefined || values === null) return null;
  if (!Array.isArray(values) || values.length === 0) return null;
  const wanted = [];
  for (const value of values) {
    const text = requireString(value, 'players entry');
    const byId = roster.find((player) => player.steamid === text);
    const byName = roster.find((player) => String(player.name).toLowerCase() === text.toLowerCase());
    const match = byId ?? byName;
    if (match !== undefined) wanted.push(match.steamid);
  }
  if (wanted.length === 0) {
    throw new Error(`No player matched. Known players: ${roster.map((player) => `${player.name} (${player.steamid})`).join(', ')}`);
  }
  return [...new Set(wanted)];
}

async function samplePositions(exec, store, resolved, roster, { round, fromRound, toRound, stepSeconds, maxTicks, players }) {
  const events = await store.eventRows(
    exec,
    resolved,
    ['round_start', 'round_freeze_end', 'round_end'],
    [],
    ['total_rounds_played', 'is_warmup_period'],
  );
  const model = buildRoundModel(events);
  const allWindows = buildRoundWindows(model.rounds);
  const windows = allWindows.filter((window) => (round === undefined || window.round === round)
    && (fromRound === undefined || window.round >= fromRound)
    && (toRound === undefined || window.round <= toRound));
  if (windows.length === 0) throw new Error('No competitive rounds match the requested scope.');

  const { ticks, step } = sampleWindowTicks(windows, stepSeconds, maxTicks);
  if (ticks.length === 0) throw new Error('No live-play ticks were found in the requested scope.');

  const result = await store.parser.call('ticks', {
    path: resolved.path,
    props: ['X', 'Y', 'team_num', 'last_place_name', 'in_bomb_zone', 'in_buy_zone'],
    ticks,
    players,
  }, exec.signal);

  const rows = [];
  for (const row of result.data) {
    const x = num(row.X);
    const y = num(row.Y);
    const tick = num(row.tick);
    if (x === undefined || y === undefined || tick === undefined) continue;
    const displayRound = roundAtTick(Math.trunc(tick), model.rounds);
    if (displayRound === undefined) continue;
    rows.push({
      round: displayRound,
      tick: Math.trunc(tick),
      steamid: String(row.steamid),
      name: row.name ?? null,
      team_num: num(row.team_num) ?? null,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      place: row.last_place_name ?? null,
      bomb_zone: row.in_bomb_zone === true,
      buy_zone: row.in_buy_zone === true,
    });
  }
  return { rows, windows, step, elapsedMs: result.elapsedMs };
}


/**
 * Replace raw bomb_planted site/c4 fields with a readable site label derived
 * from the planter's in-game place name at the plant tick.
 */
async function annotateBombSites(exec, store, resolved, rows) {
  const plants = rows.filter((row) => row.event_name === 'bomb_planted');
  if (plants.length === 0) return rows;
  const ticks = [...new Set(plants.map((row) => Math.trunc(num(row.tick))).filter((tick) => Number.isFinite(tick)))];
  if (ticks.length === 0) return rows;
  const players = [...new Set(plants.map((row) => (row.user_steamid === undefined ? undefined : String(row.user_steamid))).filter(Boolean))];
  let placeByKey = new Map();
  try {
    const result = await store.parser.call('ticks', {
      path: resolved.path,
      props: ['last_place_name'],
      ticks,
      players: players.length > 0 ? players : null,
    }, exec.signal);
    for (const row of result.data) {
      placeByKey.set(`${row.tick}:${row.steamid}`, row.last_place_name ?? null);
    }
  } catch {
    placeByKey = new Map();
  }
  return rows.map((row) => {
    if (row.event_name !== 'bomb_planted') return row;
    const place = placeByKey.get(`${row.tick}:${row.user_steamid}`) ?? null;
    const label = place !== null && /^bombsitea/i.test(place) ? 'A'
      : place !== null && /^bombsiteb/i.test(place) ? 'B'
        : null;
    const { site, c4, ...rest } = row;
    return {
      ...rest,
      site_label: label,
      site_id: site ?? null,
      c4_entity: c4 ?? null,
      place,
    };
  });
}

export function createTools(store) {
  return [
    tool({
      name: 'cs2_find_demos',
      description: 'List Counter-Strike 2 .dem files under a directory (two levels deep). Use it when the user names a demo without a full path.',
      parameters: objectSchema({
        directory: {
          type: 'string',
          description: 'Directory to scan. Defaults to the session workspace.',
        },
        limit: { ...LIMIT_PARAM, description: 'Maximum number of demos to return. Defaults to 25.' },
      }),
      async execute(args, exec) {
        const cwd = await store.cwd(exec);
        const raw = args.directory === undefined ? cwd : requireString(args.directory, 'directory');
        const directory = isAbsolute(raw) ? raw : resolve(cwd, raw);
        const limit = clampInt(args.limit, 1, 200, 25);
        const demos = await collectDemos(directory, limit);
        return {
          data: demos,
          meta: { row_count: demos.length, directory, truncated: demos.length >= limit },
        };
      },
    }),

    tool({
      name: 'cs2_demo_header',
      description: 'Return the selected demo header: map, server, demo format, patch, and file metadata. Start here when the map or format is unknown.',
      parameters: objectSchema({ demo: DEMO_PARAM }),
      async execute(args, exec) {
        const resolved = await store.resolve(exec, args.demo);
        const base = await store.base(exec, resolved);
        return {
          data: { path: resolved.path, size_bytes: resolved.size, ...base.header },
          meta: { elapsed_ms: base.elapsedMs },
        };
      },
    }),

    tool({
      name: 'cs2_list_players',
      description: 'Return the recorded roster with Steam ID, starting side, and the stable Team A/Team B identity. Team A starts CT, Team B starts T.',
      parameters: objectSchema({ demo: DEMO_PARAM }),
      async execute(args, exec) {
        const resolved = await store.resolve(exec, args.demo);
        const roster = await store.roster(exec, resolved);
        return {
          data: roster,
          meta: { row_count: roster.length },
        };
      },
    }),

    tool({
      name: 'cs2_list_events',
      description: 'List the game event names that actually occur in the demo. Use it before querying an event name you are unsure about.',
      parameters: objectSchema({ demo: DEMO_PARAM }),
      async execute(args, exec) {
        const resolved = await store.resolve(exec, args.demo);
        const base = await store.base(exec, resolved);
        return { data: base.eventNames, meta: { row_count: base.eventNames.length } };
      },
    }),

    tool({
      name: 'cs2_query_events',
      description: 'Query game events with optional extra properties and simple field filters. Request only the events and properties the question needs.',
      parameters: objectSchema({
        demo: DEMO_PARAM,
        event_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Event names such as "player_death" or "round_end". At most 16.',
        },
        player_props: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra player properties, attached with the user_ prefix (for example "X" becomes user_X).',
        },
        other_props: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra global game-state properties such as total_rounds_played.',
        },
        where: {
          type: 'object',
          additionalProperties: true,
          description: 'Exact-match filters such as {"total_rounds_played": 3, "is_warmup_period": false}.',
        },
        rounds: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Only rows in these display rounds, for example [15,16,17].',
        },
        include_warmup: {
          type: 'boolean',
          description: 'Include warmup-period events. Defaults to false.',
        },
        limit: { ...LIMIT_PARAM, description: 'Maximum event rows. Defaults to 1000, maximum 50000.' },
      }, ['demo', 'event_names']),
      async execute(args, exec) {
        const resolved = await store.resolve(exec, args.demo);
        const names = optionalStringArray(args.event_names, 'event_names', {
          max: MAX_EVENT_NAMES,
          pattern: /^[a-z][a-z0-9_]{0,63}$/,
        });
        if (names.length === 0) throw new Error('event_names must contain at least one event name.');
        const playerProps = optionalStringArray(args.player_props, 'player_props', { max: MAX_PROPERTIES });
        let otherProps = optionalStringArray(args.other_props, 'other_props', { max: MAX_PROPERTIES });
        const limit = clampInt(args.limit, 1, MAX_EVENT_ROWS, 1000);

        const includeWarmup = args.include_warmup === true;
        const where = args.where;
        const wantedRounds = optionalIntArray(args.rounds, 'rounds', { max: 100, min: 1 });

        const roundBounds = await store.eventRows(
          exec,
          resolved,
          ['round_start', 'round_freeze_end', 'round_end'],
          [],
          [],
        );
        const model = buildRoundModel(roundBounds);

        const rows = await store.eventRows(exec, resolved, names, playerProps, otherProps);
        const filtered = rows
          .map((row) => {
            const tick = num(row.tick);
            return {
              ...row,
              round: tick === undefined ? null : roundAtTick(Math.trunc(tick), model.rounds) ?? null,
            };
          })
          .filter((row) => includeWarmup || row.round !== null)
          .filter((row) => wantedRounds === undefined || (row.round !== null && wantedRounds.includes(row.round)))
          .filter((row) => matchesWhere(row, where));
        const annotated = await annotateBombSites(exec, store, resolved, filtered);
        const bounded = boundRows(annotated, limit);
        return { data: bounded.rows, meta: bounded.meta };
      },
    }),

    tool({
      name: 'cs2_query_ticks',
      description: 'Query player state at specific ticks, or at evenly sampled ticks across the match. Prefer explicit ticks; whole-match tick dumps are expensive.',
      parameters: objectSchema({
        demo: DEMO_PARAM,
        props: {
          type: 'array',
          items: { type: 'string' },
          description: 'Player properties such as X, Y, health, active_weapon_name. At most 40.',
        },
        ticks: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Explicit demo ticks. At most 10000. When omitted, ticks are sampled across the match.',
        },
        players: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional Steam IDs to include. At most 64.',
        },
        limit: { ...LIMIT_PARAM, description: 'Maximum rows and, when ticks are omitted, the number of sampled ticks. Defaults to 500.' },
      }, ['demo', 'props']),
      async execute(args, exec) {
        const resolved = await store.resolve(exec, args.demo);
        const props = optionalStringArray(args.props, 'props', { max: MAX_PROPERTIES });
        if (props.length === 0) throw new Error('props must contain at least one player property.');
        const players = optionalStringArray(args.players, 'players', { max: MAX_STEAM_IDS });
        const limit = clampInt(args.limit, 1, MAX_TICK_ROWS, 500);
        let ticks = optionalIntArray(args.ticks, 'ticks', { max: MAX_REQUESTED_TICKS, min: 0 });

        if (ticks === undefined) {
          const bounds = await store.eventRows(
            exec,
            resolved,
            ['round_start', 'round_freeze_end', 'round_end'],
            [],
            [],
          );
          const model = buildRoundModel(bounds);
          const from = model.rounds[0]?.start_tick ?? 0;
          const to = model.rounds.at(-1)?.end_tick ?? (from + 64 * 60);
          const count = Math.max(1, limit);
          ticks = equidistantIndices(Math.max(1, to - from + 1), count).map((offset) => from + offset);
        }

        const wantsActiveWeapon = props.includes('active_weapon_name');
        const parseProps = wantsActiveWeapon && !props.includes('inventory') ? [...props, 'inventory'] : props;
        const result = await store.parser.call('ticks', {
          path: resolved.path,
          props: parseProps,
          ticks,
          players: players.length > 0 ? players : null,
        }, exec.signal);
        const rows = wantsActiveWeapon
          ? result.data.map((row) => {
            if (!Array.isArray(row.inventory)) return row;
            const { inventory, ...rest } = row;
            const weapon = bestWeapon(inventory);
            return props.includes('inventory') ? { ...rest, inventory, best_weapon: weapon } : { ...rest, best_weapon: weapon };
          })
          : result.data;
        const bounded = boundRows(rows, limit);
        return { data: bounded.rows, meta: { ...bounded.meta, elapsed_ms: result.elapsedMs } };
      },
    }),

    tool({
      name: 'cs2_positions',
      description: 'Sample player positions in the live part of rounds, with the demo\'s place name, bomb-zone flag, and either raw rows or an aggregated heatmap of places and map cells.',
      parameters: objectSchema({
        demo: DEMO_PARAM,
        players: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional player names or Steam IDs. Defaults to all players.',
        },
        round: {
          type: 'integer',
          description: 'Optional single display round.',
        },
        from_round: { type: 'integer', description: 'Optional first display round (inclusive).' },
        to_round: { type: 'integer', description: 'Optional last display round (inclusive).' },
        format: {
          type: 'string',
          enum: ['heatmap', 'rows'],
          description: 'heatmap (default) aggregates places and cells; rows returns bounded samples.',
        },
        step_seconds: {
          type: 'number',
          description: 'Seconds between samples. Defaults to 2; higher is cheaper.',
        },
        cell_units: {
          type: 'integer',
          description: 'World units per heatmap cell. Defaults to 256.',
        },
        top_cells: {
          type: 'integer',
          description: 'Cells per player/team when include_cells is true. Defaults to 12.',
        },
        include_cells: {
          type: 'boolean',
          description: 'Include raw heatmap cells per player and team. Defaults to false.',
        },
        limit: { ...LIMIT_PARAM, description: 'Maximum rows when format is rows. Defaults to 2000.' },
      }, ['demo']),
      async execute(args, exec) {
        const resolved = await store.resolve(exec, args.demo);
        const roster = await store.roster(exec, resolved);
        const base = await store.base(exec, resolved);
        const players = resolvePlayerFilter(roster, args.players);
        const round = args.round === undefined ? undefined : clampInt(args.round, 1, 999, undefined);
        const fromRound = args.from_round === undefined ? undefined : clampInt(args.from_round, 1, 999, undefined);
        const toRound = args.to_round === undefined ? undefined : clampInt(args.to_round, 1, 999, undefined);
        const stepSeconds = Math.min(30, Math.max(0.5, num(args.step_seconds) ?? 2));
        const format = args.format === 'rows' ? 'rows' : 'heatmap';
        const limit = clampInt(args.limit, 1, MAX_TICK_ROWS, 2000);

        const sampled = await samplePositions(exec, store, resolved, roster, {
          round,
          fromRound,
          toRound,
          stepSeconds,
          maxTicks: 5000,
          players,
        });

        if (format === 'rows') {
          const bounded = boundRows(sampled.rows, limit);
          return { data: bounded.rows, meta: { ...bounded.meta, elapsed_ms: sampled.elapsedMs } };
        }

        const includeCells = args.include_cells === true;
        const aggregated = aggregatePositions(sampled.rows, roster, {
          cellUnits: clampInt(args.cell_units, 32, 2048, 256),
          topCells: clampInt(args.top_cells, 1, 30, 12),
        });
        const tinyPlaces = (places, limit) => places.slice(0, limit).map((place) => ({
          place: place.place,
          samples: place.samples,
          share: place.share,
        }));
        const compactPlayer = (player) => ({
          name: player.name,
          steamid: player.steamid,
          stable_team: player.stable_team,
          samples: player.samples,
          tiles_visited: player.tiles_visited,
          distance_units: player.distance_units,
          places: tinyPlaces(player.places, 5),
          ...(includeCells ? { top_cells: player.top_cells } : {}),
        });
        const compactTeam = (team) => ({
          samples: team.samples,
          places: tinyPlaces(team.places, 6),
          ...(includeCells ? { top_cells: team.top_cells } : {}),
        });
        return {
          data: {
            map: base.header?.map_name ?? null,
            rounds: sampled.windows.map((window) => window.round),
            sample_step_seconds: Math.round((sampled.step / 64) * 10) / 10,
            players: aggregated.players.map(compactPlayer),
            teams: { A: compactTeam(aggregated.teams.A), B: compactTeam(aggregated.teams.B) },
            places: aggregated.places.slice(0, 15).map((place) => ({
              place: place.place,
              samples: place.samples,
              share: place.share,
              bomb_zone_samples: place.bomb_zone_samples,
            })),
            bounds: aggregated.bounds,
            cell_units: aggregated.cell_units,
            note: aggregated.note,
          },
          meta: { row_count: sampled.rows.length, elapsed_ms: sampled.elapsedMs },
        };
      },
    }),

    tool({
      name: 'cs2_map_overview',
      description: 'Summarize how the map was actually used: observed place names, time share per place and team, map bounds, and the tight bomb-target boxes. Use it to ground map reasoning before discussing holds and rotations.',
      parameters: objectSchema({
        demo: DEMO_PARAM,
        step_seconds: {
          type: 'number',
          description: 'Seconds between position samples. Defaults to 4.',
        },
        limit_places: {
          type: 'integer',
          description: 'Places in the catalog. Defaults to 20, maximum 60.',
        },
        include_players: {
          type: 'boolean',
          description: 'Include per-player top places. Defaults to false.',
        },
        include_cells: {
          type: 'boolean',
          description: 'Include raw heatmap cells per team. Defaults to false.',
        },
      }, ['demo']),
      async execute(args, exec) {
        const resolved = await store.resolve(exec, args.demo);
        const roster = await store.roster(exec, resolved);
        const base = await store.base(exec, resolved);
        const stepSeconds = Math.min(30, Math.max(1, num(args.step_seconds) ?? 4));
        const sampled = await samplePositions(exec, store, resolved, roster, {
          stepSeconds,
          maxTicks: 3000,
          players: null,
        });
        const aggregated = aggregatePositions(sampled.rows, roster, { cellUnits: 256, topCells: 8 });
        const limitPlaces = clampInt(args.limit_places, 1, 60, 20);
        const compactPlaces = (places, limit) => places.slice(0, limit).map((place) => ({
          place: place.place,
          samples: place.samples,
          share: place.share,
          teams: place.teams,
          bounds: place.bounds,
        }));
        const compactTeam = (team) => ({
          samples: team.samples,
          places: compactPlaces(team.places, 10),
          ...(args.include_cells === true ? { top_cells: team.top_cells } : {}),
        });
        return {
          data: {
            map: base.header?.map_name ?? null,
            rounds: aggregated.rounds,
            sample_step_seconds: Math.round((sampled.step / 64) * 10) / 10,
            place_catalog: compactPlaces(aggregated.places, limitPlaces),
            bounds: aggregated.bounds,
            bomb_targets: aggregated.places
              .filter((place) => place.bomb_zone_samples > 0)
              .map((place) => ({
                place: place.place,
                samples: place.bomb_zone_samples,
                bounds: place.bomb_target_bounds,
              })),
            teams: { A: compactTeam(aggregated.teams.A), B: compactTeam(aggregated.teams.B) },
            ...(args.include_players === true ? {
              player_samples: aggregated.players.map((player) => ({
                name: player.name,
                stable_team: player.stable_team,
                samples: player.samples,
                places: player.places.slice(0, 5).map((place) => place.place),
              })),
            } : {}),
            note: 'place bounds are the callout extent observed in this demo; bomb_targets bounds are the tight in_bomb_zone (plant trigger) volume, not the whole site. ' + aggregated.note,
          },
          meta: { row_count: sampled.rows.length, elapsed_ms: sampled.elapsedMs },
        };
      },
    }),

    tool({
      name: 'cs2_query_grenades',
      description: 'Return compact grenade trajectories: thrower, type, start/end position, peak height, and sampled path points. Aggregated per grenade.',
      parameters: objectSchema({
        demo: DEMO_PARAM,
        extra: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional extra properties attached to each trajectory sample.',
        },
        path_points: {
          type: 'integer',
          description: 'Path samples per grenade. Defaults to 24, maximum 64.',
        },
        limit: { ...LIMIT_PARAM, description: 'Maximum grenades. Defaults to 200.' },
      }, ['demo']),
      async execute(args, exec) {
        const resolved = await store.resolve(exec, args.demo);
        const extra = optionalStringArray(args.extra, 'extra', { max: MAX_PROPERTIES });
        const pathPoints = clampInt(args.path_points, 2, 64, 24);
        const limit = clampInt(args.limit, 1, 1000, 200);
        const result = await store.parser.call('grenades', {
          path: resolved.path,
          extra,
          pathPoints,
        }, exec.signal);

        const bounds = await store.eventRows(
          exec,
          resolved,
          ['round_start', 'round_freeze_end', 'round_end'],
          [],
          [],
        );
        const model = buildRoundModel(bounds);

        const withRounds = [];
        for (const grenade of result.data) {
          const round = roundAtTick(grenade.start_tick, model.rounds);
          if (round === undefined) continue;
          withRounds.push({ ...grenade, round });
        }

        const bounded = boundRows(withRounds, limit);
        return { data: bounded.rows, meta: { ...bounded.meta, elapsed_ms: result.elapsedMs } };
      },
    }),

    tool({
      name: 'cs2_round_summary',
      description: 'Return the round-by-round score flow: winner (stable team and raw side), reason, tick window, kill count, and a compact freeze-end economy summary per side.',
      parameters: objectSchema({ demo: DEMO_PARAM }),
      async execute(args, exec) {
        const resolved = await store.resolve(exec, args.demo);
        const analysis = await store.analysis(exec, resolved);
        const model = buildRoundModel(analysis.events);
        const teamModel = buildTeamModel(analysis.tickRows, analysis.roster, model.rounds);
        const { rounds } = resolveRounds(model, teamModel);
        const economy = new Map(buildEconomy(analysis.tickRows, teamModel, model).map((row) => [row.round, row]));
        const data = rounds.map((round) => {
          const eco = economy.get(round.round);
          return {
            round: round.round,
            start_tick: round.start_tick,
            end_tick: round.end_tick,
            winner_side: round.winner_side,
            winner_team: round.winner_team,
            reason: round.reason,
            kill_count: round.kills.length,
            score_a: round.score.A,
            score_b: round.score.B,
            t_buy: eco?.t.buy_type ?? null,
            ct_buy: eco?.ct.buy_type ?? null,
            t_equip: eco === undefined ? null : Math.round(eco.t.average_equip_value),
            ct_equip: eco === undefined ? null : Math.round(eco.ct.average_equip_value),
            t_cash_spent: eco?.t.cash_spent_this_round ?? null,
            ct_cash_spent: eco?.ct.cash_spent_this_round ?? null,
          };
        });
        return {
          data,
          meta: { row_count: data.length, elapsed_ms: analysis.elapsedMs },
        };
      },
    }),

    tool({
      name: 'cs2_economy',
      description: 'Return per-round side economy at the freeze end: average balance, equipment value, per-round spend, and buy classification (eco/semi-buy/force-buy/full-buy/pistol).',
      parameters: objectSchema({ demo: DEMO_PARAM }),
      async execute(args, exec) {
        const resolved = await store.resolve(exec, args.demo);
        const analysis = await store.analysis(exec, resolved);
        const model = buildRoundModel(analysis.events);
        const teamModel = buildTeamModel(analysis.tickRows, analysis.roster, model.rounds);
        const rows = buildEconomy(analysis.tickRows, teamModel, model);
        return {
          data: rows,
          meta: { row_count: rows.length, elapsed_ms: analysis.elapsedMs },
        };
      },
    }),

    tool({
      name: 'cs2_utility',
      description: 'Summarize utility usage per player: smokes, flashes, molotovs, HE grenades, enemies flashed, flash duration, and utility damage.',
      parameters: objectSchema({
        demo: DEMO_PARAM,
        round: {
          type: 'integer',
          description: 'Optional display round number to scope the summary to one round.',
        },
      }, ['demo']),
      async execute(args, exec) {
        const resolved = await store.resolve(exec, args.demo);
        const analysis = await store.analysis(exec, resolved);
        const model = buildRoundModel(analysis.events);
        const teamModel = buildTeamModel(analysis.tickRows, analysis.roster, model.rounds);
        const round = args.round === undefined ? undefined : clampInt(args.round, 1, 999, undefined);
        const data = computeUtility({
          roster: analysis.roster,
          events: analysis.events,
          model,
          teamModel,
          round,
        });
        return {
          data,
          meta: { row_count: data.players.length, elapsed_ms: analysis.elapsedMs },
        };
      },
    }),

    tool({
      name: 'cs2_player_stats',
      description: 'Return derived player and team statistics: K/D/A, ADR, KAST, rating approximation, headshots, opening duels, trades, multi-kills, clutches, utility damage, and flash assists.',
      parameters: objectSchema({ demo: DEMO_PARAM }),
      async execute(args, exec) {
        const resolved = await store.resolve(exec, args.demo);
        const analysis = await store.analysis(exec, resolved);
        const model = buildRoundModel(analysis.events);
        const teamModel = buildTeamModel(analysis.tickRows, analysis.roster, model.rounds);
        const { rounds } = resolveRounds(model, teamModel);
        const stats = computePlayerStats({
          roster: analysis.roster,
          rounds,
          events: analysis.events,
          teamModel,
          model,
        });
        return {
          data: { ...stats, rounds_analyzed: rounds.length, demo: resolved.path },
          meta: { row_count: stats.players.length, elapsed_ms: analysis.elapsedMs },
        };
      },
    }),
  ];
}

export { boundRows, matchesWhere };
