[中文](README.md)

# dsh-cs-demo-analysis

A Counter-Strike 2 demo review mode for DeepSeek Harness. It keeps the full standard capability set and adds a local demo toolbox: parsing, rounds, economy, player statistics, utility, positions, and map awareness. Demos are parsed on this machine and are never uploaded.

## Features

- 13 `cs2_*` tools with bounded output and explicit `sampled` / `truncated` flags.
- Round assignment by tick windows, independent of the demo's `total_rounds_played` counter.
- Position samples carry the game's in-round place name (`last_place_name`) and the bomb-zone flag.
- N-API parsing runs on a worker thread, so the Harness host stays responsive.
- A bundled `cs2-review` skill: review workflow, metric definitions, and a report template, loaded on demand.
- MIT licensed.

## Requirements

- DeepSeek Harness Desktop, or a `dsh` profile that can install bundles.
- Node.js 22.19 or newer (the sources are TypeScript; tests run the `.ts` files directly).
- A Counter-Strike 2 (Source 2) demo. CS:GO demos are not supported.
- macOS arm64/x64, Windows x64, or Linux x64/arm64 (`@laihoe/demoparser2` publishes prebuilds).

## Install

1. Install dependencies in this directory. The `prepare` hook also builds `src/*.ts` into `dist/`:

   ```bash
   npm install
   ```

2. Install the directory as a bundle in the current profile:

   ```text
   plugin_manager { action: "install_bundle", target: "<absolute path to this directory>" }
   ```

3. Restart DeepSeek Harness.

4. Create a session and select the **CS2 Demo 复盘** mode.

A local directory install only links the directory into the profile; it does not install the bundle's own dependencies, so step 1 is required.

## Use

Name the demo path directly:

```text
Analyze D:/demos/2026-11-01_mirage.dem; focus on our T-side executes and B-site retakes.
```

Or let the model find it:

```text
Find the most recent demo on my Desktop and explain why our economy keeps collapsing.
```

The model calls `cs2_find_demos` when the path is missing, then `cs2_demo_header` / `cs2_list_players`, then whichever evidence tools the question needs. Archives (`.bz2` / `.rar` / `.zip`) are unpacked by the agent with its shell; the demo tools accept only `.dem`.

## Tools

| Tool | Purpose |
| --- | --- |
| `cs2_find_demos` | List `.dem` files under a directory (two levels deep). |
| `cs2_demo_header` | Map, server, demo format, patch, and file metadata. |
| `cs2_list_players` | Roster, Steam IDs, starting side, stable Team A/B identity. |
| `cs2_list_events` | Event names that actually occur in the demo. |
| `cs2_query_events` | Bounded event rows with extra properties, exact `where` filters, and round lists. |
| `cs2_query_ticks` | Player state at explicit or evenly sampled ticks; derives `best_weapon`. |
| `cs2_query_grenades` | Aggregated trajectories with friendly grenade kinds and engine class names. |
| `cs2_round_summary` | Per-round tick window, winner, reason, kill count, score, and economy summary. |
| `cs2_economy` | Freeze-end balance, equipment value, per-round spend, and buy type. |
| `cs2_utility` | Per-player smokes, flashes, molotovs, HE, blind effects, and utility damage. |
| `cs2_positions` | Sampled positions; raw rows or a place/cell heatmap. |
| `cs2_map_overview` | Map use summary: place catalog, team time share, map bounds, and bomb-target boxes. |
| `cs2_player_stats` | K/D/A, ADR, KAST, rating approximation, openings, trades, clutches, utility. |

## Rounds, economy, and statistics

- **Round assignment**: each round is a window built from a `round_end` tick and the preceding `round_start`; events are assigned by tick. The demo counter is not used because its base differs across demo generations and event types (professional demos report 1-based `round_end` counters and 0-based `round_start` / in-round counters).
- **Malformed rounds**: a `round_end` at `tick = 1` with no winner or reason is treated as a recording artifact and dropped without shifting later rounds.
- **Economy**: `cash_spent_this_round` is the purchase total for that round; `cash_spent_match_cumulative` is the demo's cumulative `total_cash_spent`, not a per-round value.
- **Buy types** from average freeze-end equipment value: `eco` < 2000, `semi-buy` < 3500, `force-buy` < 4500, otherwise `full-buy`. Pistol rounds are labelled `pistol`.
- **KAST**: share of rounds with a kill, assist, survival, or a traded death (killed within 5 seconds / 320 ticks by a teammate of the victim).
- **rating / impact**: the public HLTV 2.0 approximation, not official HLTV values.
- **Flashes** require `player_blind` events. Some professional demos do not contain them; those fields are `null` with `flash_data_available: false` instead of a measured zero.
- **Team A/B**: A is the roster that started CT, B started T. The demo does not carry organization names, so A/B can swap across maps.

## Map awareness

CS2 demos carry `m_szLastPlaceName`, the game's callout for the player's current area. Position tools request it on every sample, so coordinates are labelled with names such as `Truck`, `Jungle`, `Underpass`, `BombsiteA`, or `TopofMid`.

`cs2_map_overview` aggregates those names into a map-use summary: time share per place, which stable team occupied it, coordinate bounds per place, and tight `bomb_targets` boxes measured from `in_bomb_zone` samples:

- place bounds are the observed callout extent;
- `in_bomb_zone` is only the small plant trigger volume, not the whole site;
- the demo has no collision geometry, so the tools cannot prove that a spot is behind a specific box or that a line of sight exists. Such claims are model inference from map knowledge and must be labelled as such.

## Architecture

- `src/parse-worker.ts`: N-API parsing on a worker thread; grenades are aggregated before crossing the boundary.
- `src/parser.ts`: restartable main-thread client with per-call timeouts and cancellation.
- `src/demo-store.ts`: workspace path resolution, `PBDEMS2` validation, per-file-revision caches for header/roster/events.
- `src/analysis.ts`: round windows, economy, player and utility statistics.
- `src/spatial.ts`: round windows, tick sampling, place/cell aggregation.
- `src/tools.ts`: model-facing tools and bounds.
- `src/plugin.ts`: preset mount point and runtime skill registration.
- `src/types.ts`, `src/worker-protocol.ts`: domain types and the worker RPC contract.
- `skills/cs2-review/SKILL.md`: review workflow, metric definitions, and report template.

`src/` is TypeScript source; `dist/` is the build output (two entries, `plugin.js` and `parse-worker.js`) and is what `exports` points at.

Every row-returning tool samples evenly, caps serialized size, and reports `truncated` / `sampled`.

## Development and testing

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsdown, emits dist/
npm run dev         # tsdown --watch, rebuilds on edit
npm test            # node --test, runs the .ts sources directly
```

`npm test` relies on Node 22.18+ type stripping to execute TypeScript without a build step; `npm run build` is only needed for the packaged plugin that the Harness loads.

Without environment variables only unit tests run. To run integration coverage against a real demo:

```bash
CS2_DEMO=/absolute/path/to/match.dem npm test
```

To run the professional-demo regression suite (round numbering, score, economy alignment, bomb-site labels):

```bash
CS2_DEMO=/path/match.dem CS2_PRO_DEMO_DIR=/path/pro-demos npm test
```

Demo files are git-ignored and never committed.

## Privacy and security

- The demo is read locally by the native parser.
- Only the JSON returned by tools reaches the model.
- Paths are validated: regular file, size limit, Source 2 demo stamp (`PBDEMS2`).
- The plugin does not call a shell and does not write to the demo.

## Known limitations

- CS2 demos only; no CS:GO, `.bz2`, `.rar`, or `.zip` (the agent unpacks archives itself).
- No communication, intent, or calling information.
- Position evidence depends on the sampling step; short movements can be missed.
- No collision geometry or line-of-sight modelling.
- Some professional demos lack `player_blind`, so flash effectiveness is unavailable.
- No organization names; Team A/B are starting-side labels.
- rating / impact are approximations.
- Demo format changes can require a `@laihoe/demoparser2` update.

## License

MIT. See [LICENSE](LICENSE).

The parser is [`@laihoe/demoparser2`](https://github.com/LaihoE/demoparser) (MIT).
