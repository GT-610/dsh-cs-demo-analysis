/** Shared bounds and limits for tool inputs and outputs. */

export const MAX_EVENT_ROWS = 50_000;
export const MAX_TICK_ROWS = 10_000;
export const MAX_REQUESTED_TICKS = 10_000;
export const MAX_PROPERTIES = 40;
export const MAX_EVENT_NAMES = 16;
export const MAX_STEAM_IDS = 64;
export const MAX_SERIALIZED_ROWS_BYTES = 512 * 1024;

export const MAX_DEMO_BYTES = 4 * 1024 * 1024 * 1024;
export const PARSE_TIMEOUT_MS = 180_000;

export const FILTER_FIELDS = [
  'total_rounds_played',
  'is_warmup_period',
  'is_freeze_period',
  'tick',
  'user_name',
  'attacker_name',
] as const;

/** Canonical CS2 event names are lowercase snake_case with digits. */
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Friendly player properties the parser accepts for event and tick queries. */
export const PLAYER_PROPERTIES = [
  'X', 'Y', 'Z', 'health', 'armor_value', 'is_alive', 'team_num', 'balance',
  'current_equip_value', 'is_scoped', 'is_defusing', 'is_walking', 'flash_duration',
  'has_defuser', 'has_helmet', 'active_weapon_name', 'velocity', 'velocity_X',
  'velocity_Y', 'velocity_Z', 'pitch', 'yaw', 'last_place_name', 'spotted',
  'in_bomb_zone', 'in_buy_zone', 'shots_fired', 'fov', 'player_name',
  'player_steamid', 'rank', 'crosshair_code', 'start_balance', 'total_cash_spent',
  'FORWARD', 'BACK', 'LEFT', 'RIGHT', 'FIRE', 'RELOAD', 'USE', 'ZOOM',
] as const;

/** Global game-state properties the parser accepts. */
export const OTHER_PROPERTIES = [
  'total_rounds_played', 'is_warmup_period', 'is_freeze_period', 'is_bomb_planted',
  'is_bomb_dropped', 'round_win_status', 'round_win_reason', 'team_rounds_total',
  'is_ct_timeout', 'is_terrorist_timeout', 'game_phase', 'map_name',
] as const;

/** Utility weapon names used for utility-damage aggregation. */
export const UTILITY_WEAPONS: ReadonlySet<string> = new Set([
  'hegrenade', 'inferno', 'molotov', 'incgrenade', 'flashbang', 'decoy', 'smokegrenade',
]);
