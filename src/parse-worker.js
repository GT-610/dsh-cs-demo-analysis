/**
 * Worker-thread entry point for native demo parsing.
 *
 * The demoparser2 binding is a synchronous N-API addon. Parsing a large demo
 * (or every tick of it) blocks the calling thread for hundreds of milliseconds
 * to several seconds and can allocate gigabytes, so every parse runs here
 * instead of on the Harness host's main thread.
 */

import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let native;
let nativeError;

function parser() {
  if (native !== undefined) return native;
  if (nativeError !== undefined) throw nativeError;
  try {
    native = require('@laihoe/demoparser2');
  } catch (error) {
    nativeError = new Error(
      `demoparser2 native binding is unavailable (${error instanceof Error ? error.message : String(error)}). `
      + 'Reinstall the plugin so npm can fetch the platform prebuild.',
    );
    throw nativeError;
  }
  return native;
}

/** Map engine projectile class names to stable, readable grenade kinds. */
function friendlyGrenadeType(engineType) {
  const name = String(engineType ?? '').toLowerCase();
  if (name.includes('smoke')) return 'smoke';
  if (name.includes('flash')) return 'flashbang';
  if (name.includes('incendiary')) return 'incendiary';
  if (name.includes('molotov')) return 'molotov';
  if (name.includes('decoy')) return 'decoy';
  if (name.includes('hegrenade') || name.includes('he_grenade') || name.includes('frag')) return 'he';
  return 'unknown';
}

/**
 * Collapse the raw per-tick projectile rows into one compact record per
 * grenade. A single match emits hundreds of thousands of raw rows, so this
 * aggregation must happen before anything crosses the worker boundary.
 */
function aggregateGrenades(rows, pathPoints) {
  const groups = new Map();
  for (const row of rows) {
    const entity = row.grenade_entity_id ?? row.entity_id;
    if (entity === undefined) continue;
    const type = row.grenade_type ?? row.grenade_name ?? 'unknown';
    const key = `${type}:${entity}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        grenade_type: type,
        entity_id: entity,
        thrower: row.name ?? null,
        steamid: row.steamid ?? null,
        start_tick: row.tick,
        end_tick: row.tick,
        start: [row.x, row.y, row.z],
        end: [row.x, row.y, row.z],
        max_z: row.z,
        points: [],
        count: 0,
      };
      groups.set(key, group);
    }
    group.count += 1;
    group.end_tick = row.tick;
    group.end = [row.x, row.y, row.z];
    if (row.z > group.max_z) group.max_z = row.z;
    group.points.push([row.tick, row.x, row.y, row.z]);
  }

  const result = [];
  for (const group of groups.values()) {
    const points = group.points;
    const stride = Math.max(1, Math.ceil(points.length / pathPoints));
    const path = [];
    for (let index = 0; index < points.length; index += stride) {
      const point = points[index];
      path.push({ tick: point[0], x: point[1], y: point[2], z: point[3] });
    }
    const last = points[points.length - 1];
    if (path[path.length - 1]?.tick !== last[0]) {
      path.push({ tick: last[0], x: last[1], y: last[2], z: last[3] });
    }
    result.push({
      grenade_type: friendlyGrenadeType(group.grenade_type),
      engine_type: group.grenade_type,
      entity_id: group.entity_id,
      thrower: group.thrower,
      steamid: group.steamid,
      start_tick: group.start_tick,
      end_tick: group.end_tick,
      start: group.start,
      end: group.end,
      max_z: group.max_z,
      samples: group.count,
      path,
    });
  }
  result.sort((left, right) => left.start_tick - right.start_tick);
  return result;
}

function execute(op, args) {
  const api = parser();
  const path = args.path;
  switch (op) {
    case 'header':
      return api.parseHeader(path);
    case 'players':
      return api.parsePlayerInfo(path);
    case 'eventNames':
      return api.listGameEvents(path);
    case 'events':
      return api.parseEvents(path, args.names, args.playerProps ?? null, args.otherProps ?? null);
    case 'ticks':
      return api.parseTicks(path, args.props, args.ticks ?? null, args.players ?? null, false, false);
    case 'grenades':
      return aggregateGrenades(api.parseGrenades(path, args.extra ?? null, false), args.pathPoints ?? 32);
    case 'updatedFields':
      return api.listUpdatedFields(path);
    default:
      throw new Error(`unknown parser operation "${op}"`);
  }
}

parentPort.on('message', (message) => {
  const { id, op, args } = message;
  const started = Date.now();
  try {
    const data = execute(op, args ?? {});
    parentPort.postMessage({ id, ok: true, data, elapsedMs: Date.now() - started });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started,
    });
  }
});
