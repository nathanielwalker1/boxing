# LOG — Phase 1.5, hit reactions down the chain (`hitChainV2`)

Branch `anim/hit-chain`. Spec: `docs/anim/DESIGN.md` §1 (authored pose first, physics second), §2.3 (additive layers).
Nate: "I'm fighting a play-doh ragdoll, not a man."

## Where the old 0.49 m came from (measured, `scripts/hit_chain_test.mjs`, 0.8 m, vs a no-punch control run)

The legacy reaction kicks position springs on the head and torso; the skeleton fit then chases those points. On a clean
cross the head travelled 46 cm: **26 cm root** (the pelvis: knock step + legs giving), 9 cm spine, 11 cm neck. A body
shot moved the head exactly like a head shot (same springs). The chest often peaked before the head.

## Decisions

- **Joint space, additive, clamped.** Three groups — head (neck + head joints, `hitChainNeckShare` 0.6 in the neck),
  spine (lumbar / low thoracic / chest 0.25 / 0.35 / 0.4), pelvis (`hitChainPelvis` 0.15 of the spine) — each a
  damped oscillator per axis (lateral, yaw, extension) in the joints' own frames. Posted onto the fitted pose
  (`q ← q · rot`) in `sim/skel.ts fitSimTorso`, then `clampPose`, BEFORE the legs are fitted so the leg IK keeps the
  feet where they stood. Hit shapes are rewritten from that FK, so hit geometry = drawn geometry.
- **Order by period, not by cascade.** Each group has its own peak time (`hitChainHeadPeak` 2.5, `SpinePeak` 4.25,
  `PelvisPeak` 6.5 ticks) and damping ratio `hitChainZeta` 0.72 (overshoot under 5 %). A cascade delayed the chest
  but settled too slowly for the 24-tick budget.
- **Direction.** Straights: neck + spine extension by the backward part of the push. Hooks: head yaw away from the
  glove + lateral tip, shoulders roll after it. Uppercuts: chin lift + spine extension. Body shots: spine flexion,
  the head dips; a hook bends him sideways toward the hit side.
- **Size from impulse over a floor.** `size = (raw impulse − 180) / (270 − 180)`, capped at 1.6, × the grade's
  reaction scale × the neck multiplier (flush, finisher, counter). First cut was linear from 0 and every punch hit
  the cap — a jab moved the head like a cross (30 vs 32 cm). Measured impulses at 0.8 m: clean jab 195, glancing
  rear uppercut 231, clean cross 272, clean lead hook 391.
- **The legacy springs are not kicked** with the chain on (head, torso, tilt, spin); the sink still is (the legs give).
  The rig's drawn tilt / spin / torso extras therefore read zero; the rig is not edited.
- **State** in `moveHist` slots 50–67 (angle, rate): cloned and deterministic, never written with the toggle off.
  Impact pose: the kick advances one tick at once so hit-stop's frozen frames show the impact.
- `combat.ts`: one line passes `part` (head / body) to `applyReaction` (outside the block branch).

## Before / after (cm; head travel at its peak, split; peaks in live ticks after the land, hit-stop excluded)

| case | before head / root / joints | after head / root / joints | after peak head · spine · pelvis |
|---|---|---|---|
| clean jab | 24.0 / 10.8 / 13.4 | 11.2 / 7.6 / 4.1 | 2 · 4 · 6 |
| clean cross | 45.9 / 26.1 / 19.9 | 33.4 / 10.6 / 23.5 | 2 · 4 · 6 |
| lead hook (head yaw) | 55.9 / 31.6 / 24.3 (19°) | 23.0 / 15.3 / 8.6 (36°) | 2 · 4 · 6 |
| rear uppercut (glancing) | 18.2 / 11.3 / 6.9 | 10.3 / 5.4 / 5.6 | 2 · 4 · 6 |
| body cross | 44.7 / 24.9 / 19.8 (head snapped) | 8.7 / 13.0 / 13.0, spine flex −10°, neck +0.2° | 2 · 4 · 6 |
| body lead hook | 54.6 / 30.9 / 23.9 | 22.1 / 19.7 / 30.8 | 2 · 4 · 6 |

Settled to 1–3 % of peak by 24 ticks, no overshoot over 10 %. Counter cross (skeleton): head off the hips 45.7 vs
17.9 cm plain. Before, the legacy head peaked as early as tick 1 and the chest at tick 4–5, with no pelvis share.

## Film (`docs/anim/p_hitchain`, first cut, before the impulse rescale)

Cross: chin lifts and the head tips back on the neck, the upper back follows, a small lean from the waist, upright by
t24, feet planted; no broken-neck look. Lead hook: the head turns away and the shoulders follow — reads, but small from
the play camera. Body hook: he folds forward over the fist and the head dips, then straightens.

## Pinned

- `skel_test` punch-key checks run with `hitChainV2: false`: they measure the THROWER's key poses, and the struck body
  folding / turning on the land tick moved three of them (rear body hook fist-to-target on the hit tick, rear guard
  glove in the inside jab, hook elbow behind the shoulder plane).

## Left

- The near elbow dropping to cover on body shots (glove targets: gloves.ts, another workstream).
- Lead hook size from the play camera: feel-test. Re-film after the impulse rescale.
- Toggle-off identity is asserted by gating + the test (no chain slot written), not by a full-fight diff against HEAD.
