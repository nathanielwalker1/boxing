/**
 * ui/audio.ts — the game's sound. Every sound is SYNTHESISED at runtime from
 * the recipes in ui/audio/recipes.ts — no files, no licensing, and every
 * characteristic of every hit is a number there (CONTRACT: no external
 * assets). Two buses under one master and a limiter:
 *   impact  punches by class and GRADE (glancing / clean / flush), blocks,
 *           whiffs, the counter sting, the bell
 *   crowd   a continuous bed that rises with the fight (ui/audio/crowd.ts)
 *           and the house's reactions — oohs, a gasp on a near miss, a roar
 *           that climbs while a hurt man is chased, an eruption on a
 *           knockdown, a hush for the count, applause at the bell
 * The crowd follows render/mood.ts — the same excitement value and the same
 * reactions the stands are drawn from.
 *
 * NOTHING here decides anything. It subscribes to the event bus and the mood
 * and makes a noise about outcomes the sim already resolved. Knobs live in
 * config (group `audio`). `window.__audioLog` records what was asked for
 * (name, pitch, gain) so a headless check can assert on it without a sound
 * device. Silent until the first user gesture (autoplay policy); a failed
 * sound is a silent one, never a throw.
 */
import type { Config, EventBus, PunchType, SimEvent } from '../core';
import { mood, gradeOf, type Grade, type Reaction } from '../render/mood';
import { RECIPES, type Recipe } from './audio/recipes';
import { CrowdBed } from './audio/crowd';

const PUNCH_CLASS: Record<PunchType, string> = { jab: 'impactSharp', cross: 'impactSharp', hook: 'impactHeavy', uppercut: 'impactHeavy' };
const GRADE_SUFFIX: Record<Grade, string> = { glancing: 'Glance', clean: '', flush: 'Flush' };

export interface AudioLogEntry { name: string; pitch: number; gain: number; t: number }
declare global {
  interface Window {
    __audioLog?: AudioLogEntry[];
    /** Probes for scripts/audio_check.mjs: the context's state (null before the first gesture) and whether the crowd bed is playing. */
    __audio?: { state: () => string | null; bed: () => boolean };
  }
}
const LOG_MAX = 50;
const BED_TICK_MS = 100;

export class CombatAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private unavailable = false;
  private impactBus: GainNode | null = null;
  private crowdBus: GainNode | null = null;
  private bed: CrowdBed | null = null;
  readonly log: AudioLogEntry[] = [];

  constructor(private readonly cfg: Config, bus: EventBus) {
    window.__audioLog = this.log;
    window.__audio = { state: () => this.ctx?.state ?? null, bed: () => this.bed?.running ?? false };
    // The context is created inside the first user gesture (not at boot):
    // Chrome logs a warning for a context created before any gesture, and a
    // headless check with no gesture at all must stay silent, not warn.
    this.installUnlock();
    // Outcomes → sounds. A counter is a sting ON TOP of the punch's own impact.
    bus.on('punchLand', e => this.land(e));
    bus.on('punchBlock', () => this.play('impactBlocked'));
    bus.on('perfectBlock', () => this.play('impactBlocked', 1.3));
    bus.on('punchWhiff', () => this.play('whiff'));
    // A slipped punch: the whiff fires too (the attacker missed); this is the close pass by the ear on top.
    bus.on('slip', e => { if (e.dodged) { this.play('slipNear'); if (e.side === 0) this.play('counterOpen'); } });
    bus.on('knockdown', () => this.play('knockdown'));
    bus.on('rocked', () => this.play('rocked'));
    // The bell also reaches the bus from the fight flow, which the stage never sees: tell the mood (it applauds once per bell).
    bus.on('bell', () => { this.play('bell'); mood.bell(this.cfg); });
    // The house.
    mood.on(r => this.crowdReact(r));
  }

  /** One landed punch: the recipe for its class and grade; a body shot is its own family, with the breath after it. */
  private land(e: Extract<SimEvent, { type: 'punchLand' }>): void {
    const c = this.cfg;
    const grade = gradeOf(e);
    const power = e.power * (grade === 'glancing' ? c.audioGlanceGain : 1);
    if (e.part === 'body') {
      this.play(`impactBody${GRADE_SUFFIX[grade]}`, power);
      if (grade !== 'glancing') this.play('bodyExhale', e.power * c.audioExhaleGain);
      if (grade === 'flush') this.play('bodyGrunt', e.power * c.audioExhaleGain);
    } else {
      this.play(`${PUNCH_CLASS[e.punch]}${GRADE_SUFFIX[grade]}`, power);
    }
    if (e.counter) this.play('counter');
  }

  /** The crowd answers a reaction from the mood. Small ones are left to the bed (it has already risen). */
  private crowdReact(r: Reaction): void {
    const s = r.strength;
    switch (r.kind) {
      case 'land': if (s >= 0.5) this.play('crowdOh', s); break;
      case 'flush': this.play('crowdOoh', s); break;
      case 'body': this.play('crowdOof', s); break;
      case 'nearMiss': this.play('crowdGasp', s); break;
      case 'counter': this.play('crowdCheer', s); break;
      case 'rocked': this.play('crowdRoar', s); break;
      case 'knockdown': this.play('crowdEruption', s); break;
      case 'ko': this.play('crowdEruption', s * 1.2); this.play('crowdOvation', s); break;
      case 'getUp': this.play('crowdCheer', s); this.play('crowdApplause', s); break;
      case 'bell': this.play('crowdApplause', s); break;
      case 'decision': this.play('crowdOvation', s); break;
    }
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
          this.buildGraph(this.ctx);
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

  /** impact + crowd → limiter → out; then the crowd bed, and the slow tick that keeps levels on the config and the mood. */
  private buildGraph(ctx: AudioContext): void {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -9; limiter.knee.value = 6; limiter.ratio.value = 8; limiter.attack.value = 0.003; limiter.release.value = 0.2;
    limiter.connect(ctx.destination);
    this.impactBus = ctx.createGain(); this.impactBus.connect(limiter);
    this.crowdBus = ctx.createGain(); this.crowdBus.connect(limiter);
    this.levels();
    try { this.bed = new CrowdBed(ctx, this.cfg, this.crowdBus, this.noiseBuffer(ctx)); } catch { this.bed = null; }
    window.setInterval(() => {
      try { this.levels(); this.bed?.update(mood.value, mood.hush); } catch { /* feedback, never state */ }
    }, BED_TICK_MS);
  }

  private levels(): void {
    const c = this.cfg;
    if (!this.ctx || !this.impactBus || !this.crowdBus) return;
    const t = this.ctx.currentTime;
    this.impactBus.gain.setTargetAtTime(c.audioImpactVolume, t, 0.05);
    this.crowdBus.gain.setTargetAtTime(c.audioCrowdEnabled ? c.audioCrowdVolume * c.audioMasterVolume : 0, t, 0.05);
  }

  /** Play one logical sound; `power` scales the gain a little (a hard hit is louder). Jitter is random on purpose: audio is not sim. */
  play(name: string, power = 1): void {
    const recipe = RECIPES[name];
    if (!recipe) return;
    const c = this.cfg;
    const crowd = recipe.bus === 'crowd';
    const pitch = 1 + (Math.random() * 2 - 1) * c.audioPitchJitter;
    // Impacts carry the master in their own gain (the log shows what was asked for); the crowd bus carries it for its sounds.
    const level = crowd ? c.audioReactionGain : c.audioMasterVolume;
    const gain = Math.max(0, level * recipe.gain * (0.75 + 0.25 * Math.min(2, power)) * (1 + (Math.random() * 2 - 1) * c.audioVolumeJitter));
    this.log.push({ name, pitch: +pitch.toFixed(4), gain: +gain.toFixed(4), t: performance.now() });
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
    if (!c.audioEnabled || gain <= 0 || this.unavailable || !this.ctx || this.ctx.state !== 'running') return;
    if (crowd && !c.audioCrowdEnabled) return;
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

  /** Every layer is source → [filter] → gain → its bus, with its own delay / attack / hold / decay envelope. */
  private playRecipe(recipe: Recipe, pitch: number, master: number): void {
    const ctx = this.ctx!;
    const out: AudioNode = (recipe.bus === 'crowd' ? this.crowdBus : this.impactBus) ?? ctx.destination;
    const now = ctx.currentTime;
    const nyq = ctx.sampleRate / 2 - 100;
    const clampF = (hz: number): number => Math.min(Math.max(20, hz), nyq);
    for (const layer of recipe.layers) {
      const t0 = now + (layer.delay ?? 0);
      const attack = layer.attack ?? 0.001, hold = layer.hold ?? 0, decay = layer.decay ?? 0.1;
      const end = t0 + attack + hold + decay;
      const peak = Math.max(0.0001, (layer.gain ?? 1) * master * (layer.sub ? this.cfg.audioFlushSub : 1));
      let src: AudioScheduledSourceNode;
      if (layer.type === 'tone') {
        const o = ctx.createOscillator();
        o.type = layer.wave ?? 'sine';
        const f0 = (layer.freq ?? 200) * pitch, f1 = (layer.freqEnd ?? layer.freq ?? 200) * pitch;
        o.frequency.setValueAtTime(f0, t0);
        if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), end);
        o.start(t0);
        src = o;
      } else {
        // The crowd's loops, or plain noise until they exist (the walla is rendered just after the first gesture).
        const buffer = (layer.type === 'walla' ? this.bed?.walla : layer.type === 'applause' ? this.bed?.applause : null) ?? this.noiseBuffer(ctx);
        const n = ctx.createBufferSource();
        n.buffer = buffer;
        n.loop = true;
        n.playbackRate.value = pitch;
        n.start(t0, Math.random() * Math.max(0.01, buffer.duration - 0.01));
        src = n;
      }
      let node: AudioNode = src;
      if (layer.filter) {
        const biq = ctx.createBiquadFilter();
        biq.type = layer.filter.type;
        biq.Q.value = layer.filter.q ?? 1;
        const c0 = layer.filter.freq * pitch, c1 = (layer.filter.freqEnd ?? layer.filter.freq) * pitch;
        biq.frequency.setValueAtTime(clampF(c0), t0);
        if (c1 !== c0) biq.frequency.linearRampToValueAtTime(clampF(c1), end);
        src.connect(biq);
        node = biq;
      }
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(peak, t0 + attack);
      if (hold > 0) env.gain.setValueAtTime(peak, t0 + attack + hold);
      env.gain.exponentialRampToValueAtTime(0.0001, end);
      node.connect(env);
      env.connect(out);
      src.stop(end + 0.02);
      src.onended = () => { try { src.disconnect(); node.disconnect(); env.disconnect(); } catch { /* torn down */ } };
    }
  }
}
