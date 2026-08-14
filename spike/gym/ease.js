/**
 * ease.js — the easing registry.
 *
 * The 2D rig has exactly two curves (easeOut into the strike, easeInOut on the
 * recovery) shared by every joint of every punch. That is half of why it reads
 * stiff. Here every channel picks its own curve by name from this table, and the
 * name is a lil-gui dropdown, so "what if the elbow snapped harder than the hip"
 * is a question you answer by looking rather than by editing code.
 *
 * All functions map [0,1] -> roughly [0,1]. The Back/Elastic ones deliberately
 * leave that range — that is the point of them.
 */
const c1 = 1.70158;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;

export const EASE = {
  linear:        t => t,
  easeInSine:    t => 1 - Math.cos((t * Math.PI) / 2),
  easeOutSine:   t => Math.sin((t * Math.PI) / 2),
  easeInOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
  easeInQuad:    t => t * t,
  easeOutQuad:   t => 1 - (1 - t) * (1 - t),
  easeInOutQuad: t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  easeInCubic:   t => t * t * t,
  easeOutCubic:  t => 1 - Math.pow(1 - t, 3),
  easeInOutCubic:t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeInQuart:   t => t * t * t * t,
  easeOutQuart:  t => 1 - Math.pow(1 - t, 4),
  easeOutQuint:  t => 1 - Math.pow(1 - t, 5),
  easeInExpo:    t => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  easeOutExpo:   t => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  easeInBack:    t => c3 * t * t * t - c1 * t * t,
  easeOutBack:   t => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
  easeOutElastic:t => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1),
};

export const EASE_NAMES = Object.keys(EASE);

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp  = (a, b, t) => a + (b - a) * t;
