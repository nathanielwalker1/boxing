/**
 * ui/audio/voice.ts — turns a recipe into Web Audio nodes. Pure: it takes any
 * BaseAudioContext, so the live game (AudioContext) and the offline renderer
 * (scripts/audio_render.mjs, OfflineAudioContext → WAV + numbers) play
 * EXACTLY the same graph.
 */
import type { Recipe } from './recipes';

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

/** One second of white noise for a context. */
export function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** Every layer is source → [filter] → gain → `out`, with its own delay / attack / hold / decay envelope. Returns the time the last layer ends. */
export function playVoice(ctx: BaseAudioContext, out: AudioNode, recipe: Recipe, buffers: VoiceBuffers, o: VoiceOpts): number {
  const nyq = ctx.sampleRate / 2 - 100;
  const clampF = (hz: number): number => Math.min(Math.max(20, hz), nyq);
  let last = o.when;
  for (const layer of recipe.layers) {
    const t0 = o.when + (layer.delay ?? 0);
    const attack = layer.attack ?? 0.001, hold = (layer.hold ?? 0) * o.length, decay = (layer.decay ?? 0.1) * o.length;
    const end = t0 + attack + hold + decay;
    last = Math.max(last, end);
    const peak = Math.max(0.0001, (layer.gain ?? 1) * o.gain * (layer.sub ? o.sub : 1));
    let src: AudioScheduledSourceNode;
    if (layer.type === 'tone') {
      const osc = ctx.createOscillator();
      osc.type = layer.wave ?? 'sine';
      const f0 = (layer.freq ?? 200) * o.pitch, f1 = (layer.freqEnd ?? layer.freq ?? 200) * o.pitch;
      osc.frequency.setValueAtTime(f0, t0);
      if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), end);
      osc.start(t0);
      src = osc;
    } else {
      // The crowd's loops, or plain noise until they exist (the walla is rendered just after the first gesture).
      const buffer = (layer.type === 'walla' ? buffers.walla : layer.type === 'applause' ? buffers.applause : null) ?? buffers.noise;
      const n = ctx.createBufferSource();
      n.buffer = buffer;
      n.loop = true;
      n.playbackRate.value = o.pitch;
      n.start(t0, Math.random() * Math.max(0.01, buffer.duration - 0.01));
      src = n;
    }
    let node: AudioNode = src;
    if (layer.filter) {
      const biq = ctx.createBiquadFilter();
      biq.type = layer.filter.type;
      biq.Q.value = layer.filter.q ?? 1;
      const c0 = layer.filter.freq * o.pitch, c1 = (layer.filter.freqEnd ?? layer.filter.freq) * o.pitch;
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
