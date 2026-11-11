/**
 * ui/audio/crowd.ts — the crowd bed: a continuous sound that rises with the
 * fight. Everything follows the ONE excitement value the stands follow
 * (render/mood.ts), so the house never sounds different from how it looks.
 *
 * The raw material is a "walla" loop rendered once, offline, at the first
 * gesture: a few dozen synthetic voices (a sawtooth through two moving formant
 * filters, gated in syllables, panned across the stereo field). Summed, they
 * are a room full of people talking — which filtered noise alone never is.
 * The bed plays that loop through four layers:
 *   rumble   noise under 120 Hz — the room
 *   murmur   the walla, low-passed; swells slowly on its own (two LFOs)
 *   chatter  the walla sped up and high-passed; rises with excitement
 *   roar     walla + noise in the vowel band; silent at rest, rises with excitement²
 * Level and brightness track excitement; the referee's count hushes it.
 * An applause loop (a few hundred synthetic claps) is built here too.
 */
import type { Config } from '../../core';

export class CrowdBed {
  walla: AudioBuffer | null = null;
  applause: AudioBuffer | null = null;
  private nodes: { rumble: GainNode; murmur: GainNode; chatter: GainNode; roar: GainNode; murmurLp: BiquadFilterNode; chatterHp: BiquadFilterNode; swellA: GainNode; swellB: GainNode } | null = null;

  /** Resolves once the walla loop is rendered and the bed's layers are playing (the offline renderer waits on it). */
  readonly ready: Promise<void>;

  /** Any BaseAudioContext: the live AudioContext, or an OfflineAudioContext for scripts/audio_render.mjs. */
  constructor(private ctx: BaseAudioContext, private cfg: Config, private out: AudioNode, private noise: AudioBuffer) {
    try { this.applause = this.buildApplause(); } catch { this.applause = null; }
    this.ready = this.renderWalla().then(buf => { this.walla = buf; this.start(); }).catch(() => { /* no walla: reactions fall back to noise, the bed stays off */ });
  }

  /** A few hundred claps scattered over a loop; each a few ms of decaying noise. Claps wrap round the end, so it loops clean. */
  private buildApplause(): AudioBuffer {
    const sr = this.ctx.sampleRate, len = Math.floor(sr * 3);
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let k = 0; k < 520; k++) {
        const at = Math.floor(Math.random() * len), amp = 0.25 + Math.random() * 0.75;
        const n = Math.floor(sr * (0.004 + Math.random() * 0.006));
        for (let i = 0; i < n; i++) { const j = (at + i) % len; d[j] = (d[j] ?? 0) + (Math.random() * 2 - 1) * amp * Math.exp(-5 * i / n); }
      }
      for (let i = 0; i < len; i++) d[i] = Math.max(-1, Math.min(1, (d[i] ?? 0) * 0.5));
    }
    return buf;
  }

  /** Render the walla loop offline (native, off the main thread), then fold its tail into its head so the loop has no seam. */
  private async renderWalla(): Promise<AudioBuffer> {
    const c = this.cfg, sr = this.ctx.sampleRate;
    const dur = c.audioCrowdLoopSeconds, tail = 1;
    const off = new OfflineAudioContext(2, Math.floor(sr * (dur + tail)), sr);
    const total = dur + tail;
    const R = Math.random;
    for (let v = 0; v < Math.round(c.audioCrowdVoices); v++) {
      const osc = off.createOscillator();
      osc.type = 'sawtooth';
      const f0 = R() < 0.6 ? 90 + R() * 70 : 170 + R() * 90;       // more low voices than high
      osc.frequency.setValueAtTime(f0, 0);
      const f1 = off.createBiquadFilter(), f2 = off.createBiquadFilter();
      f1.type = 'bandpass'; f2.type = 'bandpass'; f1.Q.value = 5; f2.Q.value = 7;
      const env = off.createGain();
      env.gain.setValueAtTime(0, 0);
      const pan = off.createStereoPanner();
      pan.pan.value = R() * 2 - 1;
      const f2g = off.createGain(); f2g.gain.value = 0.6;
      osc.connect(f1); osc.connect(f2); f1.connect(env); f2.connect(f2g); f2g.connect(env); env.connect(pan); pan.connect(off.destination);
      // Speech: phrases of a few syllables, each its own vowel and pitch, with pauses between phrases.
      let t = R() * 1.5;
      while (t < total) {
        const syllables = 2 + Math.floor(R() * 6);
        for (let s = 0; s < syllables && t < total; s++) {
          const on = 0.07 + R() * 0.16, amp = 0.35 + R() * 0.65;
          f1.frequency.setValueAtTime(380 + R() * 480, t);
          f2.frequency.setValueAtTime(950 + R() * 1300, t);
          osc.frequency.setValueAtTime(f0 * (0.88 + R() * 0.3), t);
          env.gain.setValueAtTime(0, t);
          env.gain.linearRampToValueAtTime(amp, t + on * 0.3);
          env.gain.linearRampToValueAtTime(amp * 0.6, t + on * 0.8);
          env.gain.linearRampToValueAtTime(0, t + on);
          t += on + 0.02 + R() * 0.08;
        }
        t += 0.25 + R() * 1.6;
      }
      osc.start(0);
    }
    const raw = await off.startRendering();
    const len = Math.floor(sr * dur), tl = Math.floor(sr * tail);
    const buf = this.ctx.createBuffer(2, len, sr);
    let peak = 1e-6;
    for (let ch = 0; ch < 2; ch++) {
      const src = raw.getChannelData(ch), dst = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        let x = src[i] ?? 0;
        if (i < tl) { const u = i / tl; x = x * u + (src[len + i] ?? 0) * (1 - u); }
        dst[i] = x;
        if (Math.abs(x) > peak) peak = Math.abs(x);
      }
    }
    for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (d[i] ?? 0) * 0.7 / peak; }
    return buf;
  }

  private loop(buffer: AudioBuffer, rate: number): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer; s.loop = true; s.playbackRate.value = rate;
    s.start(0, Math.random() * buffer.duration);
    return s;
  }

  private start(): void {
    const ctx = this.ctx, walla = this.walla;
    if (!walla || this.nodes) return;
    const g = (): GainNode => { const n = ctx.createGain(); n.gain.value = 0; n.connect(this.out); return n; };
    const bq = (type: BiquadFilterType, f: number, q: number): BiquadFilterNode => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };
    const rumble = g(), murmur = g(), chatter = g(), roar = g();
    const rumbleLp = bq('lowpass', 115, 0.7);
    this.loop(this.noise, 0.5).connect(rumbleLp); rumbleLp.connect(rumble);
    const murmurLp = bq('lowpass', 1100, 0.5);
    this.loop(walla, 1).connect(murmurLp); this.loop(walla, 0.83).connect(murmurLp); murmurLp.connect(murmur);
    const chatterHp = bq('highpass', 1500, 0.6);
    this.loop(walla, 1.34).connect(chatterHp); chatterHp.connect(chatter);
    const roarA = bq('bandpass', 760, 0.6), roarB = bq('bandpass', 1350, 0.7);
    this.loop(walla, 1.13).connect(roarA); this.loop(walla, 0.94).connect(roarB); this.loop(this.noise, 0.8).connect(roarA);
    roarA.connect(roar); roarB.connect(roar);
    // Slow random-feeling swells on the murmur: two LFOs at unrelated rates, added to its gain.
    const lfo = (hz: number): GainNode => { const o = ctx.createOscillator(); o.frequency.value = hz; const d = ctx.createGain(); d.gain.value = 0; o.connect(d); d.connect(murmur.gain); o.start(); return d; };
    this.nodes = { rumble, murmur, chatter, roar, murmurLp, chatterHp, swellA: lfo(0.071), swellB: lfo(0.193) };
  }

  /** Called ~10×/s: levels and brightness follow the mood. `e` excitement 0..1, `hush` 0..1. */
  update(e: number, hush: number, when = this.ctx.currentTime, k = 0.18): void {
    const n = this.nodes;
    if (!n) return;
    const c = this.cfg, t = when;
    const on = c.audioEnabled && c.audioCrowdEnabled ? 1 : 0;
    const quiet = 1 - c.audioHushDepth * hush;
    const murmur = c.audioBedMurmur * (0.75 + 0.5 * e) * quiet * on;
    n.rumble.gain.setTargetAtTime(c.audioBedRumble * (0.6 + 0.6 * e) * on, t, k);
    n.murmur.gain.setTargetAtTime(murmur, t, k);
    n.chatter.gain.setTargetAtTime(c.audioBedChatter * (0.12 + 0.88 * e * e) * quiet * quiet * on, t, k);
    n.roar.gain.setTargetAtTime(c.audioBedRoar * Math.pow(e, 2.2) * (1 - hush) * on, t, k);
    n.murmurLp.frequency.setTargetAtTime(800 + 1500 * e, t, k);
    n.chatterHp.frequency.setTargetAtTime(1700 - 500 * e, t, k);
    n.swellA.gain.setTargetAtTime(murmur * c.audioBedSwell * 0.5, t, k);
    n.swellB.gain.setTargetAtTime(murmur * c.audioBedSwell * 0.5, t, k);
  }

  get running(): boolean { return this.nodes !== null; }
}
