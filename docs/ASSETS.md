# Downloaded assets and licences

The "no external assets" rule is lifted for the fighters only (body mesh, textures, animation data).
Everything else (ring, arena, audio, UI) stays generated in code. Nothing with a non-commercial,
unclear or share-alike licence may be used. Every download is listed here.

## Fighter body (anim/human branch)

| What | Source | Version | Licence |
|---|---|---|---|
| MPFB add-on (Blender extension; generates the body, rig, weights) | https://extensions.blender.org/add-ons/mpfb/ (zip: https://extensions.blender.org/download/sha256:c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad/add-on-mpfb-v2.0.18.zip) | 2.0.18 (build 20261010) | Add-on code GPL-3.0-or-later (a build tool only, not shipped). The meshes, targets, rigs and weights it generates are CC0 (MPFB/MakeHuman policy). |
| MakeHuman system assets pack (skin textures, eyes, eyebrows, eyelashes, hair) | https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip (page: https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html) | unversioned (CC0 edition, fetched 2026-11-16) | CC0. The asset files carry "explicitly released as CC0 in september 2020" headers. |

Used from the pack: skins `young_caucasian_male` and `young_african_male` (diffuse only), eyes `high-poly` with
`brown` iris, `eyebrow001`, `eyelashes01` (the pack's hair `short02` is no longer used). The gloves, trunks and boots are
modelled from scratch in `tools/blender/build_boxer.py` (our own geometry, fitted to the measured body surface,
weights transferred from the body). The six-pack / pec relief, scalp stubble paint and the skin normal map are
procedural (numpy, in the same script); the hair is a 1.6 mm cap over a painted scalp. No new downloads.

The zips are NOT committed. The extension and the pack stay in Blender's user folders.

## Rebuild (one command)

    npm run asset:boxer                      # -> boxer.glb + skin_dark.webp, skin_normal.webp, ...
    node tools/blender/build.mjs boxer_v2    # -> boxer_v2.glb + every texture with the _v2 suffix

The optional name lets a new look be built next to the one the game is using; the still page loads it with
`human.html?v=2`. Writes `public/fighter/<name>.glb` (meshes + skeleton, no animation) and, next to it, all textures
with the suffix. Prerequisites, once per machine:

1. Blender 5.3 at `/Applications/Blender.app` (or set `BLENDER`).
2. `Blender --background --command extension install-file -r user_default --enable <add-on-mpfb-v2.0.18.zip>`
3. Unzip the system assets pack and copy its folders (skins, eyes, eyebrows, eyelashes, hair, ...) into
   `~/Library/Application Support/Blender/5.3/extensions/.user/user_default/mpfb/data/`.

Do not run Blender with `--factory-startup`: it drops the extension repository and MPFB will not load.

## The asset

- Rig: MPFB `mixamo` rig, 52 bones, Mixamo names (`mixamorig:Hips`, `Spine`, `Spine1`, `Spine2`, `Neck`, `Head`,
  `LeftShoulder`, `LeftArm`, `LeftForeArm`, `LeftHand`, `LeftHandThumb1-3`, `LeftHandIndex1-3`, `...Middle1-3`, `...Ring1-3`,
  `...Pinky1-3`, `LeftUpLeg`, `LeftLeg`, `LeftFoot`, `LeftToeBase`, and the Right* mirrors). No eye or toe-end bones.
  three.js's GLTFLoader strips the colon, so in code they are `mixamorigHips` etc.
- Rest pose is MakeHuman's (arms down and a little forward), not Mixamo's T-pose: Mixamo clips will need a retarget
  (world-space, by bone direction) rather than direct local-rotation playback.
- Materials (renamed so colour can be set at runtime): `skin`, `glove`, `trunks`, `trim`, `boot`, `hair`, plus `eye`, `brow`, `lash`.
- About 1.76 m tall, 7.4 heads, about 31k triangles (body 16.2k, boots 6.4k, gloves 3.7k, eyes 2k, trunks 1.8k, cap 0.4k),
  1.3 MB glb, textures WebP (skin 2048 px). Also written: `skin_dark.webp` (dark tone, lifted from the pack's very dark
  diffuse and scalp-painted) and `skin_normal.webp` (shared normal map: pores, six-pack, pec border, stubble).
- Runtime: `src/human/body.ts` (`loadBoxer()` then `spawn(tone, kit)`) builds the skin material (normal map, clearcoat
  sheen); the shaft/foot of the boots and the kit meshes are weighted deterministically in the build script.

### Look 2 (art pass, `boxer_v2`)

All generated in `build_boxer.py`, no new downloads:
- Gloves: lace-up shape from an analytic lathe (cuff tapering to the wrist, padded knuckle volume, flat-ish
  knuckle face), a separate thumb capsule sunk into the side, a label patch across the back of the wrist (invented
  mark "IRONJAW", 5x7 block letters rasterised in numpy), criss-cross laces on the palm side of the cuff.
- Trunks: 8.4 cm ribbed elastic waistband (geometry ribs), pipe / diaper / half-lock folds displaced into the mesh,
  side and hem piping (`trim`), centre-front label patch.
- Boots: laces up the shaft and instep, sock cuff, heel accent panel (`trim`), seams in the normal map.
- Face: MPFB targets for a heavier brow, deep-set narrowed eyes, mouth corners down; a little crown volume.
- Skin: colour zones (blotches, redder knees / elbows / wrists / nose / cheeks / ears, dark eye sockets) over the
  pack diffuse; deltoid and serratus relief in the normal map.
- Textures (WebP, kit 1024 px): `glove_c/n/r`, `boot_c/n/r` (albedo grey multiplier, normal, roughness),
  `trunks_c/n`, `skin_rough` (R = sweat / clearcoat mask, G = roughness), `label` (embedded in the glb).
  The glb's `asset.extras` = `{look: 2, suffix}` tells `src/human/body.ts` to load them.
- New materials: `label`, `lace`, `sock` (and `guard`, reserved; no mouthguard mesh yet).
- Body proportions (2026-11-17): middleweight, not a wedge. Shoulder : waist girth 1.44 (was 2.07), bideltoid
  0.52 m (was 0.62), waist girth 0.84 m (was 0.67). MPFB refits the rig: the arm roots sit 4.5 cm further in.
  `tools/blender/_debug.mjs` prints these numbers from any built glb.
- Face morphs on the skin mesh (sparse accessors, ~0.3 MB): `hitWince`, `jawOpen` (MPFB caucasian expression
  units), `cheekL`, `cheekR` (own displacement: the cheek and mouth corner shoved across the face). Eyes, brows and
  lashes do not morph. The still page sets one with `human.html?v=2&morph=jawOpen`.
- The glb is written to `<name>_tmp.glb` and renamed when complete, so a hot-reloading page never loads half a file.
- About 39k triangles (body 16.2k, trunks 7.0k, boots 7.0k, gloves 6.1k, eyes 2k), 4.2 MB with textures.

- Gotcha: Blender's `materials.clear()` resets every face's `material_index` to 0 and `Image.save_render` applies the
  scene view transform; the build uses slot replacement and `Image.save()` instead.

## Fighter body, Meshy generation (`boxer_m1`)

| What | Source | Version | Licence |
|---|---|---|---|
| Realistic male boxer (mesh + baked textures, no rig) | Meshy (meshy.ai), image-to-3D with texture, generated by Nate on a paid plan | 2026-11-17, `Meshy_AI_Realistic_Male_Boxer_20261117_image-to-3d-texture_fbx.zip` | Meshy paid plan, commercial use allowed (confirmed by Nate 2026-11-25) |
| Fighter bodies `boxer_m2` (the default), `boxer_m3` normal, `boxer_m4` fat, `boxer_m5` skinny | Meshy (meshy.ai), generated by Nate on his paid plan | November 2026 | Meshy paid plan, commercial use allowed (confirmed by Nate 2026-11-25) |
| Trunks `trunks_t1` to `t4` (the vintage trunks "donor model" and the other styles), gloves `glove_g1`, hair `hair_h1` (cut from the bust model) | Meshy (meshy.ai), generated by Nate on his paid plan | November 2026 | Meshy paid plan, commercial use allowed (confirmed by Nate 2026-11-25) |
| Motion clips, 93 (`public/fighter/clips/`, baked by `tools/mocap`; inventory in `docs/anim/MOCAP_INVENTORY.md`) | Mixamo (Adobe), downloaded from Nate's personal account | November 2026 | Mixamo terms, commercial use in a game allowed (confirmed by Nate 2026-11-25) |

The raw download (FBX 41 MB + 4096 PNGs) is NOT in git. It stays in Nate's Downloads; the build unpacks it into
`.cache/meshy/` (gitignored). Only the built game files are committed.

Rebuild:

    npm run asset:meshy                 # -> public/fighter/boxer_m1.glb + boxer_m1_{c,n,r,mask,skin}.webp
    npm run asset:meshy -- m2           # another name; MESHY_ZIP=/path/to/other.zip for another generation
    PROBE=1 npm run asset:meshy         # measurements + "before" renders only (scripts/output/meshy_before_*.png)

`tools/blender/build_meshy.mjs` unzips (Node, no new packages) and runs Blender headless on `build_meshy.py`
(about 25 s). What it does:
- Scales to 1.80 m, feet on z=0, facing -Y in Blender (exports facing +Z, like `boxer_v2`).
- Decimates 425,808 -> 45,000 triangles (collapse, X-symmetric, protected around the shoulders, elbows, hips,
  knees, neck and face). Collapse decimation smears Meshy's UV atlas, so the low mesh gets fresh UVs (smart project
  + pack) and every texture is **re-baked** from the original with Cycles (selected to active): base colour 2048,
  tangent-space normal 2048 (the original normal map plus the geometry lost to decimation), roughness + metalness 1024.
- Skeleton: the same 52 Mixamo-named bones and parenting as `boxer_v2`, built for this body's T-pose. Joints come
  from cross sections of the mesh: armpit where the arm's underside leaves the torso, glove cuff and wrist where the
  arm's depth jumps, elbow at 54 % shoulder-to-wrist, neck base where the torso slice narrows, knee at the leg's
  narrowest depth, ankle / hips / hip joints from stature proportions (hidden in boots and trunks). Fingers sit inside
  the glove (index at the front so the palm line matches the clips).
- Weights: Blender bone heat, then rules: gloves rigid to the Hand (short blend into the ForeArm at the cuff), head
  rigid above the jaw line with a neck blend, boots on Foot / ToeBase with the shaft blending into the Leg, the
  shorts' legs follow the thighs and hand over to the pelvis towards the hip joints, the whole trunk region
  Laplacian-smoothed, max 4 influences.
- Masks (UV space, 1024): `_mask` R trunks, G gloves, B boots; `_skin` R skin, G hair. Texels are classified by colour
  inside mesh regions (trunks = near-white in the hip band, gloves = everything past the cuff, boots = dark below the
  boot top, hair = dark on the head), cleaned and feathered.
- `asset.extras = {look: 3, kind: "meshy", stem}` tells `src/human/body.ts` to take the single-material path:
  `spawn(tone, kit)` recolours a canvas copy of the base colour (trunks / gloves to the kit colour, scaled by
  luminance; skin scaled towards the dark tone) once per tone + kit. Boots stay black. `kit.trim`, `boot`, `hair`
  are ignored for this body.
- Still page: `human.html?v=m1` (posed from the clips; `&role=jab&f=contact`), capture `V=m1 node scripts/human_check.mjs`.
