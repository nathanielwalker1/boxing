/**
 * render/tier.ts — the quality tier (overhaul 2026-11-11; CONTRACT §13: desktop
 * budgets may rise behind a tier). 1 = low (phones, small or few-core
 * devices): no post, a thinner crowd, no haze or motes, two beams, a small
 * shadow map. 2 = high (desktop). The lights on the fighters are the same in
 * both — a tier never changes how a fighter reads. `qualityTier` 0
 * picks for the device once; 1 / 2 force it (dev slider, tests, a settings
 * menu later).
 */
import type { Config } from '../core';

export type Tier = 1 | 2;

let detected: Tier | null = null;
let software = false;

function detect(c: Config): Tier {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 2;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const touch = (navigator.maxTouchPoints ?? 0) > 0 && coarse;
  const small = Math.min(screen.width, screen.height) < c.lowTierMinScreen;
  const cores = navigator.hardwareConcurrency ?? 8;
  return software || touch || small || cores <= c.lowTierMaxCores ? 1 : 2;
}

/**
 * Tell the tier what WebGL is running on (Stage calls this once, before the
 * first frame). A software rasteriser — headless Chromium's SwiftShader, which
 * is what every Playwright check runs on, or llvmpipe — is a low-tier device:
 * the high tier's post pass at 2× pixel ratio is over a second a frame on a
 * CPU. A script that wants the shipped desktop look sets `qualityTier = 2`
 * itself (scripts/arena_look.mjs) or launches Chromium on the real GPU.
 * Returns whether it is software (the post target then skips MSAA even when
 * the high tier is forced).
 */
export function noteRenderer(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  software = /swiftshader|llvmpipe|software/i.test(name);
  detected = null;
  return software;
}

/** The tier in force for this config on this device. */
export function qualityTier(c: Config): Tier {
  if (c.qualityTier === 1 || c.qualityTier === 2) return c.qualityTier;
  detected ??= detect(c);
  return detected;
}
