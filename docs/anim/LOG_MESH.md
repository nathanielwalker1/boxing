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
