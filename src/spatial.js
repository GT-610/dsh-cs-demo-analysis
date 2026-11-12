/** Round windows, tick sampling, and spatial aggregation for position evidence. */

import { num } from './util.js';

export const TICK_RATE = 64;

/** Build per-round [start, freeze-end, end] tick windows from the round model. */
export function buildRoundWindows(rounds) {
  return rounds.map((round) => ({
    round: round.round,
    start: round.start_tick,
    freeze: round.freeze_tick,
    end: round.end_tick,
    liveStart: round.freeze_tick ?? (round.start_tick + 15 * TICK_RATE),
  })).filter((window) => window.liveStart !== undefined && window.end !== undefined && window.end > window.liveStart);
}

/**
 * Evenly sample ticks inside the live portion of each window.
 * Doubles the stride until the total fits `maxTicks`.
 */
export function sampleWindowTicks(windows, stepSeconds, maxTicks = 5_000) {
  let step = Math.max(1, Math.round(stepSeconds * TICK_RATE));
  const estimate = (stride) => windows.reduce((sum, window) => {
    const span = window.end - 64 - window.liveStart;
    return sum + (span <= 0 ? 0 : Math.floor(span / stride) + 1);
  }, 0);

  while (estimate(step) > maxTicks && step < 64 * 60) step *= 2;

  const ticks = [];
  for (const window of windows) {
    const last = window.end - 64;
    for (let tick = window.liveStart; tick <= last; tick += step) ticks.push(tick);
    if (ticks.length >= maxTicks) break;
  }
  return { ticks: [...new Set(ticks)].sort((left, right) => left - right), step };
}

/** Map a tick to the display round whose live window contains it. */
export function roundForTick(tick, windows) {
  let low = 0;
  let high = windows.length - 1;
  let candidate;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (windows[middle].liveStart <= tick) {
      candidate = windows[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (candidate !== undefined && tick <= candidate.end) return candidate.round;
  return undefined;
}

function regionLabel(x, y, bounds) {
  const width = bounds.maxX - bounds.minX || 1;
  const height = bounds.maxY - bounds.minY || 1;
  const nx = (x - bounds.minX) / width;
  const ny = (y - bounds.minY) / height;
  const horizontal = nx < 0.34 ? 'west' : nx > 0.66 ? 'east' : 'center';
  const vertical = ny < 0.34 ? 'south' : ny > 0.66 ? 'north' : 'center';
  if (horizontal === 'center' && vertical === 'center') return 'center';
  if (horizontal === 'center') return vertical;
  if (vertical === 'center') return horizontal;
  return `${vertical}-${horizontal}`;
}

/** Turn a place counter into a bounded, share-annotated list. */
export function placeRows(counter, limit = 20) {
  const total = [...counter.values()].reduce((sum, entry) => sum + entry.samples, 0);
  return [...counter.entries()]
    .map(([place, entry]) => ({
      place,
      samples: entry.samples,
      share: total === 0 ? 0 : Math.round((entry.samples / total) * 1000) / 10,
      bomb_zone_samples: entry.bombZone,
      teams: { A: entry.teams.A, B: entry.teams.B },
      bounds: entry.samples === 0 ? null : {
        min_x: Math.round(entry.minX),
        max_x: Math.round(entry.maxX),
        min_y: Math.round(entry.minY),
        max_y: Math.round(entry.maxY),
      },
      bomb_target_bounds: entry.bombZone === 0 ? null : {
        min_x: Math.round(entry.bombMinX),
        max_x: Math.round(entry.bombMaxX),
        min_y: Math.round(entry.bombMinY),
        max_y: Math.round(entry.bombMaxY),
      },
    }))
    .sort((left, right) => right.samples - left.samples)
    .slice(0, limit);
}

function addPlace(map, place, team, x, y, bombZone) {
  let entry = map.get(place);
  if (entry === undefined) {
    entry = {
      samples: 0,
      bombZone: 0,
      teams: { A: 0, B: 0 },
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      bombMinX: Number.POSITIVE_INFINITY,
      bombMaxX: Number.NEGATIVE_INFINITY,
      bombMinY: Number.POSITIVE_INFINITY,
      bombMaxY: Number.NEGATIVE_INFINITY,
    };
    map.set(place, entry);
  }
  entry.samples += 1;
  entry.minX = Math.min(entry.minX, x);
  entry.maxX = Math.max(entry.maxX, x);
  entry.minY = Math.min(entry.minY, y);
  entry.maxY = Math.max(entry.maxY, y);
  if (bombZone) {
    entry.bombZone += 1;
    entry.bombMinX = Math.min(entry.bombMinX, x);
    entry.bombMaxX = Math.max(entry.bombMaxX, x);
    entry.bombMinY = Math.min(entry.bombMinY, y);
    entry.bombMaxY = Math.max(entry.bombMaxY, y);
  }
  if (team === 'A' || team === 'B') entry.teams[team] += 1;
  return entry;
}

/**
 * Aggregate sampled position rows into per-player, per-team, and map-level
 * place evidence. Rows: { round, tick, steamid, name, team_num, x, y, place, bomb_zone }.
 */
export function aggregatePositions(rows, roster, { cellUnits = 256, topCells = 12 } = {}) {
  const rosterBySteam = new Map(roster.map((player) => [player.steamid, player]));
  const bounds = { minX: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY };
  const players = new Map();
  const mapPlaces = new Map();
  const teamCells = { A: new Map(), B: new Map() };
  const teamPlaces = { A: new Map(), B: new Map() };
  const roundSet = new Set();

  for (const row of rows) {
    const x = num(row.x);
    const y = num(row.y);
    if (x === undefined || y === undefined) continue;
    const place = typeof row.place === 'string' && row.place.trim() !== '' ? row.place.trim() : 'unknown';
    const bombZone = row.bomb_zone === true;
    const stable = rosterBySteam.get(row.steamid)?.stable_team ?? null;

    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxY = Math.max(bounds.maxY, y);
    roundSet.add(row.round);

    addPlace(mapPlaces, place, stable, x, y, bombZone);

    const player = players.get(row.steamid) ?? {
      name: rosterBySteam.get(row.steamid)?.name ?? row.name ?? row.steamid,
      steamid: row.steamid,
      stable_team: stable,
      samples: 0,
      distance: 0,
      cells: new Map(),
      places: new Map(),
      last: undefined,
    };
    players.set(row.steamid, player);

    const key = `${Math.floor(x / cellUnits)}:${Math.floor(y / cellUnits)}`;
    const cell = player.cells.get(key) ?? { x: 0, y: 0, count: 0 };
    cell.x += x;
    cell.y += y;
    cell.count += 1;
    player.cells.set(key, cell);
    player.samples += 1;
    addPlace(player.places, place, stable, x, y, bombZone);

    if (player.last !== undefined && player.last.round === row.round) {
      player.distance += Math.hypot(x - player.last.x, y - player.last.y);
    }
    player.last = { x, y, round: row.round };

    if (stable === 'A' || stable === 'B') {
      const map = teamCells[stable];
      const teamCell = map.get(key) ?? { x: 0, y: 0, count: 0 };
      teamCell.x += x;
      teamCell.y += y;
      teamCell.count += 1;
      map.set(key, teamCell);
      addPlace(teamPlaces[stable], place, stable, x, y, bombZone);
    }
  }

  if (rows.length === 0) {
    return { players: [], teams: { A: null, B: null }, places: [], bounds: null, cell_units: cellUnits, note: 'no position samples' };
  }

  const toCells = (map, samples) => [...map.entries()]
    .map(([key, cell]) => {
      const x = cell.x / cell.count;
      const y = cell.y / cell.count;
      return {
        cell: key.split(':').map(Number),
        x: Math.round(x),
        y: Math.round(y),
        samples: cell.count,
        share: samples === 0 ? 0 : Math.round((cell.count / samples) * 1000) / 10,
        region: regionLabel(x, y, bounds),
      };
    })
    .sort((left, right) => right.samples - left.samples)
    .slice(0, topCells);

  const playerRows = [...players.values()].map((player) => ({
    name: player.name,
    steamid: player.steamid,
    stable_team: player.stable_team,
    samples: player.samples,
    tiles_visited: player.cells.size,
    distance_units: Math.round(player.distance),
    places: placeRows(player.places, 12),
    top_cells: toCells(player.cells, player.samples),
  })).sort((left, right) => right.samples - left.samples);

  const teamSamples = (team) => [...teamPlaces[team].values()].reduce((sum, entry) => sum + entry.samples, 0);

  return {
    players: playerRows,
    teams: {
      A: { samples: teamSamples('A'), places: placeRows(teamPlaces.A, 15), top_cells: toCells(teamCells.A, teamSamples('A')) },
      B: { samples: teamSamples('B'), places: placeRows(teamPlaces.B, 15), top_cells: toCells(teamCells.B, teamSamples('B')) },
    },
    places: placeRows(mapPlaces, 40),
    bounds: {
      min_x: Math.round(bounds.minX),
      max_x: Math.round(bounds.maxX),
      min_y: Math.round(bounds.minY),
      max_y: Math.round(bounds.maxY),
    },
    rounds: [...roundSet].sort((left, right) => left - right),
    cell_units: cellUnits,
    note: 'places are the demo\'s in-game place names (last_place_name); region is derived from the sampled bounds, not map callouts',
  };
}
