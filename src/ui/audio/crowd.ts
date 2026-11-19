/**
 * ui/audio/crowd.ts — the crowd bed: a continuous sound that rises with the
 * fight. Everything follows the ONE excitement value the stands follow
 * (render/mood.ts), so the house never sounds different from how it looks.
 *
 * Second realism pass (2026-11-18): every attempt at synthetic VOICES is gone
 * (the syllable-gated "walla" read as static and chatter). The bed is a plain
 * ROOM TONE: one looped noise buffer, rendered once offline at the first
 * gesture through a 900 Hz low-pass and a 120 Hz high-pass, no gating, no
 * fast modulation. It plays through two layers:
 *   room    the tone itself; level follows excitement; two very slow shallow
 *           level drifts (11 s and 14 s periods, about ±2 dB together)
 *   bright  the same noise through a low-pass that opens with excitement
 *           (900 Hz at rest, up to 2.5 kHz); quiet, adds air
 * The referee's count hushes it. Reactions (voice.ts) are swells of this same
 * room tone. An applause loop (several hundred dense random noise ticks) is
 * built here too. `walla` keeps its name: the room-tone buffer the reactions use.
 */
import type { Config } from '../../core';

export class CrowdBed {
  walla: AudioBuffer | null = null;
  applause: AudioBuffer | null = null;
  private nodes: { room: GainNode; bright: GainNode; brightLp: BiquadFilterNode; driftA: GainNode; driftB: GainNode } | null = null;

  /** Resolves once the room-tone loop is rendered and the bed's layers are playing (the offline renderer waits on it). */
  readonly ready: Promise<void>;

  /** Any BaseAudioContext: the live AudioContext, or an OfflineAudioContext for scripts/audio_render.mjs. */
  constructor(private ctx: BaseAudioContext, private cfg: Config, private out: AudioNode, private noise: AudioBuffer) {
    try { this.applause = this.buildApplause(); } catch { this.applause = null; }
    this.ready = this.renderWalla().then(buf => { this.walla = buf; this.start(); }).catch(() => { /* no room tone: reactions fall back to noise, the bed stays off */ });
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

  /** Render the room-tone loop offline: independent noise per ear through a 900 Hz low-pass and a 120 Hz high-pass; the tail is folded into the head so the loop has no seam. */
  private async renderWalla(): Promise<AudioBuffer> {
    const sr = this.ctx.sampleRate;
    const dur = this.cfg.audioCrowdLoopSeconds, tail = 1, total = Math.floor(sr * (dur + tail));
    const off = new OfflineAudioContext(2, total, sr);
    const merger = off.createChannelMerger(2);
    merger.connect(off.destination);
    for (let ch = 0; ch < 2; ch++) {
      const nb = off.createBuffer(1, total, sr), nd = nb.getChannelData(0);
      for (let i = 0; i < total; i++) nd[i] = Math.random() * 2 - 1;
      const src = off.createBufferSource(); src.buffer = nb;
      const lp = off.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.5;
      const hp = off.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 120; hp.Q.value = 0.5;
      src.connect(lp); lp.connect(hp); hp.connect(merger, 0, ch);
      src.start(0);
    }
    const raw = await off.startRendering();
    const len = Math.floor(sr * dur), tl = Math.floor(sr * tail);
    const buf = this.ctx.createBuffer(2, len, sr);
    let peak = 1e-6;
    for (let ch = 0; ch < 2; ch++) {
      const src = raw.getChannelData(ch), dst = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        let x = src[i] ?? 0;
        if (i < tl) { const u = i / tl, a = Math.sqrt(u), b = Math.sqrt(1 - u); x = x * a + (src[len + i] ?? 0) * b; }   // equal-power: uncorrelated noise keeps its level across the seam
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
    const room = g(), bright = g();
    this.loop(walla, 1).connect(room);
    const brightLp = ctx.createBiquadFilter(); brightLp.type = 'lowpass'; brightLp.frequency.value = 900; brightLp.Q.value = 0.5;
    this.loop(this.noise, 1).connect(brightLp); brightLp.connect(bright);
    // Two very slow level drifts on the room (11 s and 14 s periods); infrasonic, never a tone.
    const drift = (period: number): GainNode => { const o = ctx.createOscillator(); o.frequency.value = 1 / period; const d = ctx.createGain(); d.gain.value = 0; o.connect(d); d.connect(room.gain); o.start(); return d; };
    this.nodes = { room, bright, brightLp, driftA: drift(11), driftB: drift(14) };
  }

  /** Called ~10×/s: level and brightness follow the mood. `e` excitement 0..1, `hush` 0..1. */
  update(e: number, hush: number, when = this.ctx.currentTime, k = 0.5): void {
    const n = this.nodes;
    if (!n) return;
    const c = this.cfg, t = when;
    const on = c.audioEnabled && c.audioCrowdEnabled ? 1 : 0;
    const quiet = 1 - c.audioHushDepth * hush;
    const room = c.audioBedMurmur * (0.75 + 0.5 * e) * quiet * on;
    n.room.gain.setTargetAtTime(room, t, k);
    n.driftA.gain.setTargetAtTime(room * c.audioBedSwell * 0.5, t, k);    // 0.25 × 0.5 each: about ±2 dB with both at a crest
    n.driftB.gain.setTargetAtTime(room * c.audioBedSwell * 0.5, t, k);
    n.bright.gain.setTargetAtTime(c.audioBedAir * (0.3 + 0.7 * e) * quiet * on, t, k);
    n.brightLp.frequency.setTargetAtTime(900 + 1600 * e, t, k);
  }

  get running(): boolean { return this.nodes !== null; }
}
