/**
 * ui/audio.ts — combat SFX (UI workstream). Port of legacy/src/audio.js:
 * every sound is SYNTHESISED at runtime from the recipes below — no files,
 * no licensing, and every characteristic of every hit is a number here
 * (CONTRACT: no external assets). The three impacts own three parts of the
 * spectrum (sharp = top, heavy = bottom, blocked = middle) so they are
 * tellable apart mid-fight; the counter is a sting layered on top of the
 * punch's own impact; the whiff is a filter sweep.
 *
 * NOTHING here decides anything. It subscribes to the event bus and makes a
 * noise about outcomes the sim already resolved. Master knobs (enabled,
 * volume, jitter) live in config; recipes are authored data, like the punch
 * shapes. `window.__audioLog` records what was asked for (name, pitch, gain)
 * so a headless check can assert on it without a sound device.
 */
import type { Config, EventBus, PunchType } from '../core';

interface Layer {
  type: 'noise' | 'tone';
  gain?: number; attack?: number; decay?: number;
  wave?: OscillatorType; freq?: number; freqEnd?: number;
  filter?: { type: BiquadFilterType; freq: number; freqEnd?: number; q?: number };
}
interface Recipe { gain: number; layers: Layer[] }

const RECIPES: Record<string, Recipe> = {
  // Jab / cross — sharp and high. The 3 kHz bandpass layer is the "crack".
  impactSharp: {
    gain: 0.62,
    layers: [
      { type: 'noise', gain: 0.85, attack: 0.001, decay: 0.060, filter: { type: 'highpass', freq: 1600, q: 0.7 } },
      { type: 'noise', gain: 0.60, attack: 0.001, decay: 0.035, filter: { type: 'bandpass', freq: 3200, q: 1.5 } },
      { type: 'tone', gain: 0.35, attack: 0.001, decay: 0.070, wave: 'triangle', freq: 320, freqEnd: 140 },
    ],
  },
  // Hook / uppercut — heavy and low. The deep sine thud carries it.
  impactHeavy: {
    gain: 0.60,
    layers: [
      { type: 'tone', gain: 1.00, attack: 0.002, decay: 0.240, wave: 'sine', freq: 150, freqEnd: 45 },
      { type: 'noise', gain: 0.55, attack: 0.001, decay: 0.140, filter: { type: 'lowpass', freq: 500, q: 0.8 } },
      { type: 'noise', gain: 0.25, attack: 0.001, decay: 0.030, filter: { type: 'bandpass', freq: 1500, q: 1.0 } },
    ],
  },
  // Body shot — the heavy thud without the crack, lower and duller.
  impactBody: {
    gain: 0.7,
    layers: [
      { type: 'tone', gain: 1.00, attack: 0.003, decay: 0.200, wave: 'sine', freq: 110, freqEnd: 40 },
      { type: 'noise', gain: 0.6, attack: 0.002, decay: 0.110, filter: { type: 'lowpass', freq: 380, q: 0.7 } },
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
    gain: 4.5,
    layers: [
      { type: 'noise', gain: 0.6, attack: 0.008, decay: 0.09, filter: { type: 'bandpass', freq: 900, freqEnd: 3800, q: 1.6 } },
      { type: 'noise', gain: 0.3, attack: 0.004, decay: 0.06, filter: { type: 'highpass', freq: 2600, q: 0.8 } },
    ],
  },
  // The window opens (2026-09-22): a short bright ping under the slip's whoosh
  // — Fight Night's "you read it" cue; the counter sting answers it if the
  // counter lands.
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
  // The bell.
  bell: {
    gain: 0.5,
    layers: [
      { type: 'tone', gain: 0.8, attack: 0.002, decay: 1.1, wave: 'sine', freq: 1180, freqEnd: 1160 },
      { type: 'tone', gain: 0.45, attack: 0.002, decay: 0.7, wave: 'triangle', freq: 2360, freqEnd: 2300 },
      { type: 'noise', gain: 0.25, attack: 0.001, decay: 0.03, filter: { type: 'highpass', freq: 3000, q: 0.7 } },
    ],
  },
};

const PUNCH_CLASS: Record<PunchType, string> = { jab: 'impactSharp', cross: 'impactSharp', hook: 'impactHeavy', uppercut: 'impactHeavy' };

export interface AudioLogEntry { name: string; pitch: number; gain: number; t: number }
declare global { interface Window { __audioLog?: AudioLogEntry[] } }
const LOG_MAX = 50;

export class CombatAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private unavailable = false;
  readonly log: AudioLogEntry[] = [];

  constructor(private readonly cfg: Config, bus: EventBus) {
    window.__audioLog = this.log;
    // The context is created inside the first user gesture (not at boot):
    // Chrome logs a warning for a context created before any gesture, and a
    // headless check with no gesture at all must stay silent, not warn.
    this.installUnlock();
    // Outcomes → sounds. A counter is a sting ON TOP of the punch's own impact.
    bus.on('punchLand', e => { this.play(e.part === 'body' ? 'impactBody' : PUNCH_CLASS[e.punch], e.power); if (e.counter) this.play('counter'); });
    bus.on('punchBlock', () => this.play('impactBlocked'));
    bus.on('perfectBlock', () => this.play('impactBlocked', 1.3));
    bus.on('punchWhiff', () => this.play('whiff'));
    // A slipped punch: the whiff fires too (the attacker missed); this is the close pass by the ear on top.
    bus.on('slip', e => { if (e.dodged) { this.play('slipNear'); if (e.side === 0) this.play('counterOpen'); } });
    bus.on('perfectBlock', e => { if (e.target === 0) this.play('counterOpen'); });
    bus.on('knockdown', () => this.play('knockdown'));
    bus.on('bell', () => this.play('bell'));
  }

  /** Autoplay policy: create the context inside a real user gesture and resume it there; unhook once it runs. */
  private installUnlock(): void {
    const unlock = (): void => {
      if (this.unavailable) return;
      try {
        if (!this.ctx) {
          const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          this.ctx = Ctor ? new Ctor() : null;
          if (!this.ctx) { this.unavailable = true; return; }
        }
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        if (this.ctx.state === 'running') for (const ev of ['pointerdown', 'touchstart', 'keydown']) window.removeEventListener(ev, unlock);
      } catch {
        this.unavailable = true;
        this.ctx = null;
      }
    };
    for (const ev of ['pointerdown', 'touchstart', 'keydown']) window.addEventListener(ev, unlock);
  }

  /** Play one logical sound; `power` scales the gain a little (a hard hit is louder). Jitter is random on purpose: audio is not sim. */
  play(name: string, power = 1): void {
    const recipe = RECIPES[name];
    if (!recipe) return;
    const c = this.cfg;
    const pitch = 1 + (Math.random() * 2 - 1) * c.audioPitchJitter;
    const gain = Math.max(0, c.audioMasterVolume * recipe.gain * (0.75 + 0.25 * Math.min(2, power)) * (1 + (Math.random() * 2 - 1) * c.audioVolumeJitter));
    this.log.push({ name, pitch: +pitch.toFixed(4), gain: +gain.toFixed(4), t: performance.now() });
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
    if (!c.audioEnabled || gain <= 0 || this.unavailable || !this.ctx || this.ctx.state !== 'running') return;
    try { this.playRecipe(recipe, pitch, gain); } catch { /* feedback, never state: a failed sound is a silent one */ }
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noise) return this.noise;
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;
    return buf;
  }

  /** Every layer is source → [filter] → gain → destination with its own AD envelope, all starting on one timestamp. */
  private playRecipe(recipe: Recipe, pitch: number, master: number): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const nyq = ctx.sampleRate / 2 - 100;
    const clampF = (hz: number): number => Math.min(Math.max(20, hz), nyq);
    for (const layer of recipe.layers) {
      const attack = layer.attack ?? 0.001, decay = layer.decay ?? 0.1;
      const peak = Math.max(0.0001, (layer.gain ?? 1) * master);
      let src: AudioScheduledSourceNode;
      let startOffset = 0;
      if (layer.type === 'noise') {
        const n = ctx.createBufferSource();
        n.buffer = this.noiseBuffer(ctx);
        n.playbackRate.value = pitch;
        startOffset = Math.random() * 0.5;
        src = n;
      } else {
        const o = ctx.createOscillator();
        o.type = layer.wave ?? 'sine';
        const f0 = (layer.freq ?? 200) * pitch, f1 = (layer.freqEnd ?? layer.freq ?? 200) * pitch;
        o.frequency.setValueAtTime(f0, t0);
        if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + attack + decay);
        src = o;
      }
      let node: AudioNode = src;
      if (layer.filter) {
        const biq = ctx.createBiquadFilter();
        biq.type = layer.filter.type;
        biq.Q.value = layer.filter.q ?? 1;
        const c0 = layer.filter.freq * pitch, c1 = (layer.filter.freqEnd ?? layer.filter.freq) * pitch;
        biq.frequency.setValueAtTime(clampF(c0), t0);
        if (c1 !== c0) biq.frequency.linearRampToValueAtTime(clampF(c1), t0 + attack + decay);
        src.connect(biq);
        node = biq;
      }
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(peak, t0 + attack);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
      node.connect(env);
      env.connect(ctx.destination);
      const stopAt = t0 + attack + decay + 0.02;
      if (layer.type === 'noise') (src as AudioBufferSourceNode).start(t0, startOffset); else src.start(t0);
      src.stop(stopAt);
      src.onended = () => { try { src.disconnect(); node.disconnect(); env.disconnect(); } catch { /* torn down */ } };
    }
  }
}
