---
name: cs2-review
description: Evidence-first Counter-Strike 2 demo review workflow, metric definitions, and coaching report template.
whenToUse: Use when analyzing a CS2 demo, reviewing a match, or turning demo evidence into practice recommendations.
---

# CS2 demo review

Use the `cs2_*` tools as the only source of truth for claims about a match. The
demo is parsed locally on this machine; nothing is uploaded by the parser.

## Workflow

1. **Locate the demo.** If the user gave a path, use it. If they named a demo
   without a path, call `cs2_find_demos` on the likely directory (default: the
   session workspace). Ask only when the search cannot identify one file.
2. **Establish context.** Call `cs2_demo_header` and `cs2_list_players` before
   any team-level claim. Never guess the map, the roster, or which side a team
   started on.
3. **Pick the scope.** A full match review needs rounds, economy, and player
   statistics. A single-round question needs that round's events. A player
   question needs that player's kill/death and position evidence.
4. **Gather the smallest evidence set.** Prefer aggregated tools
   (`cs2_round_summary`, `cs2_economy`, `cs2_player_stats`). Use
   `cs2_query_events` for discrete facts and `cs2_query_ticks` only for
   positions, aim, or movement. Use `cs2_query_grenades` only when utility
   trajectories matter. Use `cs2_map_overview` and `cs2_positions` when the
   question is about where players stood, what they held, or how they moved.
5. **Answer with citations.** Tie conclusions to round numbers, ticks, player
   names, and event facts. State the limitation when evidence was sampled.

## Team identity

- Team A is the roster that started CT (team number 3). Team B started T (2).
  These identities are stable across the halftime switch.
- `CT` and `T` describe only the side a team occupied in a specific round.
  When reporting team-level results, map round winners back to Team A/B and
  say which side they played.
- If the roster evidence is incomplete, report the raw side instead of guessing.

## Round and economy semantics

- Use the `round` field returned by the tools. Do not derive a round from
  `total_rounds_played`: professional demos report it with different bases for
  different events, and the tools map by tick windows instead.
- `cs2_round_summary` rows carry the tick window, winner, reason, kill count,
  score, and a compact economy summary. Use `cs2_query_events` for individual
  kills with `round` already attached.
- Economy: `cash_spent_this_round` is the purchase total for that round;
  `cash_spent_match_cumulative` is the demo's cumulative counter and must not
  be read as per-round spending.
- `query_events` accepts `rounds: [15,16,17]`; prefer one range query over one
  request per round.
- `query_ticks` derives `best_weapon` from inventory when
  `active_weapon_name` is requested. The active weapon may be a knife or a
  grenade; use `best_weapon` for equipment questions.
- If `flash_data_available` is false, the demo has no `player_blind` events.
  Say flash effectiveness is unavailable; do not report zeros as measured.
- Team A/B are starting-side identities, not organization names. Name the
  actual team from the roster when you know it, and say which side that team
  started on. A/B can swap across maps.

## Metric definitions

- **ADR**: total damage dealt divided by rounds played. Damage comes from
  `player_hurt`; overkill is not capped.
- **KAST**: percentage of rounds with a kill, assist, survival, or a traded
  death (killed within 5 seconds / 320 ticks by a teammate of the victim).
- **Rating**: the public HLTV 2.0 approximation. It is a comparison aid, not an
  official HLTV value. Say "approximate rating" when quoting it.
- **Opening duel**: the first counted kill of a round (enemy kill, not a
  suicide or team kill).
- **Multi-kill**: 2k/3k/4k/5k buckets per round.
- **Clutch**: the player was the last teammate alive against at least one
  enemy, and the team still won the round.
- **Buy type** from average freeze-end equipment value: `eco` < 2000,
  `semi-buy` < 3500, `force-buy` < 4500, otherwise `full-buy`.

## Map awareness

- Start spatial questions with `cs2_map_overview`: it returns the demo's own
  place names (`last_place_name`), time share per place and stable team,
  place bounds, and tight `bomb_targets` boxes. Place bounds are the callout
  extent, not the plant trigger; do not treat them as cover or as bomb zones.
- Use `cs2_positions` with `format: "rows"` when a specific round or timing
  matters, and `format: "heatmap"` for holds, map control, and rotations.
- The place names are the game's callouts (`Truck`, `Jungle`, `Underpass`,
  `BombsiteA`, `TopofMid`). Use your own map knowledge to connect a place to
  cover, common angles, and site geometry. Label that reasoning as
  interpretation, not as demo evidence.
- The parser does not model collision geometry or line of sight. Do not claim
  "he was behind the box" from coordinates alone; say which place he held and
  what that place usually offers, and mark it as inference.
- `player_blind` may be missing from professional demos. Check
  `cs2_list_events`; when `flash_data_available` is false, say flash
  effectiveness is unavailable instead of reporting zeros.
- Quote the place name and the round when making a spatial claim, and disclose
  the sampling step when positions were sampled.

## Evidence discipline

- Do not answer match-specific questions from memory or from generic CS
  knowledge. Query the demo.
- Do not invent coordinates, economy values, scores, or causes. If a tool
  result was sampled or truncated, disclose it and narrow the query.
- `query_ticks` is expensive. Pass explicit ticks when known; otherwise keep
  `limit` small. Never request every tick for a whole match.
- Distinguish observation from interpretation. "B rotated at tick 5120" is
  observation; "B read the execute" is a hypothesis, and must be labeled.
- Do not expose private chain-of-thought. Short progress text is optional.

## Report template

Use a compact structure unless the user asks for something else:

1. **Match**: map, score, roster, format, demo duration.
2. **Score flow**: pistol rounds, eco/force conversion, swing rounds.
3. **Team trends**: side splits, opening-duel balance, trade discipline,
   utility usage, post-plant and retake results.
4. **Player notes**: rating, ADR, KAST, opening/trade/clutch evidence.
5. **Decisive moments**: round number, tick, what happened, why it mattered.
6. **Practice plan**: 2-4 concrete, checkable drills tied to the evidence.

## Coaching guidance

- Prefer a small number of specific, testable recommendations over a long list.
- Tie every recommendation to evidence: a round, a repeated pattern, or a
  metric that is clearly outside the rest of the team.
- Separate mechanical issues (aim, crosshair placement, spray) from decision
  issues (rotation timing, economy discipline, utility investment).
- When the demo cannot support a claim (for example intent, communication, or
  whether a call was made), say so.

## Limitations

- CS2 (Source 2) demos only; CS:GO demos and compressed archives are rejected.
- Communication, intentions, and team calls are not in the demo. Voice data is
  not analyzed.
- Position analysis depends on requested ticks; sampled paths can miss short
  movements.
- Rating and impact are approximations with fixed coefficients.
- Demo format changes can require a parser update; report parse failures as-is.
