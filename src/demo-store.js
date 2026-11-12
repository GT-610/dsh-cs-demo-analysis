/**
 * Demo file resolution, validation, and per-demo caches.
 *
 * The module owns three concerns:
 *  - turning a model-supplied path into a validated CS2 demo on disk;
 *  - caching the expensive, stable demo facts (header, roster, event names);
 *  - loading the bounded evidence set every analysis tool shares.
 */

import { open, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { MAX_DEMO_BYTES } from './constants.js';
import { formatBytes, num, str } from './util.js';

const MAX_CACHED_DEMOS = 4;
const MAX_CACHED_EVENT_SETS = 8;

const COMPRESSED_FORMATS = [
  { magic: 'BZh', hint: 'This is a bzip2 archive. Decompress it to a .dem file first.' },
  { magic: 'PK', hint: 'This is a zip archive. Extract the .dem file inside it first.' },
  { magic: 'Rar!', hint: 'This is a RAR archive. Extract the .dem file inside it first.' },
];

const ANALYSIS_EVENTS = [
  'round_start',
  'round_end',
  'round_freeze_end',
  'player_death',
  'player_hurt',
  'bomb_planted',
  'bomb_defused',
  'player_blind',
  'smokegrenade_detonate',
  'smokegrenade_expired',
  'inferno_startburn',
  'inferno_expire',
  'flashbang_detonate',
  'hegrenade_detonate',
];

const FREEZE_TICK_PROPS = [
  'team_num',
  'team_name',
  'balance',
  'current_equip_value',
  'start_balance',
  'cash_spent_this_round',
  'total_cash_spent',
];

function isWindowsAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

async function inspectDemoFile(absPath) {
  let info;
  try {
    info = await stat(absPath);
  } catch {
    throw new Error(
      `Demo not found: ${absPath}. Use cs2_find_demos with the directory that contains the demo, `
      + 'or pass an absolute path.',
    );
  }
  if (!info.isFile()) throw new Error(`Not a file: ${absPath}`);
  if (info.size === 0) throw new Error(`Demo file is empty: ${absPath}`);
  if (info.size > MAX_DEMO_BYTES) {
    throw new Error(`Demo is too large (${formatBytes(info.size)}); the limit is ${formatBytes(MAX_DEMO_BYTES)}.`);
  }

  const handle = await open(absPath, 'r');
  let head;
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    head = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  for (const format of COMPRESSED_FORMATS) {
    if (head.subarray(0, format.magic.length).toString('latin1') === format.magic) {
      throw new Error(`${absPath}: ${format.hint}`);
    }
  }
  if (head.subarray(0, 7).toString('latin1') !== 'PBDEMS2') {
    throw new Error(
      `${absPath}: not a Counter-Strike 2 demo (expected the PBDEMS2 stamp). CS:GO demos and `
      + 'non-demo files are not supported.',
    );
  }
  return info;
}

export class DemoStore {
  constructor(ctx, parser) {
    this.ctx = ctx;
    this.parser = parser;
    this.demos = new Map();
    this.eventSets = new Map();
  }

  async cwd(exec) {
    if (exec?.agent !== undefined && this.ctx?.workingDirectory !== undefined) {
      return this.ctx.workingDirectory.ensure(exec.agent, exec.signal);
    }
    return process.cwd();
  }

  /** Resolve the model-supplied path against the session workspace and validate it. */
  async resolve(exec, demo) {
    const raw = typeof demo === 'string' ? demo.trim() : '';
    if (raw === '') throw new Error('A demo path is required.');
    if (/^file:\/\//i.test(raw)) throw new Error('Pass a filesystem path, not a file:// URL.');
    if (isWindowsAbsolute(raw) && process.platform !== 'win32') {
      throw new Error(`Windows path "${raw}" cannot be read on ${process.platform}. Use a path on this machine.`);
    }

    const expanded = expandHome(raw);
    const absPath = isAbsolute(expanded) ? expanded : resolve(await this.cwd(exec), expanded);
    const info = await inspectDemoFile(absPath);
    return { path: absPath, size: info.size, mtimeMs: info.mtimeMs };
  }

  #evictDemos() {
    while (this.demos.size > MAX_CACHED_DEMOS) {
      const oldest = this.demos.keys().next().value;
      this.demos.delete(oldest);
    }
  }

  /** Header, roster, and event-name catalog, parsed once per file revision. */
  async base(exec, resolved) {
    const cached = this.demos.get(resolved.path);
    if (cached !== undefined && cached.mtimeMs === resolved.mtimeMs && cached.size === resolved.size) {
      return cached;
    }
    const [header, players, eventNames] = await Promise.all([
      this.parser.call('header', { path: resolved.path }, exec.signal),
      this.parser.call('players', { path: resolved.path }, exec.signal),
      this.parser.call('eventNames', { path: resolved.path }, exec.signal),
    ]);
    const record = {
      path: resolved.path,
      size: resolved.size,
      mtimeMs: resolved.mtimeMs,
      header: header.data,
      players: players.data,
      eventNames: eventNames.data,
      elapsedMs: header.elapsedMs + players.elapsedMs + eventNames.elapsedMs,
    };
    this.demos.delete(resolved.path);
    this.demos.set(resolved.path, record);
    this.#evictDemos();
    return record;
  }

  #evictEventSets() {
    while (this.eventSets.size > MAX_CACHED_EVENT_SETS) {
      const oldest = this.eventSets.keys().next().value;
      this.eventSets.delete(oldest);
    }
  }

  /** Parse an event set once; later tools reuse the same bounded rows. */
  async eventRows(exec, resolved, names, playerProps = [], otherProps = []) {
    const key = JSON.stringify([resolved.path, resolved.size, resolved.mtimeMs, names, playerProps, otherProps]);
    const cached = this.eventSets.get(key);
    if (cached !== undefined) {
      this.eventSets.delete(key);
      this.eventSets.set(key, cached);
      return cached;
    }
    const result = await this.parser.call('events', {
      path: resolved.path,
      names,
      playerProps,
      otherProps,
    }, exec.signal);
    this.eventSets.set(key, result.data);
    this.#evictEventSets();
    return result.data;
  }

  /** Stable roster: Team A is the roster that starts CT, Team B starts T. */
  async roster(exec, resolved) {
    const base = await this.base(exec, resolved);
    const spawns = await this.eventRows(
      exec,
      resolved,
      ['player_spawn'],
      ['team_num'],
      ['total_rounds_played', 'is_warmup_period'],
    );
    return buildRoster(spawns, base.players);
  }

  /** Shared evidence bundle for round, economy, and player-stat analysis. */
  async analysis(exec, resolved) {
    const base = await this.base(exec, resolved);
    const roster = await this.roster(exec, resolved);
    const events = await this.eventRows(
      exec,
      resolved,
      ANALYSIS_EVENTS,
      ['team_num'],
      ['total_rounds_played', 'is_warmup_period'],
    );

    const freezeEnds = events.filter((event) => event.event_name === 'round_freeze_end'
      && event.is_warmup_period !== true
      && Number.isFinite(num(event.tick))
      && Number.isFinite(num(event.total_rounds_played)));
    const freezeTicks = [...new Set(freezeEnds.map((event) => Math.trunc(num(event.tick))))];
    let tickRows = [];
    let tickElapsedMs = 0;
    if (freezeTicks.length > 0) {
      const ticks = await this.parser.call('ticks', {
        path: resolved.path,
        props: FREEZE_TICK_PROPS,
        ticks: freezeTicks,
        players: null,
      }, exec.signal);
      tickRows = ticks.data;
      tickElapsedMs = ticks.elapsedMs;
    }

    return {
      base,
      roster,
      events,
      freezeEnds,
      tickRows,
      elapsedMs: base.elapsedMs + tickElapsedMs,
    };
  }

  dispose() {
    this.demos.clear();
    this.eventSets.clear();
  }
}

/**
 * Build the stable roster from first-spawn evidence, falling back to the
 * end-of-match player list. A final side alone cannot prove the starting side,
 * so it is only used through a mapping learned from players we did observe.
 */
export function buildRoster(spawns, playerInfo) {
  const identities = new Map();
  for (const event of spawns) {
    if (event.is_warmup_period === true) continue;
    const steamid = str(event.user_steamid);
    const teamNumber = num(event.user_team_num);
    if (steamid === undefined || steamid === '0') continue;
    if (teamNumber !== 2 && teamNumber !== 3) continue;
    const tick = num(event.tick) ?? Number.MAX_SAFE_INTEGER;
    const current = identities.get(steamid);
    if (current === undefined || tick < current.tick) {
      identities.set(steamid, {
        name: str(event.user_name) ?? current?.name ?? '',
        steamid,
        tick,
        teamNumber,
        source: 'spawn',
      });
    }
  }

  const finalSide = new Map();
  for (const player of Array.isArray(playerInfo) ? playerInfo : []) {
    const steamid = str(player?.steamid);
    if (steamid === undefined) continue;
    const teamNumber = num(player?.team_number);
    if (teamNumber === 2 || teamNumber === 3) finalSide.set(steamid, teamNumber);
    if (!identities.has(steamid)) {
      identities.set(steamid, {
        name: str(player?.name) ?? '',
        steamid,
        tick: Number.MAX_SAFE_INTEGER,
        teamNumber: undefined,
        source: 'final',
      });
    } else if (identities.get(steamid).name === '') {
      identities.get(steamid).name = str(player?.name) ?? '';
    }
  }

  // final side -> initial side, only while every observation agrees
  const finalToInitial = new Map();
  const initialToFinal = new Map();
  for (const identity of identities.values()) {
    const final = finalSide.get(identity.steamid);
    if (final === undefined || identity.teamNumber === undefined) continue;
    if (finalToInitial.has(final) && finalToInitial.get(final) !== identity.teamNumber) {
      finalToInitial.delete(final);
      continue;
    }
    if (initialToFinal.has(identity.teamNumber) && initialToFinal.get(identity.teamNumber) !== final) {
      initialToFinal.delete(identity.teamNumber);
      continue;
    }
    finalToInitial.set(final, identity.teamNumber);
    initialToFinal.set(identity.teamNumber, final);
  }

  const roster = [];
  for (const identity of identities.values()) {
    let teamNumber = identity.teamNumber;
    let source = identity.source;
    if (teamNumber === undefined) {
      const final = finalSide.get(identity.steamid);
      const inferred = final === undefined ? undefined : finalToInitial.get(final);
      if (inferred !== undefined) {
        teamNumber = inferred;
        source = 'inferred';
      }
    }
    roster.push({
      name: identity.name,
      steamid: identity.steamid,
      team_number: teamNumber ?? null,
      stable_team: teamNumber === 3 ? 'A' : teamNumber === 2 ? 'B' : null,
      initial_side: teamNumber === 3 ? 'CT' : teamNumber === 2 ? 'T' : null,
      team_source: source,
    });
  }

  roster.sort((left, right) => {
    const rank = (team) => (team === 'A' ? 0 : team === 'B' ? 1 : 2);
    return rank(left.stable_team) - rank(right.stable_team)
      || (left.name ?? '').localeCompare(right.name ?? '');
  });
  return roster;
}
