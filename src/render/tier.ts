/**
 * render/tier.ts — the quality tier (overhaul 2026-11-11; CONTRACT §13: desktop
 * budgets may rise behind a tier). 1 = low (phones, small or few-core
 * devices): no post, a thinner crowd, no haze or motes, two beams, a small
 * shadow map, no coloured back lights. 2 = high (desktop). `qualityTier` 0
 * picks for the device once; 1 / 2 force it (dev slider, tests, a settings
 * menu later).
 */
import type { Config } from '../core';

export type Tier = 1 | 2;

let detected: Tier | null = null;

function detect(c: Config): Tier {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 2;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const touch = (navigator.maxTouchPoints ?? 0) > 0 && coarse;
  const small = Math.min(screen.width, screen.height) < c.lowTierMinScreen;
  const cores = navigator.hardwareConcurrency ?? 8;
  return touch || small || cores <= c.lowTierMaxCores ? 1 : 2;
}

/**
 * True when WebGL is a software rasteriser (headless Chromium's SwiftShader,
 * llvmpipe). The tier is NOT lowered for it — the scripts must capture what
 * ships — but MSAA on the post target is skipped there: it is over half the
 * post pass's cost on a CPU rasteriser and changes nothing but edge quality.
 */
export function softwareGL(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  return /swiftshader|llvmpipe|software/i.test(name);
}

/** The tier in force for this config on this device. */
export function qualityTier(c: Config): Tier {
  if (c.qualityTier === 1 || c.qualityTier === 2) return c.qualityTier;
  detected ??= detect(c);
  return detected;
}
