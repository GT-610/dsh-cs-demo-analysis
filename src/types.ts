/**
 * Domain vocabulary shared by the parser, the analysis layer, and the tools.
 *
 * demoparser2 returns `any`, so rows stay loosely typed on purpose: a column
 * only exists when the caller asked for it. The named fields on {@link Row}
 * document the columns this preset reads; the index signature keeps everything
 * else usable without a decoder layer.
 */

/** Side number as the engine reports it: 3 is CT, 2 is T. */
export type SideNumber = 2 | 3;

/** Stable team identity: A is the team that starts CT, B the team that starts T. */
export type StableTeam = 'A' | 'B';

/** Readable side label, used after a round is resolved. */
export type SideName = 'CT' | 'T';

/** Buy classification derived from average equipment value at the freeze end. */
export type BuyType = 'eco' | 'semi-buy' | 'force-buy' | 'full-buy';

/** A flat row from demoparser2. Columns depend on the query that produced it. */
export interface Row {
  /** Game event name such as `player_death`. Only present on event rows. */
  event_name?: string;
  /** Demo tick. Always numeric in practice, but normalized through `num()`. */
  tick?: unknown;
  round?: number | null;
  is_warmup_period?: unknown;
  total_rounds_played?: unknown;
  user_steamid?: unknown;
  attacker_steamid?: unknown;
  assister_steamid?: unknown;
  user_name?: unknown;
  attacker_name?: unknown;
  weapon?: unknown;
  headshot?: unknown;
  dmg_health?: unknown;
  [column: string]: unknown;
}

/** The same loose row, named for the reader: an event query result. */
export type EventRow = Row;

/** A tick query result: one row per player per tick. */
export type TickRow = Row;

/** One entry of the stable roster this preset derives from spawn evidence. */
export interface RosterEntry {
  name: string;
  steamid: string;
  team_number: SideNumber | null;
  stable_team: StableTeam | null;
  initial_side: SideName | null;
  team_source: 'spawn' | 'final' | 'inferred';
}

/** A competitive round, addressed by the tick window that bounds it. */
export interface RoundTickWindow {
  round: number;
  start_tick: number;
  freeze_tick?: number | null;
  end_tick: number;
}

/** One sampled player position, as the position tools build it. */
export interface PositionRow {
  round: number;
  tick: number;
  steamid: string;
  name: string | null;
  team_num: number | null;
  x: number;
  y: number;
  place: string | null;
  bomb_zone: boolean;
  buy_zone?: boolean;
}

/** The working-directory service this preset resolves relative demo paths with. */
export interface WorkingDirectoryService {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
}

/** The slice of the plugin context the store needs. */
export interface DemoStoreContext {
  workingDirectory?: WorkingDirectoryService;
}

/** Per-tool-call context the Harness passes to `execute`. */
export interface ToolExec {
  agent?: unknown;
  signal?: AbortSignal;
}

/** A registered tool: JSON Schema in, bounded evidence out. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => unknown;
  };
  execute: (params: Record<string, unknown>, exec: ToolExec) => Promise<unknown>;
}

/** The Cordis plugin context surface this preset relies on. */
export interface PluginContext extends DemoStoreContext {
  tools: { register(definition: ToolDefinition): void };
  get<T = unknown>(name: string): T | undefined;
  logger?: { warn(message: string): void };
  effect(fn: () => () => void): void;
}

/** The review skill as the Harness skill loader expects it. */
export interface LoadedSkill {
  name?: string;
  description?: string;
  whenToUse?: string;
  source?: string;
  content?: string;
  error?: string;
}
