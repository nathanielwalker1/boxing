# Port notes — v1 (legacy/) → v2

Running log of every place the port deviates from `legacy/src/config.js` and why.
CONTRACT §0: "if a key doesn't make sense in 3D, record why here."

## Units

v1 is pixels and milliseconds; v2 is metres and seconds (CONTRACT §3).

| v1 | v2 | rule |
| --- | --- | --- |
| `ringWidth` 500 px | `RING_SIZE` 6.1 m | **1 px = 0.0122 m** (6.1 / 500). Every ported length uses this. |
| `ringHeight` 300 px | (none) | v1's shallow walkable band was a 2D-camera workaround. The ring is square; the broadcast camera handles framing. |
| ms | s | ÷ 1000 |
| px/s, px/s² | m/s, m/s² | × 0.0122 |
| px-based forces on a px-mass rig | N·s impulses on `massKg` | re-derive from feel, not from the number |

## Structural constants that are no longer sliders

- `ringWidth`/`ringHeight` → `RING_SIZE` (fixed 6.1 m). A slider on ring size would break every range assertion.
- `SIM_DT` 1/60 — v1 ran on Phaser's frame delta; v2 is fixed-step (CONTRACT §3).

## Dropped keys (2D-only)

- All `arena*`/`mat*` alpha/glow/vignette layers (Stage 12 "baked dressing") — replaced by real lighting.
- `RIG_MARGIN_TOP/BOTTOM` — the boundary is a floor inset (`ringInset`) applied to a point, not a sprite rectangle.
- Facing-mirror keys (`scaleX` flips) — facing is a yaw (CONTRACT 2026-09-02); nothing mirrors.

## Renamed keys

See the `legacy:` field on each entry in `src/core/config.ts`; `config_test.mjs` does not enforce
coverage yet — SIM adds a coverage check when it ports the movement/punch groups in Stage 1.

## Hook and uppercut (Stage 2, 2026-09-09)

Timing and magnitudes are 1:1 ports; the shapes are re-authored.

| v1 | v2 | rule |
| --- | --- | --- |
| `hookCockMs/ExtendMs/RecoverMs` 160/60/113 | `hookCock/Extend/Recover` 0.16/0.06/0.113 s | ÷ 1000 |
| `uppercutCockMs/ExtendMs/RecoverMs` 170/62/118 | `uppercutCock/Extend/Recover` 0.17/0.062/0.118 s | ÷ 1000 |
| `hookDamage` 1.45, `uppercutDamage` 1.55 | `hookImpulseMult`, `uppercutImpulseMult` | dimensionless, unchanged |
| `hookReact*`, `uppercutReact*` (5 each) | same names | dimensionless shape, unchanged except `uppercutReactLift` 0.58 → 0.35 and `uppercutReactTorso` 0.75 → 0.40 (see neck clamp) |
| `PUNCHES.hook.turn` 0.70, `.uppercut.turn` 0.70 | same | radians about y (the cross's 1.00 was already 1 rad) |
| `PUNCHES.hook/uppercut .cock/.peak` joint angles | `hookPath()` / `uppercutPath()` in `src/sim/punches.ts` | **re-authored in 3D**, see below |
| `PUNCHES.uppercut.dip` 6 px | (not ported) | see below |
| `hookAimPointY`, `uppercutAimPointY`, `maxAimAngle`, `aimMinRun` | (not yet) | the aim cone is a later slice |

**Shapes.** v1's rig was a side view: its hook was two joint angles that put the fist at
head height with the elbow raised, and the "lateral sweep" was implied. In 3D the fist
has to actually travel around, so each swinging punch has a wind-up pose, a control
point and a peak in the fighter's local (forward, up, lateral) frame, and the extend
phase is a quadratic curve through them. What is kept from v1: where the wind-up goes
(hook coils out across the body, uppercut drops to the hip), the reach ordering from
`reach_test` (cross ≥ jab > hook > uppercut), and the hold at the peak.

**Reach is measured from the fighter's centre**, not the shoulder, because that is how
the sim's glove targets work. The torso twist carries the punching shoulder forward
(~0.15 m at 0.7 rad), which the rig's IK sees, so a hook peak 0.66 m out draws as an
elbow bent ~115°, not a straight arm. Landing distances centre-to-centre: straights to
~0.95 m, hook to ~0.9 m, uppercut to ~0.78 m.

**Impulse direction.** v1 pushed every punch straight back and let `hookReactTwist`
carry the hook. In 3D the head can move sideways, so each punch has a `swing` weight:
the impulse direction is the attacker→defender line blended with the fist's own travel
direction at the resolve tick (hook 0.85, everything else 0). A hook therefore staggers
the defender sideways and the head whips across. The reaction springs are unchanged.

**Contact point.** Refines the 2026-09-03 rule: the held glove rests on the struck
sphere/capsule along the line from the surface's centre to the glove's own position,
so a hook rests on the cheek it hit and an uppercut under the chin. For straights this
is the same point as before to within the glove's vertical offset.

**Neck clamp.** v1's single `reactionMaxOffset` (40 px → 0.49 m) clamped head and torso
alike; its 2D rig drew the head on the torso so a big head offset just slid it. In 3D the
head offset rides on the torso offset and the neck is drawn between them, so an uppercut
lift at the v1 clamp lifted the head a full head-height off the shoulders. The head now
has its own clamp, `reactionMaxNeck` (0.12 m); `reactionMaxOffset` clamps the torso only.
The torso offset moves the chest and not the hips (they are planted), so a torso lift
stretches the spine: at v1's `uppercutReactLift` 0.58 × `uppercutReactTorso` 0.75 the
chest rose ~20 cm. Both are lowered so the chest rises under 10 cm and the head does the
rest up to the neck clamp; the lift still reads as chin-up through the tilt.

**Not ported: the uppercut dip.** v1 dropped the whole 2D rig 6 px during the wind-up.
In v2 the head is a sim hitbox, so a body dip is a sim crouch channel (it moves
`headBox`), not a rig flourish. Deferred to the slip/duck slice, which needs the same
channel.

## Determinism

Same-engine only for now. `core/math.ts` wraps `sin`/`cos`/`atan2` so they can be replaced with
polynomial approximations when NET needs cross-machine lockstep. `Math.random` in
`legacy/src/dummy.js` (block-reaction roll, idle jitter) becomes `core/rng.ts` calls with the rng
state carried in `SimState`.
