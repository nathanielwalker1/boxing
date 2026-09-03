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

## Determinism

Same-engine only for now. `core/math.ts` wraps `sin`/`cos`/`atan2` so they can be replaced with
polynomial approximations when NET needs cross-machine lockstep. `Math.random` in
`legacy/src/dummy.js` (block-reaction roll, idle jitter) becomes `core/rng.ts` calls with the rng
state carried in `SimState`.
