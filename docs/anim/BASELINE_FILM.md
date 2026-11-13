# Baseline film (before the animation rebuild)

Tool: `PORT=5191 node scripts/anim_film.mjs docs/anim/baseline [scenario ...] [--noside]`. Each scenario is a fresh seeded sim via `window.__rigReplay` (30 idle ticks, then the script), 640x400 viewport at 2x, play camera (camDistMin 2.4, camLookY 1.25, no drift/follow lag). Sheets are `docs/anim/baseline/<name>.png` (5 columns, tick on each frame); full-size frames are `docs/anim/baseline/frames/<name>_tNNN.png`. `<name>_side.png` is the second angle (azimuth 90, elevation 12). Ticks are sim ticks after the settle; presses happen at t=2 unless noted.

Frame rate: overlay `window.__fps` read in headless software GL at 640x400 @2x = 8 fps, 129 ms avg, 41 calls, 132,754 tris. That is NOT the desktop number; no real-GPU fps was measured. Triangle count (about 133k) is the useful figure.

Console: clean during every capture (the only filtered line is the known "GPU stall due to ReadPixels").

Caveats about the camera. Side 0 (red, the player) is the near man; the play camera sits behind his shoulder, so his punches are hidden by his own head and back, and the visible face is the dummy's (blue). A punch you throw is mostly seen as a glove arriving at the far man's guard. Jab and cross take no hand choice (jab = lead only, cross = rear only); hooks and uppercuts were filmed for both hands (stick x -1 lead, +1 rear). `hit_*_p` have the player (side 0) as the defender, seen from behind in the play view; `hit_*` have the dummy as defender. Combo timing is jab t=2, cross t=10, lead hook t=22 (the spacing the existing c_123 film uses); I did not search for the fastest press the sim accepts. The knockdown uses config `healthDamagePerImpulse: 0.006` (and a wider camera) because no hook forces a knockdown; no src was edited. Footwork frames crop the feet at the bottom of the play camera, so foot sliding cannot be judged there; use the `_side` strips for feet.

## Punches (play camera = `<name>.png`, side = `<name>_side.png`)

Names: jab_mid, cross_mid, hook_lead_mid, hook_rear_mid, upper_lead_mid, upper_rear_mid (0.84 m); the same six `_in` (0.55 m).

General findings across all twelve, then the specifics I checked frame by frame (jab_mid, cross_mid, hook_lead_mid, hook_rear_mid_side, upper_rear_mid_side, cross_in_side, upper_lead_in at full sheet size; individual frames cross_mid t14/t20, jab_mid t6/t12, hook_rear_mid_side t22).

- The guard never really opens. In every punch the non-punching glove stays glued to the chin, both elbows stay tucked, and the only change is one glove sliding forward. Nothing reads as a wind-up: the first 8 ticks after the press (t=2 to t=10) look almost identical to idle in every strip except a slight torso turn.
- Jab_mid: t=6 to t=12 the red glove travels about one glove-width and ends touching the dummy's guard; the arm never straightens, so it reads as a hand shuffle, not a jab. The glove covers the puncher's own face from the play camera (t=6, t=12).
- Cross_mid: the rear glove appears beside the dummy's head at t=14 and t=20, but the arm that carries it is only visible as a thin bare strip with a white wrap emerging beside the puncher's neck (t=14 frame, x about 495). The forearm looks long and thin compared to the upper arm, and the shoulder does not visibly drive. The torso turns about 20 degrees between t=10 and t=14 and snaps back by t=26.
- Cross_mid_side t=22-24: the arm is fully extended, but the front foot has not moved and the hips are barely rotated; the extension comes from the shoulder blade sliding, so the shoulder blob at the trapezius stretches (t=12 to t=22, the shoulder reads as a lump on the back).
- Hook_lead_mid (play camera): t=16 to t=26 the lead glove sits in front of the chin and moves maybe a glove-width sideways. A "hook" is not distinguishable from a jab here. The hook cannot be judged from this camera at all.
- Hook_rear_mid_side t=16 to t=26: the arm is nearly straight with the elbow at about 160 degrees, the glove travels forward and slightly up to the dummy's head, not around in an arc. This is a straight punch with a different glove height. t=22: the far-side shoulder is pulled forward; the feet are completely planted (no pivot on the ball of the rear foot) so the upper body twists while the legs stay still.
- Upper_rear_mid_side: t=10 to t=16 both gloves drop to waist height with the torso upright and the knees bent about 40 degrees, a clear dip (the best-read motion in the set). t=20 to t=26 the glove goes up into the dummy's guard, but the dummy's arms are in the same place the glove arrives, so the glove passes through the dummy's forearm/glove at t=22 and t=24 (the red glove overlaps a blue glove for 4 ticks). Recovery t=32 to t=40 is a soft linear return.
- Upper_lead_in (play camera): from 0.55 m the puncher's glove and the dummy's head overlap in screen space for every frame t=2 to t=40; the glove is drawn on top of the dummy's face at t=18-22 and the dummy's lead glove clips through the puncher's forearm. Dummy head tilts back about 15 degrees at t=26-30 with a visibly long neck.
- Cross_in_side: at 0.55 m the two torsos are in contact from t=2 and the bodies interpenetrate: the puncher's chest and the dummy's chest overlap at t=8 and t=10 (the red arm sits inside the dummy's torso). The shoulder at t=12-20 is an obvious blob/hump on the far side of the back.
- Pose snapping: between consecutive 2-tick frames the glove jumps about one glove-width (t=10 to t=12 cross, t=12 to t=14); the motion is a linear slide with no ease, and at the end of each punch the hand arrives back at the chin within about 4 ticks, so the recovery is as fast as the extension.

## combo_12hook (`combo_12hook.png`, `combo_12hook_side.png`; ticks 2..50 every 3)

Jab t=2, cross t=10, lead hook t=22; the dummy takes all three. This strip shows the worst body behaviour in the set (see the dummy's reaction):
- t=44 frame (`frames/combo_12hook_side_t044.png`): the dummy's head is yawed about 80 degrees from his chest (the face looks at the camera while the torso is side-on), the neck is not visible at all, and the upper spine is bent back about 40 degrees from the pelvis in one smooth curve (rubber, with no distinct vertebral hinge).
- t=44: a rectangular patch of skin shows through the right thigh of the dummy's trunks at the knee: the leg pokes through the shorts.
- t=35 to t=50: the dummy's hips swing about half a leg length backward while both feet stay near where they were, so he looks like he is sitting in the air (knees bent 90 degrees, shin vertical).
- t=47 to t=50: the puncher's torso is rotated nearly 90 degrees and his head faces away from the target (the back of his head toward the camera) while his lead glove is still raised: the head does not track the target.

## Hits (defender visible)

hit_head (dummy takes a cross; lands about t=14) and hit_head_p (player takes it): sheets `hit_head.png`, `hit_head_side.png`, `hit_head_p.png`, `hit_head_p_side.png`.
- hit_head t=16 to t=26: the dummy's head tips back about 20 degrees and holds there; both of his gloves stay exactly where they were, glued to the cheeks, so only the head moves, hinged on a long visible neck. It reads as a head on a spring: it tips, hangs for about 8 ticks, then settles back.
- There is no body reaction: the shoulders, trunk and feet do not move at all for a clean cross to the head. No step back, no weight shift.

hit_body (dummy takes a lead hook with level held, lands about t=27) and hit_body_p (player takes it): `hit_body*.png`.
- hit_body_p_side t=28 to t=40: the player's head goes back about 30 degrees and the chin rises, as if hit in the jaw; the hit was to the body. The neck is stretched visibly (t=37: about 1.5x a normal neck length, thin). The shorts flare like a skirt at t=37 (the cloth lifts away from the thighs).
- t=37: the blue glove lands on the upper chest/ribs but the defender's rear hand floats out and away from the body, not dropping to cover the ribs; the arm is rigid. There is no fold at the waist; the torso leans back, the opposite of what a body shot does.
- hit_body (play camera) t=37 to t=49: the dummy's torso leans back, then returns by t=52; knees stay bent the whole time at the same angle.

## counter (`counter.png`, `counter_side.png`; ticks 0..46 every 2)
The dummy jabs at t=0, the player slips (flick x -1 at t=0) and crosses at t=12.
- t=6 to t=10: the slip is a lateral head offset of about half a head width with no torso lean; the dummy's lead glove goes past the player's head and the player has already returned to guard by t=16, a very short offset.
- t=22 to t=28: the cross lands (sweat particles at t=28). The dummy then goes through the strongest reaction in the set: t=30 to t=46 his head is thrown back about 45 degrees with the mouth open (a face expression), the neck stretches to about 1.7x, and his torso lays back at an angle. The reaction is bigger than the cross-to-head in `hit_head` because it is a counter, but the arms still stay raised in a frozen guard (t=34 to t=46) while the body falls away.
- Feet slide: at t=42-46 the dummy's feet drag backward along the canvas without stepping (both feet stay flat, ankles do not lift).

## block (`block.png`, `block_side.png`; ticks 8..50 every 2)
The player holds block from t=0; the dummy crosses at t=12.
- The player's pose barely changes at all between t=8 and t=50: arms up, elbows in. The cross lands somewhere around t=24 (the dummy's red/blue gloves overlap the blocking glove at t=22 to t=26) but I could not see any reaction in the blocker: no shift of the torso, no step, no push back. This is a negative result: the blocker takes the punch with a motionless body.
- The dummy's punching arm is hidden behind his own guard hand in the play camera.

## footwork_lateral (`footwork_lateral.png`; side-on `footwork_lateral_side.png`; stick x held t=2 to t=62)
- The camera orbits as the player circles, so the background changes completely (corner post, tunnel) but the fighters' poses are nearly constant: the player's upper body is frozen in a fixed guard over every frame from t=0 to t=84 while he travels about half a ring.
- Feet are cropped in the play camera; in the side strip legs look like they slide without a clear stepping cycle (the front foot moves in a smooth glide). I could not count steps from 6-tick sampling. The dummy rotates in place to face the player, the whole body turning rigidly as one block (frames t=18 to t=48).

## footwork_in_out (`footwork_in_out.png`, `footwork_in_out_side.png`; ticks 0..80 every 5)
Step in t=2..24, pause, step back t=30..52.
- t=35 onward in the side view: the player ends up chest to chest with the dummy and the torsos overlap (red chest inside blue torso from t=45 to t=80, the two bodies interpenetrate around the shoulder). The "step back" (t=30 to t=52) does not restore any distance, so the strip shows the fighters pressed together for 35 ticks (the dummy gets pushed, not shown walking). Net: this scenario films the overlap/pushing problem rather than a clean in-out.
- t=0 to t=25: the player's rear leg is straight with the heel off the ground and the front knee deeply bent, a static pose carried across steps; no stride cycle visible at this sampling.

## knockdown (`knockdown.png`; `knockdown_side.png` if present; ticks 12..204 every 8)
One cross with `healthDamagePerImpulse: 0.006`, wide camera.
- t=20 to t=36: the dummy leans back and his knees fold with the torso still upright; t=44 (frame `frames/knockdown_t044.png`): he is sitting in mid-air, hips at about knee height and no contact with the canvas, legs held out stiff, arms out like a mannequin, head forward. No hand reaches for the floor.
- t=52 to t=108: he lies prone/side-on with the legs apart, one glove stuck out away from the body at an unnatural 90 degree angle, completely still for about 56 ticks (nothing moves between t=52 and t=100 except a slight raising of the head). Then t=108 to t=124 he pushes up on one arm with the elbow out, the glove planted behind (frame t116: the trunks have ridden up and the head is turned away from the camera, face on the floor).
- t=132 to t=204: the get-up is a smooth uniform rise from hands and knees to standing at constant speed, the torso stays horizontal until the legs are straight, then pivots up in about 16 ticks. At t=172-180 he rises facing sideways and the head is turned the wrong way (looking down and away) with his gloves hanging at his sides; he rejoins the guard at t=188 in one snap.
- Throughout, the attacker (red) stands frozen in a guard pose and does not move for 190 ticks (no step back, no hand drop, no reaction), which is a sim input choice, not animation, but it makes the film read as a statue over a fallen man.

## Five worst things (by tick)
1. combo_12hook_side t=44: dummy's head yawed about 80 degrees from his chest, no visible neck, upper spine bent back in one rubber curve, and a skin patch through the trunks at the knee (leg through shorts).
2. hit_body_p_side t=37: a body shot whips the head back about 30 degrees on a stretched neck (about 1.5x) and the rear arm floats rigid; the reaction is a head spring, not pain at the body.
3. All punches: the guard never opens and nothing winds up (t=2 to t=10 looks like idle); hooks are straight arms at 160 degree elbow (hook_rear_mid_side t=16-26) and indistinguishable from a jab in the play camera.
4. footwork_in_out_side t=45 to t=80: torsos interpenetrate, and the player's upper body stays frozen while the feet carry him.
5. knockdown t=44: the faller sits in the air with stiff legs and mannequin arms, then lies motionless for about 56 ticks with a glove stuck out at 90 degrees.

## Not captured
- `knockdown_side.png` finished rendering after this was written and was not looked at.
- Real-GPU fps (only headless software GL, 8 fps, was available).
- I did not individually inspect every sheet at full-frame size (hit_head_p, `_in` hooks, `_in` jabs, `upper_lead_mid`, `upper_rear_in`, the side strips of jab/hook_lead/upper_lead/footwork_lateral/block/counter were opened only at sheet size or not at all); statements above are limited to the frames named.
