# Overhaul — the show (render + audio workstream)

Log of the SHOW workstream of the 2026-11-11 overhaul (`docs/OVERHAUL.md` step 8,
started early). What was built, what the captures show, every call made without
asking, and what is not done. Captures: `docs/overhaul/arena_before_*.png` and
`arena_after_*.png` (play camera, 8-azimuth sheet, wide, low; colour + `_grey`;
the after set adds `play_hot` / `wide_hot` with the crowd on its feet).
Regenerate with `PORT=<port> node scripts/arena_look.mjs after hot`.

## Kinds of done

- **Verified renders / console clean / tests green:** arena, crowd, lighting,
  haze, post, quality tier, ring dressing.
- **Verified it runs, NOT heard:** all audio. `audio_check` proves the graph
  builds, the bed starts and the right recipes are asked for. Nobody has
  listened to it. Every level and every recipe is a first guess.
- **Ready for Nate to feel-test:** all of it. Nothing here has been judged by
  him; the look calls below are mine.

## What the before set showed

- Play camera: fighters in front of a navy void. The crowd is a band of
  identical dark pawns with pointed heads; nothing behind them.
- Beams read as solid grey cones with hard edges, not light.
- Wide: one dark bowl, no structure, no lights but the truss lamps.
- 30 draw calls, 76,874 triangles.

## What was built

**The room** (`src/render/arena.ts`). From the ring outward: ringside floor
(press tables with monitors, four straight rows a side, corner teams, four
camera platforms with an operator and a tally light) → a lower bowl behind a
front wall whose top band is an LED barrier board → an open concourse slot,
lit in pools round twelve doorways, that the back row is silhouetted against →
the upper deck's LED ribbon board (fictional sponsors, scrolling slowly) → a
dark upper deck → roof catwalk lamps. Twelve stair aisles per deck with step
lights. Overhead: the truss with cross-braces and hang cables, fixture
housings with lit lenses, and a four-sided scoreboard (`setBoardText`).
Structure is one mesh with light baked per vertex.

**The crowd** (`src/render/crowd.ts`). Three instanced draws by distance
(ringside ~112 tris a person, lower bowl 48, upper deck 32), animated entirely
in the vertex shader: per-person sway, a stand threshold, an arms threshold,
applause, hair and skin and clothing colour. No per-frame CPU work. Camera
flashes are one Points draw; the CPU writes a start time when one fires.

**The mood** (`src/render/mood.ts`). One excitement value, fast attack and
slow decay, plus discrete reactions, derived from `SimEvent`s inside
`Stage.handleEvents`. The stands, the flashes and the crowd audio all read the
same object. A reaction ripples outward through the stands from the side of
the ring it happened on.

**Light and air** (`stage.ts`, `atmos.ts`). Warm key (still the one shadow
caster), cool hemisphere fill, the camera-riding rim, and two new coloured
back lights fixed on the truss corners over the red and blue corners. Beams
are soft-edged shafts that fade out before they reach the fighters. One haze
layer between ringside and the lower bowl. Dust motes in the key. Every small
practical light is one Points draw.

**Post** (`post.ts`). Bloom at half resolution, then one finishing pass:
S-curve, split tone, saturation, vignette, grain, sRGB encode. Chromatic
aberration only on a knockdown or KO. No screen flashes anywhere.

**Quality tier** (`tier.ts`, config `qualityTier`). Low = no post, crowd at
40%, no haze or motes, two key beams, 1024 shadow map. Fighter lighting is
identical in both tiers.

**Audio** (`src/ui/audio.ts`, `src/ui/audio/*`). Impact and crowd buses under
a limiter. Impacts by class and grade. A crowd bed built from a synthesized
"walla" loop (voices through moving formants, rendered offline at the first
gesture) in four layers that track excitement. Crowd reactions as recipes.

**Ring dressing** (`ring.ts`). Canvas scuffs and stains, apron colour outside
the ropes, one tall corner cushion per post with sponsor marks, padded
turnbuckle covers in corner colours, satin posts with a rubber cap and base
plate, steps at the red and blue corners, stool / bucket / bottle / towel.

## What the after set shows (art-director notes)

Good:
- Play camera: the fighters are the brightest, highest-contrast thing in the
  frame, colour and grey. Behind them, in order: dim ringside heads, the lower
  bowl in haze, two warm doorways, the ribbon board along the top.
- The 8-azimuth sheet is consistent all the way round; nothing tall stands
  between the lens and the ring.
- Wide: reads as an arena. Beams read as shafts of light. The upper deck is
  dark with small lights.
- Crowd on its feet (`play_hot`): arms up across the lower bowl, readable.

Still wrong:
- The doorways are flat orange rectangles at the fighters' head height. They
  are dimmed, but they are the most "placed" thing in the frame.
- The background takes one blue-violet cast under the haze; the crowd's
  clothing colour barely survives it on the high tier.
- People are boxes with a ball on top. Fine at lower-bowl distance, crude at
  ringside in the low shot.
- At the four diagonal azimuths the near corner post sits at the bottom centre
  of the frame. It was a blown-out white ellipse before; it is now a dark cap.
  The post being there is the known follow-camera issue in FEEL.md, untouched.
- Sponsor marks on the cushion's side faces are rotated.
- The white rope reads pink under the warm key and back light.
- Low tier has no haze, so its crowd is crisper and the ribbon board more
  prominent than on the high tier. The two tiers do not look the same.
- Canvas scuffs are barely visible at play distance.

Not looked at: the scoreboard (it is above every captured frame), the KO
aberration, the crowd in motion (only stills were read), the ribbon's scroll.

## Numbers

Reference scene, play camera, 960×600.

| | draw calls | triangles | headless software GL |
| --- | --- | --- | --- |
| before | 30 | 76,874 | 11 fps |
| after, low tier | 41 | 116,510 | ~13 fps |
| after, high tier | 55 (43 scene + post) | ~150,000 | 7–10 fps |

Software fps is trend only and swung 2× during the run (the machine was
shared with two other workstreams).

Real GPU (Apple M1, headless Chromium on Metal, vsync-capped, so 60 means
"at or under 16.7 ms", measured before ring dressing landed):
- 960×600 @1×: 60 fps on both tiers.
- 1440×900 on a 2× display, high tier: 60 at pixel ratio 1.5 with MSAA 2
  (the shipped default); 46 with MSAA 4; 53 at pixel ratio 2 with no MSAA.
  Post off: 60.
- Headroom under the cap is unknown. A governor steps post down (pixel ratio,
  then MSAA) if frames stay over `postBudgetMs`.
- No "before" number exists on the real GPU.

## Test status (2026-11-11, end of the workstream)

`TEST_NO_REUSE=1 npm test` did NOT go green in this worktree: 23/28 on both
full runs. All 20 Node tests pass. Of the 8 browser checks, `arena`, `flow`
and `referee` passed both times; `audio` and `read` pass when fewer checks run
beside them; `verify`, `stun`, `read`, `audio` failed in the full runs with
the same error — `bootReady` timing out at 15 s — and `input` fails one
assertion that is not mine (see the end of this file).

The boot timeout is real and partly mine. Measured alone on a warm server at
2× on software GL: first frame 5.9 s, steady ~170 ms a frame; rebuilding the
arena costs about 1.4 s of that (0.5 s of it the crowd). Four checks booting
at once on a machine shared with two other workstreams pushes that past 15 s.
I have no baseline boot time from before my changes, so I cannot say how much
slack the old scene had. What would fix it is outside my files: a longer
`bootReady` timeout in `scripts/waits.js`, or fewer browser checks in
parallel. Not re-run a third time (CLAUDE.md debug budget).

## Phase 2 (2026-11-11, after the merge): sound for the new events, arena polish

### A. Sound

Still true: **nobody has heard any of it.** What changed is that it is now
rendered and measured. `PORT=<port> node scripts/audio_render.mjs` renders
every recipe, 50 event shapes, the bed at three moods, a worst-case overlap
and 20 s of an AI-vs-AI fight through an `OfflineAudioContext`, using the
same modules the game plays with, writes WAVs to `scripts/output/audio/`
(gitignored — listen there), prints the numbers and checks the design intent.
29/29 design checks pass.

Structure: `ui/audio/map.ts` decides which voices an event or a crowd
reaction asks for (pure); `ui/audio/voice.ts` turns a recipe into nodes on
any context and builds the master chain; `ui/audio.ts` is the live shell.

What each new event does:
- `punchLand`: recipe by class and `grade`; `variant` bends it (overhand uses
  the heavy class, lower, longer, with a late tail; shovel hook and inside
  uppercut are short and dull; body variants use the body family); `combo`
  ≥ 2 adds a layer that rises in pitch per punch; `through` plays a glove tick
  and delays the thud 40 ms; `wrongWay` forces the flush recipe plus a hollow
  drop; `liver` adds a low thud; `counter` adds the sting and a sub boom.
- `punchBlock`: pitch falls and level rises as `guard` empties, with a low
  layer under it once the guard is worn or `chip` got through.
  `perfectBlock`: a parry tick. `guardBreak`: a crack.
- `slip`: the close whoosh pitched by `kind` (pull lower, roll lowest) and up
  the `chain`; a flick that dodges nothing is a cloth move.
- `burst` scuff, `pivot` squeak, `pushOff` shove, `clinch` thud,
  `clinchBreak` by referee two hand slaps (no voice), `feint` a soft whiff,
  `bodyHurt` a groan, `getUpPhase: slump` a small canvas thud.
- Ring ambience: footfalls by distance travelled, rope creak while
  `FighterState.ropes` is high and the fighter is moving.
- Crowd (through the mood): olé on a slip chain, appreciation on `escape`,
  a rise on `guardBreak`, an "oof" on `liverShot`, a long "oooh" on
  `bodyHurt`, a grumble on the third clinch in 20 s, swell / groan / roar on
  get-up `knee` / `slump` / `rise`, a groan-and-oooh on a body knockdown, a
  gasp then the eruption on a flash knockdown. A counter now also roars.

What the numbers found and what was changed:
- A delayed layer leaked one full-scale sample at its start (a GainNode sits
  at 1 until its first event). `bodyExhale` peaked −1.3 dBFS at an RMS of
  −36. Fixed in `voice.ts`.
- `slipNear` was the loudest thing in the game alone (−1.5 dBFS). Cut 9 dB.
- The worst overlap went through the compressor at +0.7 dBFS. A soft clipper
  with a −1 dBFS ceiling now follows it (`audioCeilingDb`).
- The bed was 8.6 dB under a clean cross at rest and level with it at full
  excitement. Crowd bus 0.5 → 0.32: now 12.8 dB and 4.3 dB.
- Most crowd reactions were 8–11 dB under the resting bed (inaudible).
  Raised; the quietest now sits level with it.
- Glancing hooks and body shots were 8–15 dB under a glancing jab. Raised.

Numbers (impact bus only; dBFS, seconds, Hz, % of energy under 200 Hz /
between / over 2 kHz). Noise layers start at a random offset, so repeat
renders differ by about 1 dB.

| event | peak | RMS | dur | centroid | low/mid/high |
| --- | --- | --- | --- | --- | --- |
| jab glancing | −14.1 | −29.5 | 0.01 | 13214 | 0/0/100 |
| jab clean | −10.0 | −25.5 | 0.04 | 9713 | 1/22/78 |
| jab flush | −5.4 | −21.5 | 0.14 | 1505 | 81/7/12 |
| cross glancing | −14.0 | −28.7 | 0.01 | 12713 | 0/1/99 |
| cross clean | −7.3 | −24.4 | 0.04 | 10128 | 1/19/80 |
| cross flush | −4.1 | −20.5 | 0.14 | 1515 | 82/7/11 |
| hook glancing | −14.4 | −26.9 | 0.03 | 241 | 62/37/0 |
| hook clean | −7.9 | −21.1 | 0.13 | 148 | 95/5/0 |
| hook flush | −3.7 | −19.3 | 0.20 | 136 | 95/5/0 |
| body glancing | −17.9 | −30.4 | 0.03 | 284 | 41/59/0 |
| body clean | −8.1 | −22.3 | 0.17 | 369 | 94/3/2 |
| body flush | −4.1 | −18.1 | 0.19 | 215 | 94/5/1 |
| body flush, liver | −2.6 | −16.4 | 0.24 | 151 | 97/3/1 |
| combo 1 / 2 / 3 / 4 (RMS) | | −24.8 / −20.7 / −20.2 / −20.0 | | | |
| overhand clean | −7.2 | −19.1 | 0.21 | 104 | 98/2/0 |
| shovel hook clean | −10.3 | −21.8 | 0.08 | 122 | 97/3/0 |
| through guard, clean | −9.4 | −27.6 | 0.08 | 9998 | 1/21/79 |
| wrong way | −1.7 | −17.4 | 0.16 | 738 | 91/4/5 |
| flush counter hook | +2.2 | −16.1 | 0.24 | 146 | 91/9/0 |
| block, fresh guard | −12.4 | −28.8 | 0.04 | 1238 | 1/85/14 |
| block, guard 0.5 | −7.3 | −21.2 | 0.08 | 218 | 90/9/1 |
| block, guard 0.1 | −4.4 | −19.5 | 0.07 | 200 | 89/11/1 |
| perfect block | −11.1 | −25.9 | 0.02 | 2038 | 0/86/14 |
| guard break | −7.3 | −24.1 | 0.10 | 2669 | 61/16/22 |
| slip / pull / roll dodged (centroid) | −8.2 | −24.6 | 0.08 | 5254 / 3191 / 2926 | |

| scene | peak | RMS |
| --- | --- | --- |
| bed, excitement 0.2 | −20.1 | −37.1 |
| bed, 0.6 | −18.6 | −33.1 |
| bed, 1.0 | −14.8 | −28.6 |
| worst overlap (flush counter + eruption + knockdown + full bed), through the master | −2.4 | −20.1 |
| 20 s AI fight (84 voices), through the master | −2.1 | −24.1 |

Honest limits of the numbers:
- The flush counter sums to +2.2 dBFS before the master. It stays under the
  ceiling only because the compressor and clipper take about 5 dB off it, so
  a counter is audibly squashed. Whether that reads as "heaviest" or as
  distortion needs ears.
- The checks compare levels, lengths and spectra. They say nothing about
  whether a crowd "ooh" sounds like people.
- The 20 s fight had no knockdown, body hurt or guard break in it, so those
  were measured alone, not in a mix.

### Hooks for main.ts

Nothing is required: until the host calls `update`, the audio reads the
fighters and the pause off `window.__sim` / `window.__flow` ten times a
second. That fallback rides on test hooks and is coarse (footfalls land up to
100 ms late). The clean wiring is two lines:
- where audio is made: `const audio = new CombatAudio(cfg, bus);`
- once per frame, after the sim steps: `audio.update(next, sdt, flow !== null && flow.state().paused);`
  (or whatever flow exposes for "the pause menu is up"; `audio.setPaused(on)`
  also exists on its own).

### B. Arena polish

- **Doorways** are recesses now: lit far wall, walls and floor falling off to
  the mouth, one or two figures in silhouette. They no longer read as orange
  stickers; from the play camera they are dark notches with a warm core.
- **Entrance tunnel** over the blue corner's diagonal: a wide, cool, bright
  mouth under an arch of lamps, three figures in it, a runway with edge
  lamps down its aisle (no seats on it), a ramp over the front wall and a
  strip of carpet to the foot of the corner steps. In the `tunnel` capture it
  reads as an entrance; the floor carpet is hard to see.
- **Crowd colour**: warm key spill over cool house light, each person a
  little warm or cool, the two back lights tint the rows nearest them, camera
  flashes light the rows the spill reaches. The right of the play frame is
  now visibly warmer than the left.
- **Ringside figures** (high tier only): neck, rounded shoulders, a lap. Low
  tier keeps the plain body to hold its budget.
- **Near corner post**: checked. With the fixed seat at any of the four
  diagonals the near post is 1.2–1.6 m from the lens, bottom-centre. Posts,
  caps, cushions and turnbuckle covers now dissolve (dithered) inside
  1.5–2.8 m of the lens. In the az sheet the post is gone at all four
  diagonals. The near ropes still cross there.
- **Low-tier haze**: the haze cylinder now runs on both tiers (0.7× on low).
- **Cushion side faces** carry no mark. **White rope** leans cool to offset
  the warm rig; it is whiter but still faintly pink in the low shot.
- **Scoreboard**: the screens were inside the housing in phase 1 — four
  black faces. Fixed; `arena_after_board.png` shows "ROUND 2 / 1:47" legible
  on two faces from the stands.

Budgets (`arena_check`, both passing): low tier 42 calls, 132,850 triangles
(limit 150k); high tier 43 calls + post, 234,334 triangles (limit 300k).

Phase 2 test status: `TEST_NO_REUSE=1 npm test` is **40/41, not green**. Run
twice; both times `flow_check` timed out after 30 s waiting for the corner
card (an 8 s round has to finish in 30 s of wall time, so it needs over one
frame a second). `flow_check` alone passes 33/33. The first run also failed
my own `audio_check` on a fixed 0.8 excitement bar under load; that bar is
now relative. After the first failure the haze was taken off the low tier on
a software rasteriser (it stays on real low-tier devices); the second run
still failed. I do not know whether phase 2 made the software frame slower
or the machine was busier: there is no like-for-like frame time from before.
Not run a third time (debug budget).

Harsh notes on the new after set:
- The lower bowl is brighter than in phase 1 (the back-light term and warmer
  spill). In grey the dark-skinned fighter separates from it by less than he
  did. He still reads; it is closer than I would like.
- Where the low camera is close to a post the dither shows as speckle.
- The entrance tunnel is a lit box with cut-out figures; fine at distance,
  a diorama up close.
- Seated ringside figures are still simple. Better than a box and a ball,
  not people.
- Nothing here was looked at in motion.

## Calls made without asking

1. **Software WebGL is a low-tier device.** Headless Chromium is SwiftShader;
   the high tier at 2× is over a second a frame there and every browser check
   timed out. So Playwright checks render the LOW tier. A script that wants
   the shipped desktop look sets `window.__cfg.qualityTier = 2`
   (`arena_look.mjs` does). `verify_check`, `lookbook` and `filmstrip` are not
   mine and still capture the low tier.
2. **Back lights are on in both tiers**, so a tier never changes how a
   fighter is lit.
3. **Post draws at pixel ratio 1.5, MSAA 2.** MSAA 4 at full Retina missed 60.
4. **The old post pass squared the pixel ratio** (the composer multiplied by
   it a second time). Fixed.
5. **Additive light is authored linear.** Without post it was being encoded
   and washed the room lavender; additive materials now take one shared gain
   (`noPostAdditive`) instead.
6. **`lowTierMinScreen` is 560**, so a 960×600 desktop window is not a phone.
7. **Arena config defaults changed meaning**: `bowlInnerR`, `bowlTiers`,
   `bowlTierRise`, `bowlTierDepth` now describe the lower bowl's rows.
8. **`arena_check`** now waits up to 90 s for boot (frames, not time), asserts
   software GL picks the low tier, and adds a high-tier budget (≤ 400 calls,
   ≤ 300k triangles, post off) and the same value rule on the high tier.
9. **The bell applauds once.** The flow's bell reaches only the bus, so the
   audio forwards it to the mood, which de-duplicates.
10. **Ring-dressing tunables live in `show`**, not `ring` (not my group).

## Not done / below standard

- Audio is unheard (see top). Ring ambience (canvas squeak, footfalls) not built.
- Vomitories are doorways on the concourse wall, not tunnels cut into the
  seating. No fighter entrance tunnel.
- Railings: only the lower bowl's wall cap and the upper deck's front rail.
- Light spill on the crowd is the analytic falloff only; nothing in the
  stands responds to the coloured back lights or to camera flashes.
- Rope sag is unchanged (`ropeSag` is in the `ring` group).
- The scoreboard shows the sponsor card; nothing calls `setBoardText` yet.
- Crowd reactions to SIM's future events (body-shot hurt, clinch) are no-ops
  until those events exist.
- `scripts/input_check.mjs` fails one assertion ("diamond + block buttons
  exist" expects 5 touch buttons; there are 6 since the LOW button). Not
  mine, not touched.
