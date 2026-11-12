/** Small, dependency-free helpers shared by the tools and the analysis layer. */

export function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function str(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

export function roundOf(event) {
  const round = num(event?.total_rounds_played);
  return round === undefined ? undefined : Math.trunc(round);
}

export function isWarmup(event) {
  return event?.is_warmup_period === true;
}

export function clampInt(value, low, high, fallback) {
  const parsed = num(value);
  if (parsed === undefined) return fallback;
  return Math.min(high, Math.max(low, Math.trunc(parsed)));
}

/** Indices of `count` items sampled evenly, always including first and last. */
export function equidistantIndices(count, limit) {
  if (limit <= 0 || count <= 0) return [];
  if (limit >= count) return Array.from({ length: count }, (_, index) => index);
  if (limit === 1) return [0];
  const last = count - 1;
  return Array.from({ length: limit }, (_, index) => Math.floor((index * last) / (limit - 1)));
}

/** Bound an array to `limit` rows by even sampling; reports whether it sampled. */
export function sampleRows(rows, limit) {
  const total = rows.length;
  if (limit >= total) return { rows, total, sampled: false };
  const picked = equidistantIndices(total, limit)
    .map((index) => rows[index])
    .filter((row) => row !== undefined);
  return { rows: picked, total, sampled: true };
}

/** Team number 3 is CT, 2 is T. Team A is the roster that starts CT. */
export function stableTeam(teamNumber) {
  if (teamNumber === 3) return 'A';
  if (teamNumber === 2) return 'B';
  return undefined;
}

export function sideLabel(teamNumber) {
  if (teamNumber === 3) return 'CT';
  if (teamNumber === 2) return 'T';
  return undefined;
}

export function stableTeamRank(teamNumber) {
  if (teamNumber === 3) return 0;
  if (teamNumber === 2) return 1;
  return 2;
}

/** Deduplicate while keeping first-seen order. */
export function unique(items) {
  return [...new Set(items)];
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const PRIMARY_WEAPONS = new Set([
  'AK-47', 'M4A1-S', 'M4A4', 'AUG', 'SG 553', 'Galil AR', 'FAMAS',
  'AWP', 'SSG 08', 'G3SG1', 'SCAR-20',
]);
const SECONDARY_LONG = new Set([
  'MP9', 'MP7', 'MP5-SD', 'MAC-10', 'UMP-45', 'P90', 'PP-Bizon',
  'Nova', 'XM1014', 'MAG-7', 'Sawed-Off',
]);
const PISTOLS = new Set([
  'Desert Eagle', 'R8 Revolver', 'USP-S', 'Glock-18', 'P2000', 'P250',
  'Five-SeveN', 'Tec-9', 'CZ75-Auto', 'Dual Berettas',
]);

function weaponRank(weapon) {
  const name = String(weapon ?? '');
  if (name === 'AWP') return 5;
  if (PRIMARY_WEAPONS.has(name)) return 4;
  if (SECONDARY_LONG.has(name)) return 3;
  if (PISTOLS.has(name)) return 2;
  return 0;
}

/**
 * Pick the strongest carried weapon from an inventory list. `active_weapon_name`
 * is whatever is in hand (knife, grenade, bomb), so it is a poor proxy for the
 * player's actual equipment.
 */
export function bestWeapon(inventory) {
  if (!Array.isArray(inventory)) return null;
  let best = null;
  let bestRank = 0;
  for (const weapon of inventory) {
    const rank = weaponRank(weapon);
    if (rank > bestRank) {
      bestRank = rank;
      best = weapon;
    }
  }
  return best;
}
