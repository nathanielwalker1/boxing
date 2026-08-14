/**
 * dummy.js — the thing that takes the hit.
 *
 * Half of "does this punch feel good" lives in what happens to the other guy, so
 * the dummy is a full rig rather than a bag on a rope.
 *
 * The impulse magnitude comes from the GLOVE'S WORLD SPEED at the instant of
 * contact — measured from actual world-space movement between two frames — not
 * from a table keyed on punch type. That is the project's locked physics
 * philosophy, and this is the first time it can be implemented literally: in the
 * 2D rig, a glove position is a pose lookup composed with a container mirror, so
 * "how fast is the glove moving" was never a quantity that existed.
 *
 * Three spring-dampers descend the chain — pelvis, chest, head — each with its
 * OWN stiffness, not a shared one scaled down. Shared stiffness gives you a
 * chain that shrinks in amplitude while staying perfectly in phase, which reads
 * as one rigid object wobbling. Separate stiffness gives lag, and lag is what
 * makes a head snap after a body rather than with it.
 *
 * Because head is a child of neck is a child of chest, the chest's displacement
 * is inherited by the head for free. Only the DIFFERENCE is modelled here.
 */
import * as THREE from 'three';

const LEVELS = ['pelvis', 'chest', 'head'];

class Spring {
  constructor() {
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.rot = new THREE.Vector3();
    this.angVel = new THREE.Vector3();
  }
  reset() { this.pos.set(0, 0, 0); this.vel.set(0, 0, 0); this.rot.set(0, 0, 0); this.angVel.set(0, 0, 0); }
}

export class Reaction {
  constructor(cfg) {
    this.cfg = cfg;
    this.s = {};
    for (const l of LEVELS) this.s[l] = new Spring();
    this.lastImpulse = 0;
    this.lastSpeed = 0;
  }

  reset() { for (const l of LEVELS) this.s[l].reset(); this.lastImpulse = 0; this.lastSpeed = 0; }

  /**
   * @param rig            the dummy rig
   * @param contactWorld   world point where the glove touched
   * @param dirWorld       unit direction of the glove's world velocity
   * @param speed          glove world speed, m/s
   * @param bias           head/body multiplier from config
   */
  apply(rig, contactWorld, dirWorld, speed, bias) {
    const mag = speed * this.cfg.impulseScale * bias;
    this.lastImpulse = mag;
    this.lastSpeed = speed;

    // Everything is resolved in the dummy ROOT's frame so a dummy that has been
    // turned around reacts identically — the same property assertion (c) pins
    // down for the stance.
    const q = rig.root.getWorldQuaternion(new THREE.Quaternion()).invert();
    const dirL = dirWorld.clone().applyQuaternion(q);
    const contactL = rig.root.worldToLocal(contactWorld.clone());

    const jp = new THREE.Vector3();
    for (const l of LEVELS) {
      const cf = this.cfg[l];
      const s = this.s[l];
      s.vel.addScaledVector(dirL, mag * cf.lin);

      rig.joints[l].getWorldPosition(jp);
      rig.root.worldToLocal(jp);
      const r = contactL.clone().sub(jp);
      s.angVel.addScaledVector(new THREE.Vector3().crossVectors(r, dirL), mag * cf.ang);
    }
  }

  step(dt) {
    const sub = 4;
    const h = dt / sub;
    for (let i = 0; i < sub; i++) {
      for (const l of LEVELS) {
        const cf = this.cfg[l];
        const s = this.s[l];
        s.vel.addScaledVector(s.pos, -cf.k * h);
        s.vel.addScaledVector(s.vel, -cf.c * h);
        s.pos.addScaledVector(s.vel, h);
        s.angVel.addScaledVector(s.rot, -cf.k * h);
        s.angVel.addScaledVector(s.angVel, -cf.c * h);
        s.rot.addScaledVector(s.angVel, h);
      }
    }
    const ml = this.cfg.maxLin, ma = this.cfg.maxAng;
    for (const l of LEVELS) {
      const s = this.s[l];
      if (s.pos.length() > ml) s.pos.setLength(ml);
      if (s.rot.length() > ma) s.rot.setLength(ma);
    }
  }

  /** Fold the current spring state into a pose dict the rig can consume. */
  writeDict(dict) {
    for (const l of LEVELS) {
      const s = this.s[l];
      dict[`${l}.position.x`] = (dict[`${l}.position.x`] || 0) + s.pos.x;
      dict[`${l}.position.y`] = (dict[`${l}.position.y`] || 0) + s.pos.y;
      dict[`${l}.position.z`] = (dict[`${l}.position.z`] || 0) + s.pos.z;
      dict[`${l}.rotation.x`] = (dict[`${l}.rotation.x`] || 0) + s.rot.x;
      dict[`${l}.rotation.y`] = (dict[`${l}.rotation.y`] || 0) + s.rot.y;
      dict[`${l}.rotation.z`] = (dict[`${l}.rotation.z`] || 0) + s.rot.z;
    }
    return dict;
  }

  get displaced() {
    return this.s.head.pos.length() + this.s.chest.pos.length()
         + this.s.head.rot.length() + this.s.chest.rot.length();
  }
}

/**
 * Glove-vs-dummy contact. One hit per punch; the caller owns the latch.
 * Returns the level that was struck, or null.
 */
const _hp = new THREE.Vector3();
const _cp = new THREE.Vector3();
export function testContact(rig, glovePos, gloveR, cfg) {
  rig.joints.head.getWorldPosition(_hp);
  _hp.y += rig.body.headR * 0.92;
  if (glovePos.distanceTo(_hp) < cfg.headHitR + gloveR) return { level: 'head', point: _hp.clone(), bias: cfg.headBias };

  rig.joints.chest.getWorldPosition(_cp);
  _cp.y += 0.10;
  if (glovePos.distanceTo(_cp) < cfg.chestHitR + gloveR) return { level: 'chest', point: _cp.clone(), bias: cfg.bodyBias };

  return null;
}
