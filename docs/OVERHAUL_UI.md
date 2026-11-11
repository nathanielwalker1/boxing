# Overhaul — UI workstream log

The screens round a fight (`docs/OVERHAUL.md` step 8, second half, plus the gym
of step 7). Phase 1 written 2026-11-11; phase 2 (polish and proof, after SIM's
styles / difficulty / drills, RIG's reads and SHOW's audio hooks landed) the
same day. What was built, every call made without asking, what the captures
show, and what is not done or below standard.

Captures: `docs/overhaul/ui_*.png`. Regenerate with
`PORT=<port> node scripts/flow_look.mjs` (about 25 minutes on headless
software GL), or one pass: `… flow_look.mjs desktop | gym | phone`.

## Kinds of done

- **Verified renders / console clean / tests green:** every screen below.
  Checks that are mine: `flow_check` (keyboard, end to end, 37), `gym_check`
  (every drill, 41), `flow_input_check` (mouse, touch, gamepad, difficulty,
  28), `replay_check` (12).
- **Ready for Nate to feel-test:** all of it. Nothing here has been seen or
  played by a person. Pacing (walk, card, replay), the camera kick per grade,
  the drill panel and every layout call are mine.
- **Run by a script, never by a hand:** touch (a touch-emulating browser
  context), the gamepad (`navigator.getGamepads` replaced by a stub in the
  page — no real pad has been plugged in), and the drills (scripted players).

## What exists

| # | Thing | Where |
| --- | --- | --- |
| 1 | Title: the two men in view spar slowly under the wide orbit (a silent private sim, easy AI on both sides at half work rate), the referee with them; the wordmark is lettering drawn in code; Fight / Ladder / Gym / Controls | `ui/director.ts` `sparring`, `ui/wordmark.ts` |
| 2 | Fighter select: nine plates (eight + a random slot), the man on the turntable in HIS guard, seen from the front first. His sheet: name, nickname, hometown, stance; height / reach / weight as bars against the roster's range; the five ratings; style name, guard by name, the range he wants, one line, and three lines of "how he fights" | `flow.ts` `infoHtml`, `ui/styleInfo.ts` |
| 3 | Opponent select: the same sheet for the other man with THE MATCHUP in plain words ("He out-reaches you by 6 cm. He is taller by 10 cm. He is heavier by 35 kg.") and "how to beat him" (SIM's three `beat` lines); difficulty and rounds | `flow.ts` |
| 4 | Ring walk: opponent, then player, each walked to his mark by a private sim with a name card; then a two-shot with the referee and a tape strip along the bottom edge | `director.ts` `walkScene` |
| 5 | Between rounds: a corner sheet on the right (round stats, condition bars, one line of advice, optionally the judges' running cards); on the left the ring with both men in their corners | `flow.ts` `openCard`, `director.ts` `corners` |
| 6 | Knockdown replay, the count path and the stoppage path | `main.ts`, `ui/replay.ts` |
| 7 | Results: a sheet on the right (winner, method, the judges' cards, round by round, the fight's totals with accuracy); the pair and the referee on the left under a closer shot | `flow.ts` `renderResults`, `director.ts` `results` |
| 8 | Ladder with saved progress, beaten rungs struck through, a champion card | `ui/ladder.ts` |
| 9 | Gym: eight drills (SIM's seven, then free sparring), each with a strip along the top: what to do, the exact controls on keys / pad / touch, a progress bar, a stat line, a clock; next / previous / again | `ui/drills.ts`, `flow.ts` `updateDrill` |
| 10 | Controls card, two columns, all three tables on one screen; pause | `ui/controls.ts` |
| 11 | HUD: stamina ceiling on the thin bar; readable bars for dark trunks | `ui/hud.ts`, `ui/accent.ts` |

## Difficulty: one key

`aiDifficulty` (SIM's, group `ai`). My phase-1 `difficulty` key is gone. The
menu's choice (and each ladder rung's) is written to `cfg.aiDifficulty` when a
flow fight starts (`flow.ts` `beginFight`) and passed to
`styleFor(spec, cfg, difficulty)` in `main.ts` `styleForOpponent`. Only fights
the flow starts get a style; tests and `?menu=0` keep the default.
`flow_input_check` proves it: three runs against the same opponent at Easy /
Medium / Hard give `aiDifficulty` 0 / 1 / 2 and three different
`AiState.style`s (mistake rate 0.25 / 0 / 0; attack gap 0.49 / 0.35 / 0.28 s
at the time of writing).

## Lines the other workstreams should know

- **SIM / RIG — a stoppage with no count freezes the loser upright.**
  `stepCount` advances `downT` only in the `count` phase. When the fight ends
  ON a knockdown (the knockdown limit: a TKO, phase `over` at once) `downT`
  stays 0, and the rig draws the fall from `downT`, so the loser stood stiff
  at the first frame of his fall for good. Found by the new stoppage check.
  Worked round in presentation (`main.ts` `fallen`: once the fight is over the
  views are handed a copy of a downed fighter with the seconds since added to
  `downT`; the replay clip's tail gets the same). The sim is not touched. The
  real fix is one line in the sim.
- **SIM — `survive` floors a player who does nothing in about a second.** The
  drill gives half a second's grace. With the scripted player it works; as a
  first impression for a person it may be too fast to read the screen.
- **SIM — a partner who is floored takes a count.** In `slip-counter` and
  `body-work` the scripted player put him down after one or two clean shots.
  The drill carries on through the count (it used to restart, which wiped the
  tally), but the count is dead time. Free sparring runs with
  `healthDamagePerImpulse` × 0.2 for its length so the bag stays up; the seven
  SIM drills are left as SIM wrote them.
- **SHOW —** `main.ts` keeps the `CombatAudio` instance and calls
  `audio.update(next, sdt, paused)` once a frame; the flow also calls
  `audio.setPaused` when the pause opens and closes. The title spar is a
  private sim whose events never reach the bus, so it is silent.
- **RIG —** the replay pre-rolls the rigs through `window.__rig[side].feed`
  (24 buffered ticks before the clip, and the last 24 live ticks when it
  ends) so cloth, hair and feet are settled on the first frame after each
  cut. `freeze` is not used.
- **Anyone writing a browser check —** `window.__sim.drive(side, fn)` calls
  `fn(state)` on every sim tick (null clears it). A scripted player that has
  to time something to a sixtieth of a second cannot do it from the test
  process at a headless frame rate; this can. `scripts/lib/drill_bots.js` has
  one per drill.

## Config (group `flow`)

Added in phase 2: `flowShowScores` (bool, off: the judges' running cards on
the corner sheet). Removed: `difficulty`. Changed defaults of my own keys:
`flowTurntableLookY` 0.8, `flowTurntablePortraitFov` 70,
`flowTurntablePortraitLookY` 0.35, `flowDrillRestartSeconds` 4. The rest are
as listed in phase 1: `flowTitle…` (3), `flowTurntable…` (8),
`flowPreviewDelay`, `flowWalk…` (7 with `flowStareSeconds`),
`flowCornerSeconds`, `flowReplay…` (8), `flowKickGlancing`, `flowKickFlush`.
No key outside the group was changed. `debugFps` is switched off at boot when
the flow is on (unless `?tune=1`), and the overlay is hidden over any menu or
card.

## Interfaces

- **`CameraShot`** (`render/stage.ts`): optional `key`, `azimuth`, `dist`,
  `elevationDeg`, `lookY`, `fov`, `lambda`, `cut` (phase 1; unchanged).
- **`Scene`** (`ui/director.ts`): `fighters` may be null (= draw the live
  fight under `shot`: the results); `refSnap` (put the referee on his spot
  this frame); `events` (for the views only).
- **`FlowHooks`**: `start`, `preview`, `bell`, `skipRest`, `skipReplay`,
  `crowd`, `audioPaused`.
- **`Referee.update(…, snap)`**; **`ReplayBuffer.tail`**, `clipAround().pre`.
- **Hooks for scripts**: `window.__flow.state()` (now with `drillProgress`,
  `drillDone`, `turnGuard`), `.rounds(count, seconds)`, `.drill(id)`;
  `window.__sim.drive(side, fn)`. Every older hook is unchanged.

## Assertions changed (phase 2)

- `flow_check`: the sheet check now compares the rating bars with the spec's
  real numbers and checks the size bars, guard, range and "how he fights";
  new: the man on the turntable is in his own guard, the matchup lines, Hard
  reaches the AI, results have the round-by-round table and accuracy, the gym
  lists eight drills. `cfg.difficulty` → `cfg.aiDifficulty`; the tape strip
  reads "2 × 0:08" (was "2 ROUNDS").
- `replay_check`: + the stoppage path (2).
- New: `gym_check`, `flow_input_check`.
- Every state wait in these four has a 180 s ceiling (they were 15–90 s and
  timed out in the full parallel suite, where software GL draws about one
  frame a second).

## Decisions made without asking

Phase 1 (still standing): working title LONG COUNT; the turntable is the lens
circling a still man; scores hidden until the results by default; the corner
sheet holds the sim and the rest is run off when it goes; the replay holds
the sim and starts at count 2; menu rounds default 3 × 1:00; ladder order by
rating sum, a draw is a loss; opponent walks first; "house lights down" is
the crowd only; no guard-wear bar on the HUD.

Phase 2:

1. **The title is a spar, not two men standing.** Easy AI on both sides, half
   the aggression, attack gaps doubled, restarted every 45 s or when someone
   wins. Silent.
2. **The wordmark is a stroke alphabet of fourteen letters** on a 4 × 7 grid
   (`ui/wordmark.ts`), slanted, with a gold rule and the strapline in the
   same letters. No font is loaded.
3. **"How he fights" is derived, not written per fighter:** one line of plan
   per style, one line saying what his guard gives and costs (each claim is a
   number in `core/styles.ts` `GUARDS`), one line from his range, rhythm and
   stance width.
4. **Sheets go on the right; the men go on the left.** Corner, results,
   fighter and opponent sheets share one place and one build (scrolling body,
   fixed foot with the buttons). The stare-down's tape is a strip on the
   bottom edge.
5. **A drill ends** when its metric reaches 1 ("Done"), when its suggested
   length runs out ("Time"), when the player goes down, or when the fight is
   over. It shows that for 4 s and starts again. N / P (or `]` / `[`, Select
   on a pad, the panel's own buttons) move on or back at any time. The
   partner going down does not end it.
6. **A drill's setup runs after a 30-tick settle** (the hands have to get to
   the guard after the pair is moved). `survive` therefore starts the clock
   at 0.5 s; the player is rocked (3.0 s) and cornered on the first state.
7. **On touch the drill strip shows the touch column only**, in one column on
   the left (the punch diamond has the right), and there is no pause button
   in a drill (the strip has its own Gym button).
8. **A button held when the fight resumes is ignored until it is let go**
   (after a card, a replay, the walk, a pause). All six flags, not only the
   punches.
9. **A fast skip into the two-shot puts the men and the referee on their
   marks** rather than showing them hurry there.
10. **Replay sound: silence.** A slowed whoosh needs a recipe in SHOW's
    files.
11. **Free sparring is tuned** (above). Logged because it is the one place
    the flow changes a combat number.
12. **The pause button is always on screen in a fight** (top right; under the
    plaque on touch), so a mouse or a finger can pause.

## What the captures show (harsh)

Desktop, 1280 × 720, high tier:

- **`ui_title`** — Two men sparring and a referee in a lit ring; the wordmark
  is clearly lettering now, heavy and slanted, with a rule. The letters are
  monoline and a little crude (the G and the C differ only by a spur); it
  reads as a logo sketch, not a finished mark. The fighters are small in the
  right half and at some orbit angles a corner post stands in front of them.
- **`ui_select`** — Whole body from the front, boots clear of the plates, the
  sheet complete without scrolling (sizes and ratings side by side; the lower
  third of the sheet is empty at this height). *The capture is taken with the turntable slowed to
  2°/s*, because a headless frame lasts up to a second and at the real speed
  he is side-on before the shutter; a player sees him from the front for the
  first second or two. The sheet is dense: thirteen rows of small caps before
  the style block.
- **`ui_select_random`** — Same. The generated man's lines are his style's,
  so two sluggers read identically below the bars.
- **`ui_opponent`** — The matchup box is the most useful thing on the sheet
  and it is three sentences in one paragraph; the numbers do not stand out.
  At 720 px all three "how to beat him" lines now fit; at 600 px the last
  needs a scroll.
- **`ui_walk_opponent` / `ui_walk_player`** — As phase 1. The waiting man's
  shoulder still fills the right edge of the player's shot.
- **`ui_stare`** — Both men head to boots above the strip, the referee
  between them facing the lens. The strip's stat lines are small (11 px).
- **`ui_fight`** — Unchanged, plus a small pause button top right.
- **`ui_replay_first`** — The first frame after the cut: nothing visibly
  mid-pop. A still cannot show a one-frame jump; this is weak evidence.
- **`ui_replay`** — As phase 1: low, close, reverse side, both in profile.
- **`ui_replay_after`** — The live fight after the replay; by the time of the
  capture he was getting up.
- **`ui_corner`** — The ring and both corners in view on the left (the lens
  is square on to the diagonal and only sways), the sheet on the right. The two men are small and simply stand; there is still no
  stool, no corner man, nothing happening in the corner.
- **`ui_corner_scores`** — `flowShowScores` on: three "Judges" rows between
  the stats and the bars. They look like more stat rows; a reader has to find
  them.
- **`ui_results`** — The pair and the raised arm on the left, clear of the
  sheet; winner, cards, round by round, totals and buttons all on screen at
  720 px. It is a wall of numbers: eleven rows of totals in 12 px. The near
  ropes cross the men's legs (the shot is the fight camera moved in).
- **`ui_ladder` / `ui_ladder_progress`** — Header is a name and a record you
  can read from across a room. Beaten rungs are dimmed, struck through and
  say BEATEN.
- **`ui_gym`** — Eight drills, each with its length and what it trains, all
  on screen.
- **`ui_controls`** — All three tables on one screen. The moves column wraps
  to two and three lines; it is the densest thing in the game.
- **`ui_champion`** — As phase 1. Plain.

The gym, each drill played by its scripted player (tier the machine picks):

- **`ui_drill_jab-and-move`** — The strip sits above both heads. "8 jabs
  landed · 0 taken", bar two-thirds. Clear.
- **`ui_drill_cut-off`** — Caught at "Done … again in 3": the bot walked him
  to the ropes in four seconds. The drill may be too easy to finish to teach
  anything; that is SIM's metric (on the ropes with you within 1.1 m = done).
- **`ui_drill_get-inside`** — "5 landed inside · inside now". The taller
  partner is visibly taller.
- **`ui_drill_slip-timing`** — "3 slipped · 0 taken". The "Roll under" row is
  the longest in any strip and still fits.
- **`ui_drill_slip-counter`** — "2 counters landed · 2 slipped". The third
  control row ("Which hand — the side you slipped to") says the same thing
  three times across the columns.
- **`ui_drill_body-work`** — The partner is on the canvas being counted over
  after three body shots; the drill goes on, but this is what a player will
  see most of in this drill.
- **`ui_drill_survive_start`** — First frames: player in the corner, health
  bar already half gone, the other man on him. The red hurt edge is on.
- **`ui_drill_survive`** — Mid-drill, clock at 7 s, out of the corner.
- **`ui_drill_free-sparring`** — Eleven clean punches in and the partner is
  still on his feet (before the bag tune he was down after six). He has been
  driven back to the ropes: nothing walks him back to the middle.
- In every drill capture the HUD plaque still shows a round clock ("2:55
  ROUND 1 OF 1") that means nothing in a drill and disagrees with the drill's
  own clock.

Phone:

- **`ui_phone_title`** — Works; the spar is small behind the menu.
- **`ui_phone_select`** — He stands above the sheet, boots just cut by it.
  Name, sizes, ratings, style name, guard and range are on screen; the three
  lines start at the fold and need a scroll.
- **`ui_phone_drill`** — The HUD, then the drill strip (touch controls only),
  take the top third; the punch diamond covers both men from the knee down.
  It is usable and crowded. The HUD's names run into the clock plaque at this
  width (the HUD's own problem, older than this work).
- **`ui_phoneland_title`** — Works.
- **`ui_phoneland_select`** — The sheet shows everything down to the second
  style line; the third needs a scroll. Plates are surnames only and fit.
- **`ui_phoneland_drill`** — The strip is one column on the left so the
  diamond is clear, but it sits right over the player's own fighter: from the
  waist up he is behind the panel. On a phone on its side a drill is the worst
  screen in the set.

## Not done / below standard

1. **No stool, no corner men, no sitting** in the rest. The corners used are
   the ring's diagonal, not matched to its red and blue dressing.
2. **The ring walk is short, has no entrance, and the lights do not change.**
3. **The wordmark is a first pass.** Monoline, fourteen glyphs, no kerning.
4. **Replay**: silent; one-frame pops at the cuts cannot be ruled out from
   stills; the replay still interrupts the count at 2.
5. **The stoppage fall is a presentation patch** over a sim gap (above).
6. **The drill HUD shows a meaningless round clock.**
7. **Drill captures are low-tier**; the look of the gym on the high tier is
   the same scene the fight captures show, but it was not captured.
8. **A real gamepad and a real finger have not touched it.** The stub proves
   the code paths, not the feel (stick thresholds, repeat rate: there is no
   auto-repeat on a held d-pad).
9. **The select sheet is dense**, and on a phone (either way up) its style
   lines still need a scroll. **A drill on a phone on its side** hides the
   player's fighter behind the strip.
10. **Results**: no per-round split by punch type; the numbers are counts and
    one percentage.
11. **The scoreboard text is fed** but has still not been seen in a frame of
    mine.
12. **fps**: not measured on a real GPU. The title now steps a second sim and
    two AIs every tick and draws two fighters and a referee, which the empty
    title did not.
13. **Suite time.** The full suite is now about ten minutes of wall time
    (603 s; 44/44). My four checks are the slowest things in it under
    parallel load: `flow` 511 s, `flow_input` 536 s (three page boots), `gym`
    388 s, `replay` 96 s. Alone each takes 1.5–4 minutes. They wait on state,
    not time, so they are slow rather than flaky; splitting `flow_input` into
    three scripts would let the runner spread it.
