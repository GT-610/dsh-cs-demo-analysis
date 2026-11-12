/**
 * Deterministic analysis over the bounded evidence bundle.
 *
 * Round numbering is derived from round_end ticks and the round_start that
 * precedes each end. Demo counters are NOT used for numbering: demoparser2
 * reports `total_rounds_played` with different bases across demo generations
 * (round_end is 1-based in current professional demos while round_start and
 * in-round events are 0-based), so mapping by counter shifts events by one
 * round. Tick windows are stable.
 */

import { num } from './util.js';
import { UTILITY_WEAPONS } from './constants.js';

const TRADE_WINDOW_TICKS = 320; // 5 seconds at 64 tick
const TICKRATE = 64;
const HALF_LENGTH = 12;

export const BUY_TYPES = Object.freeze([
  { max: 2_000, name: 'eco' },
  { max: 3_500, name: 'semi-buy' },
  { max: 4_500, name: 'force-buy' },
  { max: Number.POSITIVE_INFINITY, name: 'full-buy' },
]);

export function classifyBuy(averageEquipValue) {
  for (const bucket of BUY_TYPES) {
    if (averageEquipValue < bucket.max) return bucket.name;
  }
  return 'full-buy';
}

export function isCountedKill(event) {
  const attacker = event.attacker_steamid;
  const victim = event.user_steamid;
  if (attacker === undefined || attacker === null || victim === undefined || victim === null) return false;
  if (String(attacker) === String(victim)) return false;
  return true;
}

/** Normalize the many shapes of round_end.winner into a side number. */
export function parseWinnerSide(value) {
  if (typeof value === 'number') return value === 2 || value === 3 ? value : undefined;
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'ct' || text === '3' || text.includes('counter')) return 3;
  if (text === 't' || text === '2' || text.includes('terror')) return 2;
  return undefined;
}

export function normalizeReason(event) {
  const value = event.reason ?? event.message;
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number') return String(value);
  return null;
}

function lastAtOrBefore(items, tick) {
  let low = 0;
  let high = items.length - 1;
  let found;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (items[middle].tick <= tick) {
      found = items[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

function lastBetween(ticks, low, high) {
  let found;
  for (const tick of ticks) {
    if (tick > high) break;
    if (tick >= low) found = tick;
  }
  return found;
}

/**
 * Build the competitive round model: tick windows, winner side, reason, and
 * the kill list for each round. Warmup rounds and malformed round_end rows are
 * dropped.
 */
export function buildRoundModel(events) {
  const starts = events
    .filter((event) => event.event_name === 'round_start' && Number.isFinite(num(event.tick)))
    .map((event) => ({ tick: Math.trunc(num(event.tick)), warmup: event.is_warmup_period === true }))
    .sort((left, right) => left.tick - right.tick);
  const freezes = events
    .filter((event) => event.event_name === 'round_freeze_end' && Number.isFinite(num(event.tick)))
    .map((event) => Math.trunc(num(event.tick)))
    .sort((left, right) => left - right);
  const ends = events
    .filter((event) => event.event_name === 'round_end' && Number.isFinite(num(event.tick)))
    .map((event) => ({
      tick: Math.trunc(num(event.tick)),
      side: parseWinnerSide(event.winner),
      reason: normalizeReason(event),
      reasonCode: typeof event.reason === 'number' ? event.reason : null,
    }))
    // A tick-1 round_end with no winner or reason is a recording artifact,
    // not a round. A partially valid end is kept so numbering cannot shift.
    .filter((end) => end.tick > 1 && (end.side !== undefined || end.reason !== null))
    .sort((left, right) => left.tick - right.tick);

  const rounds = [];
  for (const end of ends) {
    const start = lastAtOrBefore(starts, end.tick);
    if (start === undefined || start.warmup) continue;
    const previousEnd = rounds.length > 0 ? rounds[rounds.length - 1].end_tick : 0;
    if (end.tick <= previousEnd) continue;
    const startTick = start.tick > previousEnd ? start.tick : previousEnd + 1;
    if (end.tick <= startTick) continue;
    const freeze = lastBetween(freezes, startTick, end.tick);
    rounds.push({
      round: rounds.length + 1,
      start_tick: startTick,
      freeze_tick: freeze ?? null,
      end_tick: end.tick,
      winner_side: end.side,
      winner_team: null,
      reason: end.reason,
      reason_code: end.reasonCode,
      kills: [],
      score: { A: 0, B: 0 },
    });
  }

  const killsByRound = new Map();
  for (const event of events) {
    if (event.event_name !== 'player_death' || event.is_warmup_period === true || !isCountedKill(event)) continue;
    const tick = num(event.tick);
    if (tick === undefined) continue;
    const round = roundAtTick(tick, rounds);
    if (round === undefined) continue;
    let kills = killsByRound.get(round);
    if (kills === undefined) {
      kills = [];
      killsByRound.set(round, kills);
    }
    kills.push({
      tick: Math.trunc(tick),
      attacker: event.attacker_steamid === undefined || event.attacker_steamid === null ? null : String(event.attacker_steamid),
      attacker_name: event.attacker_name ?? null,
      victim: event.user_steamid === undefined || event.user_steamid === null ? null : String(event.user_steamid),
      victim_name: event.user_name ?? null,
      assister: event.assister_steamid === undefined || event.assister_steamid === null ? null : String(event.assister_steamid),
      weapon: event.weapon ?? null,
      headshot: event.headshot === true,
    });
  }
  for (const round of rounds) {
    round.kills = (killsByRound.get(round.round) ?? []).sort((left, right) => left.tick - right.tick);
  }

  return { rounds, flashDataAvailable: events.some((event) => event.event_name === 'player_blind') };
}

/** Binary-search the display round whose [start, end] window contains a tick. */
export function roundAtTick(tick, rounds) {
  if (!Number.isFinite(tick) || rounds.length === 0) return undefined;
  let low = 0;
  let high = rounds.length - 1;
  let found;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (rounds[middle].end_tick >= tick) {
      found = rounds[middle];
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  if (found !== undefined && found.start_tick <= tick) return found.round;
  return undefined;
}

/** Side membership per round from freeze-end ticks, plus side→stable-team votes. */
export function buildTeamModel(tickRows, roster, rounds) {
  const teamsByRound = new Map();
  for (const row of Array.isArray(tickRows) ? tickRows : []) {
    const tick = num(row.tick);
    const round = tick === undefined ? undefined : roundAtTick(Math.trunc(tick), rounds);
    const steamid = row.steamid === undefined ? undefined : String(row.steamid);
    const side = num(row.team_num);
    if (round === undefined || steamid === undefined || (side !== 2 && side !== 3)) continue;
    let teams = teamsByRound.get(round);
    if (teams === undefined) {
      teams = new Map();
      teamsByRound.set(round, teams);
    }
    teams.set(steamid, side);
  }

  const rosterBySteam = new Map(roster.map((player) => [player.steamid, player]));

  function sideToStableTeam(round, side) {
    const teams = teamsByRound.get(round);
    if (teams !== undefined) {
      const votes = new Map();
      for (const [steamid, team] of teams) {
        if (team !== side) continue;
        const stable = rosterBySteam.get(steamid)?.stable_team;
        if (stable !== undefined && stable !== null) votes.set(stable, (votes.get(stable) ?? 0) + 1);
      }
      const winner = [...votes.entries()].sort((left, right) => right[1] - left[1])[0];
      if (winner !== undefined) return winner[0];
    }
    return side === 3 ? 'A' : side === 2 ? 'B' : undefined;
  }

  function teamOf(steamid, round) {
    const side = teamsByRound.get(round)?.get(steamid);
    if (side !== undefined) return side;
    return rosterBySteam.get(steamid)?.team_number ?? undefined;
  }

  return { teamsByRound, rosterBySteam, sideToStableTeam, teamOf };
}

/** Attach stable winners and the running score to the round model. */
export function resolveRounds(model, teamModel) {
  const score = { A: 0, B: 0 };
  const rounds = model.rounds.map((round) => {
    const winnerTeam = teamModel.sideToStableTeam(round.round, round.winner_side);
    if (winnerTeam === 'A' || winnerTeam === 'B') score[winnerTeam] += 1;
    return {
      ...round,
      winner_side: round.winner_side === 3 ? 'CT' : round.winner_side === 2 ? 'T' : null,
      winner_team: winnerTeam ?? null,
      score: { ...score },
    };
  });
  return { rounds };
}

function emptySide() {
  return {
    steamids: new Set(),
    players: 0,
    totalBalance: 0,
    totalEquipValue: 0,
    totalStartBalance: 0,
    cashSpentRound: 0,
    cashSpentMatch: 0,
  };
}

function finishSide(side, stableTeam, pistol) {
  const divisor = Math.max(1, side.players);
  const averageEquip = side.totalEquipValue / divisor;
  return {
    stable_team: stableTeam ?? null,
    players: side.players,
    total_balance: side.totalBalance,
    average_balance: round2(side.totalBalance / divisor),
    total_equip_value: side.totalEquipValue,
    average_equip_value: round2(averageEquip),
    total_start_balance: side.totalStartBalance,
    cash_spent_this_round: side.cashSpentRound,
    average_cash_spent_this_round: round2(side.cashSpentRound / divisor),
    cash_spent_match_cumulative: side.cashSpentMatch,
    buy_type: pistol ? 'pistol' : classifyBuy(averageEquip),
  };
}

/**
 * Per-round side economy at the freeze-end tick. `cash_spent_this_round` is a
 * per-round value; `total_cash_spent` from the demo is cumulative across the
 * match and is exposed separately.
 */
export function buildEconomy(tickRows, teamModel, model) {
  const byRound = new Map();
  for (const row of Array.isArray(tickRows) ? tickRows : []) {
    const tick = num(row.tick);
    const round = tick === undefined ? undefined : roundAtTick(Math.trunc(tick), model.rounds);
    const side = num(row.team_num);
    const steamid = row.steamid === undefined ? undefined : String(row.steamid);
    if (round === undefined || steamid === undefined || (side !== 2 && side !== 3)) continue;
    let entry = byRound.get(round);
    if (entry === undefined) {
      entry = { t: emptySide(), ct: emptySide() };
      byRound.set(round, entry);
    }
    const bucket = side === 2 ? entry.t : entry.ct;
    if (bucket.steamids.has(steamid)) continue;
    bucket.steamids.add(steamid);
    bucket.players += 1;
    bucket.totalBalance += num(row.balance) ?? 0;
    bucket.totalEquipValue += num(row.current_equip_value) ?? 0;
    bucket.totalStartBalance += num(row.start_balance) ?? 0;
    bucket.cashSpentRound += num(row.cash_spent_this_round) ?? 0;
    bucket.cashSpentMatch += num(row.total_cash_spent) ?? 0;
  }

  const rows = [];
  for (const round of [...byRound.keys()].sort((left, right) => left - right)) {
    const entry = byRound.get(round);
    const pistol = round === 1 || (round - 1) % HALF_LENGTH === 0;
    rows.push({
      round,
      pistol_round: pistol,
      t: finishSide(entry.t, teamModel.sideToStableTeam(round, 2), pistol),
      ct: finishSide(entry.ct, teamModel.sideToStableTeam(round, 3), pistol),
    });
  }
  return rows;
}

function emptyPlayer(player) {
  return {
    name: player.name ?? String(player.steamid),
    steamid: String(player.steamid),
    stable_team: player.stable_team ?? null,
    rounds: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    headshot_kills: 0,
    damage: 0,
    utility_damage: 0,
    enemies_flashed: null,
    flash_duration: null,
    kast_rounds: 0,
    traded_deaths: 0,
    opening_kills: 0,
    opening_deaths: 0,
    plants: 0,
    defuses: 0,
    multi: { '2k': 0, '3k': 0, '4k': 0, '5k': 0 },
    clutch_wins: 0,
    clutch_situations: 0,
  };
}

function groupByRound(events, eventName, model) {
  const groups = new Map();
  for (const event of events) {
    if (event.event_name !== eventName || event.is_warmup_period === true) continue;
    const tick = num(event.tick);
    if (tick === undefined) continue;
    const round = roundAtTick(tick, model.rounds);
    if (round === undefined) continue;
    let group = groups.get(round);
    if (group === undefined) {
      group = [];
      groups.set(round, group);
    }
    group.push(event);
  }
  return groups;
}

/**
 * Player and team statistics.
 *
 * KAST uses the standard definition: a round counts when the player got a
 * kill or assist, survived, or was traded. Rating is the public HLTV 2.0
 * approximation; it is not an official HLTV figure.
 */
export function computePlayerStats({ roster, rounds, events, teamModel, model }) {
  const rosterBySteam = teamModel.rosterBySteam;
  const stats = new Map();
  const limitations = [];

  const flashEvents = events.some((event) => event.event_name === 'player_blind');
  if (!flashEvents) {
    limitations.push('player_blind events are absent from this demo; flash statistics are unavailable');
  }

  for (const player of roster) stats.set(player.steamid, emptyPlayer(player));

  const ensure = (steamid, name) => {
    if (steamid === undefined || steamid === null) return undefined;
    const key = String(steamid);
    if (key === '' || key === 'null' || key === 'undefined' || key === '0') return undefined;
    let entry = stats.get(key);
    if (entry === undefined) {
      entry = emptyPlayer({ name: name ?? key, steamid: key, stable_team: rosterBySteam.get(key)?.stable_team ?? null });
      stats.set(key, entry);
    }
    if (name !== undefined && entry.name === entry.steamid) entry.name = name;
    return entry;
  };

  const hurtByRound = groupByRound(events, 'player_hurt', model);
  const blindByRound = groupByRound(events, 'player_blind', model);
  const plantByRound = groupByRound(events, 'bomb_planted', model);
  const defuseByRound = groupByRound(events, 'bomb_defused', model);

  for (const round of rounds) {
    const roundNumber = round.round;
    const teams = teamModel.teamsByRound.get(roundNumber);
    if (teams === undefined) limitations.push(`round ${roundNumber}: no freeze-end team snapshot; side mapping falls back to the starting roster`);

    const participants = new Set();
    if (teams !== undefined) {
      for (const steamid of teams.keys()) participants.add(steamid);
    } else {
      for (const player of roster) participants.add(player.steamid);
    }
    for (const steamid of participants) {
      const entry = stats.get(steamid) ?? ensure(steamid);
      if (entry !== undefined) entry.rounds += 1;
    }

    const teamOf = (steamid) => teamModel.teamOf(steamid, roundNumber);
    const alive = new Map();
    for (const steamid of participants) {
      const team = teamOf(steamid);
      if (team === undefined) continue;
      if (!alive.has(team)) alive.set(team, new Set());
      alive.get(team).add(steamid);
    }

    const killsByPlayer = new Map();
    const assistsByPlayer = new Map();
    const deathsByPlayer = new Set();
    const traded = new Set();
    const clutchCandidates = new Map();

    for (let index = 0; index < round.kills.length; index += 1) {
      const kill = round.kills[index];
      const attacker = kill.attacker === null ? undefined : String(kill.attacker);
      const victim = kill.victim === null ? undefined : String(kill.victim);
      if (victim !== undefined) {
        deathsByPlayer.add(victim);
        const entry = ensure(victim, kill.victim_name);
        if (entry !== undefined) entry.deaths += 1;
      }
      if (attacker !== undefined && attacker !== victim) {
        killsByPlayer.set(attacker, (killsByPlayer.get(attacker) ?? 0) + 1);
        const entry = ensure(attacker, kill.attacker_name);
        if (entry !== undefined) {
          entry.kills += 1;
          if (kill.headshot) entry.headshot_kills += 1;
        }
      }
      if (kill.assister !== null && kill.assister !== undefined) {
        const assister = String(kill.assister);
        assistsByPlayer.set(assister, (assistsByPlayer.get(assister) ?? 0) + 1);
        const entry = ensure(assister);
        if (entry !== undefined) entry.assists += 1;
      }

      if (index === 0 && attacker !== undefined && attacker !== victim) {
        const opener = ensure(attacker, kill.attacker_name);
        if (opener !== undefined) opener.opening_kills += 1;
        const victimEntry = ensure(victim, kill.victim_name);
        if (victimEntry !== undefined) victimEntry.opening_deaths += 1;
      }

      // Trade: the victim's teammate kills the killer within the window.
      if (victim !== undefined && attacker !== undefined && attacker !== victim) {
        const victimTeam = teamOf(victim);
        for (let later = index + 1; later < round.kills.length; later += 1) {
          const next = round.kills[later];
          const nextAttacker = next.attacker === null ? undefined : String(next.attacker);
          const nextVictim = next.victim === null ? undefined : String(next.victim);
          const delta = (next.tick ?? 0) - (kill.tick ?? 0);
          if (delta < 0) continue;
          if (delta > TRADE_WINDOW_TICKS) break;
          if (nextVictim === attacker && nextAttacker !== undefined && nextAttacker !== victim) {
            const avengerTeam = teamOf(nextAttacker);
            if (victimTeam !== undefined && avengerTeam === victimTeam) {
              traded.add(victim);
              break;
            }
          }
        }
      }

      // The last player alive on a side becomes a clutch candidate.
      if (victim !== undefined) {
        const victimTeam = teamOf(victim);
        if (victimTeam !== undefined) {
          const teammates = alive.get(victimTeam);
          teammates?.delete(victim);
          if (teammates !== undefined && teammates.size === 1) {
            const lastAlive = [...teammates][0];
            const enemies = victimTeam === 2 ? alive.get(3) : alive.get(2);
            const enemyCount = enemies?.size ?? 0;
            if (enemyCount > 0) clutchCandidates.set(lastAlive, Math.max(clutchCandidates.get(lastAlive) ?? 0, enemyCount));
          }
        }
      }
    }

    for (const [steamid, count] of killsByPlayer) {
      if (count < 2) continue;
      const entry = ensure(steamid);
      const key = `${Math.min(5, count)}k`;
      if (entry !== undefined && entry.multi[key] !== undefined) entry.multi[key] += 1;
    }

    for (const steamid of participants) {
      const entry = ensure(steamid);
      if (entry === undefined) continue;
      const survived = !deathsByPlayer.has(steamid);
      const gotKill = killsByPlayer.has(steamid);
      const gotAssist = assistsByPlayer.has(steamid);
      const wasTraded = traded.has(steamid);
      if (gotKill || gotAssist || survived || wasTraded) entry.kast_rounds += 1;
      if (wasTraded) entry.traded_deaths += 1;
    }

    for (const [steamid, enemyCount] of clutchCandidates) {
      const entry = ensure(steamid);
      if (entry === undefined) continue;
      entry.clutch_situations += 1;
      const playerTeam = teamModel.teamOf(steamid, roundNumber);
      const playerTeamName = playerTeam === 3
        ? teamModel.sideToStableTeam(roundNumber, 3)
        : teamModel.sideToStableTeam(roundNumber, 2);
      if (playerTeamName !== undefined && round.winner_team === playerTeamName && enemyCount > 0) entry.clutch_wins += 1;
    }

    for (const event of plantByRound.get(roundNumber) ?? []) {
      const entry = ensure(stringOrUndefined(event.user_steamid), event.user_name);
      if (entry !== undefined) entry.plants += 1;
    }
    for (const event of defuseByRound.get(roundNumber) ?? []) {
      const entry = ensure(stringOrUndefined(event.user_steamid), event.user_name);
      if (entry !== undefined) entry.defuses += 1;
    }

    for (const hurt of hurtByRound.get(roundNumber) ?? []) {
      const attacker = stringOrUndefined(hurt.attacker_steamid);
      if (attacker === undefined) continue;
      const entry = ensure(attacker, hurt.attacker_name);
      if (entry === undefined) continue;
      const damage = num(hurt.dmg_health) ?? 0;
      entry.damage += damage;
      if (UTILITY_WEAPONS.has(String(hurt.weapon ?? ''))) entry.utility_damage += damage;
    }

    for (const blind of blindByRound.get(roundNumber) ?? []) {
      const attacker = stringOrUndefined(blind.attacker_steamid);
      const victim = stringOrUndefined(blind.user_steamid);
      if (attacker === undefined || victim === undefined || attacker === victim) continue;
      const attackerTeam = teamModel.teamOf(attacker, roundNumber);
      const victimTeam = teamModel.teamOf(victim, roundNumber);
      if (attackerTeam === undefined || victimTeam === undefined || attackerTeam === victimTeam) continue;
      const entry = ensure(attacker);
      if (entry === undefined) continue;
      entry.enemies_flashed = (entry.enemies_flashed ?? 0) + 1;
      entry.flash_duration = (entry.flash_duration ?? 0) + (num(blind.blind_duration) ?? 0);
    }
  }

  const players = [...stats.values()]
    .filter((entry) => entry.rounds > 0)
    .map((entry) => {
      const roundsPlayed = Math.max(1, entry.rounds);
      const kpr = entry.kills / roundsPlayed;
      const dpr = entry.deaths / roundsPlayed;
      const apr = entry.assists / roundsPlayed;
      const adr = entry.damage / roundsPlayed;
      const kast = (entry.kast_rounds / roundsPlayed) * 100;
      const impact = 2.13 * kpr + 0.42 * apr - 0.41;
      const rating = 0.0073 * kast + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * adr + 0.1587;
      return {
        name: entry.name,
        steamid: entry.steamid,
        stable_team: entry.stable_team,
        rounds: entry.rounds,
        kills: entry.kills,
        deaths: entry.deaths,
        assists: entry.assists,
        kd: round2(entry.kills / Math.max(1, entry.deaths)),
        headshot_kills: entry.headshot_kills,
        hs_rate: entry.kills === 0 ? 0 : round2((entry.headshot_kills / entry.kills) * 100),
        adr: round2(adr),
        kast: round2(kast),
        kpr: round3(kpr),
        dpr: round3(dpr),
        apr: round3(apr),
        impact: round2(impact),
        rating: round2(rating),
        opening_kills: entry.opening_kills,
        opening_deaths: entry.opening_deaths,
        opening_rate: round2(100 * entry.opening_kills / Math.max(1, entry.opening_kills + entry.opening_deaths)),
        traded_deaths: entry.traded_deaths,
        clutch_wins: entry.clutch_wins,
        clutch_situations: entry.clutch_situations,
        multi_kills: entry.multi,
        plants: entry.plants,
        defuses: entry.defuses,
        utility_damage: Math.round(entry.utility_damage),
        enemies_flashed: entry.enemies_flashed,
        flash_duration: entry.flash_duration === null ? null : round2(entry.flash_duration),
      };
    })
    .sort((left, right) => right.rating - left.rating);

  return {
    players,
    teams: { A: teamAggregate('A', players, rounds), B: teamAggregate('B', players, rounds) },
    limitations: [...new Set(limitations)].slice(0, 12),
    flash_data_available: flashEvents,
    team_identity_note: 'Team A/B are starting-side identities (A started CT); the demo does not carry organization names',
    rating_note: 'rating/impact use the public HLTV 2.0 approximation, not official HLTV values',
  };
}

function teamAggregate(team, players, rounds) {
  const members = players.filter((player) => player.stable_team === team);
  const won = rounds.filter((round) => round.winner_team === team).length;
  const played = rounds.length;
  return {
    team,
    players: members.length,
    rounds_won: won,
    rounds_played: played,
    win_rate: played === 0 ? 0 : round2((won / played) * 100),
    kills: members.reduce((sum, player) => sum + player.kills, 0),
    deaths: members.reduce((sum, player) => sum + player.deaths, 0),
    average_rating: members.length === 0 ? 0 : round2(members.reduce((sum, player) => sum + player.rating, 0) / members.length),
    average_adr: members.length === 0 ? 0 : round2(members.reduce((sum, player) => sum + player.adr, 0) / members.length),
  };
}

/**
 * Utility usage per player. Detonations are deduplicated by entity id because
 * a single smoke can emit several detonate events. Flash effectiveness is
 * reported only when the demo contains player_blind events.
 */
export function computeUtility({ roster, events, model, teamModel, round }) {
  const players = new Map();
  const seen = new Set();

  const ensure = (steamid, name) => {
    if (steamid === undefined || steamid === null) return undefined;
    const key = String(steamid);
    if (key === '' || key === 'null' || key === 'undefined' || key === '0') return undefined;
    let entry = players.get(key);
    if (entry === undefined) {
      const known = teamModel.rosterBySteam.get(key);
      entry = {
        name: known?.name ?? name ?? key,
        steamid: key,
        stable_team: known?.stable_team ?? null,
        smokes: 0,
        flashes: 0,
        molotovs: 0,
        he_grenades: 0,
        enemies_flashed: model.flashDataAvailable ? 0 : null,
        flash_duration: model.flashDataAvailable ? 0 : null,
        utility_damage: 0,
      };
      players.set(key, entry);
    }
    return entry;
  };

  for (const player of roster) ensure(player.steamid, player.name);

  const inScope = (event) => {
    if (event.is_warmup_period === true) return false;
    const tick = num(event.tick);
    if (tick === undefined) return false;
    const mapped = roundAtTick(tick, model.rounds);
    if (mapped === undefined) return false;
    return round === undefined || mapped === round;
  };

  for (const event of events) {
    if (!inScope(event)) continue;

    if (event.event_name === 'player_hurt') {
      if (!UTILITY_WEAPONS.has(String(event.weapon ?? ''))) continue;
      const attacker = stringOrUndefined(event.attacker_steamid);
      if (attacker === undefined) continue;
      const entry = ensure(attacker, event.attacker_name);
      if (entry !== undefined) entry.utility_damage += num(event.dmg_health) ?? 0;
      continue;
    }

    if (event.event_name === 'player_blind') {
      if (!model.flashDataAvailable) continue;
      const attacker = stringOrUndefined(event.attacker_steamid);
      const victim = stringOrUndefined(event.user_steamid);
      if (attacker === undefined || victim === undefined || attacker === victim) continue;
      const mapped = roundAtTick(Math.trunc(num(event.tick)), model.rounds);
      const attackerTeam = teamModel.teamOf(attacker, mapped);
      const victimTeam = teamModel.teamOf(victim, mapped);
      if (attackerTeam === undefined || victimTeam === undefined || attackerTeam === victimTeam) continue;
      const entry = ensure(attacker);
      if (entry === undefined) continue;
      entry.enemies_flashed += 1;
      entry.flash_duration += num(blind_duration(event)) ?? 0;
      continue;
    }

    const entityKey = event.entityid ?? event.entity_id;
    if (entityKey !== undefined) {
      const key = `${event.event_name}:${entityKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }

    const steamid = stringOrUndefined(event.user_steamid);
    const entry = ensure(steamid, event.user_name);
    if (entry === undefined) continue;
    switch (event.event_name) {
      case 'smokegrenade_detonate': entry.smokes += 1; break;
      case 'flashbang_detonate': entry.flashes += 1; break;
      case 'inferno_startburn': entry.molotovs += 1; break;
      case 'hegrenade_detonate': entry.he_grenades += 1; break;
      default: break;
    }
  }

  const rows = [...players.values()]
    .map((entry) => ({
      ...entry,
      flash_duration: entry.flash_duration === null ? null : round2(entry.flash_duration),
      utility_damage: Math.round(entry.utility_damage),
    }))
    .sort((left, right) => right.utility_damage - left.utility_damage);

  return {
    players: rows,
    totals: {
      smokes: rows.reduce((sum, entry) => sum + entry.smokes, 0),
      flashes: rows.reduce((sum, entry) => sum + entry.flashes, 0),
      molotovs: rows.reduce((sum, entry) => sum + entry.molotovs, 0),
      he_grenades: rows.reduce((sum, entry) => sum + entry.he_grenades, 0),
      enemies_flashed: model.flashDataAvailable ? rows.reduce((sum, entry) => sum + (entry.enemies_flashed ?? 0), 0) : null,
      utility_damage: rows.reduce((sum, entry) => sum + entry.utility_damage, 0),
    },
    flash_data_available: model.flashDataAvailable,
    scope_round: round ?? 'all competitive rounds',
    note: model.flashDataAvailable
      ? 'counts use deduplicated detonation events'
      : 'counts use deduplicated detonation events; player_blind is absent, so flash effectiveness is unavailable',
  };
}

function blind_duration(event) {
  return event.blind_duration ?? event.flash_duration ?? 0;
}

function stringOrUndefined(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text === '' || text === 'null' || text === 'undefined' ? undefined : text;
}

export function round2(value) {
  return Math.round(value * 100) / 100;
}

export function round3(value) {
  return Math.round(value * 1000) / 1000;
}

export { TICKRATE };
