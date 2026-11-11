/**
 * ui/audio/recipes.ts — every sound in the game as data. A recipe is a list of
 * layers; a layer is a source (white noise, an oscillator, the crowd "walla"
 * loop, the applause loop) → optional filter (with a sweep) → an
 * attack / hold / decay envelope. No files: all of it is synthesized
 * (CONTRACT: no external assets).
 *
 * WHO OWNS WHICH BAND (so impacts are tellable apart mid-fight):
 *   sharp (jab / cross)      the top: a crack around 3 kHz
 *   heavy (hook / uppercut)  the bottom: a sine thud 150 → 45 Hz
 *   blocked                  the middle only: 500–1200 Hz, slow attack, no thud, no crack
 *   body                     below the heavy thud and duller: a "whump" with no crack at all, then breath
 *   crowd                    the vowel band, 300–1500 Hz, kept under the impacts' transients by slow attacks
 *
 * GRADE (SIM's `grade` on punchLand; read defensively, default clean):
 *   glancing  a slap or a tick — the punch class's band, but only its thin top, short, no body
 *   clean     the solid hit (the recipes this file has always had)
 *   flush     layered: the crack, a sub thump under it (`sub` layers, scaled by audioFlushSub), and a short tail
 */

export interface Layer {
  type: 'noise' | 'tone' | 'walla' | 'applause';
  gain?: number;
  /** Seconds: start offset, rise, time held at the peak, fall. */
  delay?: number; attack?: number; hold?: number; decay?: number;
  wave?: OscillatorType; freq?: number; freqEnd?: number;
  filter?: { type: BiquadFilterType; freq: number; freqEnd?: number; q?: number };
  /** A sub-bass layer: its gain also takes audioFlushSub. */
  sub?: boolean;
}
export interface Recipe { gain: number; layers: Layer[]; bus?: 'impact' | 'crowd' }

export const RECIPES: Record<string, Recipe> = {
  // ── Sharp: jab / cross ──
  impactSharpGlance: {
    gain: 0.5,
    layers: [
      { type: 'noise', gain: 0.8, attack: 0.001, decay: 0.022, filter: { type: 'highpass', freq: 2800, q: 0.7 } },
      { type: 'noise', gain: 0.5, attack: 0.001, decay: 0.014, filter: { type: 'bandpass', freq: 4800, q: 2.2 } },
    ],
  },
  // The 3 kHz bandpass layer is the "crack".
  impactSharp: {
    gain: 0.62,
    layers: [
      { type: 'noise', gain: 0.85, attack: 0.001, decay: 0.060, filter: { type: 'highpass', freq: 1600, q: 0.7 } },
      { type: 'noise', gain: 0.60, attack: 0.001, decay: 0.035, filter: { type: 'bandpass', freq: 3200, q: 1.5 } },
      { type: 'tone', gain: 0.35, attack: 0.001, decay: 0.070, wave: 'triangle', freq: 320, freqEnd: 140 },
    ],
  },
  impactSharpFlush: {
    gain: 0.7,
    layers: [
      { type: 'noise', gain: 1.00, attack: 0.001, decay: 0.050, filter: { type: 'bandpass', freq: 3300, q: 2.0 } },   // the crack
      { type: 'noise', gain: 0.70, attack: 0.001, decay: 0.090, filter: { type: 'highpass', freq: 1700, q: 0.7 } },
      { type: 'tone', gain: 0.50, attack: 0.001, decay: 0.090, wave: 'triangle', freq: 430, freqEnd: 150 },           // the knock
      { type: 'tone', gain: 0.90, attack: 0.003, decay: 0.260, wave: 'sine', freq: 96, freqEnd: 38, sub: true },      // the sub thump
      { type: 'noise', gain: 0.22, attack: 0.010, decay: 0.340, filter: { type: 'lowpass', freq: 900, q: 0.6 } },     // the tail
    ],
  },

  // ── Heavy: hook / uppercut ──
  impactHeavyGlance: {
    gain: 0.85,
    layers: [
      { type: 'noise', gain: 0.8, attack: 0.002, decay: 0.045, filter: { type: 'lowpass', freq: 750, q: 0.8 } },
      { type: 'tone', gain: 0.4, attack: 0.002, decay: 0.055, wave: 'sine', freq: 190, freqEnd: 115 },
    ],
  },
  // The deep sine thud carries it.
  impactHeavy: {
    gain: 0.60,
    layers: [
      { type: 'tone', gain: 1.00, attack: 0.002, decay: 0.240, wave: 'sine', freq: 150, freqEnd: 45 },
      { type: 'noise', gain: 0.55, attack: 0.001, decay: 0.140, filter: { type: 'lowpass', freq: 500, q: 0.8 } },
      { type: 'noise', gain: 0.25, attack: 0.001, decay: 0.030, filter: { type: 'bandpass', freq: 1500, q: 1.0 } },
    ],
  },
  impactHeavyFlush: {
    gain: 0.66,
    layers: [
      { type: 'tone', gain: 1.00, attack: 0.002, decay: 0.380, wave: 'sine', freq: 125, freqEnd: 32, sub: true },     // the sub thump
      { type: 'tone', gain: 0.55, attack: 0.002, decay: 0.200, wave: 'sine', freq: 170, freqEnd: 60 },
      { type: 'noise', gain: 0.65, attack: 0.001, decay: 0.200, filter: { type: 'lowpass', freq: 460, q: 0.8 } },
      { type: 'noise', gain: 0.55, attack: 0.001, decay: 0.045, filter: { type: 'bandpass', freq: 1900, q: 1.5 } },   // the crack, lower than a jab's
      { type: 'noise', gain: 0.20, attack: 0.015, decay: 0.420, filter: { type: 'bandpass', freq: 600, q: 0.6 } },    // the tail
    ],
  },

  // ── Body: lower and duller than any head shot — no crack at all ──
  impactBodyGlance: {
    gain: 1.6,
    layers: [
      { type: 'noise', gain: 0.9, attack: 0.003, decay: 0.050, filter: { type: 'lowpass', freq: 520, q: 0.7 } },
    ],
  },
  impactBody: {
    gain: 0.7,
    layers: [
      { type: 'tone', gain: 1.00, attack: 0.003, decay: 0.200, wave: 'sine', freq: 110, freqEnd: 40 },
      { type: 'noise', gain: 0.6, attack: 0.002, decay: 0.110, filter: { type: 'lowpass', freq: 380, q: 0.7 } },
    ],
  },
  impactBodyFlush: {
    gain: 0.9,
    layers: [
      { type: 'tone', gain: 1.00, attack: 0.003, decay: 0.330, wave: 'sine', freq: 96, freqEnd: 30, sub: true },
      { type: 'tone', gain: 0.45, attack: 0.002, decay: 0.090, wave: 'triangle', freq: 210, freqEnd: 90 },
      { type: 'noise', gain: 0.7, attack: 0.002, decay: 0.180, filter: { type: 'lowpass', freq: 330, q: 0.7 } },
    ],
  },
  // The air leaving him: breath noise falling in pitch, a beat after the whump.
  bodyExhale: {
    gain: 0.4,
    layers: [
      { type: 'noise', gain: 0.8, delay: 0.05, attack: 0.03, decay: 0.24, filter: { type: 'bandpass', freq: 1250, freqEnd: 650, q: 0.9 } },
      { type: 'noise', gain: 0.3, delay: 0.05, attack: 0.02, decay: 0.16, filter: { type: 'highpass', freq: 3000, q: 0.6 } },
    ],
  },
  // …and on a flush one, the grunt under the breath.
  bodyGrunt: {
    gain: 0.4,
    layers: [
      { type: 'tone', gain: 0.8, delay: 0.035, attack: 0.02, decay: 0.19, wave: 'sawtooth', freq: 150, freqEnd: 92, filter: { type: 'lowpass', freq: 620, q: 1.2 } },
    ],
  },

  // Blocked — absorbed: mids only, slower attack, no thud and no crack.
  impactBlocked: {
    gain: 1.50,
    layers: [
      { type: 'noise', gain: 0.90, attack: 0.005, decay: 0.090, filter: { type: 'bandpass', freq: 820, q: 1.3 } },
      { type: 'noise', gain: 0.20, attack: 0.006, decay: 0.045, filter: { type: 'bandpass', freq: 1150, q: 1.5 } },
      { type: 'noise', gain: 0.45, attack: 0.006, decay: 0.070, filter: { type: 'bandpass', freq: 520, q: 1.4 } },
    ],
  },
  // Counter — a sting on top of the impact.
  counter: {
    gain: 0.55,
    layers: [
      { type: 'tone', gain: 0.70, attack: 0.001, decay: 0.110, wave: 'square', freq: 180, freqEnd: 640 },
      { type: 'tone', gain: 0.45, attack: 0.001, decay: 0.190, wave: 'triangle', freq: 900, freqEnd: 1500 },
      { type: 'noise', gain: 0.30, attack: 0.001, decay: 0.050, filter: { type: 'bandpass', freq: 2400, freqEnd: 5200, q: 2.2 } },
    ],
  },
  // Whiff — a filter sweep through air.
  whiff: {
    gain: 2.60,
    layers: [
      { type: 'noise', gain: 0.55, attack: 0.030, decay: 0.160, filter: { type: 'bandpass', freq: 300, freqEnd: 2400, q: 1.4 } },
      { type: 'noise', gain: 0.28, attack: 0.020, decay: 0.120, filter: { type: 'bandpass', freq: 1800, freqEnd: 500, q: 1.2 } },
    ],
  },
  // Slipped — the whiff, close: a fist past the ear. Shorter, brighter, a
  // little louder than a miss in space (2026-09-18, the read).
  slipNear: {
    gain: 1.6,
    layers: [
      { type: 'noise', gain: 0.6, attack: 0.008, decay: 0.09, filter: { type: 'bandpass', freq: 900, freqEnd: 3800, q: 1.6 } },
      { type: 'noise', gain: 0.3, attack: 0.004, decay: 0.06, filter: { type: 'highpass', freq: 2600, q: 0.8 } },
    ],
  },
  // The window opens (2026-09-22): a short bright ping under the slip's whoosh
  // — the "you read it" cue; the counter sting answers it if the counter
  // lands. Only a slip opens a counter window (a perfect block does not).
  counterOpen: {
    gain: 0.5,
    layers: [
      { type: 'tone', gain: 0.6, attack: 0.002, decay: 0.16, wave: 'sine', freq: 1320, freqEnd: 1980 },
      { type: 'tone', gain: 0.25, attack: 0.002, decay: 0.10, wave: 'triangle', freq: 2640, freqEnd: 3300 },
    ],
  },
  // Knockdown — the heavy hit plus the canvas.
  knockdown: {
    gain: 0.9,
    layers: [
      { type: 'tone', gain: 1.00, attack: 0.003, decay: 0.45, wave: 'sine', freq: 90, freqEnd: 30 },
      { type: 'noise', gain: 0.7, attack: 0.002, decay: 0.25, filter: { type: 'lowpass', freq: 300, q: 0.7 } },
    ],
  },
  // ROCKED (2026-10-15): a deep thud under the land and a dull ring that hangs — the legs went.
  rocked: {
    gain: 0.7,
    layers: [
      { type: 'tone', gain: 0.9, attack: 0.004, decay: 0.5, wave: 'sine', freq: 70, freqEnd: 40 },
      { type: 'tone', gain: 0.25, attack: 0.03, decay: 1.4, wave: 'sine', freq: 2900, freqEnd: 2800 },
      { type: 'noise', gain: 0.4, attack: 0.002, decay: 0.2, filter: { type: 'lowpass', freq: 400, q: 0.8 } },
    ],
  },
  // The bell.
  bell: {
    gain: 0.5,
    layers: [
      { type: 'tone', gain: 0.8, attack: 0.002, decay: 1.1, wave: 'sine', freq: 1180, freqEnd: 1160 },
      { type: 'tone', gain: 0.45, attack: 0.002, decay: 0.7, wave: 'triangle', freq: 2360, freqEnd: 2300 },
      { type: 'noise', gain: 0.25, attack: 0.001, decay: 0.03, filter: { type: 'highpass', freq: 3000, q: 0.7 } },
    ],
  },

  // ── Phase 2 (2026-11-11): the new fight events ──
  // Combination: a bright rising layer on the 2nd, 3rd… clean punch of a combination; pitched up per punch by the caller.
  comboRise: {
    gain: 0.9,
    layers: [
      { type: 'tone', gain: 0.8, attack: 0.001, decay: 0.07, wave: 'triangle', freq: 620, freqEnd: 980 },
      { type: 'noise', gain: 0.5, attack: 0.001, decay: 0.04, filter: { type: 'bandpass', freq: 2500, q: 2.0 } },
    ],
  },
  // Came through or round a guard: leather on leather first — then the caller plays the thud a beat late.
  gloveTick: {
    gain: 0.7,
    layers: [
      { type: 'noise', gain: 1.0, attack: 0.001, decay: 0.020, filter: { type: 'bandpass', freq: 1500, q: 2.2 } },
      { type: 'noise', gain: 0.4, attack: 0.001, decay: 0.012, filter: { type: 'highpass', freq: 3500, q: 0.7 } },
    ],
  },
  // Slipped INTO it: on top of the flush impact, a hollow knock and a drop — the worst sound short of a counter.
  impactWrong: {
    gain: 0.75,
    layers: [
      { type: 'tone', gain: 1.0, attack: 0.002, decay: 0.34, wave: 'sine', freq: 140, freqEnd: 42, sub: true },
      { type: 'noise', gain: 0.6, attack: 0.001, decay: 0.05, filter: { type: 'bandpass', freq: 950, q: 2.5 } },
    ],
  },
  // An overhand's weight arriving just behind the contact.
  impactTail: {
    gain: 0.55,
    layers: [
      { type: 'tone', gain: 1.0, attack: 0.012, decay: 0.3, wave: 'sine', freq: 82, freqEnd: 36, sub: true },
      { type: 'noise', gain: 0.4, attack: 0.012, decay: 0.2, filter: { type: 'lowpass', freq: 300, q: 0.7 } },
    ],
  },
  // A counter is the heaviest sound in the game: under the sting, a boom.
  counterWeight: {
    gain: 0.6,
    layers: [
      { type: 'tone', gain: 1.0, attack: 0.002, decay: 0.55, wave: 'sine', freq: 105, freqEnd: 27, sub: true },
      { type: 'noise', gain: 0.5, attack: 0.002, decay: 0.3, filter: { type: 'lowpass', freq: 240, q: 0.7 } },
      { type: 'noise', gain: 0.5, attack: 0.001, decay: 0.06, filter: { type: 'bandpass', freq: 2700, q: 1.6 } },
    ],
  },
  // The liver: a sick, wet low thud — lower and longer than any body shot, with a mid "give".
  liverThud: {
    gain: 0.75,
    layers: [
      { type: 'tone', gain: 1.0, attack: 0.004, decay: 0.5, wave: 'sine', freq: 72, freqEnd: 27, sub: true },
      { type: 'tone', gain: 0.5, attack: 0.003, decay: 0.12, wave: 'triangle', freq: 270, freqEnd: 115 },
      { type: 'noise', gain: 0.5, attack: 0.004, decay: 0.16, filter: { type: 'lowpass', freq: 210, q: 0.9 } },
    ],
  },
  // The body gives (bodyHurt, the delayed buckle): a groan with the breath going out of it.
  bodyGroan: {
    gain: 0.5,
    layers: [
      { type: 'tone', gain: 0.9, attack: 0.05, hold: 0.1, decay: 0.42, wave: 'sawtooth', freq: 128, freqEnd: 78, filter: { type: 'lowpass', freq: 560, freqEnd: 330, q: 1.4 } },
      { type: 'noise', gain: 0.6, attack: 0.04, hold: 0.05, decay: 0.4, filter: { type: 'bandpass', freq: 1050, freqEnd: 560, q: 0.9 } },
    ],
  },
  // A worn guard takes a shot: the weight that gets through the gloves (layered under impactBlocked as the meter drops).
  blockHeavy: {
    gain: 0.6,
    layers: [
      { type: 'tone', gain: 1.0, attack: 0.004, decay: 0.15, wave: 'sine', freq: 125, freqEnd: 58 },
      { type: 'noise', gain: 0.5, attack: 0.004, decay: 0.09, filter: { type: 'lowpass', freq: 360, q: 0.8 } },
    ],
  },
  // The guard breaks: a crack, hands knocked apart.
  guardCrack: {
    gain: 0.55,
    layers: [
      { type: 'noise', gain: 1.0, attack: 0.001, decay: 0.045, filter: { type: 'highpass', freq: 2100, q: 0.7 } },
      { type: 'noise', gain: 0.8, attack: 0.001, decay: 0.07, filter: { type: 'bandpass', freq: 1250, q: 3.0 } },
      { type: 'tone', gain: 0.7, attack: 0.002, decay: 0.2, wave: 'sine', freq: 200, freqEnd: 66 },
    ],
  },
  // A perfect block: a crisp parry tick, high and dry.
  parryTick: {
    gain: 1.0,
    layers: [
      { type: 'noise', gain: 0.9, attack: 0.001, decay: 0.016, filter: { type: 'bandpass', freq: 3900, q: 4.0 } },
      { type: 'tone', gain: 0.5, attack: 0.001, decay: 0.035, wave: 'triangle', freq: 1900, freqEnd: 1500 },
    ],
  },
  // Cloth and air: a slip's flick with nothing to dodge, a smothered or stuffed punch, a denied clinch.
  clothMove: {
    gain: 1.0,
    layers: [
      { type: 'noise', gain: 0.6, attack: 0.02, decay: 0.09, filter: { type: 'bandpass', freq: 700, freqEnd: 1300, q: 1.0 } },
    ],
  },
  // Footwork: a burst scuffs, a pivot squeaks, a step is a soft pat on canvas.
  shoeScuff: {
    gain: 0.8,
    layers: [
      { type: 'noise', gain: 0.9, attack: 0.004, decay: 0.07, filter: { type: 'bandpass', freq: 2700, freqEnd: 1400, q: 3.0 } },
      { type: 'noise', gain: 0.4, attack: 0.003, decay: 0.04, filter: { type: 'lowpass', freq: 260, q: 0.7 } },
    ],
  },
  shoeSqueak: {
    gain: 0.3,
    layers: [
      { type: 'tone', gain: 0.7, attack: 0.008, decay: 0.07, wave: 'sine', freq: 2150, freqEnd: 2950 },
      { type: 'noise', gain: 0.5, attack: 0.005, decay: 0.05, filter: { type: 'bandpass', freq: 3100, q: 6.0 } },
    ],
  },
  footfall: {
    gain: 0.3,
    layers: [
      { type: 'noise', gain: 0.9, attack: 0.003, decay: 0.035, filter: { type: 'lowpass', freq: 230, q: 0.8 } },
      { type: 'tone', gain: 0.5, attack: 0.003, decay: 0.03, wave: 'sine', freq: 95, freqEnd: 70 },
    ],
  },
  // A man leaning on the ropes: a slow creak.
  ropeCreak: {
    gain: 1.2,
    layers: [
      { type: 'tone', gain: 0.9, attack: 0.12, hold: 0.1, decay: 0.3, wave: 'sawtooth', freq: 96, freqEnd: 71, filter: { type: 'bandpass', freq: 640, freqEnd: 520, q: 7.0 } },
      { type: 'noise', gain: 0.25, attack: 0.1, decay: 0.3, filter: { type: 'bandpass', freq: 1500, q: 5.0 } },
    ],
  },
  // A shove with both gloves; two bodies coming together in a clinch.
  shove: {
    gain: 0.7,
    layers: [
      { type: 'noise', gain: 0.8, attack: 0.006, decay: 0.08, filter: { type: 'lowpass', freq: 330, q: 0.8 } },
      { type: 'tone', gain: 0.7, attack: 0.005, decay: 0.09, wave: 'sine', freq: 112, freqEnd: 70 },
    ],
  },
  clinchThud: {
    gain: 0.7,
    layers: [
      { type: 'tone', gain: 0.9, attack: 0.008, decay: 0.16, wave: 'sine', freq: 88, freqEnd: 52 },
      { type: 'noise', gain: 0.6, attack: 0.008, decay: 0.1, filter: { type: 'lowpass', freq: 260, q: 0.8 } },
      { type: 'noise', gain: 0.4, attack: 0.03, decay: 0.16, filter: { type: 'bandpass', freq: 720, q: 1.0 } },
    ],
  },
  // The referee breaks them — no voice: two flat slaps of his hands on their arms.
  breakTap: {
    gain: 1.0,
    layers: [
      { type: 'noise', gain: 0.9, attack: 0.001, decay: 0.03, filter: { type: 'bandpass', freq: 1700, q: 1.2 } },
      { type: 'noise', gain: 0.9, delay: 0.15, attack: 0.001, decay: 0.03, filter: { type: 'bandpass', freq: 1800, q: 1.2 } },
    ],
  },

  // ── The crowd's voice (bus: crowd). Vowels are two formant bands over the walla loop; pitch glides do the talking. ──
  // A clean shot: a short low "oh" from the near side.
  crowdOh: {
    gain: 2.2, bus: 'crowd',
    layers: [
      { type: 'walla', gain: 1.0, attack: 0.07, hold: 0.05, decay: 0.38, filter: { type: 'bandpass', freq: 520, freqEnd: 400, q: 1.4 } },
    ],
  },
  // A flush shot: "OOH" — both formants fall.
  crowdOoh: {
    gain: 2.2, bus: 'crowd',
    layers: [
      { type: 'walla', gain: 1.0, attack: 0.06, hold: 0.16, decay: 0.6, filter: { type: 'bandpass', freq: 500, freqEnd: 330, q: 1.5 } },
      { type: 'walla', gain: 0.6, attack: 0.06, hold: 0.12, decay: 0.5, filter: { type: 'bandpass', freq: 950, freqEnd: 700, q: 1.6 } },
      { type: 'noise', gain: 0.12, attack: 0.08, hold: 0.1, decay: 0.5, filter: { type: 'bandpass', freq: 420, q: 0.7 } },
    ],
  },
  // A body shot: the same, a third lower — "oof".
  crowdOof: {
    gain: 2.6, bus: 'crowd',
    layers: [
      { type: 'walla', gain: 1.0, attack: 0.07, hold: 0.1, decay: 0.5, filter: { type: 'bandpass', freq: 390, freqEnd: 260, q: 1.5 } },
      { type: 'noise', gain: 0.12, attack: 0.08, hold: 0.05, decay: 0.4, filter: { type: 'lowpass', freq: 320, q: 0.7 } },
    ],
  },
  // A near miss: the gasp — breath in, rising, quick.
  crowdGasp: {
    gain: 2.2, bus: 'crowd',
    layers: [
      { type: 'noise', gain: 0.8, attack: 0.09, decay: 0.2, filter: { type: 'bandpass', freq: 1300, freqEnd: 2700, q: 1.3 } },
      { type: 'walla', gain: 0.4, attack: 0.08, decay: 0.18, filter: { type: 'bandpass', freq: 900, freqEnd: 1500, q: 1.2 } },
    ],
  },
  // A counter: "OHH!" — rising, with an edge.
  crowdCheer: {
    gain: 2.0, bus: 'crowd',
    layers: [
      { type: 'walla', gain: 1.0, attack: 0.08, hold: 0.25, decay: 0.9, filter: { type: 'bandpass', freq: 520, freqEnd: 780, q: 1.2 } },
      { type: 'walla', gain: 0.7, attack: 0.08, hold: 0.25, decay: 0.8, filter: { type: 'bandpass', freq: 1150, freqEnd: 1500, q: 1.3 } },
      { type: 'noise', gain: 0.15, attack: 0.1, hold: 0.2, decay: 0.8, filter: { type: 'bandpass', freq: 2200, q: 0.6 } },
    ],
  },
  // A fighter is rocked: the roar starts to rise (the bed's roar layer carries it on while he is chased).
  crowdRoar: {
    gain: 1.8, bus: 'crowd',
    layers: [
      { type: 'walla', gain: 1.0, attack: 0.3, hold: 0.7, decay: 1.6, filter: { type: 'bandpass', freq: 600, freqEnd: 880, q: 0.9 } },
      { type: 'walla', gain: 0.7, attack: 0.35, hold: 0.7, decay: 1.5, filter: { type: 'bandpass', freq: 1250, freqEnd: 1600, q: 1.0 } },
      { type: 'noise', gain: 0.3, attack: 0.4, hold: 0.6, decay: 1.6, filter: { type: 'bandpass', freq: 900, q: 0.5 } },
    ],
  },
  // A knockdown / KO: the house erupts — everything at once, wide, long.
  crowdEruption: {
    gain: 1.4, bus: 'crowd',
    layers: [
      { type: 'walla', gain: 1.0, attack: 0.12, hold: 1.6, decay: 2.8, filter: { type: 'bandpass', freq: 650, freqEnd: 900, q: 0.6 } },
      { type: 'walla', gain: 0.8, attack: 0.15, hold: 1.5, decay: 2.6, filter: { type: 'bandpass', freq: 1400, freqEnd: 1700, q: 0.7 } },
      { type: 'noise', gain: 0.5, attack: 0.15, hold: 1.4, decay: 2.8, filter: { type: 'bandpass', freq: 1000, q: 0.4 } },
      { type: 'noise', gain: 0.25, attack: 0.2, hold: 1.2, decay: 2.2, filter: { type: 'highpass', freq: 2400, q: 0.6 } },
      { type: 'noise', gain: 0.5, attack: 0.05, hold: 0.3, decay: 1.2, filter: { type: 'lowpass', freq: 140, q: 0.7 } },     // feet on the stands
    ],
  },
  // A man folds from a body shot, or slumps trying to get up: a long falling "oooh" and a groan under it.
  crowdOooh: {
    gain: 2.0, bus: 'crowd',
    layers: [
      { type: 'walla', gain: 1.0, attack: 0.15, hold: 0.35, decay: 1.1, filter: { type: 'bandpass', freq: 470, freqEnd: 290, q: 1.5 } },
      { type: 'walla', gain: 0.5, attack: 0.15, hold: 0.3, decay: 0.9, filter: { type: 'bandpass', freq: 860, freqEnd: 600, q: 1.6 } },
    ],
  },
  crowdGroan: {
    gain: 2.2, bus: 'crowd',
    layers: [
      { type: 'walla', gain: 1.0, attack: 0.12, hold: 0.25, decay: 0.9, filter: { type: 'bandpass', freq: 330, freqEnd: 210, q: 1.3 } },
      { type: 'noise', gain: 0.15, attack: 0.15, hold: 0.2, decay: 0.8, filter: { type: 'lowpass', freq: 260, q: 0.7 } },
    ],
  },
  // Too much holding: a low, flat grumble.
  crowdGrumble: {
    gain: 2.0, bus: 'crowd',
    layers: [
      { type: 'walla', gain: 1.0, attack: 0.3, hold: 0.5, decay: 1.0, filter: { type: 'bandpass', freq: 260, freqEnd: 220, q: 1.0 } },
      { type: 'noise', gain: 0.12, attack: 0.3, hold: 0.4, decay: 0.9, filter: { type: 'bandpass', freq: 500, q: 0.6 } },
    ],
  },
  // A chain of slips: "o-LÉ" — short, rising, brighter with each one (the caller pitches it up).
  crowdOle: {
    gain: 2.2, bus: 'crowd',
    layers: [
      { type: 'walla', gain: 1.0, attack: 0.05, hold: 0.08, decay: 0.4, filter: { type: 'bandpass', freq: 450, freqEnd: 820, q: 1.4 } },
      { type: 'walla', gain: 0.6, attack: 0.05, hold: 0.08, decay: 0.35, filter: { type: 'bandpass', freq: 1100, freqEnd: 1900, q: 1.5 } },
    ],
  },
  // Applause: the bell, a man beating the count, the decision. Length is in the layer's hold.
  crowdApplause: {
    gain: 3.0, bus: 'crowd',
    layers: [
      { type: 'applause', gain: 1.0, attack: 0.35, hold: 1.4, decay: 1.8, filter: { type: 'bandpass', freq: 1900, q: 0.5 } },
      { type: 'walla', gain: 0.35, attack: 0.3, hold: 0.8, decay: 1.4, filter: { type: 'bandpass', freq: 700, freqEnd: 600, q: 0.9 } },
    ],
  },
  crowdOvation: {
    gain: 2.6, bus: 'crowd',
    layers: [
      { type: 'applause', gain: 1.0, attack: 0.4, hold: 3.2, decay: 2.6, filter: { type: 'bandpass', freq: 1900, q: 0.5 } },
      { type: 'walla', gain: 0.6, attack: 0.3, hold: 2.0, decay: 2.4, filter: { type: 'bandpass', freq: 720, freqEnd: 820, q: 0.8 } },
      { type: 'noise', gain: 0.2, attack: 0.3, hold: 1.5, decay: 2.2, filter: { type: 'bandpass', freq: 1100, q: 0.5 } },
    ],
  },
};
