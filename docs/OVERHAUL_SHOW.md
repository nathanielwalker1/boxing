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
