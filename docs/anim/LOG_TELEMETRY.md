# LOG: dev telemetry overlay

What: `src/ui/telemetry.ts`, a dev-only text panel (bottom left, pointer-events none) so mechanics can be verified before they are felt. Off by default; the shipping game shows no words.

Turn on: open the game with `?tune=1`, Debug folder, tick `devTelemetry`. Scripts: `window.__cfg.devTelemetry = true`, then read `window.__telemetry` (fighters[0|1] with health, stamina, staminaSpent, hurt, hurtKind, hurtStyle, down, punch, phase, last, tally; plus log and text).

Shows per fighter: last punch landed or blocked (punch, hand, head/body and zone, grade, counter and its rule, damage absolute and %, impulse magnitude, hit-stop ticks, blocked), live health / stamina / stamina spent by the last punchStart / hurt kind and style / down / punch phase, and tallies (thrown, landed, blocked, counters, average damage of counters vs normal lands). Also the last 8 events with sim tick numbers.

How values are derived (no sim change): damage = target health lost over the tick of the event; hit-stop ticks = the rise in `SimState.hitStop` that tick x 60 (a land that lands inside a freeze already running reports 0); stamina spent = drop over the punchStart tick (includes that tick's regen, so it is slightly low); counter flag is the event's own `counter` (rule: a landing in a slip's window, combat.ts:593). Two lands on the same target in one tick would both report that tick's full health loss (not seen to happen).

Hook: one line in `tickOnce` (`telemetry.tick(prev, next, r.events)`), one config key. Off, `tick` returns at once and no element exists.

Check: `scripts/telemetry_check.mjs` (normal cross vs counter cross: counter flag, grade, damage 0.0615 vs 0.0282, i.e. about 2.2x, hit-stop 11 ticks).
