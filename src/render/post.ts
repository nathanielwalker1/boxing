/**
 * render/post.ts — the post pass (CONTRACT §7; on by default on the high tier
 * since the 2026-11-11 overhaul). Scene → MSAA half-float target → bloom (at
 * a fraction of the frame: cheaper and softer) → ONE finishing pass that does
 * everything else: a gentle filmic S-curve, a cool-shadow / warm-highlight
 * split tone, saturation, vignette, film grain, the linear→sRGB encode, and
 * chromatic aberration — which exists for a knockdown / KO only (`ko` > 0).
 *
 * No screen flashes, ever (FEEL.md): nothing here brightens the frame on an
 * event. Built lazily the first time post is wanted, so the low tier pays
 * nothing.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { Config } from '../core';

const FinishShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.3 }, uContrast: { value: 0.2 }, uSaturation: { value: 1 }, uSplit: { value: 0.03 },
    uGrain: { value: 0.02 }, uTime: { value: 0 }, uAberration: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uVignette, uContrast, uSaturation, uSplit, uGrain, uTime, uAberration;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5;
      vec3 c;
      if (uAberration > 0.0) {
        vec2 o = d * dot(d, d) * 4.0 * uAberration;     // nothing at the centre, growing to the corners
        c = vec3(texture2D(tDiffuse, vUv + o).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - o).b);
      } else {
        c = texture2D(tDiffuse, vUv).rgb;
      }
      // Soft shoulder for the bloom's overshoot, then encode to sRGB; the grade works on display values.
      c = c / (1.0 + max(c - 0.8, 0.0) * 0.6);
      c = mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
      c = clamp(c, 0.0, 1.0);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);                          // S-curve
      c += uSplit * mix(vec3(-0.35, 0.05, 0.6), vec3(0.5, 0.1, -0.5), l) * (1.0 - abs(l * 2.0 - 1.0) * 0.5);   // cool shadows, warm highlights
      c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, uSaturation);
      c *= 1.0 - uVignette * smoothstep(0.55, 1.35, length(d * vec2(1.0, 0.8)) * 2.0);
      c += (hash(gl_FragCoord.xy + fract(uTime) * 311.0) - 0.5) * uGrain * (1.0 - 0.6 * l);
      gl_FragColor = vec4(c, 1.0);
    }`,
};

export class PostPass {
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private finish: ShaderPass;
  private w = 1; private h = 1;
  private bloomScale = -1;
  /** MSAA samples the scene target was built with (a change means a rebuild). */
  readonly samples: number;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, w: number, h: number, cfg: Config, samples: number) {
    this.samples = samples;
    // Our own target: half-float for the bloom's headroom, MSAA so the ropes do not alias. Sizes here are DEVICE
    // pixels; the composer would multiply by the renderer's pixel ratio a second time (16× the pixels on a Retina
    // display — the old pass did exactly that), so its ratio is pinned to 1.
    const target = new THREE.WebGLRenderTarget(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), { type: THREE.HalfFloatType, samples: this.samples });
    this.composer = new EffectComposer(renderer, target);
    this.composer.setPixelRatio(1);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), cfg.bloomStrength, cfg.bloomRadius, cfg.bloomThreshold);
    this.composer.addPass(this.bloom);
    this.finish = new ShaderPass(FinishShader);
    this.composer.addPass(this.finish);
    this.setSize(w, h);
  }

  setSize(w: number, h: number): void {
    this.w = Math.max(1, Math.round(w)); this.h = Math.max(1, Math.round(h));
    this.composer.setSize(this.w, this.h);
    this.bloomScale = -1;   // the composer just resized the bloom chain to full; re-apply the scale next render
  }

  /** `t` seconds (grain), `ko` 0..1 the knockdown aberration envelope. */
  render(cfg: Config, t: number, ko: number): void {
    if (this.bloomScale !== cfg.postBloomScale) {
      this.bloomScale = cfg.postBloomScale;
      this.bloom.setSize(Math.max(8, Math.round(this.w * this.bloomScale)), Math.max(8, Math.round(this.h * this.bloomScale)));
    }
    this.bloom.strength = cfg.bloomStrength;
    this.bloom.radius = cfg.bloomRadius;
    this.bloom.threshold = cfg.bloomThreshold;
    const u = this.finish.uniforms as Record<string, THREE.IUniform<number>>;
    u['uVignette']!.value = cfg.vignetteStrength;
    u['uContrast']!.value = cfg.postContrast;
    u['uSaturation']!.value = cfg.postSaturation;
    u['uSplit']!.value = cfg.postSplitTone;
    u['uGrain']!.value = cfg.postGrain;
    u['uTime']!.value = t;
    u['uAberration']!.value = cfg.postKoAberration * ko;
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
  }
}
