/**
 * debug.js — the two overlays that make animation authorable.
 *
 * TRAILS turn a punch arc into a shape you can look at instead of a motion you
 * have to catch. A hook that passes through the torso is obvious as a line and
 * nearly invisible at 60 fps.
 *
 * SKELETON draws the actual parent/child bone graph and per-joint axes. Both
 * read straight off getWorldPosition/getWorldQuaternion, which is the same data
 * gym_test.mjs asserts on — the picture and the test cannot disagree.
 */
import * as THREE from 'three';
import { JOINT_NAMES, PARENT } from './fighter.js';

export class Trail {
  constructor(scene, color, maxFrames) {
    this.max = maxFrames;
    this.buf = new Float32Array(maxFrames * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.buf, 3));
    g.setDrawRange(0, 0);
    this.line = new THREE.Line(g, new THREE.LineBasicMaterial({
      color: new THREE.Color(color), depthTest: false, transparent: true, opacity: 0.95,
    }));
    this.line.renderOrder = 10;
    this.line.frustumCulled = false;
    scene.add(this.line);
    this.n = 0;
  }

  clear() { this.n = 0; this.line.geometry.setDrawRange(0, 0); }

  push(v) {
    if (this.n >= this.max) {                       // slide the window
      this.buf.copyWithin(0, 3);
      this.n = this.max - 1;
    }
    this.buf[this.n * 3] = v.x; this.buf[this.n * 3 + 1] = v.y; this.buf[this.n * 3 + 2] = v.z;
    this.n++;
    this.line.geometry.setDrawRange(0, this.n);
    this.line.geometry.attributes.position.needsUpdate = true;
  }

  set visible(v) { this.line.visible = v; }
}

export class Skeleton {
  constructor(scene, rig, color) {
    this.rig = rig;
    const bones = Object.entries(PARENT);
    this.bones = bones;
    this.buf = new Float32Array(bones.length * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.buf, 3));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: new THREE.Color(color), depthTest: false, transparent: true, opacity: 0.9,
    }));
    this.lines.renderOrder = 11;
    this.lines.frustumCulled = false;
    scene.add(this.lines);

    this.axes = [];
    for (const n of JOINT_NAMES) {
      const a = new THREE.AxesHelper(0.055);   // scaled at update time by the slider
      a.material.depthTest = false;
      a.renderOrder = 12;
      a.frustumCulled = false;
      scene.add(a);
      this.axes.push({ name: n, helper: a });
    }
    this.group = [this.lines, ...this.axes.map(a => a.helper)];
  }

  update(axesSize) {
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    this.bones.forEach(([child, parent], i) => {
      this.rig.joints[parent].getWorldPosition(p);
      this.buf[i * 6] = p.x; this.buf[i * 6 + 1] = p.y; this.buf[i * 6 + 2] = p.z;
      this.rig.joints[child].getWorldPosition(p);
      this.buf[i * 6 + 3] = p.x; this.buf[i * 6 + 4] = p.y; this.buf[i * 6 + 5] = p.z;
    });
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.computeBoundingSphere();

    for (const a of this.axes) {
      const j = this.rig.joints[a.name];
      j.getWorldPosition(p); j.getWorldQuaternion(q);
      a.helper.position.copy(p);
      a.helper.quaternion.copy(q);
      a.helper.scale.setScalar(axesSize / 0.055);
    }
  }

  set visible(v) { for (const o of this.group) o.visible = v; }
}
