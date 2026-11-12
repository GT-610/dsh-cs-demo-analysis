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
import { num, str } from './util.ts';
import type { Row } from './types.ts';
import type { Grenade, GrenadePoint, ParseRequest } from './worker-protocol.ts';
import { isParseRequest } from './worker-protocol.ts';

const require = createRequire(import.meta.url);

/**
 * The native surface this preset uses. demoparser2 ships `any` for every
 * export, so this interface is the one place that states the contract; the
 * cast below is the boundary where "trusted but untyped" becomes typed.
 */
interface DemoparserApi {
  parseHeader(path: string): Record<string, unknown>;
  parsePlayerInfo(path: string): Row[];
  listGameEvents(path: string): string[];
  parseEvents(path: string, names?: string[] | null, playerExtra?: string[] | null, otherExtra?: string[] | null): Row[];
  parseTicks(path: string, wantedProps: string[], wantedTicks?: number[] | null, wantedPlayers?: string[] | null, structOfArrays?: boolean, orderBySteamid?: boolean): Row[];
  parseGrenades(path: string, extra?: string[] | null, grenades?: boolean): Row[];
  listUpdatedFields(path: string): unknown;
}

let native: DemoparserApi | undefined;
let nativeError: Error | undefined;

function parser(): DemoparserApi {
  if (native !== undefined) return native;
  if (nativeError !== undefined) throw nativeError;
  try {
    native = require('@laihoe/demoparser2') as DemoparserApi;
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
function friendlyGrenadeType(engineType: unknown): string {
  const name = String(engineType ?? '').toLowerCase();
  if (name.includes('smoke')) return 'smoke';
  if (name.includes('flash')) return 'flashbang';
  if (name.includes('incendiary')) return 'incendiary';
  if (name.includes('molotov')) return 'molotov';
  if (name.includes('decoy')) return 'decoy';
  if (name.includes('hegrenade') || name.includes('he_grenade') || name.includes('frag')) return 'he';
  return 'unknown';
}

interface GrenadeGroup {
  grenade_type: string;
  entity_id: number;
  thrower: string | null;
  steamid: string | null;
  start_tick: number;
  end_tick: number;
  start: [number, number, number];
  end: [number, number, number];
  max_z: number;
  points: Array<[number, number, number, number]>;
  count: number;
}

/**
 * Collapse the raw per-tick projectile rows into one compact record per
 * grenade. A single match emits hundreds of thousands of raw rows, so this
 * aggregation must happen before anything crosses the worker boundary.
 */
function aggregateGrenades(rows: readonly Row[], pathPoints: number): Grenade[] {
  const groups = new Map<string, GrenadeGroup>();
  for (const row of rows) {
    const entity = num(row.grenade_entity_id ?? row.entity_id);
    const tick = num(row.tick);
    const x = num(row.x) ?? 0;
    const y = num(row.y) ?? 0;
    const z = num(row.z) ?? 0;
    if (entity === undefined || tick === undefined) continue;
    const type = String(row.grenade_type ?? row.grenade_name ?? 'unknown');
    const key = `${type}:${entity}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        grenade_type: type,
        entity_id: entity,
        thrower: str(row.name) ?? null,
        steamid: str(row.steamid) ?? null,
        start_tick: tick,
        end_tick: tick,
        start: [x, y, z],
        end: [x, y, z],
        max_z: z,
        points: [],
        count: 0,
      };
      groups.set(key, group);
    }
    group.count += 1;
    group.end_tick = tick;
    group.end = [x, y, z];
    if (z > group.max_z) group.max_z = z;
    group.points.push([tick, x, y, z]);
  }

  const result: Grenade[] = [];
  for (const group of groups.values()) {
    const points = group.points;
    const stride = Math.max(1, Math.ceil(points.length / pathPoints));
    const path: GrenadePoint[] = [];
    for (let index = 0; index < points.length; index += stride) {
      const point = points[index];
      if (point === undefined) continue;
      path.push({ tick: point[0], x: point[1], y: point[2], z: point[3] });
    }
    const last = points[points.length - 1];
    if (last !== undefined && path[path.length - 1]?.tick !== last[0]) {
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

function execute(request: ParseRequest): unknown {
  const api = parser();
  switch (request.op) {
    case 'header':
      return api.parseHeader(request.args.path);
    case 'players':
      return api.parsePlayerInfo(request.args.path);
    case 'eventNames':
      return api.listGameEvents(request.args.path);
    case 'events':
      return api.parseEvents(
        request.args.path,
        request.args.names,
        request.args.playerProps ?? null,
        request.args.otherProps ?? null,
      );
    case 'ticks':
      return api.parseTicks(
        request.args.path,
        request.args.props,
        request.args.ticks ?? null,
        request.args.players ?? null,
        false,
        false,
      );
    case 'grenades':
      return aggregateGrenades(
        api.parseGrenades(request.args.path, request.args.extra ?? null, false),
        request.args.pathPoints ?? 32,
      );
    case 'updatedFields':
      return api.listUpdatedFields(request.args.path);
    default:
      throw new Error(`unknown parser operation "${String((request as { op?: unknown }).op)}"`);
  }
}

if (parentPort === null) {
  throw new Error('parse-worker must run inside a worker thread');
}

parentPort.on('message', (message: unknown) => {
  if (!isParseRequest(message)) {
    parentPort?.postMessage({ id: -1, ok: false, error: 'malformed parser request', elapsedMs: 0 });
    return;
  }
  const { id } = message;
  const started = Date.now();
  try {
    const data = execute(message);
    parentPort?.postMessage({ id, ok: true, data, elapsedMs: Date.now() - started });
  } catch (error) {
    parentPort?.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started,
    });
  }
});
