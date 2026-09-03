/**
 * Pose scrubber (Stage 18b part 1) — dev-only.
 *
 * Freezes one fighter's punch animation and renders whatever progress the
 * tuning panel asks for. Its entire reason for existing is to let an
 * INTERMEDIATE frame of a punch be held still and inspected: at 8 frames per
 * punch the deformed in-between poses were invisible, and at 20+ they are not.
 *
 * The one rule this module exists to enforce: it drives the SAME pose path the
 * renderer drives. It builds a punch state in the exact shape `_punchState()`
 * returns and hands it to `drawRig()` → `computePose()` → `punchKey()`. There is
 * no parallel evaluator here, and there must never be one — a scrubber that
 * disagrees with the game is worse than no scrubber, because it makes authoring
 * against it actively wrong.
 *
 * Both Fighter and Dummy consult this in three places:
 *   - draw time      (which pose to render, and with what facing)
 *   - reaction time  (a frozen fighter absorbs no reactions or stagger)
 *   - throw time     (a frozen fighter starts no punches of its own)
 */

import { config } from './config.js';

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Is the scrubber currently driving this fighter?
 * @param {'player'|'dummy'} who
 */
export function poseDebugActive(who) {
  return !!config.poseDebugEnabled && config.poseDebugTarget === who;
}

/** True while the scrubber is driving ANYONE — for scene-level gating. */
export function poseDebugAny() {
  return !!config.poseDebugEnabled;
}

/**
 * The punch state to render, in the exact shape Fighter/Dummy._punchState()
 * returns — so it flows through the identical code path.
 *
 * `arm` is a rig SLOT ('lead'/'rear'), which is what _punchState() has already
 * resolved the anatomical arm to by the time drawRig sees it. The scrubber
 * therefore names slots directly and skips the stance mapping, which is the
 * right call: the deformation being hunted lives in the trajectory, and stance
 * only decides which shoulder that trajectory is hung off.
 */
export function poseDebugPunchState() {
  return {
    type: config.poseDebugPunch,
    arm:  config.poseDebugArm === 'rear' ? 'rear' : 'lead',
    p:    clamp01(config.poseDebugProgress),
    aim:  config.poseDebugAim || 0,
  };
}

/** Facing to render the frozen fighter at, independent of where anyone stands. */
export function poseDebugFacingRight() {
  return config.poseDebugFacing !== 'left';
}

// Joint marker colours. Deliberately three DIFFERENT colours rather than three
// dots of one colour: the question being asked of these is "which way does the
// elbow bend", which is unanswerable if you can't tell the elbow from the wrist.
const SHOULDER_COLOR = 0xffffff;
const ELBOW_COLOR    = 0xffcc22;
const WRIST_COLOR    = 0x22ddff;

/**
 * Draw shoulder/elbow/wrist markers for both arms over a solved pose.
 *
 * Drawn into the fighter's own graphics object, so they mirror with the rig for
 * free and land exactly on the joints the solver produced — the whole point is
 * that these are the SOLVED positions, not a re-derivation.
 *
 * @param {Phaser.GameObjects.Graphics} g
 * @param {ReturnType<import('./rig.js').computePose>} pose
 */
export function drawJointMarkers(g, pose) {
  if (!pose) return;
  for (const arm of [pose.lead, pose.rear]) {
    // A thin bone line first, so a forearm that has detached from its elbow is
    // visible as a gap rather than having to be inferred from two dots.
    g.lineStyle(1, 0x000000, 0.55);
    g.beginPath();
    g.moveTo(arm.sx, arm.sy);
    g.lineTo(arm.ex, arm.ey);
    g.lineTo(arm.wx, arm.wy);
    g.strokePath();

    g.fillStyle(SHOULDER_COLOR, 0.95); g.fillCircle(arm.sx, arm.sy, 2.5);
    g.fillStyle(ELBOW_COLOR,    0.95); g.fillCircle(arm.ex, arm.ey, 2.5);
    g.fillStyle(WRIST_COLOR,    0.95); g.fillCircle(arm.wx, arm.wy, 2.5);
  }
}
