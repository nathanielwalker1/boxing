# Overhaul — UI workstream log

The screens round a fight (`docs/OVERHAUL.md` step 8, second half, plus the gym
shell of step 7). Written 2026-11-11. What was built, every call made without
asking, the places SIM's phase 2 has to be connected, what the captures show,
and what is not done or below standard.

Captures: `docs/overhaul/ui_*.png` (1280 × 720 on the high tier, then a phone
upright and on its side). Regenerate with `PORT=<port> node scripts/flow_look.mjs`
(about ten minutes on headless software GL).

## Kinds of done

- **Verified renders / console clean / tests green:** every screen below.
  `npm test`: 38/38 scripts (29 Node, 9 browser). `flow_check` 33 assertions,
  `replay_check` 10.
- **Ready for Nate to feel-test:** all of it. Nothing here has been seen or
  played by a person. Pacing (walk length, card length, replay length), the
  camera kick per grade and every layout call are mine.
- **Never exercised at all:** the gamepad on the menus (no pad in a headless
  browser) and taps / clicks (the checks drive the keyboard; the pointer
  handlers are written but unrun).

## What was built

| # | Thing | Where |
| --- | --- | --- |
| 1 | Title over a slow orbit of the lit, empty ring: Fight / Ladder / Gym / Controls | `ui/flow.ts`, `ui/director.ts` `wide` |
| 2 | Fighter select: nine plates (the roster of eight + a random slot), the highlighted man in a sim-settled rest guard at ring centre with the lens circling him, a panel with name, nickname, hometown, stance, height / reach / weight, five rating bars, style name, one line and three more | `flow.ts`, `director.ts` `turntable`, `ui/styleInfo.ts` |
| 3 | Opponent select: same screen, your own plate greyed out, difficulty (easy / medium / hard) and rounds (3 × 0:30, 3 × 1:00, 6 × 1:00) | `flow.ts` |
| 4 | Ring walk: the opponent walks from his side of the ring to his mark while the lens pushes in, name card in his colours; then the player; then a side-on two-shot with the referee and a tale-of-the-tape card; cut to the fight camera and the bell | `director.ts` `walkScene`, `flow.ts` |
| 5 | Between rounds: a corner card with the round's punch stats, each man's condition as bars, one line from the corner, a countdown | `flow.ts` `openCard`, `ui/stats.ts` |
| 6 | Knockdown replay: the 1.5 s before and 0.5 s after the knockdown, quarter speed, from the reverse side, low and close, a REPLAY bug in the corner | `main.ts`, `ui/replay.ts` |
| 7 | Results: winner, method, round-by-round cards, a punch-stat table, the winner in the ring with the referee's arm up (existing) | `flow.ts` `renderResults` |
| 8 | Seven-fight ladder with saved progress and a champion card | `ui/ladder.ts`, `flow.ts` |
| 9 | Gym shell: drill list, a drill running with its panel, restart on completion or R, Esc back | `ui/drills.ts`, `flow.ts` |
| 10 | Controls card (title and pause); pause with Resume / Controls / Quit | `ui/controls.ts`, `flow.ts` |
| 11 | HUD: the stamina bar now shows its ceiling; bars for fighters in near-black trunks use the trim colour | `ui/hud.ts`, `ui/accent.ts` |
| 12 | Wiring: `RigView` views, the style / difficulty adapter, the scoreboard, camera kick by grade | `main.ts`, `render/stage.ts` |

The walk that was built is the real one, not the fallback: each fighter is
walked by a private sim (stick input toward his mark), so the feet are the
rig's own. It is short: about 1.6 m from the ropes on his side to his mark, not
an entrance from a tunnel.

## Where SIM phase 2 connects (adapters and TODOs)

Nothing here needs editing if the exports arrive with the expected names.

| What | File and line | What it expects | Until it lands |
| --- | --- | --- | --- |
| Style and difficulty into the AI | `src/main.ts:95–104` (`styleForOpponent`), called at `src/main.ts:128` | `styleFor(spec, cfg, difficulty)` exported from `src/ai`, returning `StyleParams`. Only fights the flow starts use it; tests and `?menu=0` keep the default style | returns null: **the difficulty choice and the ladder's difficulty steps do nothing yet** |
| Difficulty value | `src/ui/flow.ts:520` writes `cfg.difficulty` (0 / 1 / 2) at every flow fight; `src/ui/flow.ts:524` also passes it in `StartOpts` | — | stored only |
| Style text | `src/ui/styleInfo.ts:69` (glob) and `:75` (`fromTable`) | `STYLES[style]` in `src/core/styles.ts` with `name`, `blurb`, `howToBeat: string[]` (also read: `title`, `description`, `desc`, `howHeFights`, `fights`, `beat`, `tips`). `guard` is not shown | built-in text per style, in the same file |
| Drills | `src/ui/drills.ts:88` (glob) and `:46` (`mapDrill`) | `DRILLS` (or `drills`, or default) in `src/ai/drills.ts`: `{ id, title, goal, placement, opponent, setup?, metric? }`. An optional `controls` string is used if present; otherwise the text is matched from the drill's id / title in `CONTROLS` (`drills.ts:30`) | one built-in drill, "Free sparring" |

A drill whose `opponent` is missing is driven by the normal AI. `setup` runs
after the placement and a 30-tick settle (hands on the guard), not on tick 0;
the `tick` handed to `opponent` counts from the drill's start.

**Key name risk:** the brief asked for a `flow`-group key called `difficulty`.
If SIM adds a key with the same name the merge has a duplicate key to resolve.

## New config keys (group `flow`, appended at the end of SCHEMA)

`difficulty` · `flowTitleOrbitDegPerSec` `flowTitleDist` `flowTitleElevationDeg` ·
`flowTurntableDegPerSec` `flowTurntableDist` `flowTurntableElevationDeg`
`flowTurntableLookY` `flowTurntableOffset` `flowTurntableFov`
`flowTurntablePortraitFov` `flowTurntablePortraitLookY` `flowPreviewDelay` ·
`flowWalkOn` `flowWalkSeconds` `flowStareSeconds` `flowWalkDist`
`flowWalkDistEnd` `flowWalkElevationDeg` `flowWalkCrowd` · `flowCornerSeconds` ·
`flowReplayOn` `flowReplaySeconds` `flowReplayAfterSeconds` `flowReplaySpeed`
`flowReplayAtCount` `flowReplayAzimuthDeg` `flowReplayDist`
`flowReplayElevationDeg` · `flowKickGlancing` `flowKickFlush` ·
`flowDrillRestartSeconds`.

No existing default was changed. `introSeconds` is no longer read (the walk
has its own keys); `betweenRoundSeconds` is still the sim's rest, but in a flow
fight the card holds the sim and the rest is run off when the card goes, so
the player never waits through it.

## Interface changes

- **`CameraShot`** (`render/stage.ts`) gained optional `key`, `azimuth`,
  `dist`, `elevationDeg`, `lookY`, `fov`, `lambda`, `cut`. A bare `{ focus }`
  is the knockdown shot exactly as before. A shot with `azimuth` takes the
  orbit; the follow camera's own angle is kept aside and put back when the
  shot ends. `cut` places the lens on the first frame of the shot and again on
  the first frame after it. Follow, band and dolly are untouched.
- **Camera kick by grade**: in `Stage.handleEvents`' `punchLand` branch only,
  punch-in and shake are multiplied by `flowKickGlancing` (0.25) or
  `flowKickFlush` (1.5); clean is unchanged.
- **`FlowHooks`** (flow → main): `start(player, opponent, opts)`, `preview`,
  `bell`, `skipRest`, `skipReplay`, `crowd`. `StartOpts` = `{ difficulty,
  driver, prepare }`.
- **`main.startFight`** keeps a body whose fighter has not changed (a rematch,
  a drill restarting) instead of rebuilding it.
- **`Referee`**: `snapshot()` and `draw(snapshot, dt)` (the replay shows him
  where he stood). **`ReadOverlay.update(state, off)`**: the hurt tint, rim and
  slow motion are off while a menu, a card or a replay is on screen.
- **Test hooks**: `window.__flow.state()` and `window.__flow.rounds(count,
  seconds)`. Every existing hook is unchanged.
- **`src/ui/vite-glob.d.ts`** types `import.meta.glob` (tsconfig has
  `types: []`).

## Assertions changed

`scripts/flow_check.mjs` was rewritten for the new flow (10 assertions → 33).
Old → new: menu → title; a card per roster entry → nine plates; "tale of the
tape" on its own screen → the ring walk's three beats (name card, name card,
tape card); the black rest card "END OF ROUND 1, then ROUND 2" → the corner
card (END OF ROUND 1, stats, bars, advice; "Round 2 of 2 next" is on the same
card); results `table tr` × 3 → `table.cards tr` × 3 plus the stat grid;
rematch → a fresh fight behind a new ring walk. Added: opponent select,
pause, ladder save and resume, gym, controls. New: `scripts/replay_check.mjs`.
No other test was touched.

## Decisions made without asking

1. **Working title: LONG COUNT** ("Main Event Boxing" under it). A boxing
   phrase, not a product I know of. Change it in `flow.ts` `renderTitle`.
2. **The turntable is the lens circling a still fighter**, not a platform
   turning him. A turning `FighterState` makes the rig's feet shuffle; the
   orbit keeps the pose clean, and the key light is overhead so he is lit the
   same all the way round. The room turns behind him.
3. **Scores are hidden until the results.** The corner card shows punch stats,
   condition and advice only.
4. **The corner card holds the sim** for `flowCornerSeconds` (12 s) and then
   runs the sim's own rest off in one go, so the bell comes when the card
   goes. Reason: 5 s is too short to read a card and the sim's default was not
   mine to change.
5. **The replay holds the sim.** It starts after the live slow-motion fall,
   once the referee reaches `flowReplayAtCount` (2), or at once if the fight is
   over. The count stops while it plays and picks up where it was, so nothing
   happens that the player cannot see. A button skips it. The results wait for
   it. No replay in a drill.
6. **Menu rounds default to 3 × 1:00**; the config default stays 3 × 0:30 so
   the tests are unchanged. The flow writes `roundCount` / `roundSeconds` at
   the start of each fight, so the tuning panel's values for those two keys
   are overridden in a flow fight.
7. **A drill is one 3-minute round** (`roundCount` 1, `roundSeconds` 180 while
   it runs, put back on leaving). It restarts when its metric reaches 1, when
   the round ends, or on R. No referee in a drill: he walked through the pair.
8. **Ladder order** is the sum of the five ratings, weakest first; rungs 1–2
   easy, 3–5 medium, 6–7 hard. A draw counts as a loss. A generated fighter
   can climb it (saved as `gen-<seed>`); he faces the seven strongest of the
   eight.
9. **Opponent walks first, the player second.**
10. **"House lights down" is the crowd only.** The walk pins the crowd's
    excitement at 0.8 and cheers each man; no light changes, because lighting
    is outside the files I could edit.
11. **The HUD is hidden on the results** (the panel carries the numbers) and
    behind the corner card.
12. **Guard wear is not on the HUD.** It did not fit the existing bars without
    a third bar per side. The stamina ceiling did: the thin bar's dark end
    grows as body work and misses lower it.
13. **The random slot's seeds are a fixed sequence** (first one is always the
    same fighter), so captures are repeatable.
14. **Words during the fight**: the round lower-third at a bell (kept from
    before), the REPLAY bug, and a small pause button on touch. Nothing about
    the action.

## What the captures show (harsh)

- **`ui_title`** — Reads as a title. The ring is lit and the room is behind
  it. The ring is empty: no fighters, no referee, nothing moving but the lens
  and the crowd. The wordmark is plain system-font italic; it is a working
  title and looks like one.
- **`ui_select`** (Kofi Adjei-Lund) — He is whole, head to boots, left of
  centre, lit from above. The long name fits on one line in the panel and on
  his plate. His boots dip a few pixels behind the plate strip. He is dark
  skin in black trunks against a dark room: he reads, but less well than a
  pale fighter. The panel has dead space between the style lines and the
  buttons at this height. The hint line sits on top of the ring logo and is
  hard to read.
- **`ui_select_random`** — The generated fighter was caught from behind (the
  lens was on that side), so the capture shows a back. That is the orbit doing
  its job, but it means a quick look at any one fighter can land on his back.
  Re-roll button present.
- **`ui_opponent`** — Same layout; the player's own plate is greyed. The
  difficulty and rounds rows are clear. Pike's forearm covers his face at this
  angle.
- **`ui_walk_opponent`** — The strongest frame of the set: the man centred,
  the crowd on its feet, his card in green bottom left. He has already
  finished his walk in this capture, so it shows him standing.
- **`ui_walk_player`** — The opponent, waiting on his mark, fills the right
  fifth of the frame out of focus-distance. It reads as an over-the-shoulder
  shot, but it was not designed; from some pairings his shoulder may cover
  more.
- **`ui_stare`** — Two-shot with the referee between them. The tape card
  covers both men from the thigh down. The fighters are at the frame edges and
  the player is seen from behind his lead shoulder.
- **`ui_fight`** — The fight as before, HUD unchanged apart from bar colours.
  The near top rope runs across the bottom of the frame (existing camera).
- **`ui_replay`** — Low, close, the reverse side, both men in profile, the bug
  top left. Good angle on a jab. Not checked: a hook thrown from the far side
  of the puncher, where his own back could cover the contact.
- **`ui_replay_late`** — Taken just after the replay ended: the live count
  (COUNT 4). The cut back is correct. This frame is the existing knockdown
  shot, and two thick ropes cross it, one straight through the standing man's
  head. That is the old shot's problem, made obvious by cutting to it from a
  clean one.
- **`ui_pause`** — Clear. The scene dims behind it.
- **`ui_corner`** — Legible, aligned, the long name fits. Each man's bars are
  in his colour, damage in red. Two faults: the card covers the middle of the
  ring, so the two men standing in their corners are barely visible behind it
  and the "corner beat" is in practice a card over a wide shot; and the four
  condition labels are small (8.5 px caps).
- **`ui_results`** — Winner, method, cards and stats all readable; the
  referee's raised arm shows above the panel. The panel hides both men below
  the chest. The scene behind is the fight camera, ropes across it.
- **`ui_ladder`** — Next opponent on the turntable, seven numbered plates
  along the bottom, record in the header. The header is one long line of small
  gold caps and easy to miss. Beaten rungs are meant to be struck through and
  dimmed; `flow_check` asserts the class is set, but no capture shows one, so
  that look is unseen.
- **`ui_gym`** — One drill, so the sheet is mostly empty. It will hold seven.
- **`ui_drill`** — The panel top left is small and out of the way. The stat
  line is the only thing that changes.
- **`ui_controls`** — Dense but ordered. On 720 px the third table ("what each
  button throws") is below the fold; up / down scroll it. Back is pinned top
  right.
- **`ui_champion`** — Card on the right, the fighter on the turntable on the
  left. Plain.
- **`ui_phone_title`** — Works. The menu sits over the ring.
- **`ui_phone_select`** — He fits above the sheet, boots just cut by it. Only
  three plates show at once; the strip scrolls and follows the highlight. The
  style lines are below the fold of the sheet and need a scroll.
- **`ui_phoneland_select`** — Tight. The panel shows name, numbers and bars;
  the style text needs a scroll. Plate names are truncated ("COUNTER-P…").
- The debug frame-time overlay (`debugFps`, on by default) sits top left over
  every menu. It was switched off for these captures.

## Not done / below standard

1. **Difficulty does nothing yet** (see the adapter table). The opponent
   screen and the ladder offer it; the AI ignores it until `styleFor` lands.
2. **One drill.** The seven the brief names are SIM's; the shell lists
   whatever `ai/drills.ts` exports.
3. **No stool, no sitting, no corner men** in the rest. Two men stand in
   opposite diagonal corners behind a card. The corners used are not matched
   to the ring's red and blue dressing.
4. **The ring walk is short and has no entrance**, and the lights do not
   change. The referee can still be walking to his place when the two-shot
   starts if the walk is skipped quickly.
5. **Replay cuts are hard on the rig's springs.** Cloth, hair and the foot
   solver jump for a frame or two at each cut. There is no sound during the
   replay. The KO / TKO path (replay, then results) is built but only the
   count path has a check.
6. **The replay interrupts the count** at 2. If that is wrong in the hand, the
   knob is `flowReplayAtCount`, or `flowReplayOn`.
7. **Skipping with a punch button throws that punch** when the fight resumes
   (the sim sees the held button as a fresh press). Same for Space and block.
8. **Pause does not silence the crowd bed** (audio is not mine).
9. **Gamepad menus and all pointer input are unverified** (above).
10. **The scoreboard text is fed** (`ROUND n`, clock) but the board is above
    every fight frame, so it has not been seen.
11. **fps**: not measured on a real GPU. The menus add no draw calls; the
    turntable draws one fighter instead of two. Headless software GL runs the
    high tier at 1–2 fps at 1280 × 720, which says nothing about a real
    machine.
12. **`flow_look.mjs` prints a "not a test by convention" warning** from the
    runner; the list that silences it is in `scripts/run_tests.mjs`, which is
    not mine.
13. **Results stats are counts only**: no accuracy percentage, no per-round
    breakdown, no punch-family split by grade.
14. **Phone on its side** is cramped on the select screens (above).
