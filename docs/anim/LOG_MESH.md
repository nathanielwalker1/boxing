# LOG — Phase 1.2 / 1.3, the body mesh (mesh workstream)

Branch `anim/skeleton-and-feel`. Every decision with its reason. Spec: `docs/anim/DESIGN.md` §2, §4; evidence
`docs/RIG_AUDIT.md` §3. Port 5195. Captures: `docs/anim/p1_2/before`, `.../after` (`node scripts/lookbook.mjs shots <dir> red boiler referee`:
guard pose and arms hung, front / 3/4 / side / back; the referee is added to the roster for the occasion).

Poses available: the guard (`rest`), the arms hung (`rig.portrait(true)`). No T / A pose is reachable through `window.__rig[side].override`
(with an override the solver takes the sim's boxes, not a skeleton), so the "arms hung" view stands in for it. The extreme joint poses of
deliverable 2 are driven through `override` (glove targets, crouch, torsoTwist) and the replay hook; see the section on verification.

## 1. Baseline: what is anatomically wrong (before, full-size frames, red / boiler / referee)

Against a real athletic boxer (1.80 m, about 7.5 heads tall, bideltoid breadth about 0.26 h, neck circumference about 0.2 h):

- **No neck.** Front, side and back: the head sits directly on the trapezius line; the neck is a stub 25 % of a head high, hidden by the jaw
  from the front and by the shoulders from behind. Real boxers carry a visible, thick neck (cylinder about 0.5 head wide, 0.4 head tall) and a
  trapezius that slopes in a long line from the ear to the shoulder tip.
- **Shoulders read narrow and pinched.** The yoke closes in over the shoulder joint and the deltoid is a small ball hanging off the corner; from
  behind the corner comes to a point where the clavicle-weighted torso skin meets the deltoid cap. No acromion, no deltoid width; with the arms
  hung the silhouette is a coat hanger, not a boxer's yoke (the deltoid caps should sit a hand outside the ribcage).
- **Torso is flat in depth and short.** Side view: the chest is no deeper than the waist, so the pecs do not read; abdominal and oblique relief is
  too faint to see from the play camera, and the lat flare is missing, so the V taper is only the waist narrowing.
- **Hip and thigh.** Thigh mesh above the joint is 100 % thigh, pelvis 100 % hips: they interpenetrate and, in the stance, the thigh's top shows as
  a bulge through the side of the trunks. Legs "poke out": the leg panels of the trunks hug the thigh at 2 cm, and the thigh bulges through.
- **Limb girth.** Upper arm 0.42 bodyR: matches a lean boxer; forearm and wrist are fine; thighs are slightly thin against the hips and the
  calf is a low sausage with no knee or elbow landmark. Hanging arm: fingertips reach the trunk hem (upper thigh) rather than mid-thigh: about
  one glove short. Not changed: it is a reach number (`BodyDims.upperArm`, `forearm`), pinned by roster_test.
- **Head** is 1 / 6.2 of the height (real 1 / 7.5): reads as stylised and is what makes the body look small. Not changed: it is hit geometry
  (`headsTall`, roster-pinned). Recommendation for Nate.
- **Referee**: a long-trunks panel hangs below the shirt like briefs, the trousers are skin-tight leggings (one cloth tube per leg at 1.1 x the
  thigh), no belly, boxer's arms under short sleeves. Reads as a man in leggings, not a referee.

## 2. Skinning (1.2)

Tools: `scripts/mesh_view.mjs` draws the bare mesh on its own canvas with bones set by hand (the game's driver re-poses every bone each frame,
and was being rewritten), `scripts/clip_check.mjs` measures. `window.__rigMeshes` / `window.__THREE` (set in `rig/mesh.ts`) are the test hooks.

- **One weight field at the hips** (`anatomy.ts thighShare`, `legSkinWeights`): a point's share of a thigh is a smooth ramp over ± `rigHipBlend`
  thigh radii around the hip joint (and, for the torso's lower rings and the trunks' panel, which side of the body it is on). Torso skin, thigh
  skin, trunks panel and trunks legs all take their weights from it, so two surfaces at one place always move together. The thigh mesh above the
  joint is now pelvis-weighted (hips 100 % at its top), the torso's lower rings carry a thigh share: no plane where thigh and pelvis slide through
  each other. FOUND the hard way: the torso's cut-off for this field was a fixed height shorter than the field's support, leaving a step in the
  weights that opened a ring of exposed skin around the belly of a heavy fighter (31 exposed vertices to 2 once the cut-off covered the support).
- **Shoulder**: the deltoid cap above and around the joint takes exactly the torso's weights at that place (chest and clavicle), then hands over to
  the arm through the deltoid helper over the length of the muscle. Yoke and cap are one surface; the old cap weights (clavicle .5 / helper .3 / arm
  .2 at the top, against the torso's .82 clavicle) were the crease. Verified bare, arms raised overhead (170°), arms across the chest, elbow at 140°.
- **Elbow / knee**: blend widened (`rigJointBlend` 1.15 → 1.5 radii each side, with the half-way helper kept). At elbow 140° the lead arm shows no
  pinch or balloon in `scripts/output/mv/red_elbow140_*` (the inner crook folds as a crease, the outer point holds). I added no helper-bone
  scale and no extra loops: not needed at the angles looked at.
- **Neck**: chest → neck → head weights run from a little below the neck base to the top of the neck in two smooth stages; the neck leaves the
  trapezius at `rigNeckBase` 0.15 of the chest length (was 0.27) so a visible neck stands between the trapezius and the jaw; neck radius
  `rigNeckR` 0.45 → 0.56 of headR (13 cm to 16 cm). The trapezius slopes about 15° from the shoulder tip to the neck.
- **Not verified in the real driver**: deep knee bend and torso twist are drawn bare (mesh_view `crouch`, `twist45`). `head60` bare shows the
  jaw and neck turn as one skin.

## 3. Proportions and definition

Changed (drawn shape only, no hit shape): neck radius, neck base height (above); pelvis half-width `rigPelvisWidth` 1.12 → 1.22 (the thigh tops
stood out past the pelvis they hang from); muscle relief `rigMuscleDef` 1.0 → 1.25; torso rings denser through the abdomen and ribcage (a row every 3 cm
lost the 1.3 cm abs) and 44 columns instead of 36 on the high tier. Referee: belly `rigRefBelly` (a bodyFat equivalent of 0.45 on the torso),
arm girth `rigRefArm` 0.82, trouser legs straight and loose (`rigRefTrouser` 1.3 × the thigh, narrowing 30 % to the hem, narrow at the top so they
hang from the waist).

NOT changed, on purpose (gameplay): `headsTall` 6.2 (the head is 1 / 6.2 of the height, real 1 / 7.5; it is the head hit sphere and roster-pinned;
it is what makes the body read small and toy-like: recommendation: 6.8 with a roster-number review), shoulder width ratio (the drawn bideltoid
0.62 m on 1.80 m is wide because the joint span is 0.26 h; the drawn yoke is fine), arm length (hanging fingertips reach the trunk hem: one glove
short of mid-thigh; it is `BodyDims.upperArm + forearm`, a reach number). No BodyDims, no body.ts and no sim number moved: roster, body, heights, config
tests are green with no edit.

## 4. Trunks (1.3)

A shell OUTSIDE the skin, config `rigTrunkGap` 2 cm. The panel is the torso's own surface lifted by the gap and widened below the hip line to the OUTER
OUTLINE of the two leg shells' top rings (each leg's surface at that depth, muscle bumps and all, as a polygon; the panel's radius per column is the
farthest ray hit): its lower rim IS the outline of the shells' tops, so the shell is closed from the waistband to the hem. The leg shell is the leg's
own surface pushed out by the gap (more toward the hem: a hem flare to gap + 2.2 cm), weighted with the skin's own field plus the hem bone for at most
0.45 of the way down (`rigClothMax` 9 cm of hem swing × 0.45 is 4 cm, which the flare absorbs: the skin does not show on the lee side of a swinging
hem), and not at all where a knee bends the skin (the long cut reaches the knee blend). All six cuts are the same code with a different length and
`hemAt` (split) or the skirt panel. The skin under the trunks is KEPT (it is what clip_check measures). First tries, for the record: pushing the
panel out of the thighs radially left ragged coplanar rims; extruding the pelvis straight down made a bag. Neither is in.

## 5. Clipping check

`scripts/clip_check.mjs` (runner name `clip`), report `docs/anim/CLIPPING.md`, baseline `docs/anim/p1_2/clipping_before.md` (the same script against
the commit before the mesh work, with only the test hooks patched in). Method: at the bind pose, every skin vertex (torso, arms, legs) that five rays
(its normal and four tilted 35°) all meet the trunks (or a glove, for an arm; trunks and boot for a leg) within 12 cm is "must be covered". In each
pose the skinned positions and normals come from the live bone matrices and the vertex counts as EXPOSED when four or more of its five rays meet
nothing. The first version counted any miss and flagged vertices on the cover's rim; the five-ray rule removed them without hiding a real poke (the
baseline's real pokes miss with all five). Poses go through the real rig view: sim punch poses at full extension (`__pose`), the held block, a crouch
and a twisted torso and arms overhead through the state override, scripted exchanges through `__rigReplay` (slip left / right, roll, a wide step,
a mid-step, and the knockdown fall at tick 36 knee, 60 back, 84 down, 116 hands and knees, 148 seated, 172 getting up). Six builds with six cuts:
red short, boiler classic, raffle belt, alambre long, monsoon skirt, grandad split. Limit `clipMaxExposed` 40.

## 6. Faces (1.3)

Mesh: heavier brow ridge, deeper sockets, a firmer cheekbone, a jawline running from the corner to the chin, a philtrum, nostril wings (alae) standing out
from the cheek with a hollow under them, ears with a scooped concha inside a raised rim and a fuller lobe. Morph targets appended after the existing four
(`MORPHS_EXTRA` in `rig/mesh.ts`, indices 4 and 5 of `morphTargetInfluences`, also by name in `morphTargetDictionary`): they are NOT in `MORPHS`
because `rig/index.ts` types its face state by that list and I do not own it.

What the rig driver should drive (next worker; weight 0..1, eased like the others):
- `wince` (existing): a hit landing, eyes shut tight, brow down. Drive from `hurt` / the impact event as now.
- `grimace` (new): teeth clenched, brow down and together, eyes narrowed, nose wrinkled, lips drawn back thin and wide (the strip between them opens a
  little onto the guard). Drive from effort and pain held IN: a rocked fighter on his feet (`hurt` > 0), a body shot, the late rounds at low stamina,
  a held block taking a heavy punch. Keep `mouthOpen` at 0 with it.
- `slack` (new): jaw hangs about half open, upper lids half shut, brow and cheeks let go. Drive from a stunned or dazed fighter (`hurt` at its
  highest, the knockdown count, the get-up), blended in over `grimace` as the fighter goes from taking it to not knowing where he is.
- `mouthOpen` (existing): a breath, a shout; `swellL/R` (existing): accumulated damage.
Verified in `scripts/output/mv/red_face_*_front.png` (bare mesh, morph at 1): the brow, eyes and mouth do what is described; the grimace's brow was first
too strong and smeared the painted brow into the hairline, now 0.05 head radii.

## 7. Evidence and numbers

Setup note: the shared dev server (5195) hot-reloaded mid-capture whenever another workstream saved a file (and a reload leaves the page's
module instances out of step with a dynamic import of the roster), so the final captures, film, gpu_check, pose_grid and clip_check were run on
a static snapshot server (port 5196: HEAD's sim and `rig/index.ts` plus this workstream's files). `heights_test` fails on the live tree
(18/24) because of the other workstream's uncommitted sim edits and is 24/24 on the snapshot (HEAD sim + these files): nothing here touches a hit shape.

- **Clipping** (exposed must-cover skin vertices, `docs/anim/CLIPPING.md` against `docs/anim/p1_2/clipping_before.md`): worst fighter x pose
  69 (red, short, knee falling) → 19 (raffle, belt, slip right: the belly folds over the band). Before, 13 of 132 cells were above 40 and every
  build showed 20 to 60 in a step or the knockdown; after, no cell is above 19 and 127 of 132 are 5 or fewer. The residue is the rim of the cover
  and heavy-belly fold-over (raffle slips, prone, seated: 9 to 19), and the skirt cut at the knee (6).
- **Triangles** (body mesh, real GPU tier): red 17,052 → 18,164, blue 17,184 → 18,296 (+6.5 %); frame total 234,349 → 239,077.
- **fps** (overlay, M1, AI fight, headed Metal): 60 / 16.65 ms before and after (vsync-capped: shows no drop, cannot resolve a small cost).
  Low tier is unchanged in structure (every new row count halves with it; the denser torso rows and 44 columns are high tier only).
- **gpu_check**: 3/3, lit frame 61.9, `scripts/output/gpu_fight.png` looked at: both fighters, the referee, trunks and definition all draw.
- **Console**: clean in every capture, film, pose grid and clip run.

### What the captures show, harshly (`docs/anim/p1_2/after`, `film`)

- Better: abs, obliques, pecs and the serratus read from the play camera; the neck is a neck; trunks are a clean shell on all six cuts with no thigh
  through the side; the hip no longer shears; shoulders and deltoids move with the arm in the hook film with no crease; the referee has trousers.
- Still wrong:
  - The head is still 1 / 6.2 of the height, so every body reads small and toy-like next to it. Not touched (hit sphere).
  - Red's trunks seen from behind in the play-camera film (hit_head t10 to t22) bulge at the buttock like a bag: the panel's lower rim follows the
    thigh outlines and the stance rotates the pelvis; the shape is honest but the cloth is too full there. Next: pull the panel in where it is
    wider than both the skin and the outlines (a smoother max).
  - Shoulders from the front are still broad slabs: the deltoid is a cap, not three heads; a trapezius ridge would help.
  - Faces: more relief and better light, but still soft and painted; the nose wings and jawline read in a close portrait and are lost at 0.85 m.
  - Referee: the shirt is a tube with a belly bump; no tuck, no belt line below it, sleeves are painted on skin arms.
  - The raffle belly folds over his belt in slips and when down (9 to 19 exposed vertices).
  - Not verified in the real driver: a deep knee bend and a 45° torso twist (bare mesh only), `grimace` and `slack` (no driver yet).
- Not done: a T or A pose through the override hooks (not reachable; the arms-hung portrait stands in); skin removal under the trunks (kept on
  purpose); a helper-bone volume loss measure at 90 to 140° elbow flexion beyond looking (none seen).

## 8. Pass 2: silhouette (shape only; no BodyDims, headsTall or sim number touched)

Evidence `docs/anim/p1_2/after2` (guard / hang x four views for red, boiler, referee; bare red poses), `docs/anim/CLIPPING.md` re-run. Levers are profile tables and config keys:
`rigDeltoid` 1.17 to 1.3, `rigNeckBase` 0.15 to 0.2, new `rigLatFlare`, `rigGluteDepth`, `rigFaceForm`. Arm contact radii (`rigUpperArmR`, `rigForearmR`) untouched.
1. Shoulders: the yoke tip is rounded (squareness 2.15) and the trapezius is a straight slope (about 18 degrees; heavier traps bulge) into the neck; the deltoid is a SLOPED dome centred outside the joint axis (a lens-shaped cap read as an epaulette). Partly: from the front a faint horizontal crease remains where chest meets trapezius (curvature AO, lightened by a vertex tint).
2. Arms: insertion notch, belly at 50 percent, bony elbow, brachioradialis swell below it, forearm tapering to 56 percent at the wrist. Got.
3. Torso: pectoral shelf (steep lower edge), lat flare at the sides, lumbar curve (back goes in at the waist), glute depth. Partly: the V is mostly hidden by the arms.
4. Legs: quads thickest in the upper third and wider outside, a narrower blocky knee, calf belly at 28 percent of the shin, thin ankle. Radii not raised (the calf is already 46 cm round against 38 real). Got.
5. Trunks at the buttock: cloth sag fades out round the back, glute depth in the torso. Partly.
6. Referee: standing collar, shirt blousing over the belt, short cloth sleeves with cuffs, smaller deltoid. Got; the placket is painted only.
7. Face: `rigFaceForm` 1.35 scales brow shelf, sockets, cheekbones, jaw and chin; jaw and chin squarer; nose bridge projects more in profile. Partly: reads in portrait, still soft at play distance; ears still petals.
Regression to watch: arms raised overhead with no clavicle motion leaves the deltoid crown on the chest (bare mesh only; the driver's clavicle should cover it). Clip worst cell is boiler, arms overhead, 30 exposed (was 19 at raffle slip right).
