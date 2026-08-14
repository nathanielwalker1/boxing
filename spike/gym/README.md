# spike/gym — does a real third dimension make punches better?

A throwaway Three.js gym on its own branch. It does not touch `src/`. The only
edits outside this folder are `three` in `package.json` dependencies and the
`gym` script.

    npm run gym          # http://localhost:5174   (the main game keeps 5173)

## The question

`src/reaction.js` says the rig is a side view with one horizontal axis where +x
means *toward the opponent*. `src/rig.js` draws a front view. The rear glove,
correctly placed at −x by the maths, renders on top of the fighter's own face.
That is not a bug in either file — it is two halves of the system disagreeing
about whether a depth axis exists.

This spike gives the rig a real one and asks whether it is worth the port.

## Controls

| | |
|---|---|
| `WASD` | move (so a punch can be walked in — glove speed drives impulse) |
| `J` `K` `H` | jab, cross, hook |
| `Q` `E` | slip toward the lead / rear side (hold) |
| `1` `2` `3` `4` | camera SIDE / THREE_Q / OVER / FREE |
| drag | orbit (any preset; the sliders follow the camera) |
| `space` | pause · `,` `.` step one frame · `R` reset |
| `T` `Y` | glove trail · skeleton overlay |

The lil-gui panel is generated from `config.js`, so every timing, offset, angle
and easing choice in the whole gym is a live control. Nothing is hardcoded at a
call site.

## Files

| | |
|---|---|
| `config.js` | the entire tunable surface: proportions, stance, three punches, slip, dummy springs, camera presets |
| `fighter.js` | the Object3D hierarchy + pose application + ground clamp |
| `anim.js` | per-channel kinetic-chain evaluator and the slip driver |
| `dummy.js` | three spring-dampers down the chain + glove contact |
| `camera.js` | orbit, presets, live az/el/dist readback |
| `debug.js` | glove trail, skeleton overlay |
| `gui.js` | walks `config.js` into lil-gui |
| `gym_test.mjs` | the assertions (see below) |
| `pose_sheet.mjs` | contact sheet, same spirit as `scripts/pose_grid.mjs` |

    node spike/gym/gym_test.mjs
    node spike/gym/pose_sheet.mjs jab,cross,hook 9 TOP,SIDE

Captures land in `scripts/output/gym/` (already gitignored).

## What the test asserts

Everything reads `getWorldPosition()` / `getWorldQuaternion()` directly.

- **(a)** at rest the rear glove is behind the head on the depth axis, on the
  rear-side cheek, and further from the camera than the head under both SIDE and
  THREE_Q — i.e. it renders *behind* the face, not over it
- **(b)** through 61 phases of a hook the forearm axis never enters either torso
  box
- **(c)** at rest, at the hook's peak and mid-slip, turning the fighter 180°
  leaves joint geometry bit-identical and is a rigid rotation of every world
  position and orientation — there is no facing-only term to get mirrored wrong
- **(d)** impulse == measured glove world speed × scale × bias, and the dummy
  actually moves
- **(e)** a slip keeps both feet at 0.0 mm and displaces the head 0.32 m — the
  head bone *is* the hurtbox, so seen displacement == real displacement

## Deliberately absent

No HUD/arena/crowd/ropes/audio/hit-stop/shake/particles/stamina/health/career,
no mobile input, no physics library, no external assets, no uppercut, no port of
any existing system. Materials are flat-shaded primitives with one directional
light and ambient, because the thing being judged is motion.

## Known rough edges

- Legs hang off the **root**, not the pelvis (so hip drive and spine bend cannot
  move the feet). The cost is that a knee bend lifts the foot instead of lowering
  the hip; a ground clamp puts it back. Real knee bend during a slip needs foot
  IK, which is not here — hence the slip has no leg channels.
- Torso is two boxes at different yaws, so a corner pokes out at the waist.
- `OVER` is the least resolved preset; it was tuned by eye in two passes.
