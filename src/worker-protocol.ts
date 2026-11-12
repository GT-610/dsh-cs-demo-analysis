/**
 * The worker RPC contract, shared by the main-thread client and the worker.
 *
 * This module exports types only, so it disappears at build time. The point of
 * the mapping is that an operation's name and its argument shape cannot drift
 * apart: passing `{ name: [...] }` where the worker reads `args.names` would
 * otherwise reach `parseEvents` as `undefined` and parse every event in the
 * demo instead of failing.
 */

import type { EventRow, Row, TickRow } from './types.ts';

/** One sampled point of a grenade trajectory. */
export interface GrenadePoint {
  tick: number;
  x: number;
  y: number;
  z: number;
}

/** One aggregated grenade: hundreds of per-tick rows collapsed into a path. */
export interface Grenade {
  grenade_type: string;
  engine_type: string;
  entity_id: number;
  thrower: string | null;
  steamid: string | null;
  start_tick: number;
  end_tick: number;
  start: [number, number, number];
  end: [number, number, number];
  max_z: number;
  samples: number;
  path: GrenadePoint[];
}

/** Arguments accepted by each parser operation. */
export interface ParseArgs {
  header: { path: string };
  players: { path: string };
  eventNames: { path: string };
  events: { path: string; names: string[]; playerProps?: string[] | null; otherProps?: string[] | null };
  ticks: { path: string; props: string[]; ticks?: number[] | null; players?: string[] | null };
  grenades: { path: string; extra?: string[] | null; pathPoints?: number | null };
  updatedFields: { path: string };
}

/** What each parser operation resolves to. */
export interface ParseData {
  header: Record<string, unknown>;
  players: Row[];
  eventNames: string[];
  events: EventRow[];
  ticks: TickRow[];
  grenades: Grenade[];
  updatedFields: string[];
}

/** Every parser operation name. */
export type ParseOperation = keyof ParseArgs;

/** One request: the operation and its arguments travel together. */
export type ParseRequest = {
  [K in ParseOperation]: { id: number; op: K; args: ParseArgs[K] };
}[ParseOperation];

/** One response, correlated by `id`. */
export type ParseResponse =
  | { id: number; ok: true; data: unknown; elapsedMs: number }
  | { id: number; ok: false; error: string; elapsedMs: number };

/** A resolved parser result. */
export interface ParseResult<K extends ParseOperation> {
  data: ParseData[K];
  elapsedMs: number;
}

/** Type guard for the message that reaches the worker. */
export function isParseRequest(message: unknown): message is ParseRequest {
  return message !== null && typeof message === 'object' && 'op' in message && 'args' in message;
}

/** Type guard for the message that reaches the client. */
export function isParseResponse(message: unknown): message is ParseResponse {
  return message !== null && typeof message === 'object' && 'id' in message && 'ok' in message;
}
