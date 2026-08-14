/**
 * camera.js — the viewing angle is a question, not a decision.
 *
 * The single thing 3D buys that 2D cannot is that "where should the camera be
 * for boxing to read" becomes something you answer by looking rather than by
 * re-authoring every pose. So nothing here picks an angle: four presets, live
 * az/el/dist/fov/target sliders, and free orbit, all interchangeable at any
 * instant including mid-punch while the scrubber holds a frame.
 *
 * az 0   camera in front of the player, looking back down the depth axis
 * az 90  camera on the player's lead flank (the closest thing to the 2D game)
 * az 180 camera behind the player
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const D2R = Math.PI / 180;

export class GymCamera {
  constructor(cfg, renderer, aspect) {
    this.cfg = cfg;
    this.cam = new THREE.PerspectiveCamera(cfg.fov, aspect, 0.05, 100);
    this.controls = new OrbitControls(this.cam, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.target = new THREE.Vector3();
    this.dirty = true;              // a slider or preset moved: rewrite the camera
    this.controls.addEventListener('start', () => { this.dirty = false; });
    this.applyPreset(cfg.preset);
  }

  applyPreset(name) {
    const p = this.cfg.presets[name];
    if (!p) return;
    this.cfg.preset = name;
    for (const k of ['az', 'el', 'dist', 'fov', 'targetY', 'targetMix']) this.cfg[k] = p[k];
    this.dirty = true;
  }

  /** Store the current slider values back into the active preset. */
  savePreset() {
    const p = this.cfg.presets[this.cfg.preset];
    if (!p) return;
    for (const k of ['az', 'el', 'dist', 'fov', 'targetY', 'targetMix']) p[k] = this.cfg[k];
  }

  /**
   * @param playerPos world position of the player root
   * @param dummyPos  world position of the dummy root
   */
  update(playerPos, dummyPos) {
    const c = this.cfg;
    const prev = this.target.clone();
    this.target.lerpVectors(playerPos, dummyPos, c.targetMix);
    this.target.y = c.targetY;

    if (this.dirty) {
      const el = c.el * D2R, az = c.az * D2R;
      this.cam.position.set(
        this.target.x + c.dist * Math.sin(az) * Math.cos(el),
        this.target.y + c.dist * Math.sin(el),
        this.target.z + c.dist * Math.cos(az) * Math.cos(el),
      );
      this.dirty = false;
    } else {
      // Free orbit owns the camera; carry it along as the subject moves so the
      // user's chosen angle survives locomotion, then read the angle back out so
      // the sliders always show where they actually are.
      this.cam.position.add(this.target.clone().sub(prev));
      const d = this.cam.position.clone().sub(this.target);
      c.dist = d.length();
      c.el = Math.asin(THREE.MathUtils.clamp(d.y / (c.dist || 1), -1, 1)) / D2R;
      c.az = Math.atan2(d.x, d.z) / D2R;
    }

    if (this.cam.fov !== c.fov) { this.cam.fov = c.fov; this.cam.updateProjectionMatrix(); }
    this.controls.target.copy(this.target);
    this.controls.enabled = true;
    this.controls.update();
  }

  resize(aspect) { this.cam.aspect = aspect; this.cam.updateProjectionMatrix(); }
}
