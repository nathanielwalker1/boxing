/**
 * rig/ik.ts — analytic two-bone IK (shoulder→elbow→glove, hip→knee→ankle).
 *
 * The end effector is the sim's position and is never moved: when the target
 * is beyond reach the second bone may stretch up to `stretchMax`, and past that
 * the chain simply falls short (the glove sphere still sits exactly where the
 * sim says — what you see hit is what hit). The bend plane is chosen by a pole
 * vector; the caller decides the pole so elbows go out/down and knees forward.
 */
import { Vector3 } from 'three';

export interface TwoBone { mid: Vector3; end: Vector3; stretch: number }

const _dir = new Vector3();
const _perp = new Vector3();
const _tmp = new Vector3();

export function solveTwoBone(root: Vector3, target: Vector3, l1: number, l2: number, pole: Vector3, stretchMax: number, out: TwoBone): TwoBone {
  _dir.subVectors(target, root);
  let d = _dir.length();
  if (d < 1e-6) { _dir.set(0, -1, 0); d = 1e-6; } else _dir.divideScalar(d);

  let len2 = l2;
  let stretch = 1;
  if (d > l1 + l2) {
    len2 = Math.min(d - l1, l2 * stretchMax);
    stretch = len2 / l2;
  }
  const dEff = Math.min(d, l1 + len2);
  const a = (l1 * l1 - len2 * len2 + dEff * dEff) / (2 * dEff);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));

  _perp.copy(pole).addScaledVector(_dir, -pole.dot(_dir));
  if (_perp.lengthSq() < 1e-8) {
    _tmp.set(0, 1, 0);
    if (Math.abs(_dir.y) > 0.9) _tmp.set(1, 0, 0);
    _perp.crossVectors(_dir, _tmp).cross(_dir);
  }
  _perp.normalize();

  out.mid.copy(root).addScaledVector(_dir, a).addScaledVector(_perp, h);
  out.end.copy(root).addScaledVector(_dir, dEff);
  out.stretch = stretch;
  return out;
}
