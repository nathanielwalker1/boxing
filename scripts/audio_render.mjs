/**
 * audio_render.mjs — the sound, as files and numbers (nobody can hear a
 * headless run). Renders through an OfflineAudioContext in headless Chromium,
 * using the SAME modules the game plays with (ui/audio/recipes, voice, map,
 * crowd), and writes 16-bit WAVs to scripts/output/audio/:
 *
 *   recipes/<name>.wav     every recipe alone, at power 1, no jitter, at the level its bus gives it
 *   events/<label>.wav     what real event shapes ask for (grade tiers, combo, variants, through, wrongWay, liver, guard wear…)
 *   bed_<e>.wav            the crowd bed at rest / warm / full excitement
 *   worst.wav              the worst realistic overlap through the limiter: flush counter + eruption + bed at full
 *   fight20.wav            20 s of an AI-vs-AI fight: the sim's own events, the mood's reactions, the bed following
 *
 * For each: peak dBFS, RMS dBFS (over the sounding part), duration (to −40 dB
 * under the peak), spectral centroid, and the energy split low (<200 Hz) /
 * mid / high (>2 kHz). Then the design intent, checked in numbers (PASS/FAIL).
 * This does not replace ears; it catches the gross errors.
 *
 *   PORT=<port> node scripts/audio_render.mjs          (dev server must be running)
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output', 'audio');
for (const d of ['', 'recipes', 'events']) mkdirSync(resolve(OUT, d), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/GPU stall due to ReadPixels/.test(m.text())) logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.goto(`${DEV_URL}/?ai=0&menu=0`, { waitUntil: 'domcontentloaded', timeout: 30000 });

const results = await page.evaluate(async () => {
  const SR = 48000;
  const [{ RECIPES }, { playVoice, makeNoise, buildMaster },{ voicesForEvent, voicesForReaction }, { CrowdBed }, { CrowdMood }, core, sim, ai, style] = await Promise.all([
    import('/src/ui/audio/recipes.ts'), import('/src/ui/audio/voice.ts'), import('/src/ui/audio/map.ts'), import('/src/ui/audio/crowd.ts'),
    import('/src/render/mood.ts'), import('/src/core/index.ts'), import('/src/sim/index.ts'), import('/src/ai/index.ts'), import('/src/ai/style.ts'),
  ]);
  const cfg = core.createConfig();
  cfg.audioPitchJitter = 0; cfg.audioVolumeJitter = 0;

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
    let sq = 0;
    for (let i = first; i <= last; i++) sq += mono[i] * mono[i];
    const rms = Math.sqrt(sq / Math.max(1, last - first + 1));
    let N = 1; while (N < n) N <<= 1; N = Math.min(N, 1 << 20);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < Math.min(n, N); i++) re[i] = mono[i];
    fft(re, im);
    let tot = 0, cen = 0, lo = 0, hi = 0;
    for (let k = 1; k < N / 2; k++) { const p = re[k] * re[k] + im[k] * im[k], f = k * SR / N; tot += p; cen += p * f; if (f < 200) lo += p; else if (f > 2000) hi += p; }
    tot = Math.max(tot, 1e-20);
    return { peak: db(peak), rms: db(rms), dur: (last - first) / SR, centroid: cen / tot, low: lo / tot, mid: 1 - (lo + hi) / tot, high: hi / tot };
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
  /** Schedule one request the way CombatAudio.play does. Returns when it ends. */
  function schedule(ctx, buses, req, at) {
    const recipe = RECIPES[req.name];
    if (!recipe) throw new Error(`no recipe '${req.name}'`);
    const crowd = recipe.bus === 'crowd';
    const level = crowd ? cfg.audioReactionGain : cfg.audioMasterVolume;
    const gain = level * recipe.gain * (0.75 + 0.25 * Math.min(2, req.power ?? 1));
    return playVoice(ctx, crowd ? buses.crowd : buses.impact, recipe, buffers, { when: at + (req.delay ?? 0), pitch: req.pitch ?? 1, gain, sub: cfg.audioFlushSub, length: req.length ?? 1 });
  }
  /** The live graph: impact + crowd buses → limiter → out (limiter optional, to measure a bus raw). */
  function graph(ctx, limit) {
    let out = ctx.destination;
    if (limit) out = buildMaster(ctx, cfg.audioCeilingDb);
    const impact = ctx.createGain(); impact.gain.value = cfg.audioImpactVolume; impact.connect(out);
    const crowd = ctx.createGain(); crowd.gain.value = cfg.audioCrowdVolume * cfg.audioMasterVolume; crowd.connect(out);
    return { impact, crowd };
  }
  async function render(seconds, limit, build) {
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * seconds), SR);
    const buses = graph(ctx, limit);
    await build(ctx, buses);
    const buf = await ctx.startRendering();
    return { ...analyse(buf), wav: wav(buf) };
  }
  const lengthOf = reqs => Math.max(0.2, ...reqs.map(r => { const rc = RECIPES[r.name]; return (r.delay ?? 0) + Math.max(...rc.layers.map(l => (l.delay ?? 0) + (l.attack ?? 0.001) + ((l.hold ?? 0) + (l.decay ?? 0.1)) * (r.length ?? 1))); })) + 0.15;

  const out = { recipes: {}, events: {}, scenes: {} };
  for (const name of Object.keys(RECIPES)) {
    const reqs = [{ name }];
    out.recipes[name] = await render(lengthOf(reqs), false, (ctx, b) => { schedule(ctx, b, reqs[0], 0.02); });
    out.recipes[name].bus = RECIPES[name].bus ?? 'impact';
  }

  // ── events, as the sim shapes them ──
  const land = (o) => ({ type: 'punchLand', side: 0, target: 1, punch: 'cross', hand: 'rear', part: 'head', at: { x: 0, y: 1.6, z: 0 }, impulse: { x: 1, y: 0, z: 0 }, power: 1,
    counter: false, variant: 'cross', grade: 'clean', combo: 1, liver: false, through: false, wrongWay: false, ...o });
  const block = (o) => ({ type: 'punchBlock', side: 0, target: 1, punch: 'cross', at: { x: 0, y: 1.5, z: 0 }, variant: 'cross', part: 'head', chip: 0, guard: 1, stun: 0.1, ...o });
  const EVENTS = {
    jab_glancing: land({ punch: 'jab', variant: 'jab', grade: 'glancing', power: 0.7 }), jab_clean: land({ punch: 'jab', variant: 'jab', power: 0.7 }), jab_flush: land({ punch: 'jab', variant: 'jab', grade: 'flush', power: 0.7 }),
    cross_glancing: land({ grade: 'glancing' }), cross_clean: land({}), cross_flush: land({ grade: 'flush' }),
    hook_glancing: land({ punch: 'hook', variant: 'hook', grade: 'glancing', power: 1.4 }), hook_clean: land({ punch: 'hook', variant: 'hook', power: 1.4 }), hook_flush: land({ punch: 'hook', variant: 'hook', grade: 'flush', power: 1.4 }),
    body_glancing: land({ punch: 'hook', variant: 'bodyHook', part: 'body', grade: 'glancing', power: 1.2 }), body_clean: land({ punch: 'hook', variant: 'bodyHook', part: 'body', power: 1.2 }), body_flush: land({ punch: 'hook', variant: 'bodyHook', part: 'body', grade: 'flush', power: 1.2 }),
    body_liver: land({ punch: 'hook', variant: 'bodyHook', part: 'body', grade: 'flush', power: 1.3, liver: true }),
    combo_1: land({}), combo_2: land({ combo: 2 }), combo_3: land({ combo: 3 }), combo_4: land({ combo: 4 }),
    overhand_clean: land({ variant: 'overhand', power: 1.5 }), shovel_clean: land({ punch: 'hook', variant: 'shovelHook', power: 1.1 }), insideUppercut_clean: land({ punch: 'uppercut', variant: 'insideUppercut', power: 1.1 }),
    through_clean: land({ through: true }), wrongWay_clean: land({ wrongWay: true }),
    counter_flush_hook: land({ punch: 'hook', variant: 'hook', grade: 'flush', power: 1.6, counter: true, combo: 1 }),
    block_fresh: block({ guard: 1 }), block_half: block({ guard: 0.5, chip: 0.01 }), block_worn: block({ guard: 0.1, chip: 0.03 }),
    perfectBlock: { type: 'perfectBlock', side: 0, target: 1, punch: 'jab', at: { x: 0, y: 1.5, z: 0 }, variant: 'jab' },
    guardBreak: { type: 'guardBreak', side: 1, by: 0, seconds: 1 },
    whiff: { type: 'punchWhiff', side: 0, punch: 'hook', variant: 'hook' }, feint: { type: 'feint', side: 0, punch: 'cross', variant: 'cross' },
    slip_dodged: { type: 'slip', side: 0, dir: 1, dodged: true, kind: 'slip', chain: 1 }, pull_dodged: { type: 'slip', side: 0, dir: 2, dodged: true, kind: 'pull', chain: 1 },
    roll_dodged: { type: 'slip', side: 0, dir: 1, dodged: true, kind: 'roll', chain: 1 }, slip_chain3: { type: 'slip', side: 0, dir: -1, dodged: true, kind: 'slip', chain: 3 },
    slip_flick: { type: 'slip', side: 0, dir: 1, dodged: false, kind: 'slip', chain: 1 },
    burst: { type: 'burst', side: 0, x: 0, y: 1 }, pivot: { type: 'pivot', side: 0, dir: 1 }, escape: { type: 'escape', side: 0, how: 'pivot' },
    pushOff_hit: { type: 'pushOff', side: 0, target: 1, hit: true }, clinch: { type: 'clinch', side: 0, target: 1 }, clinchBreak_referee: { type: 'clinchBreak', side: 0, reason: 'referee' },
    liverShot: { type: 'liverShot', side: 1, by: 0, delay: 0.8 }, bodyHurt: { type: 'bodyHurt', side: 1, by: 0, liver: false, seconds: 1.2 }, bodyHurt_liver: { type: 'bodyHurt', side: 1, by: 0, liver: true, seconds: 1.6 },
    getUp_knee: { type: 'getUpPhase', side: 1, phase: 'knee', tries: 1 }, getUp_slump: { type: 'getUpPhase', side: 1, phase: 'slump', tries: 1 }, getUp_rise: { type: 'getUpPhase', side: 1, phase: 'rise', tries: 1 },
    knockdown_health: { type: 'knockdown', side: 1, count: 1, cause: 'health' }, knockdown_body: { type: 'knockdown', side: 1, count: 1, cause: 'body' }, knockdown_flash: { type: 'knockdown', side: 1, count: 1, cause: 'flash' },
    rocked: { type: 'rocked', side: 1, by: 0, punch: 'hook', impulse: 500, threshold: 400, seconds: 2 }, bell: { type: 'bell' },
  };
  /** An event's full sound: its impact voices plus what the crowd answers (a fresh mood per event, so the reaction is the event's own). */
  function voicesAll(e) {
    const reqs = [...voicesForEvent(e, cfg, 0)];
    const m = new CrowdMood();
    m.update(0.016, cfg);
    m.on(r => reqs.push(...voicesForReaction(r)));
    m.handle([e], cfg);
    return reqs;
  }
  out.silent = [];
  for (const [label, e] of Object.entries(EVENTS)) {
    const impactOnly = voicesForEvent(e, cfg, 0), all = voicesAll(e);
    if (!all.length) { out.silent.push(label); continue; }
    const r = await render(lengthOf(all), false, (ctx, b) => { for (const q of all) schedule(ctx, b, q, 0.02); });
    r.voices = all.map(q => q.name).join(' + ');
    // The impact bus alone, for the tier comparisons (the crowd's answer is measured in the scenes).
    if (impactOnly.length) { const i = await render(lengthOf(impactOnly), false, (ctx, b) => { for (const q of impactOnly) schedule(ctx, b, q, 0.02); }); r.impact = { peak: i.peak, rms: i.rms, dur: i.dur, centroid: i.centroid, low: i.low, mid: i.mid, high: i.high }; }
    out.events[label] = r;
  }

  // ── the bed, raw, at three moods ──
  for (const e of [0.2, 0.6, 1]) {
    out.scenes[`bed_${e}`] = await render(6, false, async (ctx, b) => { const bed = new CrowdBed(ctx, cfg, b.crowd, noise); await bed.ready; bed.update(e, 0, 0, 0.001); });
  }
  // ── the worst realistic overlap, through the limiter ──
  out.scenes.worst = await render(5, true, async (ctx, b) => {
    const bed = new CrowdBed(ctx, cfg, b.crowd, noise); await bed.ready; bed.update(1, 0, 0, 0.001);
    const hit = EVENTS.counter_flush_hook;
    for (const q of voicesForEvent(hit, cfg, 0)) schedule(ctx, b, q, 1);
    for (const kind of ['counter', 'knockdown']) for (const q of voicesForReaction({ kind, strength: 1, pos: null })) schedule(ctx, b, q, 1);
    for (const q of voicesForEvent(EVENTS.knockdown_health, cfg, 0)) schedule(ctx, b, q, 1.05);
  });

  // ── 20 s of a real fight: AI against AI, the sim's own events ──
  {
    const specs = [core.ROSTER[0], core.ROSTER[1]];
    const SECONDS = 20;
    let s = sim.createState(specs, cfg, 7);
    let a0 = ai.createAi(0, 7, cfg, style.styleFor(specs[0], cfg)), a1 = ai.createAi(1, 8, cfg, style.styleFor(specs[1], cfg));
    const timeline = [];           // { t, reqs }
    const moodLine = [];           // { t, e, hush }
    const m = new CrowdMood();
    let now = 0;
    m.on(r => timeline.push({ t: now, reqs: voicesForReaction(r) }));
    const counts = {};
    for (let tick = 0; tick < SECONDS * 60; tick++) {
      now = tick / 60;
      const d0 = ai.aiStep(a0, s, cfg), d1 = ai.aiStep(a1, s, cfg);
      a0 = d0.ai; a1 = d1.ai;
      const r = sim.step(s, [d0.input, d1.input], cfg);
      s = r.state;
      for (const e of r.events) { counts[e.type] = (counts[e.type] ?? 0) + 1; const reqs = voicesForEvent(e, cfg, 0); if (reqs.length) timeline.push({ t: now, reqs }); }
      m.handle(r.events, cfg); m.update(1 / 60, cfg);
      if (tick % 6 === 0) moodLine.push({ t: now, e: m.value, hush: m.hush });
    }
    out.scenes.fight20 = await render(SECONDS + 3, true, async (ctx, b) => {
      const bed = new CrowdBed(ctx, cfg, b.crowd, noise); await bed.ready;
      bed.update(moodLine[0].e, 0, 0, 0.001);
      for (const p of moodLine) bed.update(p.e, p.hush, p.t);
      for (const item of timeline) for (const q of item.reqs) schedule(ctx, b, q, item.t + 0.02);
    });
    out.scenes.fight20.events = counts;
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
for (const [n, r] of Object.entries(results.scenes)) save(`${n}.wav`, r);

// ── tables ──
const f1 = x => x.toFixed(1).padStart(6), pc = x => `${Math.round(x * 100)}`.padStart(3);
const row = (n, r) => `${n.padEnd(22)} ${f1(r.peak)} ${f1(r.rms)} ${r.dur.toFixed(2).padStart(5)} ${String(Math.round(r.centroid)).padStart(5)}   ${pc(r.low)}/${pc(r.mid)}/${pc(r.high)}`;
const head = `${'name'.padEnd(22)}   peak    rms   dur  cent   low/mid/high %   (dBFS, dBFS, s, Hz)`;
console.log(`\nRECIPES (alone, power 1, at bus level)\n${head}`);
for (const [n, r] of Object.entries(results.recipes)) console.log(row(n, r) + (r.bus === 'crowd' ? '  crowd' : ''));
console.log(`\nEVENTS — impact bus only\n${head}`);
for (const [n, r] of Object.entries(results.events)) if (r.impact) console.log(row(n, r.impact) + `  ${r.voices}`);
console.log(`\nEVENTS with no impact voice (crowd only)`);
for (const [n, r] of Object.entries(results.events)) if (!r.impact) console.log(row(n, r) + `  ${r.voices}`);
console.log(`\nSCENES\n${head}`);
for (const [n, r] of Object.entries(results.scenes)) console.log(row(n, r));
const fight = results.scenes.fight20;
console.log(`fight20: ${fight.voices} voices; excitement ${fight.excite[0].toFixed(2)}–${fight.excite[1].toFixed(2)}; events ${Object.entries(fight.events).map(([k, v]) => `${k} ${v}`).join(', ')}`);
if (results.silent.length) console.log(`\nSILENT events (no voice at all): ${results.silent.join(', ')}`);

// ── design intent, in numbers ──
let pass = 0, fail = 0;
const check = (ok, msg) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'} ${msg}`); };
const E = n => results.events[n].impact, S = results.scenes;
console.log('\nDESIGN CHECKS');
for (const k of ['jab', 'cross', 'hook', 'body']) {
  const g = E(`${k}_glancing`), c = E(`${k}_clean`), f = E(`${k}_flush`);
  check(f.rms > c.rms - 0.01 && c.rms > g.rms && f.peak > c.peak && c.peak > g.peak, `${k}: flush louder than clean louder than glancing (peak ${f1(g.peak)} < ${f1(c.peak)} < ${f1(f.peak)})`);
  check(f.dur > c.dur && c.dur > g.dur, `${k}: flush longer than clean longer than glancing (${g.dur.toFixed(2)} < ${c.dur.toFixed(2)} < ${f.dur.toFixed(2)} s)`);
}
const RC = results.recipes;
check(RC.impactBody.centroid < RC.impactHeavy.centroid && RC.impactHeavy.centroid < RC.impactSharp.centroid, `the whump is lower than the thud is lower than the crack (${Math.round(RC.impactBody.centroid)} < ${Math.round(RC.impactHeavy.centroid)} < ${Math.round(RC.impactSharp.centroid)} Hz centroid)`);
check(E('body_clean').low > 0.85 && E('body_clean').low > E('cross_clean').low, `a body shot with its breath is still a low sound (${pc(E('body_clean').low)}% under 200 Hz; a cross ${pc(E('cross_clean').low)}%)`);
check(E('cross_clean').high > 0.4, `sharp owns the top (${pc(E('cross_clean').high)}% above 2 kHz)`);
check(E('hook_clean').low > 0.5, `heavy owns the bottom (${pc(E('hook_clean').low)}% under 200 Hz)`);
check(E('block_fresh').mid > 0.7 && E('block_fresh').mid > E('cross_clean').mid && E('block_fresh').mid > E('hook_clean').mid, `blocked owns the middle (${pc(E('block_fresh').mid)}% between; cross ${pc(E('cross_clean').mid)}%, hook ${pc(E('hook_clean').mid)}%)`);
check(E('body_clean').high < 0.05, `body has no crack (${pc(E('body_clean').high)}% above 2 kHz)`);
// Noise layers start at a random offset, so two renders of one recipe differ by about a dB: the combination has to clear that.
check(E('combo_3').rms > E('combo_1').rms + 1 && E('combo_4').rms > E('combo_2').rms, `combination builds: the 3rd punch is over 1 dB RMS louder than the 1st (${f1(E('combo_1').rms)} → ${f1(E('combo_3').rms)} → ${f1(E('combo_4').rms)})`);
const quietest = Object.entries(RC).filter(([, r]) => r.bus === 'crowd').sort((a, b) => a[1].rms - b[1].rms)[0];
check(quietest[1].rms >= results.scenes['bed_0.2'].rms - 6, `every crowd reaction can be heard over the resting bed (quietest ${quietest[0]} ${f1(quietest[1].rms)} dB RMS vs bed ${f1(results.scenes['bed_0.2'].rms)})`);
check(E('block_worn').centroid < E('block_fresh').centroid && E('block_worn').rms > E('block_fresh').rms, `a worn guard blocks duller and heavier (${Math.round(E('block_fresh').centroid)} → ${Math.round(E('block_worn').centroid)} Hz, ${f1(E('block_fresh').rms)} → ${f1(E('block_worn').rms)} dB)`);
check(E('overhand_clean').low > E('cross_clean').low && E('overhand_clean').dur > E('cross_clean').dur, 'overhand heavier and longer than a cross');
check(E('shovel_clean').dur < E('hook_clean').dur && E('shovel_clean').centroid < E('hook_clean').centroid + 1, 'shovel hook shorter and no brighter than a hook');
check(E('wrongWay_clean').peak > E('cross_flush').peak - 0.01, 'slipping into one sounds at least as bad as a flush shot');
const loudest = Math.max(...Object.entries(results.events).filter(([n]) => n !== 'counter_flush_hook').map(([, r]) => (r.impact ? r.impact.peak : -99)));
check(E('counter_flush_hook').peak >= loudest, `the counter is the heaviest impact (${f1(E('counter_flush_hook').peak)} vs next ${f1(loudest)} dBFS)`);
check(E('body_liver').low > E('body_flush').low - 0.001 && E('body_liver').dur > E('body_flush').dur - 0.001, 'the liver shot is lower / longer than a flush body shot');
check(S.worst.peak <= -1, `no clipping in the worst overlap (peak ${f1(S.worst.peak)} dBFS ≤ −1)`);
check(S.fight20.peak <= -1, `no clipping across the 20 s fight (peak ${f1(S.fight20.peak)} dBFS ≤ −1)`);
const gap = E('cross_clean').rms - S['bed_0.2'].rms, gapHot = E('cross_clean').rms - S.bed_1.rms;
check(gap >= 10, `the resting bed sits well under a clean cross (${gap.toFixed(1)} dB RMS gap ≥ 10)`);
check(gapHot >= 3, `even the full-excitement bed stays under a clean cross (${gapHot.toFixed(1)} dB ≥ 3)`);
check(S.bed_1.rms > S['bed_0.6'].rms && S['bed_0.6'].rms > S['bed_0.2'].rms && S.bed_1.centroid > S['bed_0.2'].centroid, `the bed rises and brightens with excitement (${f1(S['bed_0.2'].rms)} → ${f1(S.bed_1.rms)} dB, ${Math.round(S['bed_0.2'].centroid)} → ${Math.round(S.bed_1.centroid)} Hz)`);
check(results.silent.length === 0 || results.silent.every(n => ['liverShot'].includes(n)), `every event shape makes a sound (silent: ${results.silent.join(', ') || 'none'})`);
check(logs.length === 0, `console clean (${logs.length})`);
logs.forEach(l => console.log(`    ${l}`));
writeFileSync(resolve(OUT, 'numbers.json'), JSON.stringify(results, null, 1));
console.log(`\n${pass}/${pass + fail} design checks passed — WAVs and numbers.json in ${OUT}`);
if (fail) process.exit(1);
