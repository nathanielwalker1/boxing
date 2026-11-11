# Overhaul — RIG workstream log

Part B of the overhaul (`docs/OVERHAUL.md`, step 3): bodies and variance.
Branch `worktree-agent-a106fd81cd2086a43`, forked from `overhaul/fight-and-look`
at `d025eb8`. Written 2026-11-11. What landed, every call made on Nate's
behalf, what I saw in the renders, and what is not done.

**Phase 2 (the reads, and the art fixes) is the next section. Phase 1 follows
it unchanged; where the two disagree, phase 2 is current.**

# Phase 2 — the fight state drawn on the body

Merged `overhaul/fight-and-look` at `f71cd79` (SIM mechanics, SHOW arena).
Nothing here has been feel-tested. Suite: `TEST_NO_REUSE=1 npm test` →
**37/37 scripts passed**.

## What landed

- **`src/rig/reads.ts`** — `Reads.step` runs inside the view's `apply` and
  turns `FighterState` and the frame's events into pose channels (chest
  pitch / roll / yaw, hips, shrug, head, heels, lead-foot step, hop), a face
  and a skin. Hits KICK loose springs, so a flush shot follows through and
  comes back. main.ts calls nothing new.
- **`stanceParams(state, cfg)`** in `reads.ts` — the one place stance width,
  bounce rate / depth and the blade are read from. Neutral = config; point it
  at `core/styles.ts` when that lands.
- **`src/rig/spray.ts`** — pooled sweat droplets (one lit InstancedMesh per
  fighter, world space, not drawn while empty).
- **`src/rig/replay.ts`** — `window.__rigReplay`: the filmstrip hook. main's
  `__replay` hands the views a frozen state and no events, so nothing the rig
  draws from events or its own springs was in a strip. This runs the same
  deterministic sim, feeds every tick and its events through both views,
  calls `__replay` for the host's pose and camera, and freezes the views.
- **Art fixes 1–5** and **the blade** (below).

## Decisions

1. **The blade is back on the ribcage, not the shoulders.** The chest bone
   yaws `rigStanceChestYawDeg` (20°) toward the lead side on top of the sim's
   shoulder line; the shoulder BONES stay on the sim's joints and the torso's
   corner weight on them went 0.6 → 0.82, so no joint or hit shape moves. It
   fades out as the punch's own twist passes 0.5 rad. Limit, by arithmetic
   not by a render: the chest corner sits 0.234 m from the spine, so 20° is
   8 cm of shear between ribcage and shoulder, 25° is 10 cm. **The hips are
   still at 12°** (`rigStanceHipYawDeg`, lowered in phase 1) — I did not put
   them back to 28°, so this is a partial blade: ribcage 20°, hips 12°, feet
   as they were. A full blade at the shoulders needs `core/arms.ts`.
2. **The drawn arms leave the sim's joints in two cases**: the clinch (wrapped
   round the other man) and the push-off (both forearms out). The sim leaves
   the gloves at the guard for both and nobody can punch in either, but it is
   an exception to "drawn = hit geometry" and should be the sim's to place.
3. **The drawn shoulder moves up to ~3.5 cm off the sim's** (`reads.shrug`,
   the feint twitch) so a hunch, a slump and a feint read.
4. **`filmstrip.mjs` was edited beyond appending scenarios**: the loop calls
   `__rigReplay` when it exists, a scenario may carry `cfg` (config for that
   strip only) and `over` (view-only state, `RigProbe.override`), and a
   stalled capture is retried once and reported.
5. **Knockdown strips turn damage up** (`healthDamagePerImpulse` /
   `liverDropFrac` for that strip) and pull the camera back and down, because
   the play framing cuts a man on the canvas out of the picture.
6. Abs are relief now; the painted rungs and the ab outline are gone.
7. Fat no longer thickens the limbs beyond what `bodyR` already does.

## Interface changes

- **View**: `RigView` is unchanged (`setFace`, `setBodyState` still work; a
  host value wins when it is larger than what the fight has done).
- **`RigProbe`** (`window.__rig[side]`) gained `override(partialState | null)`,
  `feed(prev, next, events)`, `freeze(on)`, `sprayCount()`.
- **`window.__rigReplay(dist, s0, ticks, s1, over)`**.
- **Config**: new group `rig reads` (every key has a `desc`). No key outside
  my groups changed.
- **`FootPlanter.stepNow`** (rig-internal).
- No `FighterSpec`, `BodyDims` or core type changed.

## Numbers (Metal ANGLE headless, 960 × 600 @2×, vsync-capped)

| | high | low |
| --- | --- | --- |
| triangles per fighter (red / blue) | ~17,100 | ~7,900 |
| draw calls per fighter (main + shadow) | 1 + 1 | 1 + 1 |
| sweat spray while droplets are alive | +1 call, ≤ 960 triangles | same |
| scene (SHOW's arena included) | 55 calls, 203,948 tris | 55 calls, 167,100 tris |
| fps | 60 | 60 |

The spray lives under the scene, so the per-fighter probe does not count it;
the +1 call is from the code, not a measurement taken mid-burst.

## What I saw, item by item

Strips are play-camera, 24 frames; `docs/overhaul/strip_*_after.png` are the
committed ones (flush_counter, body_hook, inside, knockdown, body_knockdown).
The others are in `scripts/output/filmstrip/` (not tracked).

**Art 1 — shoulders, arms down.** The trapezius now runs out over the top of
the arm and the arm comes out from under it; the epaulette cap is gone. There
is still a tonal line across at clavicle height where the two skins meet.
**Art 2 — nose and jaw.** The bridge is a ridge. The jaw holds its width to a
jaw line that runs back under the ear, with a flat underside: a defined
profile. **Art 3 — abs.** Relief only; visible from the front without the
ladder. Fainter than the paint was. **Art 4 — heavy arm.** The taper below
the elbow is in the mesh, but I did not get a clean look at it: the one
close-up I shot was from behind. Unverified. **Art 5 — boots.** A dark welted
sole, a heel counter, a toe-cap line, a top band, laces. They read as boots.
There is a visible step where the shaft meets the foot.

**1. Levels, posture, roll.** `body_hook` t=4–24: knees bend and the torso
pitches forward together — a crouch, not a lift going down. `inside`: both
men hunched chest to chest. `roll` t=4–10 down, t=12–22 the head goes under
the hook and across, t=24–32 up the far side: a U. Not checked: a knee
"pop" between frames (strips are 2–4 ticks apart).

**2. Footwork.** `pivot`: the body swings round and ends at blue's side by
t=16; whether the lead foot stays on `pivot.cx/cz` cannot be judged at strip
size and was not measured. `burst`: the gap closes between t=8 and t=14; **the
hop itself does not read** — no visible rise or landing at this size. Bounce
× (1 − flat), the heel off the canvas, and the ropes lean are wired and were
**not filmed**.

**3. Punch variants.** Body shots: the whole torso bends into them
(`body_hook` t=24–32, `inside` t=36–51). Shovel hook / inside uppercut: seen
only as "compact" in the `inside` strip, not isolated. Step jab, retreat jab,
overhand, rising hook / uppercut, check hook and the feint are wired and
**not filmed** — untested by eye.

**4. Getting hit, by grade.** `flush_counter` t=27–36: the head whips with
the hook, the mouth opens, the arms are knocked apart; a droplet is visible
at t=39. On a fresh fighter the spray is a handful of droplets and nearly invisible at
play distance; it has not been seen on a sweating one. Glancing vs clean vs
flush were not compared side by side. Body shot (`body_hook` t=36): a small
fold; the buckle at t=64–92 is head down, hands low, hunched — a different
shape from the rocked wobble, but subtle at this size (fold raised 34° → 44°
after that strip; not re-read). **The elbow dropping to cover is not done**:
the arms are the sim's.

**5. Guard.** `guardBroken`, `blockStun` and `guardDroop` are wired (slump,
rock back, shoulders down). **None was filmed.**

**6. Fatigue and damage.** `tired` (view-only override on red): he is
visibly redder and shinier than the fresh man. The open mouth, faster
breathing, flat feet and the swollen eye cannot be seen at strip size and
were not looked at close in play. The jaw swing went 15° → 25°. Swelling and
cuts follow `damage.head` with the side taken from which way the head shots
pushed him; the asymmetry is untested. The liver side is not redder than the
other: `redden.body` is one value.

**7. Clinch, push-off.** `clinch` t=20–95: chest to chest, each man's arms
round the other, broken at t=100. The heads sit apart and tilted back rather
than together, and the arms pass through the other man (no collision).
`push` t=8–22: both forearms drive out from the chest and blue goes back.

**8. Knockdown and get-up.** Head KO (`strip_knockdown_after`): t=40 going
back with the arms flung, t=50–100 on his back with the arms out on the
canvas, t=110–120 propping on an arm, t=130–140 up on a knee, t=150–160
rising, t=170 on his feet. He lies with the knees up and feet planted, like
a sit-up — the hips do not slide far enough. Body KO
(`strip_body_knockdown_after`): t=66–76 he sags, t=86 down on a knee with a
hand going to the canvas, t=96–146 folded over one knee, head down, propped
on an arm, t=156–196 up through a crouch. One arm is near full stretch to
the canvas, and it is a one-knee prop, not all fours. Two bugs were found
and fixed from these strips: gloves pointing at the ceiling when laid out,
and a glove and cuff standing on the canvas by themselves under a man still
on his feet. **The slump (failed try) did not occur in either roll and has
not been seen. The flash knockdown (sits down) was seen only at strip size
in `flush_counter` t=45–69.** No frame was inspected closer than the play
camera except three in the first head-KO strip.

**9. `stanceParams`.** In; neutral.

**Pose grid, all four punches, hitboxes on** (low tier — `pose_grid.mjs`
does not force the high mesh): the head sphere wraps the skull, the glove
spheres sit on the gloves and the body capsule runs inside the torso through
jab, cross, hook and uppercut; nothing breaks.

## Corrections to things I said during the run

- I reported that the after-lookbook was blue and banded because the fight
  behind it ran out and the arena lighting changed. **That was wrong.** The
  cells are correct; the banding was the image viewer reducing the large
  sheet. The round-clock hold I added to `lookbook.mjs` is a precaution and
  fixed nothing. Judge colour from `scripts/output/lookbook/cells/`.
- A pose-grid run failed with `__pose is not a function` because I edited a
  source file while it was capturing and vite reloaded the page.

## Not done / below standard

- Everything marked "not filmed" above: bounce / flat feet / heels, ropes,
  six punch variants, the feint, all three guard reads.
- The hop of the burst does not read.
- The elbow dropping to cover a body shot; the liver side redder.
- The slump; a close inspection of the fall and get-up frame by frame.
- The heavy fighter's arm (art 4) is unverified.
- The blade is partial (hips at 12°).
- **Captures stall intermittently**: three filmstrip runs died with a 30 s
  screenshot timeout at the first frame of a scenario (roll twice, burst
  once); the same scenarios pass on a rerun, and a timing probe of `roll`
  showed nothing slow. Cause not found. `filmstrip.mjs` now retries once and
  says so.
- The lookbook sheets are too large to judge in one view; read the cells.
- `pose_grid.mjs` shows the low mesh.

---

# Phase 1 — bodies and variance (as written at the end of phase 1)

## What landed

- **The capsule figure is gone.** `src/rig/mesh.ts` now assembles one skinned
  mesh from lofted parts: `anatomy.ts` (torso, arms, legs), `head.ts` (skull,
  face, ears, hair, facial hair), `kit.ts` (gloves, trunks, boots, the
  referee's hands and bow tie), on the builder in `geo.ts` (grids with their
  own smooth normals, curvature AO per vertex, up to 4 blended bone weights,
  morph targets). One draw call per fighter, one more in the shadow pass.
- **A real bind pose** (`skeleton.ts`): 26 bones, inverse bind matrices, so a
  vertex follows several bones. Elbows and knees blend upper → a half-way
  joint bone → lower; the waist blends hips → spine → chest; the neck blends
  chest → neck → head; the deltoid rides a shoulder bone turned half-way
  between chest and upper arm, and the corners of the chest lean on it.
- **The pose solver** (`index.ts`) places limbs with a hinge frame (both bones
  of an arm or leg share the joint's axis, so there is no twist for the skin
  to collapse over), widens the joint bone in the bend plane to put back the
  volume linear blending loses, turns the fist over as the arm straightens,
  and springs the trunks' hems and hanging hair in world space.
- **Painted atlas** (`paint.ts`, `atlas.ts`): one canvas per fighter — skin
  variation, face (eyes with iris and whites, brows, lips, mouthguard,
  nostrils, stubble, the hairline), muscle lines, tattoos, trunks patterns and
  initials on the waistband, glove cuff / laces / strap / seams / panel, boot
  laces / sole / stripes. A second small canvas is the damage layer.
- **Skin shader** (`materials.ts`): MeshPhong with its lighting chunk
  replaced — wrap diffuse with the wrapped light tinted warm, a sheen and a
  tight highlight that grow with `sweat`, sweat beads on the high tier,
  `redden` blotches, bruises and cuts from the damage layer; cloth, leather,
  hair and eye responses by a per-vertex kind. Scene lights, the shadow map
  and fog work as stock. The rim and the read's warm glow are kept. The
  outline hull is kept (off by default, as before).
- **Build is continuous** (`FighterSpec.morph`), **a roster of eight**, **a
  seeded generator** (`core/generator.ts`), `scripts/roster_test.mjs`.
- **Lookbook** gained two portrait columns (face; hurt = wince + swollen eye +
  cuts + sweat + reddening) and `gen N [fromSeed]`.

## Decisions made for Nate

1. **The chest now turns with the sim's shoulder joints.** The old rig yawed
   the chest 38° (the stance blade) while the sim's shoulders — which the arms
   are drawn on — sit square at rest. With capsules nobody could see it; with
   a deltoid and a pec that are one skin with the arm, the shoulders floated
   15 cm off the chest. The chest (and the head's follow) now take their yaw
   from the line between the two sim shoulders. `rigStanceShoulderYawDeg` is
   retired (kept so saved tunings load) and `rigStanceHipYawDeg` went 28 → 12
   so the waist does not stand twisted. **The stance silhouette is squarer
   than the one Nate accepted.** If he wants the blade back it has to go into
   the sim's shoulder placement (`core/arms.ts`), not the rig.
2. **Hip joints moved in.** `hipW` stays the sim's number, but the drawn
   femurs sit at `rigHipJoint` (0.6) of it; at 1.0 the legs hung outside the
   pelvis like the toy figure.
3. **Legs thicker** (`rigThighR` 0.55 → 0.63, `rigShinR` 0.42 → 0.48), chest
   shallower (`rigChestDepth` 1.0 → 0.9), waist narrower (`rigWaistRatio`
   0.70 → 0.64). Arm radii are untouched: the sim uses them for arm contacts.
4. **Torso inside the body capsule at the waist.** The drawn belly is
   `rigWaistDepth` 0.72 × bodyR deep; the hit capsule is bodyR. A glove
   stops 3–4 cm short of a lean fighter's abs. A drawn waist as deep as the
   capsule is a barrel. The chest (0.9 × bodyR) and the sides sit on it.
5. **Arm floor relaxed for wide frames** (`core/body.ts`): a frame wider than
   neutral takes its extra shoulder out of the shortest arm allowed. 0 for
   red and blue (their numbers are bit-identical, pinned in `roster_test`).
   Without it the 1.63 m swarmer out-reached Ray.
6. **`bodyFat < 0` is drawn only.** Being shredded does not shrink the hit
   capsule; positive fat grows it.
7. **Toon banding is retired for the fighters.** `toonBands` and
   `rigFlatShading` no longer do anything in the rig. Skin is smooth-shaded.
8. **The referee is always the low tier** (he is background) and got a
   receding crop and a moustache so he is not a third boxer.
9. **`addToRoster(spec)`** in `core/roster.ts`, and rig-side hooks
   `window.__rigGen(seeds)`, `window.__rosterSpec(id)`, so the lookbook can
   show generated fighters without touching `src/main.ts`.
10. **`wip` lookbooks go to `scripts/output/`**, not `docs/overhaul/`.
11. `generateFighter` is re-exported from `core/roster.ts` rather than adding
    a line to `core/index.ts` (not my file).

## Interface changes

**`FighterSpec`** (`core/types.ts`)
- removed `build: 'lean' | 'athletic' | 'heavy'` and the `Build` type
- `morph: BodyMorph` — `{ frame, muscle, bodyFat, limbLength, neck, head: HeadMorph }`,
  every value −1..1, 0 = the baseline athlete. `HeadMorph` =
  `{ width, jaw, chin, brow, nose, ears, height }`
- `hair: HairStyle` — 16: none, short, afro, braids, long, mohawk, buzz, fade,
  flatTop, curls, cornrows, dreads, tied, receding, slick, topKnot
- `hairColor?: string`, `eyeColor?: string`
- `facialHair: FacialHair` — 10: none, goatee, beard, stubble, moustache,
  chinstrap, longBeard, muttonChops, soulPatch, handlebar
- `tattoos?: Tattoo[]` — `{ place, motif, seed }`; places chest, back,
  sleeveL/R, forearmL/R, shoulderL/R, neck, ribs; motifs tribal, script,
  cross, star, wings, rose, bands, geometric, serpent (was a list of four
  place names that nothing drew)
- `trunksStyle: TrunksCut` — short, classic, long, belt, skirt, split
- `trunksPattern?: TrunksPattern` — solid, sideStripe, waistStripe, twoTone,
  flames, stars, checker, gradient
- `gloveCuff?`, `gloveThumb?`, `glovePanel?: string`, `gloveClosure?: 'laces' | 'strap'`
- `bootHeight?: 'low' | 'mid' | 'high'`, `bootTrim?: string`, `bootTassels?`, `bootStripes?: boolean`

**`BodyDims`** — no field added or removed.

**`core/body.ts`** — `NEUTRAL_MORPH`, `morphOf(spec)`.
**`core/roster.ts`** — `ROSTER` (8), `addToRoster(spec)`, re-exports `generateFighter`.
**`core/generator.ts`** — `generateFighter(seed: number): FighterSpec`.

**Config** (`core/config.ts`)
- `body`: removed `buildLean`, `buildHeavy`; added `morphMuscleGirth`,
  `morphFatGirth`, `morphFrameGirth`, `morphFrameShoulder`, `morphFrameHip`,
  `morphFatHip`, `morphLimbLeg`, `morphNeckLen`
- `render`: added `rigQuality` (1 = high, 0 = low)
- `rig`: added `rigGlovePronateDeg`, `rigGloveGuardRollDeg`, `rigJointBlend`,
  `rigJointMitre`, `rigJointMitreMax`, `rigShoulderFollow`; changed defaults
  of `rigStanceHipYawDeg`, `rigChestDepth`, `rigWaistRatio`, `rigThighR`,
  `rigShinR`; `rigStanceShoulderYawDeg` retired
- new group `rig body`: `rigChestWidth`, `rigWaistDepth`, `rigPelvisWidth`,
  `rigHipJoint`, `rigDeltoid`, `rigMuscleDef`, `rigMorphMuscleDef`,
  `rigMorphMuscleLimb`, `rigMorphFatBelly`, `rigMorphNeckR`, `rigAoStrength`,
  `rigHandScale`
- new group `rig skin`: `rigSkinWrap`, `rigSkinScatter`, `rigSkinScatterColor`,
  `rigSkinSheen`, `rigSweatSheen`, `rigSweatGloss`, `rigLeatherGloss`, `rigClothSheen`
- new group `rig cloth`: `rigClothK`, `rigClothZeta`, `rigClothMax`, `rigTailK`,
  `rigTailZeta`, `rigTailMaxDeg`

**The view** — `createFighterView` returns `RigView extends FighterView`
(`src/rig/index.ts`; `FighterView` in `core/types.ts` is untouched):
- `setFace({ wince?, mouthOpen?, swell?: [left, right], cuts?: { browL, browR, cheekL, cheekR, nose, lip } })`
  — scalars 0..1; anything left out keeps its value; eased over ~0.1 s
- `setBodyState({ sweat?, redden?: { head?, body? } })` — 0..1
- test hooks: `window.__rig[side].setFace / setBodyState / portrait(on)`
  (portrait hangs the arms for the lookbook; never set it in play)

**Nothing outside my folders was edited.** `src/ui/flow.ts` compiled as is.
Hooks the orchestrator may want: type `views` in `main.ts` as `RigView` (or
add the two methods to `FighterView`) to call `setFace` / `setBodyState`.

## Numbers

| | before | high tier | low tier |
| --- | --- | --- | --- |
| triangles per fighter (red / blue) | ~3,000 | ~16,500 | ~7,700 |
| draw calls per fighter (main + shadow) | 1 + 1 | 1 + 1 | 1 + 1 |
| atlas | none | 2048² + 512² damage | 1024² + 256² damage |
| scene triangles (two fighters, no referee) | 76,874 | ~132,000 | 96,022 |
| headless GPU fps (Metal ANGLE, 960×600 @2×, vsync) | 60 | 60 | 60 |

The fps line is vsync-capped at 60 on both sides, so it only says "not below
60 here"; the real gate is Nate's browser. `verify_check`'s own fps line prints
"no sample" on software GL, before and after.

**Software GL is slower with the new rig.** The browser checks run on
SwiftShader; a frame there cost ~0.28 s at the low tier and ~0.3–0.44 s at the
high tier in quiet moments, and the machine was shared with the SIM
workstream's runs, which moved the same measurement 2–4×. See "Tests".

## What I saw (harsh notes)

**Torso.** Front: pecs with an under-edge, a sternum line, two rows of abs
above the waistband, a V from lats to waist. It reads as an athlete from the
play camera. The ab lines are partly painted and look drawn-on in the block
close-up ("a ladder"); geometry alone was invisible under the flat top light,
which is why the paint is there. Back: spine groove, blade and lat lines; the
upper back is now one mass with the deltoids after the yoke was widened and
squared behind the shoulders — the first cut was "two balls glued to the
corners of a plank" and that is fixed from behind and from above. No
clavicles in geometry (two painted strokes). No glutes under the trunks beyond
the pelvis table.

**Shoulders.** In the guard and the block the deltoid flows into the pec and
the upper arm; the block close-up is the best view of the rig. In the lookbook
portraits (arms hung, a pose the game never shows) the deltoid still reads as
an epaulette cap sitting on the chest corner with a crease under it. From the
rear three-quarter the lead deltoid is still a rounded knob past the corner of
the back, connected but too spherical.

**Arms.** Elbows at ~140° of bend (guard, block) keep their width and show a
crease, no candy-wrapper and no collapse; a straight cross shows biceps,
triceps and a forearm that tapers into the cuff. The extended arm was "a
string of sausages" on the first cut; the bumps were flattened and it is
better but still a little rubbery in the cross. The upper arm is thick seen
end-on in the guard.

**Legs.** Quad, teardrop over the knee, kneecap, a calf high on the shin; the
knee bends as one skin in the stance. Not checked: a knee past ~90°
(the knockdown's folded legs were seen once, mid-fall, at game distance — no
breakage visible, not inspected close).

**Head.** Reads as a face at lookbook distance: brow, sockets, eyes with
whites and iris, a nose with a bridge, lips, jaw, ears. From the play camera
it is brow + nose + hair + beard, which is enough to tell fighters apart. The
jaw is soft in profile — there is no hard jaw angle, the lower face slopes
into the neck. Every fighter has the same neutral expression. `wince` shuts
the eyes to slits and drops the brow; `swell` closes one eye from below with
a bruise; cuts draw and run; `mouthOpen` drops the jaw but from the side it
mostly reads as a receding chin, and the teeth / mouthguard strip is barely
visible. The 'short' crop shows a few stair-steps where the hair shell meets
the temple.

**Gloves.** The strongest part: body, thumb, cuff with stripes, laces or a
strap, a stitched seam, a leather highlight.

**Trunks.** Waistband with initials, six cuts, eight patterns; the hems hang
off the thigh and are on springs. On the first full sheet the thigh came
through the cloth on the long and classic cuts (fixed by weighting the panel
to the thigh and widening the gap; clean on the after sheet). The skirt is a
pleated kilt over short leg panels, not separate panels: its first cut let
the thighs through at the hip, its second stood out like a wing when each half
followed its own leg, the third mostly follows the hips — and from the side
the lead thigh still comes through the front of it below the short panel. The spring's swing was not measured or
filmed moving; a filmstrip only shows it settling between posed frames.

**Boots.** The weakest part: a rounded foot and a shaft with painted laces
and a top band. They read as boots, not as good boots — no heel, a thin sole
line, the toe is a blob.

**Skin.** Soft terminator with a warm edge, sheen on shoulders and forehead;
`sweat = 1` is clearly wet with beads. Dark skin against the dark arena is
low in value separation (monsoon, blue) and leans on the rim light.

**Silhouettes** (greyscale sheet, front and side columns):
- **red** — the reference: medium everything, cropped cap of hair, short trunks.
- **blue** — taller and narrower, bald dome, trunks to the knee, tall boots.
- **boiler** — a head shorter than anyone, as wide as he is deep, no neck, a
  flat-top block on the head, a belt-high waistband.
- **lighthouse** — a head taller than red, small head on a long neck, long
  thin limbs, long trunks.
- **raffle** — the widest shape on the sheet: belly past the waistband, thick
  arms and legs, bull neck, mutton chops widening the jaw.
- **alambre** — the thinnest: stick limbs, big ears, short flared split
  trunks, southpaw (mirrored guard).
- **monsoon** — dreadlocks to the shoulders, a full beard, and a skirt instead
  of leg panels.
- **grandad** — thick middle, a long beard below the chin line, a tail of hair
  behind the head, long trunks.
red and monsoon are the closest pair in body; hair and trunks separate them.

## Tests

- Node (sim) tests: 21 / 21 green, none edited except `body_test.mjs` (mine:
  `build` → `morph`) and the new `roster_test.mjs`.
- `red` / `blue` sim-facing `BodyDims`: bit-identical to the values computed
  before `body.ts` changed (pinned in `roster_test.mjs`).
- Browser checks: below.

`TEST_NO_REUSE=1 npm test`, last run: **26/28 scripts passed** — all 21 Node
tests and 5 of 7 browser checks. The two failures are in files this
workstream does not own:

- `flow_check` — "confirm → the tale of the tape": it picks the second card
  and expects the opponent to be Castellano. `ui/flow.ts` takes the next
  roster entry as the opponent, which was Castellano only while the roster
  was two; with eight it is Benny Brask. Caused by the roster growing; the
  fix is the test's expectation (or the flow's opponent rule).
- `input_check` — "diamond + block buttons exist" expects 5 touch buttons;
  the LOW button added with `FrameInput.level` makes 6. Not caused by the rig.

`arena_check`'s triangle budget (150,000 for the scene, shadow pass included)
failed once at 156,902 with the referee in; the high tier was trimmed from
~18,700 to ~16,500 triangles a fighter and the referee pinned to the low tier,
and it passes. It is close to the line: a fighter with dreadlocks and a beard
costs more than red or blue.

Earlier in the session every browser check timed out at boot (15 s) while the
machine was busy with the other workstream's runs; nothing was changed for
that and they pass when it is quiet.

The committed sheets (`docs/overhaul/lookbook_after.png`,
`lookbook_gen_after.png`, each with a `_grey`) were rendered just before the
last ~10 % segment trim; they were not re-rendered after it.

## Not done / below standard

- **Feel-tested: nothing.** All of this is "renders / sim tests green".
- **Sim state is not wired to the face or the skin.** `setFace` /
  `setBodyState` exist and work from the hooks; nothing calls them in play.
- **Pose grid**: `hook` was read with hitboxes on — the head sphere wraps the
  skull, the glove spheres sit on the gloves, the body capsule runs inside the
  torso; at p = 0.45–0.6 the hooking arm lies flat with the deltoid joined to
  the upper back and the torso turned to show the back. `cross` was rendered
  and not read; `jab` and `uppercut` were not rendered. The exchange filmstrip
  and the referee check's two screenshots (the count, mid-fall) were read.
- **Extreme poses not inspected close**: deep crouch, the knockdown lying on
  the canvas, the get-up.
- **Boots** below the standard of the rest (above).
- **Jaw / profile** soft; `mouthOpen` weak; one expression for everyone.
- **Skirt** is a pleated cone, not separate panels; no cloth collision — a
  high knee can come through a hem.
- **Hair**: afro, curls, mohawk, topKnot, braids, long, fade and buzz are
  built but were only seen on generated fighters at sheet size, not inspected.
  Hanging hair is one sprung bone for all strands.
- **Tattoos**: nine motifs on ten places; only the roster's were looked at.
  They are ink shapes, not drawings.
- **No procedural normal map**; muscle relief is geometry + vertex AO + paint.
- **No trunk name text** beyond initials.
- **Software-GL cost** rose (above); no optimisation was done for it. Splitting
  the head (the only part with morph targets) into its own mesh is the first
  thing to try.
- `toonBands` and `rigStanceShoulderYawDeg` are config keys the rig no longer
  reads (`rigFlatShading` already was not read).
