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
`brown` iris, `eyebrow001`, `eyelashes01`, hair `short02`. The gloves, trunks and boots are modelled in
`tools/blender/build_boxer.py` (our own geometry, derived from the generated body surface).

The zips are NOT committed. The extension and the pack stay in Blender's user folders.

## Rebuild (one command)

    npm run asset:boxer

Writes `public/fighter/boxer.glb` (meshes + skeleton, no animation) and `public/fighter/skin_dark.webp`
(second skin tone, same UVs, swapped in at runtime). Prerequisites, once per machine:

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
- About 1.76 m tall, 7.4 heads, about 32k triangles, 1.4 MB, textures WebP (skin 2048 px).
