/**
 * audio_render.mjs — the show, as files and numbers (nobody can hear a
 * headless run). Renders through an OfflineAudioContext in headless Chromium,
 * using the SAME modules the game plays with (ui/audio/recipes, voice, map,
 * crowd; render/mood for the crowd; render/stage's landKick for the camera),
 * and writes 16-bit WAVs to scripts/output/audio/:
 *
 *   recipes/<name>.wav     every recipe alone, at power 1, no jitter, at the level its bus gives it
 *   events/<label>.wav     what real event shapes ask for, polish toggles ON (the game as it ships)
 *   before/<label>.wav     the same events with every polish-phase show toggle OFF (the overhaul's sound) — A/B by ear
 *   bed_<e>.wav            the crowd bed at rest / warm / full excitement
 *   combo.wav              a clean 1-2-3 whose hook is the finisher, over a warm bed, through the limiter
 *   worst.wav              the worst realistic overlap through the limiter: a flush counter that is also a finisher + eruption + bed at full
 *   fight20.wav            20 s of an AI-vs-AI fight: the sim's own events, the mood's reactions, the bed following
 *
 * For each: peak dBFS, energy (dB, the whole sound's summed square — the
 * fair loudness number for sounds of different lengths), RMS dBFS (over the
 * sounding part), duration (to −40 dB under the peak), spectral centroid, and
 * the energy split low (<200 Hz) / mid / high (>2 kHz).
 *
 * Then THE TIERS, before and after (glancing / clean / flush × jab, cross,
 * hook, uppercut, body), for sound, camera and crowd; and the design intent,
 * checked in numbers (PASS/FAIL). This does not replace ears; it catches the
 * gross errors.
 *
 *   PORT=<port> node scripts/audio_render.mjs          (dev server must be running)
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output', 'audio');
for (const d of ['', 'recipes', 'events', 'before']) mkdirSync(resolve(OUT, d), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/GPU stall due to ReadPixels/.test(m.text())) logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.goto(`${DEV_URL}/?ai=0&menu=0`, { waitUntil: 'domcontentloaded', timeout: 30000 });

const results = await page.evaluate(async () => {
  const SR = 48000;
  const [{ RECIPES }, { playVoice, makeNoise, buildMaster, duckBus }, { voicesForEvent, voicesForReaction, duckForEvent, newVoiceMemory }, { CrowdBed }, { CrowdMood }, core, sim, ai, style, { landKick }] = await Promise.all([
    import('/src/ui/audio/recipes.ts'), import('/src/ui/audio/voice.ts'), import('/src/ui/audio/map.ts'), import('/src/ui/audio/crowd.ts'),
    import('/src/render/mood.ts'), import('/src/core/index.ts'), import('/src/sim/index.ts'), import('/src/ai/index.ts'), import('/src/ai/style.ts'), import('/src/render/stage.ts'),
  ]);
  const TOGGLES = ['showSoundTiersOn', 'showCamTiersOn', 'showCrowdTiersOn', 'showFinisherOn', 'showNerfOn', 'showKindsOn'];
  const mk = on => { const c = core.createConfig(); c.audioPitchJitter = 0; c.audioVolumeJitter = 0; for (const k of TOGGLES) c[k] = on; return c; };
  const cfgAfter = mk(true), cfgBefore = mk(false);
  let cfg = cfgAfter;

  // The crowd's loops, rendered once and shared by every offline context below.
  const seedCtx = new OfflineAudioContext(2, SR, SR);
  const noise = makeNoise(seedCtx);
  const seedBed = new CrowdBed(seedCtx, cfg, seedCtx.destination, noise);
  await seedBed.ready;
  const buffers = { noise, walla: seedBed.walla, applause: seedBed.applause };

  // ── analysis ──
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { const a = re[i]; re[i] = re[j]; re[j] = a; const b = im[i]; im[i] = im[j]; im[j] = b; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k], vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }
  const db = x => (x > 1e-9 ? 20 * Math.log10(x) : -180);
  function analyse(buf) {
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L, n = L.length;
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) / 2;
    const floor = peak * 0.01;   // −40 dB under the peak
    let first = 0, last = 0;
    for (let i = 0; i < n; i++) if (Math.abs(mono[i]) > floor) { first = i; break; }
    for (let i = n - 1; i >= 0; i--) if (Math.abs(mono[i]) > floor) { last = i; break; }
    let sq = 0, all = 0;
    for (let i = first; i <= last; i++) sq += mono[i] * mono[i];
    for (let i = 0; i < n; i++) all += mono[i] * mono[i];
    const rms = Math.sqrt(sq / Math.max(1, last - first + 1));
    let N = 1; while (N < n) N <<= 1; N = Math.min(N, 1 << 20);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < Math.min(n, N); i++) re[i] = mono[i];
    fft(re, im);
    let tot = 0, cen = 0, lo = 0, hi = 0;
    for (let k = 1; k < N / 2; k++) { const p = re[k] * re[k] + im[k] * im[k], f = k * SR / N; tot += p; cen += p * f; if (f < 200) lo += p; else if (f > 2000) hi += p; }
    tot = Math.max(tot, 1e-20);
    // energy: the summed square in dB re one second at full scale — independent of how long the render window is.
    return { peak: db(peak), rms: db(rms), energy: 10 * Math.log10(Math.max(1e-18, all / SR)), dur: (last - first) / SR, centroid: cen / tot, low: lo / tot, mid: 1 - (lo + hi) / tot, high: hi / tot };
  }
  function wav(buf) {
    const ch = Math.min(2, buf.numberOfChannels), n = buf.length, bytes = new Uint8Array(44 + n * ch * 2), v = new DataView(bytes.buffer);
    const s = (o, t) => { for (let i = 0; i < t.length; i++) bytes[o + i] = t.charCodeAt(i); };
    s(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, n * ch * 2, true);
    const d = []; for (let c = 0; c < ch; c++) d.push(buf.getChannelData(c));
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) v.setInt16(44 + (i * ch + c) * 2, Math.max(-1, Math.min(1, d[c][i])) * 32767, true);
    let bin = ''; const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
  }

  // ── the game's own gain staging, without the jitter ──
  /** Schedule one request the way CombatAudio.play does. Unseeded noise layers get a fixed seed here so two renders of one sound are the same numbers. */
  function schedule(ctx, buses, req, at) {
    const recipe = RECIPES[req.name];
    if (!recipe) throw new Error(`no recipe '${req.name}'`);
    const crowd = recipe.bus === 'crowd';
    const level = (crowd ? cfg.audioReactionGain : cfg.audioMasterVolume) * (req.level ?? 1);
    const gain = level * recipe.gain * (0.75 + 0.25 * Math.min(2, req.power ?? 1));
    return playVoice(ctx, crowd ? buses.crowd : buses.impact, recipe, buffers, { when: at + (req.delay ?? 0), pitch: req.pitch ?? 1, gain, sub: cfg.audioFlushSub, length: req.length ?? 1, seed: req.seed ?? 0.4142 });
  }
  /** The live graph: impact + crowd buses → limiter → out (limiter optional, to measure a bus raw). */
  function graph(ctx, limit) {
    let out = ctx.destination;
    if (limit) out = buildMaster(ctx, cfg.audioCeilingDb);
    const impact = ctx.createGain(); impact.gain.value = cfg.audioImpactVolume; impact.connect(out);
    const crowd = ctx.createGain(); crowd.gain.value = cfg.audioCrowdVolume * cfg.audioMasterVolume; crowd.connect(out);
    return { impact, crowd };
  }
  const duck = (buses, e, at) => { const d = duckForEvent(e, cfg); if (d) duckBus(buses.crowd.gain, cfg.audioCrowdVolume * cfg.audioMasterVolume, at, d.depth, d.hold); };
  async function render(seconds, limit, build) {
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * seconds), SR);
    const buses = graph(ctx, limit);
    await build(ctx, buses);
    const buf = await ctx.startRendering();
    return { ...analyse(buf), wav: wav(buf) };
  }
  const lengthOf = reqs => Math.max(0.2, ...reqs.map(r => { const rc = RECIPES[r.name]; return (r.delay ?? 0) + Math.max(...rc.layers.map(l => (l.delay ?? 0) + (l.attack ?? 0.001) + ((l.hold ?? 0) + (l.decay ?? 0.1)) * (r.length ?? 1))); })) + 0.15;

  const out = { recipes: {}, events: {}, before: {}, scenes: {}, camera: {}, crowd: {} };
  for (const name of Object.keys(RECIPES)) {
    const reqs = [{ name }];
    out.recipes[name] = await render(lengthOf(reqs), false, (ctx, b) => { schedule(ctx, b, reqs[0], 0.02); });
    out.recipes[name].bus = RECIPES[name].bus ?? 'impact';
  }

  // ── events, as the sim shapes them ──
  // Impulses are the sim's own (docs/POLISH_SIM.md 2d, scripts/feel_probe.mjs grades): N·s; power = impulse / punchImpulseBase.
  const land = (o) => { const ns = o.ns ?? 272; const e = { type: 'punchLand', side: 0, target: 1, punch: 'cross', hand: 'rear', part: 'head', at: { x: 0, y: 1.6, z: 0 }, impulse: { x: ns, y: 0, z: 0 }, power: ns / cfg.punchImpulseBase,
    counter: false, variant: 'cross', grade: 'clean', combo: 1, liver: false, through: false, wrongWay: false, finisher: false, vary: 0, nerf: 0, ...o }; delete e.ns; return e; };
  const block = (o) => ({ type: 'punchBlock', side: 0, target: 1, punch: 'cross', at: { x: 0, y: 1.5, z: 0 }, variant: 'cross', part: 'head', chip: 0, guard: 1, stun: 0.1, ...o });
  const NS = { jab: [117, 195, 220], cross: [163, 272, 412], hook: [235, 391, 508], uppercut: [250, 420, 546], body: [215, 360, 470], bodyS: [150, 250, 330] };
  const SHAPE = { jab: { punch: 'jab', variant: 'jab' }, cross: {}, hook: { punch: 'hook', variant: 'hook' }, uppercut: { punch: 'uppercut', variant: 'uppercut' },
    body: { punch: 'hook', variant: 'bodyHook', part: 'body' }, bodyS: { punch: 'cross', variant: 'bodyCross', part: 'body' } };
  const GRADES = ['glancing', 'clean', 'flush'];
  const TIERS = {};
  for (const k of Object.keys(NS)) GRADES.forEach((g, i) => { TIERS[`${k}_${g}`] = land({ ...SHAPE[k], grade: g, ns: NS[k][i] }); });
  const hurtStyle = (kind, style, late = false) => ({ type: 'hurtStyle', side: 1, kind, style, late });
  const EVENTS = {
    ...TIERS,
    body_liver: land({ ...SHAPE.body, grade: 'flush', ns: 470, liver: true, zone: 'liver' }),
    combo_1: land({}), combo_2: land({ combo: 2 }), combo_3: land({ combo: 3 }), combo_4: land({ combo: 4 }),
    finisher_hook: land({ ...SHAPE.hook, ns: 581, combo: 3, finisher: true }), finisher_cross: land({ ns: 420, combo: 3, finisher: true }), finisher_body: land({ ...SHAPE.body, ns: 520, combo: 3, finisher: true }),
    zone_chin: land({ zone: 'chin' }), zone_jaw: land({ zone: 'jaw' }), zone_temple: land({ zone: 'temple' }), zone_nose: land({ zone: 'nose' }), zone_forehead: land({ zone: 'forehead' }),
    zone_solar: land({ ...SHAPE.body, ns: 360, zone: 'solar' }), zone_ribs: land({ ...SHAPE.body, ns: 360, zone: 'ribs' }), zone_belly: land({ ...SHAPE.body, ns: 360, zone: 'belly' }),
    vary_minus: land({ vary: -0.83 }), vary_plus: land({ vary: 0.83 }), vary_plus_again: land({ vary: 0.83 }), vary_small: land({ vary: 0.21 }),
    nerf_cross_half: land({ nerf: 0.5 }), nerf_cross_full: land({ nerf: 1 }),
    overhand_clean: land({ variant: 'overhand', ns: 366 }), shovel_clean: land({ punch: 'hook', variant: 'shovelHook', ns: 268 }), insideUppercut_clean: land({ punch: 'uppercut', variant: 'insideUppercut', ns: 268 }),
    through_clean: land({ through: true }), wrongWay_clean: land({ wrongWay: true }),
    counter_flush_hook: land({ punch: 'hook', variant: 'hook', grade: 'flush', ns: 508, counter: true, combo: 1 }),
    block_fresh: block({ guard: 1 }), block_half: block({ guard: 0.5, chip: 0.01 }), block_worn: block({ guard: 0.1, chip: 0.03 }),
    perfectBlock: { type: 'perfectBlock', side: 0, target: 1, punch: 'jab', at: { x: 0, y: 1.5, z: 0 }, variant: 'jab' },
    guardBreak: { type: 'guardBreak', side: 1, by: 0, seconds: 1 },
    whiff: { type: 'punchWhiff', side: 0, punch: 'hook', variant: 'hook' }, whiff_nerf: { type: 'punchWhiff', side: 0, punch: 'hook', variant: 'hook', _nerf: 1 }, feint: { type: 'feint', side: 0, punch: 'cross', variant: 'cross' },
    slip_dodged: { type: 'slip', side: 0, dir: 1, dodged: true, kind: 'slip', chain: 1 }, pull_dodged: { type: 'slip', side: 0, dir: 2, dodged: true, kind: 'pull', chain: 1 },
    roll_dodged: { type: 'slip', side: 0, dir: 1, dodged: true, kind: 'roll', chain: 1 }, slip_chain3: { type: 'slip', side: 0, dir: -1, dodged: true, kind: 'slip', chain: 3 },
    slip_flick: { type: 'slip', side: 0, dir: 1, dodged: false, kind: 'slip', chain: 1 },
    burst: { type: 'burst', side: 0, x: 0, y: 1 }, pivot: { type: 'pivot', side: 0, dir: 1 }, escape: { type: 'escape', side: 0, how: 'pivot' },
    pushOff_hit: { type: 'pushOff', side: 0, target: 1, hit: true }, clinch: { type: 'clinch', side: 0, target: 1 }, clinchBreak_referee: { type: 'clinchBreak', side: 0, reason: 'referee' },
    liverShot: { type: 'liverShot', side: 1, by: 0, delay: 0.8 }, bodyHurt: { type: 'bodyHurt', side: 1, by: 0, liver: false, seconds: 1.2 }, bodyHurt_liver: { type: 'bodyHurt', side: 1, by: 0, liver: true, seconds: 1.6 },
    hurtStyle_legs: hurtStyle('head', 'legs'), hurtStyle_reach: hurtStyle('head', 'reach'), hurtStyle_cover: hurtStyle('head', 'cover'),
    hurtStyle_fold: hurtStyle('body', 'fold'), hurtStyle_elbow: hurtStyle('body', 'elbow'), hurtStyle_knee: hurtStyle('body', 'knee'), hurtStyle_fold_late: hurtStyle('body', 'fold', true),
    getUp_knee: { type: 'getUpPhase', side: 1, phase: 'knee', tries: 1 }, getUp_slump: { type: 'getUpPhase', side: 1, phase: 'slump', tries: 1 }, getUp_rise: { type: 'getUpPhase', side: 1, phase: 'rise', tries: 1 },
    knockdown_health: { type: 'knockdown', side: 1, count: 1, cause: 'health', kind: 'heavy', fall: 'none' }, knockdown_body: { type: 'knockdown', side: 1, count: 1, cause: 'body', kind: 'heavy', fall: 'none' },
    knockdown_flash: { type: 'knockdown', side: 1, count: 1, cause: 'flash', kind: 'flash', fall: 'none' }, knockdown_knee: { type: 'knockdown', side: 1, count: 1, cause: 'health', kind: 'knee', fall: 'none' },
    knockdown_out: { type: 'knockdown', side: 1, count: 1, cause: 'flash', kind: 'out', fall: 'stiff' },
    ko: { type: 'ko', winner: 0 }, ko_waved: { type: 'ko', winner: 0, waved: true }, countTick: { type: 'countTick', side: 1, n: 3 },
    rocked: { type: 'rocked', side: 1, by: 0, punch: 'hook', impulse: 500, threshold: 400, seconds: 2 }, bell: { type: 'bell' },
  };
  const impactVoices = e => { const mem = newVoiceMemory(); if (e._nerf) mem.nerf[e.side] = e._nerf; return voicesForEvent(e, cfg, 0, mem); };
  /** What the crowd does about one event: a fresh mood, the reactions it emits and how far its excitement moved. */
  function crowdFor(e) {
    const m = new CrowdMood();
    m.update(0.016, cfg);
    const reqs = [], kinds = [];
    m.on(r => { kinds.push(r.kind); reqs.push(...voicesForReaction(r, cfg)); });
    const e0 = m.energy;
    m.handle([e], cfg);
    return { reqs, kinds, delta: m.energy - e0 };
  }
  async function renderEvents(into, only) {
    const silent = [];
    for (const [label, e] of Object.entries(EVENTS)) {
      if (only && !only(label)) continue;
      const impactOnly = impactVoices(e), all = [...impactOnly, ...crowdFor(e).reqs];
      if (!all.length) { silent.push(label); continue; }
      const r = await render(lengthOf(all), false, (ctx, b) => { for (const q of all) schedule(ctx, b, q, 0.02); });
      r.voices = all.map(q => q.name).join(' + ');
      // The impact bus alone, for the tier comparisons (the crowd's answer is measured in the scenes).
      if (impactOnly.length) { const i = await render(lengthOf(impactOnly), false, (ctx, b) => { for (const q of impactOnly) schedule(ctx, b, q, 0.02); }); r.impact = { peak: i.peak, rms: i.rms, energy: i.energy, dur: i.dur, centroid: i.centroid, low: i.low, mid: i.mid, high: i.high }; }
      into[label] = r;
    }
    return silent;
  }
  /** Camera and crowd for the tier events and the finisher, under the config in force. */
  function showFor() {
    const cam = {}, crowd = {};
    for (const label of [...Object.keys(TIERS), 'finisher_hook', 'finisher_cross', 'nerf_cross_full']) {
      const e = EVENTS[label], k = landKick(e, cfg), c = crowdFor(e);
      cam[label] = k;
      crowd[label] = { delta: c.delta, kinds: c.kinds, voices: c.reqs.map(q => q.name) };
    }
    for (const label of ['knockdown_health', 'knockdown_body', 'knockdown_flash', 'knockdown_knee', 'knockdown_out', 'ko', 'ko_waved', 'countTick', 'hurtStyle_legs', 'hurtStyle_reach', 'hurtStyle_cover', 'hurtStyle_fold', 'hurtStyle_elbow', 'hurtStyle_knee', 'hurtStyle_fold_late']) {
      const c = crowdFor(EVENTS[label]);
      crowd[label] = { delta: c.delta, kinds: c.kinds, voices: c.reqs.map(q => q.name), impact: impactVoices(EVENTS[label]).map(q => q.name) };
    }
    return { cam, crowd };
  }

  // BEFORE: every polish-phase show toggle off — the overhaul's behaviour, measured by the same code.
  cfg = cfgBefore;
  await renderEvents(out.before, l => /^(jab|cross|hook|uppercut|body|bodyS)_|^combo_|^finisher_|^nerf_|^whiff|^knockdown_|^zone_/.test(l));
  out.showBefore = showFor();
  cfg = cfgAfter;
  out.silent = await renderEvents(out.events, null);
  out.show = showFor();

  // The out-cold arc: gasp, roar, then the house drops away (the mood's own clock).
  {
    const m = new CrowdMood();
    for (let i = 0; i < 120; i++) m.update(1 / 60, cfg);
    m.handle([EVENTS.knockdown_out, EVENTS.ko_waved], cfg);
    const line = [];
    for (let i = 0; i <= 8 * 60; i++) { m.update(1 / 60, cfg); if (i % 60 === 0) line.push({ t: i / 60, e: m.value, hush: m.hush }); }
    out.outArc = line;
    const f = new CrowdMood();
    for (let i = 0; i < 120; i++) f.update(1 / 60, cfg);
    f.handle([EVENTS.knockdown_flash], cfg);
    const fl = [];
    for (let i = 0; i <= 5 * 60; i++) { f.update(1 / 60, cfg); if (i % 60 === 0) fl.push({ t: i / 60, e: f.value, hush: f.hush }); }
    out.flashArc = fl;
    const h = new CrowdMood();
    for (let i = 0; i < 120; i++) h.update(1 / 60, cfg);
    h.handle([EVENTS.knockdown_health], cfg);
    const hl = [];
    for (let i = 0; i <= 5 * 60; i++) { h.update(1 / 60, cfg); if (i % 60 === 0) hl.push({ t: i / 60, e: h.value, hush: h.hush }); }
    out.heavyArc = hl;
  }

  // ── the bed, raw, at three moods ──
  for (const e of [0.2, 0.6, 1]) {
    out.scenes[`bed_${e}`] = await render(6, false, async (ctx, b) => { const bed = new CrowdBed(ctx, cfg, b.crowd, noise); await bed.ready; bed.update(e, 0, 0, 0.001); });
  }
  // ── a clean 1-2-3, the hook the finisher, over a warm bed, through the limiter ──
  const comboSeq = [[1.0, land({ punch: 'jab', variant: 'jab', ns: 195, vary: 0.3 })], [1.28, land({ ns: 290, combo: 2, vary: -0.5 })], [1.6, EVENTS.finisher_hook]];
  out.scenes.combo = await render(4.5, true, async (ctx, b) => {
    const bed = new CrowdBed(ctx, cfg, b.crowd, noise); await bed.ready; bed.update(0.5, 0, 0, 0.001);
    for (const [t, e] of comboSeq) {
      for (const q of impactVoices(e)) schedule(ctx, b, q, t);
      for (const q of crowdFor(e).reqs) schedule(ctx, b, q, t);
      duck(b, e, t);
    }
  });
  // ── the worst realistic overlap, through the limiter: a flush counter hook that is also a finisher, an eruption, a knockdown, the bed at full ──
  out.scenes.worst = await render(5, true, async (ctx, b) => {
    const bed = new CrowdBed(ctx, cfg, b.crowd, noise); await bed.ready; bed.update(1, 0, 0, 0.001);
    const hit = { ...EVENTS.counter_flush_hook, finisher: true, combo: 3 };
    for (const q of impactVoices(hit)) schedule(ctx, b, q, 1);
    for (const kind of ['counter', 'finisher', 'knockdown']) for (const q of voicesForReaction({ kind, strength: 1, pos: null }, cfg)) schedule(ctx, b, q, 1);
    for (const q of voicesForEvent(EVENTS.knockdown_health, cfg, 0)) schedule(ctx, b, q, 1.05);
  });

  // ── 20 s of a real fight: AI against AI, the sim's own events ──
  {
    const specs = [core.ROSTER[0], core.ROSTER[1]];
    const SECONDS = 20;
    let s = sim.createState(specs, cfg, 7);
    let a0 = ai.createAi(0, 7, cfg, style.styleFor(specs[0], cfg)), a1 = ai.createAi(1, 8, cfg, style.styleFor(specs[1], cfg));
    const timeline = [];           // { t, reqs }
    const ducks = [];              // { t, e }
    const moodLine = [];           // { t, e, hush }
    const m = new CrowdMood();
    const mem = newVoiceMemory();
    let now = 0;
    m.on(r => timeline.push({ t: now, reqs: voicesForReaction(r, cfg) }));
    const counts = {}, grades = {};
    for (let tick = 0; tick < SECONDS * 60; tick++) {
      now = tick / 60;
      const d0 = ai.aiStep(a0, s, cfg), d1 = ai.aiStep(a1, s, cfg);
      a0 = d0.ai; a1 = d1.ai;
      const r = sim.step(s, [d0.input, d1.input], cfg);
      s = r.state;
      for (const e of r.events) {
        counts[e.type] = (counts[e.type] ?? 0) + 1;
        if (e.type === 'punchLand') { const g = e.grade + (e.finisher ? '+finisher' : ''); grades[g] = (grades[g] ?? 0) + 1; ducks.push({ t: now, e }); }
        const reqs = voicesForEvent(e, cfg, 0, mem); if (reqs.length) timeline.push({ t: now, reqs });
      }
      m.handle(r.events, cfg); m.update(1 / 60, cfg);
      if (tick % 6 === 0) moodLine.push({ t: now, e: m.value, hush: m.hush });
    }
    out.scenes.fight20 = await render(SECONDS + 3, true, async (ctx, b) => {
      const bed = new CrowdBed(ctx, cfg, b.crowd, noise); await bed.ready;
      bed.update(moodLine[0].e, 0, 0, 0.001);
      for (const p of moodLine) bed.update(p.e, p.hush, p.t);
      for (const item of timeline) for (const q of item.reqs) schedule(ctx, b, q, item.t + 0.02);
      for (const d of ducks) duck(b, d.e, d.t + 0.02);
    });
    out.scenes.fight20.events = counts;
    out.scenes.fight20.grades = grades;
    out.scenes.fight20.voices = timeline.reduce((n, i) => n + i.reqs.length, 0);
    out.scenes.fight20.excite = [Math.min(...moodLine.map(p => p.e)), Math.max(...moodLine.map(p => p.e))];
  }
  return out;
});
await browser.close();

// ── files ──
const save = (path, r) => { writeFileSync(resolve(OUT, path), Buffer.from(r.wav, 'base64')); delete r.wav; };
for (const [n, r] of Object.entries(results.recipes)) save(`recipes/${n}.wav`, r);
for (const [n, r] of Object.entries(results.events)) save(`events/${n}.wav`, r);
for (const [n, r] of Object.entries(results.before)) save(`before/${n}.wav`, r);
for (const [n, r] of Object.entries(results.scenes)) save(`${n}.wav`, r);

// ── tables ──
const f1 = x => x.toFixed(1).padStart(6), pc = x => `${Math.round(x * 100)}`.padStart(3);
const row = (n, r) => `${n.padEnd(22)} ${f1(r.peak)} ${f1(r.energy)} ${f1(r.rms)} ${r.dur.toFixed(2).padStart(5)} ${String(Math.round(r.centroid)).padStart(5)}   ${pc(r.low)}/${pc(r.mid)}/${pc(r.high)}`;
const head = `${'name'.padEnd(22)}   peak energy    rms   dur  cent   low/mid/high %   (dBFS, dB, dBFS, s, Hz)`;
console.log(`\nRECIPES (alone, power 1, at bus level)\n${head}`);
for (const [n, r] of Object.entries(results.recipes)) console.log(row(n, r) + (r.bus === 'crowd' ? '  crowd' : ''));
console.log(`\nEVENTS — impact bus only (polish toggles on)\n${head}`);
for (const [n, r] of Object.entries(results.events)) if (r.impact) console.log(row(n, r.impact) + `  ${r.voices}`);
console.log(`\nEVENTS with no impact voice (crowd only)`);
for (const [n, r] of Object.entries(results.events)) if (!r.impact) console.log(row(n, r) + `  ${r.voices}`);
console.log(`\nSCENES\n${head}`);
for (const [n, r] of Object.entries(results.scenes)) console.log(row(n, r));
const fight = results.scenes.fight20;
console.log(`fight20: ${fight.voices} voices; excitement ${fight.excite[0].toFixed(2)}–${fight.excite[1].toFixed(2)}; lands ${Object.entries(fight.grades).map(([k, v]) => `${k} ${v}`).join(', ')}; events ${Object.entries(fight.events).map(([k, v]) => `${k} ${v}`).join(', ')}`);
if (results.silent.length) console.log(`\nSILENT events (no voice at all): ${results.silent.join(', ')}`);

// ── the tiers, before and after ──
const E = n => results.events[n].impact, B = n => results.before[n].impact, S = results.scenes;
const CLASSES = ['jab', 'cross', 'hook', 'uppercut', 'body', 'bodyS'], GR = ['glancing', 'clean', 'flush'];
const cell = r => `${f1(r.peak)} ${f1(r.energy)} ${r.dur.toFixed(2).padStart(5)} ${String(Math.round(r.centroid)).padStart(5)} ${pc(r.low)}/${pc(r.mid)}/${pc(r.high)}`;
console.log(`\nTIERS — SOUND, impact bus (peak dBFS, energy dB, dur s, centroid Hz, low/mid/high %)   body = a hook to the body, bodyS = a straight`);
console.log(`${''.padEnd(18)} ${'BEFORE'.padEnd(37)} AFTER`);
for (const k of CLASSES) for (const g of GR) console.log(`${`${k} ${g}`.padEnd(18)} ${cell(B(`${k}_${g}`)).padEnd(37)} ${cell(E(`${k}_${g}`))}`);
console.log(`\nTIER GAPS — energy, dB (and what changes in character)`);
console.log(`${''.padEnd(10)} glancing→clean  before / after     clean→flush  before / after     flush length × clean  before / after`);
for (const k of CLASSES) {
  const b = GR.map(g => B(`${k}_${g}`)), a = GR.map(g => E(`${k}_${g}`));
  console.log(`${k.padEnd(10)} ${f1(b[1].energy - b[0].energy).padStart(22)} / ${f1(a[1].energy - a[0].energy)}   ${f1(b[2].energy - b[1].energy).padStart(22)} / ${f1(a[2].energy - a[1].energy)}   ${(b[2].dur / b[1].dur).toFixed(1).padStart(24)} / ${(a[2].dur / a[1].dur).toFixed(1)}`);
}
const cm = k => `${(k.punchIn * 100).toFixed(1).padStart(5)} ${(k.shake * 1000).toFixed(1).padStart(5)} ${(k.jolt * 100).toFixed(1).padStart(5)}`;
console.log(`\nTIERS — CAMERA (punch-in cm, shake mm, jolt cm)      BEFORE              AFTER`);
for (const [n, k] of Object.entries(results.show.cam)) console.log(`${n.padEnd(22)} ${cm(results.showBefore.cam[n]).padStart(30)}   ${cm(k)}`);
console.log(`\nTIERS — CROWD (excitement nudge from rest; the reaction it voices)`);
for (const [n, k] of Object.entries(results.show.crowd)) {
  const b = results.showBefore.crowd[n];
  console.log(`${n.padEnd(22)} ${b.delta.toFixed(3)} ${`[${b.voices.join('+')}]`.padEnd(44)} → ${k.delta.toFixed(3)} [${k.voices.join('+')}]${k.impact ? `  ring: ${k.impact.join('+') || '—'}` : ''}`);
}
const arc = l => l.map(p => `${p.t}s ${p.e.toFixed(2)}${p.hush > 0.05 ? `(hush ${p.hush.toFixed(1)})` : ''}`).join('  ');
console.log(`\nKNOCKDOWN ARCS — the crowd's excitement second by second\n  heavy: ${arc(results.heavyArc)}\n  flash: ${arc(results.flashArc)}\n  out:   ${arc(results.outArc)}`);

// ── design intent, in numbers ──
let pass = 0, fail = 0;
const check = (ok, msg) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'} ${msg}`); };
console.log('\nDESIGN CHECKS');
for (const k of CLASSES) {
  const g = E(`${k}_glancing`), c = E(`${k}_clean`), f = E(`${k}_flush`);
  check(c.energy - g.energy >= 8 && c.peak > g.peak, `${k}: glancing is a tier under clean (${f1(c.energy - g.energy)} dB energy ≥ 8)`);
  check(g.low < 0.1 && g.dur < 0.08, `${k}: glancing is thin and short (${pc(g.low)}% under 200 Hz, ${g.dur.toFixed(2)} s)`);
  check(f.energy - c.energy >= 3 && f.peak > c.peak, `${k}: flush is a tier over clean (${f1(f.energy - c.energy)} dB energy ≥ 3)`);
  const ring = k.startsWith('body') ? 1.25 : 1.8;   // a clean body shot already carries its breath, so the flush one has less to add in length
  check(f.dur >= c.dur * ring, `${k}: flush rings on (${c.dur.toFixed(2)} → ${f.dur.toFixed(2)} s, ≥ ${ring}×)`);
}
// The crack, as energy above 2 kHz in dB (a share of the total says nothing on a sound that is mostly sub).
const top = r => r.energy + 10 * Math.log10(Math.max(1e-12, r.high));
// (A flush jab / cross always had its crack — what it gained is the tail; a flush hook had none: that one must have grown.)
for (const k of ['jab', 'cross', 'hook', 'uppercut']) check(top(E(`${k}_flush`)) >= top(E(`${k}_clean`)) + 1.5 && (k === 'jab' || k === 'cross' || top(E(`${k}_flush`)) >= top(B(`${k}_flush`)) + 6) && E(`${k}_flush`).low > 0.5, `${k}: flush has a crack on top of a body (energy above 2 kHz ${f1(top(B(`${k}_flush`)))} → ${f1(top(E(`${k}_flush`)))} dB; a clean one ${f1(top(E(`${k}_clean`)))}; ${pc(E(`${k}_flush`).low)}% under 200 Hz)`);
const RC = results.recipes;
check(RC.impactBody.centroid < RC.impactHeavy.centroid && RC.impactHeavy.centroid < RC.impactSharp.centroid, `the whump is lower than the thud is lower than the crack (${Math.round(RC.impactBody.centroid)} < ${Math.round(RC.impactHeavy.centroid)} < ${Math.round(RC.impactSharp.centroid)} Hz centroid)`);
check(E('body_clean').low > 0.85 && E('body_clean').low > E('cross_clean').low, `a body shot with its breath is still a low sound (${pc(E('body_clean').low)}% under 200 Hz; a cross ${pc(E('cross_clean').low)}%)`);
check(E('cross_clean').high > 0.4, `sharp owns the top (${pc(E('cross_clean').high)}% above 2 kHz)`);
check(E('hook_clean').low > 0.5, `heavy owns the bottom (${pc(E('hook_clean').low)}% under 200 Hz)`);
check(E('block_fresh').mid > 0.7 && E('block_fresh').mid > E('cross_clean').mid && E('block_fresh').mid > E('hook_clean').mid, `blocked owns the middle (${pc(E('block_fresh').mid)}% between; cross ${pc(E('cross_clean').mid)}%, hook ${pc(E('hook_clean').mid)}%)`);
check(E('body_clean').high < 0.05 && E('body_flush').high < 0.05 && E('finisher_body').high < 0.05, `the body family has no crack, even flush or as a finisher (${pc(E('body_clean').high)} / ${pc(E('body_flush').high)} / ${pc(E('finisher_body').high)}% above 2 kHz)`);
// The combination: 1 < 2 < 3 < 4 in level, each pitched up, and the finisher over all of them.
const cb = [1, 2, 3, 4].map(i => E(`combo_${i}`));
check(cb[1].energy > cb[0].energy + 0.5 && cb[2].energy > cb[1].energy + 0.5 && cb[3].energy > cb[2].energy + 0.5, `a combination builds punch by punch (${cb.map(c => f1(c.energy)).join(' →')} dB; before ${[1, 2, 3, 4].map(i => f1(B(`combo_${i}`).energy)).join(' →')})`);
const fin = E('finisher_hook');
check(fin.energy >= cb[3].energy + 6 && fin.energy >= E('hook_flush').energy + 2 && fin.dur > E('hook_flush').dur, `the finisher is the biggest land of the exchange (${f1(fin.energy)} dB, ${fin.dur.toFixed(2)} s; the 4th punch ${f1(cb[3].energy)}, a flush hook ${f1(E('hook_flush').energy)} dB / ${E('hook_flush').dur.toFixed(2)} s; before it was ${f1(B('finisher_hook').energy)})`);
check(fin.centroid < E('hook_clean').centroid * 3 && E('finisher_cross').low > 0.5, `…and it lands low (a finishing cross is ${pc(E('finisher_cross').low)}% under 200 Hz; a clean cross ${pc(E('cross_clean').low)}%)`);
// Zone and variation. (The noise buffer is new each run, so the centroid of a 40 ms sound wanders: the variation measured 3–9% apart over three runs, hence the 1.5% bar.)
const zones = ['chin', 'jaw', 'temple', 'nose', 'forehead'].map(z => E(`zone_${z}`));
const distinct = zones.every((a, i) => zones.every((b, j) => i >= j || Math.abs(a.centroid - b.centroid) / b.centroid > 0.015 || Math.abs(a.energy - b.energy) > 0.25));
check(distinct, `five head zones are five different sounds (centroids ${zones.map(z => Math.round(z.centroid)).join(' / ')} Hz)`);
check(E('zone_ribs').centroid > E('zone_belly').centroid && E('zone_solar').mid > E('zone_belly').mid, `ribs are brighter than the belly, the solar plexus breathier (${Math.round(E('zone_ribs').centroid)} vs ${Math.round(E('zone_belly').centroid)} Hz)`);
check(Math.abs(E('vary_minus').centroid - E('vary_plus').centroid) / E('vary_plus').centroid > 0.015, `the seeded variation is audible in pitch (${Math.round(E('vary_minus').centroid)} vs ${Math.round(E('vary_plus').centroid)} Hz centroid)`);
check(Math.abs(E('vary_plus').peak - E('vary_plus_again').peak) < 0.01 && Math.abs(E('vary_plus').energy - E('vary_plus_again').energy) < 0.01, `…and deterministic: the same land renders the same twice (${E('vary_plus').peak.toFixed(3)} / ${E('vary_plus_again').peak.toFixed(3)} dBFS)`);
// The nerfed punch.
check(E('cross_clean').energy - E('nerf_cross_full').energy >= 4 && E('nerf_cross_half').energy < E('cross_clean').energy && E('nerf_cross_half').energy > E('nerf_cross_full').energy, `a nerfed punch lands lighter, by how nerfed (${f1(E('cross_clean').energy)} → ${f1(E('nerf_cross_half').energy)} → ${f1(E('nerf_cross_full').energy)} dB)`);
check(E('whiff_nerf').energy < E('whiff').energy - 4 && E('whiff_nerf').dur < E('whiff').dur && E('whiff_nerf').centroid < E('whiff').centroid, `…and its whoosh is quieter, shorter and duller (${f1(E('whiff').energy)} → ${f1(E('whiff_nerf').energy)} dB, ${E('whiff').dur.toFixed(2)} → ${E('whiff_nerf').dur.toFixed(2)} s, ${Math.round(E('whiff').centroid)} → ${Math.round(E('whiff_nerf').centroid)} Hz)`);
// Kinds.
const C = results.show.crowd, sig = n => C[n].voices.join('+');
const kd = ['knockdown_health', 'knockdown_flash', 'knockdown_knee', 'knockdown_out'];
check(new Set(kd.map(sig)).size === 4, `four kinds of knockdown, four crowd reactions (${kd.map(n => `${n.slice(10)}: ${sig(n)}`).join('; ')})`);
check(C.ko_waved.voices.length === 0 && C.ko.voices.includes('crowdOvation') && C.countTick.voices.length === 0 && C.countTick.impact.length === 0, 'a waved-off KO gets no ovation and no count sound (a counted KO still gets the ovation)');
check(results.outArc[1].e > 0.8 && results.outArc.at(-1).e < 0.2 && results.outArc.at(-1).hush > 0.8, `out cold: the roar, then the house drops away (excitement ${results.outArc[1].e.toFixed(2)} at 1 s → ${results.outArc.at(-1).e.toFixed(2)} at 8 s, hush ${results.outArc.at(-1).hush.toFixed(1)})`);
check(results.flashArc[3].e < results.heavyArc[3].e - 0.15 && results.flashArc.every(p => p.hush < 0.1), `a flash knockdown settles fast and is never hushed (3 s after: ${results.flashArc[3].e.toFixed(2)} vs a heavy one's ${results.heavyArc[3].e.toFixed(2)})`);
const hs = ['hurtStyle_legs', 'hurtStyle_reach', 'hurtStyle_cover', 'hurtStyle_elbow', 'hurtStyle_knee', 'hurtStyle_fold_late'];
check(new Set(hs.map(n => `${C[n].impact.join('+')}|${sig(n)}`)).size === hs.length && hs.every(n => C[n].impact.length > 0), `each kind of hurt has its own sound (${hs.map(n => `${n.slice(10)}: ${C[n].impact.join('+')}${C[n].voices.length ? ` / ${sig(n)}` : ''}`).join('; ')})`);
// Camera and crowd tiers.
const K = results.show.cam;
check(['jab', 'cross', 'hook', 'uppercut', 'body'].every(k => K[`${k}_glancing`].punchIn === 0 && K[`${k}_glancing`].shake === 0), 'camera: a glancing land does not move the lens');
check(K.jab_clean.punchIn < K.cross_clean.punchIn && K.cross_clean.punchIn < K.hook_clean.punchIn, `camera: a clean land pushes in by its power (jab ${cm(K.jab_clean).trim()} < cross < hook ${cm(K.hook_clean).trim()}; before all ${(results.showBefore.cam.jab_clean.punchIn * 100).toFixed(1)} cm)`);
check(['jab', 'cross', 'hook', 'uppercut'].every(k => K[`${k}_flush`].punchIn > K[`${k}_clean`].punchIn * 1.4 && K[`${k}_flush`].shake > K[`${k}_clean`].shake * 1.5 && K[`${k}_flush`].jolt > 0), 'camera: a flush land pushes further, shakes harder and jolts');
check(Object.entries(K).every(([n, k]) => n.startsWith('finisher') || (K.finisher_hook.punchIn > k.punchIn && K.finisher_hook.shake >= k.shake && K.finisher_hook.jolt > k.jolt)), `camera: the finisher is the biggest move a land can make (${cm(K.finisher_hook).trim()})`);
check(['jab', 'cross', 'hook', 'body'].every(k => C[`${k}_glancing`].delta === 0 && C[`${k}_glancing`].voices.length === 0), 'crowd: a glancing land is nothing to the house');
check(['jab', 'cross', 'hook'].every(k => C[`${k}_flush`].voices.includes('crowdIntake') && C[`${k}_flush`].delta > C[`${k}_clean`].delta * 2), 'crowd: a flush land gets the intake, then the answer, and over twice the nudge');
check(C.finisher_hook.delta > C.hook_flush.delta && C.finisher_hook.voices.includes('crowdCheer'), `crowd: the finisher pops (nudge ${C.finisher_hook.delta.toFixed(2)} vs a flush hook ${C.hook_flush.delta.toFixed(2)})`);
// The rest of the mix.
const quietest = Object.entries(RC).filter(([, r]) => r.bus === 'crowd').sort((a, b) => a[1].rms - b[1].rms)[0];
check(quietest[1].rms >= results.scenes['bed_0.2'].rms - 6, `every crowd reaction can be heard over the resting bed (quietest ${quietest[0]} ${f1(quietest[1].rms)} dB RMS vs bed ${f1(results.scenes['bed_0.2'].rms)})`);
check(E('block_worn').centroid < E('block_fresh').centroid && E('block_worn').rms > E('block_fresh').rms, `a worn guard blocks duller and heavier (${Math.round(E('block_fresh').centroid)} → ${Math.round(E('block_worn').centroid)} Hz, ${f1(E('block_fresh').rms)} → ${f1(E('block_worn').rms)} dB)`);
check(E('overhand_clean').low > E('cross_clean').low && E('overhand_clean').dur > E('cross_clean').dur, 'overhand heavier and longer than a cross');
check(E('shovel_clean').dur < E('hook_clean').dur && E('shovel_clean').centroid < E('hook_clean').centroid + 1, 'shovel hook shorter and no brighter than a hook');
check(E('wrongWay_clean').energy > E('cross_flush').energy - 0.01, 'slipping into one sounds at least as bad as a flush shot');
const rest = Object.entries(results.events).filter(([n, r]) => r.impact && n !== 'counter_flush_hook' && !n.startsWith('finisher')).sort((a, b) => b[1].impact.peak - a[1].impact.peak)[0];
check(E('counter_flush_hook').peak >= rest[1].impact.peak, `a flush counter hits harder than any land that is not a finisher (peak ${f1(E('counter_flush_hook').peak)} vs next, ${rest[0]}, ${f1(rest[1].impact.peak)} dBFS before the limiter)`);
check(E('body_liver').low > E('body_flush').low - 0.02 && E('body_liver').energy > E('body_flush').energy, 'the liver shot is lower / heavier than a flush body shot');
check(S.combo.peak <= -1, `no clipping in the 1-2-3 with its finisher (peak ${f1(S.combo.peak)} dBFS ≤ −1)`);
check(S.worst.peak <= -1, `no clipping in the worst overlap — a flush counter that is also a finisher, the eruption, the bed at full (peak ${f1(S.worst.peak)} dBFS ≤ −1)`);
check(S.fight20.peak <= -1, `no clipping across the 20 s fight (peak ${f1(S.fight20.peak)} dBFS ≤ −1)`);
const gap = E('cross_clean').rms - S['bed_0.2'].rms, gapHot = E('cross_clean').rms - S.bed_1.rms;
check(gap >= 10, `the resting bed sits well under a clean cross (${gap.toFixed(1)} dB RMS gap ≥ 10)`);
check(gapHot >= 3, `even the full-excitement bed stays under a clean cross (${gapHot.toFixed(1)} dB ≥ 3)`);
check(S.bed_1.rms > S['bed_0.6'].rms && S['bed_0.6'].rms > S['bed_0.2'].rms && S.bed_1.centroid > S['bed_0.2'].centroid, `the bed rises and brightens with excitement (${f1(S['bed_0.2'].rms)} → ${f1(S.bed_1.rms)} dB, ${Math.round(S['bed_0.2'].centroid)} → ${Math.round(S.bed_1.centroid)} Hz)`);
const QUIET = ['liverShot', 'hurtStyle_fold', 'ko_waved', 'countTick'];
check(results.silent.every(n => QUIET.includes(n)), `every event shape makes a sound, bar the ones meant not to (silent: ${results.silent.join(', ') || 'none'})`);
check(logs.length === 0, `console clean (${logs.length})`);
logs.forEach(l => console.log(`    ${l}`));
writeFileSync(resolve(OUT, 'numbers.json'), JSON.stringify(results, null, 1));
console.log(`\n${pass}/${pass + fail} design checks passed — WAVs and numbers.json in ${OUT}`);
if (fail) process.exit(1);
