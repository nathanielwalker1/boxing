/**
 * render/post.ts — optional post pass (CONTRACT §7): light bloom + vignette
 * through three's EffectComposer. Built lazily the first time `postEnabled`
 * is on, so the default (off) path costs nothing.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Config } from '../core';

const VignetteShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null }, strength: { value: 0.4 } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float strength; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float d = length((vUv - 0.5) * vec2(1.0, 0.8)) * 2.0;
      c.rgb *= 1.0 - strength * smoothstep(0.55, 1.35, d);
      gl_FragColor = c;
    }`,
};

export class PostPass {
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private vignette: ShaderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, w: number, h: number) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.35, 0.4, 0.8);
    this.composer.addPass(this.bloom);
    this.vignette = new ShaderPass(VignetteShader);
    this.composer.addPass(this.vignette);
    this.composer.addPass(new OutputPass());
    this.setSize(w, h);
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  render(cfg: Config): void {
    this.bloom.strength = cfg.bloomStrength;
    this.bloom.radius = cfg.bloomRadius;
    this.bloom.threshold = cfg.bloomThreshold;
    (this.vignette.uniforms['strength'] as THREE.IUniform<number>).value = cfg.vignetteStrength;
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
  }
}
