# LOG — knockdown falls (`knockdownV2`)

Branch `anim/knockdown`. Spec: DESIGN.md §1 (authored pose first, physics second).

## Audit (before)
The fall was drawn by the RIG, not the sim: `src/rig/index.ts` (the "Knockdown" block, ~line 716) rewrites hips, chest,
head and gloves as point targets from a timeline on `downT` (hips under `rigFallGravity`, torso tipped about the hips,
a damped bounce, arms flopped), then fits the skeleton to them. The sim's own skeleton stayed standing the whole time.
Fall of about 0.5 s for a heavy knockdown, ending on the back, whatever dropped him (a body shot only folds him).

## Decisions
- The sim now poses the fall (`sim/skel.ts fitFall`, end of `fitSimTorso`): pelvis, spine, head, legs and arms are targets
  for the same legal fit the standing body uses, then `clampPose`. Hit shapes, gloves and `arms[]` are left alone
  (a downed man cannot be hit), so no sim rule moves; the count and get-up events are identical on and off (tested).
- Which fall is chosen at `knockDown` from the punch still on the puncher (`sim/resources.ts`): cross/jab = straight,
  hook = sideways, body shot or uppercut = folded. Stored in `moveHist` slots 70-74 (`fallInfo`).
- Clock: kdDelay 8 ticks (legs lock, pelvis rises 1.2 cm), kdFall 30 ticks (pelvis height falls as u², so it accelerates),
  kdSettle 8 (bounce under 1 cm). The trunk tips after the pelvis drops (seat first); feet stay planted until the knees fold, then slide out.
- Rig (smallest change): with `knockdownV2` on and a heavy/flash knockdown, the rig skips its own fall block and draws
  the sim's interpolated skeleton (`skSimPose`) as it is. Off = the old rig fall exactly.
- Only heavy and flash kinds; `knee` and `out` keep the rig's old falls.

## Known gap
Get-ups are not part of this slice: the sim holds the lying pose until `down` ends, then he returns to standing at once
(the rig's old get-up timeline is skipped for the heavy / flash kinds). Next slice.
