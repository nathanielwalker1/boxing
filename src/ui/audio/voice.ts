/**
 * ui/audio/voice.ts — turns a recipe into Web Audio nodes. Pure: it takes any
 * BaseAudioContext, so the live game (AudioContext) and the offline renderer
 * (scripts/audio_render.mjs, OfflineAudioContext → WAV + numbers) play
 * EXACTLY the same graph.
 *
 * REALISM PASS (2026-11-18, "sounds like mii characters"): a glove on a face is
 * noise, not a note. So the recipe's layers are VOICED here, whatever the
 * recipe says:
 *   noise layers   a short broadband smack, never faster than a 2 ms rise (a
 *                  click-free transient), with its filter frequency, decay and
 *                  gain each nudged ± `vary` per hit so no two jabs match
 *   low tones      (sine / triangle, 200 Hz or under) stay as the THUMP: a
 *                  pure sine, capped at 160 Hz, that falls to its end pitch in
 *                  under 90 ms and then just rings out; weight, not a note
 *   other tones    (anything brighter, or a saw / square at any pitch) become a
 *                  band of noise with the same sweep and envelope, louder by
 *                  `toneNoise` to make up for the energy a band of noise lacks
 *   crowd layers   slower swells (a roar builds, it does not snap on), and no
 *                  narrow formant peaks (Q capped), so it is a room, not a choir
 * Only `keepTones` sounds (the bell's partials) keep real oscillators.
 */
import type { Layer, Recipe } from './recipes';

export interface VoiceBuffers { noise: AudioBuffer; walla?: AudioBuffer | null | undefined; applause?: AudioBuffer | null | undefined }

export interface VoiceOpts {
  /** Seconds on the context clock at which the recipe starts. */
  when: number;
  /** Pitch multiplier on every oscillator, filter and noise rate. */
  pitch: number;
  /** Linear gain on every layer. */
  gain: number;
  /** Extra gain on `sub` layers (audioFlushSub). */
  sub: number;
  /** Stretch on every layer's hold + decay (1 = as authored): a short, dull variant < 1; a big one > 1. */
  length: number;
  /** 0..1 (polish phase): where each noise layer starts in its buffer, instead of a random offset — an impact carrying the land's seeded variation is the same sound every time that land is replayed. Omitted = random. */
  seed?: number | undefined;
  /** ± fraction of random variation on each noise layer's filter frequency, decay and gain (0 = as authored). Default 0.12. Seeded when `seed` is. */
  vary?: number | undefined;
  /** Gain boost on a recipe tone voiced as noise (band-passed noise carries far less energy than a tone). Default 4. */
  toneNoise?: number | undefined;
  /** True for sounds that ARE pitched (the bell's partials): tone layers play as written. */
  keepTones?: boolean | undefined;
  /** True for the crowd bus: slower swells, lower-Q bands. */
  crowd?: boolean | undefined;
}

/**
 * A beat of ducked crowd (polish phase): the bus drops to `depth` of `base`
 * at `when`, holds for `hold` seconds and comes back. Shared by the live
 * shell and the offline renderer.
 */
export function duckBus(gain: AudioParam, base: number, when: number, depth: number, hold: number): void {
  gain.cancelScheduledValues(when);
  gain.setTargetAtTime(base * depth, when, 0.012);
  gain.setTargetAtTime(base, when + hold, 0.07);
}

/**
 * The master chain both buses run into: a compressor to ride the big
 * moments down, then a soft clipper whose ceiling the signal cannot pass.
 * A DynamicsCompressor is not a limiter — the worst overlap (a flush counter
 * on top of an eruption on top of a hot bed) measured +0.7 dBFS through it
 * alone (scripts/audio_render.mjs, 2026-11-11). The clipper is transparent
 * until about 6 dB under the ceiling. Returns the node to connect buses to.
 */
export function buildMaster(ctx: BaseAudioContext, ceilingDb: number): AudioNode {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12; comp.knee.value = 8; comp.ratio.value = 10; comp.attack.value = 0.002; comp.release.value = 0.18;
  const ceil = Math.pow(10, ceilingDb / 20);
  const n = 2048, curve = new Float32Array(n);
  // Linear to half the ceiling, then a tanh shoulder that lands on the ceiling: inputs up to ±4 are covered.
  const knee = ceil * 0.5, span = 4;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1) * 2 - 1) * span, a = Math.abs(x);
    const y = a <= knee ? a : knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee));
    curve[i] = Math.sign(x) * y;
  }
  const clip = ctx.createWaveShaper();
  clip.curve = curve;                                           // no oversampling: its filter can overshoot the ceiling
  const pre = ctx.createGain(); pre.gain.value = 1 / span;     // the shaper reads [-1, 1] across the curve, so scale the signal onto it
  comp.connect(pre); pre.connect(clip); clip.connect(ctx.destination);
  return comp;
}

/** Three seconds of white noise for a context (long, so a loop's repeat is not heard as a buzz and each hit can start somewhere different). */
export function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

const THUMP_TOP = 200;   // Hz: a sine / triangle layer entirely at or under this is a thump; anything brighter is not allowed to be a note
const THUMP_CAP = 160;   // Hz: a thump never starts above this
const THUMP_SWEEP = 0.09; // s: the fall from start to end pitch is over by here

/** Every layer is source → [filter] → gain → `out`, with its own delay / attack / hold / decay envelope. Returns the time the last layer ends. */
export function playVoice(ctx: BaseAudioContext, out: AudioNode, recipe: Recipe, buffers: VoiceBuffers, o: VoiceOpts): number {
  const nyq = ctx.sampleRate / 2 - 100;
  const clampF = (hz: number): number => Math.min(Math.max(20, hz), nyq);
  const vary = o.vary ?? 0.12, boost = o.toneNoise ?? 4, crowd = o.crowd === true;
  let last = o.when;
  let li = 0;
  // Crowd reactions (second pass): size by importance = the recipe's own length, so a gasp is small and the eruption biggest; the whole reaction is about half the level it was.
  let crowdSize = 1;
  if (crowd) {
    let dur = 0;
    for (const l of recipe.layers) if (!l.delay) dur = Math.max(dur, (l.hold ?? 0) + (l.decay ?? 0.1));
    crowdSize = 0.5 * (0.5 + 0.25 * Math.min(4, dur));
  }
  for (const layer of recipe.layers) {
    li++;
    if (crowd && layer.delay) continue;   // no repeated bursts (the laugh): a reaction is one smooth swell
    // Variation: random, or derived from the land's seed so a replay sounds the same.
    const k = li;
    const rnd = (j: number): number => {
      if (o.seed === undefined) return Math.random();
      const x = Math.sin((o.seed + 0.137) * 12.9898 * 100 + k * 78.233 + j * 37.719) * 43758.5453;
      return x - Math.floor(x);
    };
    const nudge = (j: number): number => 1 + (rnd(j) * 2 - 1) * vary;

    // What kind of layer is it, once voiced?
    const raw: Layer = layer;
    let thump = false, asNoise = raw.type !== 'tone';
    let f0 = (raw.freq ?? 200), f1 = (raw.freqEnd ?? raw.freq ?? 200);
    let filter = raw.filter ? { ...raw.filter } : undefined;
    let gainMul = 1;
    if (raw.type === 'tone' && !o.keepTones) {
      const wave = raw.wave ?? 'sine';
      if ((wave === 'sine' || wave === 'triangle') && Math.max(f0, f1) <= THUMP_TOP) {
        thump = true;
      } else {
        // Not a thump: voice it as a band of noise sweeping the same way.
        asNoise = true;
        gainMul = boost;
        if (Math.max(f0, f1) > THUMP_TOP) filter = { type: 'bandpass', freq: f0, freqEnd: f1, q: Math.max(1.2, raw.filter?.q ?? 1.4) };
        else filter = { type: 'bandpass', freq: raw.filter ? raw.filter.freq * 0.6 : f0 * 2.5, ...(raw.filter?.freqEnd !== undefined ? { freqEnd: raw.filter.freqEnd * 0.6 } : {}), q: 1.0 };   // a saw / square groan or creak: its body as a band of breath
      }
    }
    const keepTone = raw.type === 'tone' && !asNoise && !thump;   // keepTones: the bell

    const t0 = o.when + (raw.delay ?? 0);
    let attack = raw.attack ?? 0.001;
    let hold = (raw.hold ?? 0) * o.length, decay = (raw.decay ?? 0.1) * o.length;
    if (crowd) {
      // A smooth swell of the room tone: 200-500 ms in, 1.5-3 s out. No formant filters: the walla layers are the room tone opening 900 → 1300 Hz, the noise layers the brighter band opening 1 → 2.5 kHz (Q 0.5); applause keeps its own dense-ticks band.
      attack = Math.min(0.5, Math.max(0.2, attack * 3));
      decay = Math.min(3, Math.max(1.5, decay * 1.6));
      if (raw.type === 'walla') filter = { type: 'lowpass', freq: 900, freqEnd: 1300, q: 0.5 };
      else if (raw.type === 'noise') filter = { type: 'lowpass', freq: 1000, freqEnd: 2500, q: 0.5 };
      else if (filter) filter.q = Math.min(filter.q ?? 1, 0.5);
      gainMul = crowdSize;
    } else if (asNoise && !thump) {
      attack = Math.max(attack, 0.002);                           // 2 ms rise: a smack, not a click
    }
    if (!keepTone) decay *= nudge(1);
    if (!keepTone && hold > 0) hold *= nudge(2);
    const end = t0 + attack + hold + decay;
    last = Math.max(last, end);
    const peak = Math.max(0.0001, (raw.gain ?? 1) * o.gain * (raw.sub ? o.sub : 1) * gainMul * (keepTone ? 1 : nudge(3)));

    let src: AudioScheduledSourceNode;
    if (thump || keepTone) {
      const osc = ctx.createOscillator();
      let a = f0 * o.pitch, b = f1 * o.pitch;
      if (thump) {
        osc.type = 'sine';
        const cap = THUMP_CAP * o.pitch * nudge(4);
        if (a > cap) { b *= cap / a; a = cap; }
        const sweepEnd = t0 + Math.min(THUMP_SWEEP, Math.max(0.02, (end - t0) * 0.5));
        osc.frequency.setValueAtTime(a, t0);
        if (b !== a) osc.frequency.exponentialRampToValueAtTime(Math.max(1, b), sweepEnd);   // the fall is fast; after it the thump just rings out
      } else {
        osc.type = raw.wave ?? 'sine';
        osc.frequency.setValueAtTime(a, t0);
        if (b !== a) osc.frequency.exponentialRampToValueAtTime(Math.max(1, b), end);
      }
      osc.start(t0);
      src = osc;
    } else {
      // The crowd's loops, or plain noise until they exist (the walla is rendered just after the first gesture).
      const buffer = (raw.type === 'walla' ? buffers.walla : raw.type === 'applause' ? buffers.applause : null) ?? buffers.noise;
      const n = ctx.createBufferSource();
      n.buffer = buffer;
      n.loop = true;
      n.playbackRate.value = o.pitch;
      const u = o.seed === undefined ? Math.random() : (o.seed + li * 0.381966) % 1;
      n.start(t0, u * Math.max(0.01, buffer.duration - 0.01));
      src = n;
    }
    let node: AudioNode = src;
    if (filter) {
      const biq = ctx.createBiquadFilter();
      biq.type = filter.type;
      biq.Q.value = filter.q ?? 1;
      const fj = nudge(5);
      const c0 = filter.freq * o.pitch * fj, c1 = (filter.freqEnd ?? filter.freq) * o.pitch * fj;
      biq.frequency.setValueAtTime(clampF(c0), t0);
      if (c1 !== c0) biq.frequency.linearRampToValueAtTime(clampF(c1), end);
      src.connect(biq);
      node = biq;
    }
    const env = ctx.createGain();
    env.gain.value = 0.0001;   // a GainNode is at 1 until its first event: a delayed layer leaked one full-scale sample at its start (bodyExhale peaked −1.3 dBFS at an RMS of −36)
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    if (hold > 0) env.gain.setValueAtTime(peak, t0 + attack + hold);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    node.connect(env);
    env.connect(out);
    src.stop(end + 0.02);
    src.onended = () => { try { src.disconnect(); node.disconnect(); env.disconnect(); } catch { /* torn down */ } };
  }
  return last;
}
