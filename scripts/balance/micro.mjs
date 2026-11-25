/**
 * micro.mjs — small scripted measurements against the frozen rules (human-mode config). One process, prints tables.
 *   node micro.mjs
 * Side 0 is always "the player under test", side 1 the target. 60 ticks = 1 second.
 */
import { makeEnv } from './env.mjs';
const env = makeEnv();
const { core, sim } = env;
const cfg = { ...env.cfg, roundSeconds: 180 };
const inp = (o = {}) => ({ move: { x: 0, y: 0 }, jab: false, cross: false, hook: false, uppercut: false, block: false, level: false, ...o });
const dist = s => Math.hypot(s.fighters[1].pos.x - s.fighters[0].pos.x, s.fighters[1].pos.z - s.fighters[0].pos.z);
const f2 = (v, n = 2) => (v === null || v === undefined || Number.isNaN(v)) ? '-' : (+v).toFixed(n);
const pad = (v, n) => String(v).padStart(n), padr = (v, n) => String(v).padEnd(n);
const spec = (ratings = null) => ratings ? { ...core.ROSTER[0], ratings: { ...core.ROSTER[0].ratings, ...ratings } } : core.ROSTER[0];

/** Both men standing still, centre distance `want`, nothing in flight. */
function stage(want, specs = [spec(), spec()], seed = 7) {
  let s = sim.createState(specs, cfg, seed);
  for (let t = 0; t < 1200; t++) {
    const d = dist(s), a = inp();
    if (d > want + 0.01) a.move.y = Math.min(1, (d - want) * 3 + 0.12); else if (d < want - 0.02) a.move.y = -0.3;
    s = sim.step(s, [a, inp()], cfg).state;
    const v = Math.hypot(s.fighters[0].vel.x, s.fighters[0].vel.z);
    if (Math.abs(d - want) < 0.025 && v < 0.03 && t > 30) break;
  }
  for (let t = 0; t < 45; t++) s = sim.step(s, [inp(), inp()], cfg).state;   // let stance, slip clocks and gloves settle
  for (const f of s.fighters) { f.stamina = 1; f.health = 1; }
  return s;
}

/** Run `ticks` from `s0`; ins(t, s) -> [in0, in1]; hook(t, s) may mutate the state before the step. Returns per-tick trace + events. */
function run(s0, ticks, ins, hook = null) {
  let s = s0; const trace = [], events = [];
  for (let t = 0; t < ticks; t++) {
    if (hook) hook(t, s);
    const r = sim.step(s, ins(t, s), cfg);
    for (const e of r.events) events.push({ t, ...e });
    trace.push({ t, pre: s, post: r.state });
    s = r.state;
  }
  return { s, trace, events };
}
const resolveOf = (events, side, from = 0) => events.find(e => e.t >= from && e.side === side && ['punchLand', 'punchBlock', 'perfectBlock', 'punchWhiff', 'punchSmother'].includes(e.type));

// ───────────────────────────── M1: press -> motion -> hit, per punch ─────────────────────────────
console.log('\n== M1  cold press: ticks to punch start, first glove motion (sim glove), hit test, hands free  (1 tick = 16.7 ms)');
console.log(padr('punch', 16) + pad('start', 6) + pad('glove>1cm', 10) + pad('glove>5cm', 10) + pad('hit', 5) + pad('free', 6) + '  result');
for (const [k, body, D] of [['jab', false, 1.1], ['cross', false, 1.1], ['hook', false, 1.0], ['uppercut', false, 0.95], ['jab', true, 1.1], ['cross', true, 1.1], ['hook', true, 1.0]]) {
  const s0 = stage(D);
  const g0 = s0.fighters[0].gloves.map(g => ({ ...g.pos }));
  const r = run(s0, 90, t => [inp({ [k]: t < 2, level: body && t < 10 }), inp()]);
  const st = r.events.find(e => e.type === 'punchStart' && e.side === 0);
  const res = resolveOf(r.events, 0);
  const hand = r.trace[st ? st.t : 0].post.fighters[0].punch.hand === 'lead' ? 0 : 1;
  const moved = lim => { const x = r.trace.find(q => { const p = q.post.fighters[0].gloves[hand].pos, o = g0[hand]; return Math.hypot(p.x - o.x, p.y - o.y, p.z - o.z) > lim; }); return x ? x.t + 1 : null; };
  const free = r.trace.find(q => st && q.t > st.t && q.post.fighters[0].punch.type === null);
  console.log(padr(k + (body ? ' (body)' : ''), 16) + pad(st ? st.t + 1 : '-', 6) + pad(moved(0.01) ?? '-', 10) + pad(moved(0.05) ?? '-', 10) + pad(res ? res.t + 1 : '-', 5) + pad(free ? free.t + 1 : '-', 6)
    + `  ${res ? res.type + (res.grade ? ' ' + res.grade : '') + (res.part ? ' ' + res.part : '') : 'none'}${st ? ' variant ' + st.variant : ''}`);
}

// block <-> punch
{
  const s0 = stage(1.1);
  const a = run(s0, 80, t => [inp({ block: t < 30, jab: t === 30 || t === 31 }), inp()]);
  const st = a.events.find(e => e.type === 'punchStart' && e.side === 0);
  console.log(`block -> punch: block held 30 ticks, released and jab pressed on the same tick: punch starts ${st ? st.t - 30 + 1 : 'never'} tick(s) after the press`);
  const b = run(s0, 80, t => [inp({ jab: t < 2, block: t >= 3 }), inp()]);
  const fe = b.events.find(e => e.type === 'feint'); const bt = b.trace.find(q => q.t >= 3 && q.post.fighters[0].block);
  console.log(`punch -> block, block pressed 3 ticks into a jab: ${fe ? 'the jab is cancelled (feint) at tick ' + (fe.t + 1) : 'no cancel'}; guard is up ${bt ? bt.t - 3 + 1 : 'never'} tick(s) after the block press`);
  for (const [k, at] of [['jab', 10], ['cross', 14], ['hook', 15], ['uppercut', 15]]) {
    const c = run(stage(k === 'uppercut' ? 0.95 : 1.05), 120, t => [inp({ [k]: t < 2, block: t >= at }), inp()]);
    const res = resolveOf(c.events, 0), ct = c.trace.find(q => q.t >= at && q.post.fighters[0].block), fe2 = c.events.find(e => e.type === 'feint');
    console.log(`punch -> block, block pressed ${at} ticks into a ${k} (past the cancel point): ${fe2 ? 'cancelled' : 'punch ' + (res ? res.type + ' at tick ' + (res.t + 1) : 'unresolved')}; guard up ${ct ? ct.t - at + 1 : 'never'} ticks after the block press`);
  }
}

// movement
{
  let s = sim.createState([spec(), spec()], cfg, 3);
  for (let t = 0; t < 60; t++) s = sim.step(s, [inp(), inp()], cfg).state;
  const p0 = { ...s.fighters[0].pos };
  const fwd = run(s, 90, () => [inp({ move: { x: 0, y: 1 } }), inp()]);
  const sp = q => Math.hypot(q.post.fighters[0].vel.x, q.post.fighters[0].vel.z);
  const top = Math.max(...fwd.trace.map(sp));
  const t1 = fwd.trace.find(q => Math.hypot(q.post.fighters[0].pos.x - p0.x, q.post.fighters[0].pos.z - p0.z) > 0.01);
  const t90 = fwd.trace.find(q => sp(q) >= 0.9 * top);
  console.log(`movement from rest (stick forward): body has moved 1 cm after ${t1 ? t1.t + 1 : '-'} tick(s); 90% of top speed (${top.toFixed(2)} m/s) after ${t90 ? t90.t + 1 : '-'} ticks`);
  const dir = { x: fwd.s.fighters[0].vel.x / top, z: fwd.s.fighters[0].vel.z / top };
  const back = run(fwd.s, 90, () => [inp({ move: { x: 0, y: -1 } }), inp()]);
  const along = q => q.post.fighters[0].vel.x * dir.x + q.post.fighters[0].vel.z * dir.z;
  const zero = back.trace.find(q => along(q) <= 0), topB = Math.min(...back.trace.map(along)), t90b = back.trace.find(q => along(q) <= 0.9 * topB);
  const ev = back.events.filter(e => e.side === 0 && (e.type === 'slip' || e.type === 'burst')).map(e => e.type + (e.kind ? ':' + e.kind : '')).join(',');
  console.log(`reverse (forward at top speed, stick pulled back): moving backward after ${zero ? zero.t + 1 : '-'} ticks; 90% of backward speed (${(-topB).toFixed(2)} m/s) after ${t90b ? t90b.t + 1 : '-'} ticks${ev ? '; side effects: ' + ev : ''}`);
}

// ───────────────────────────── M2: combinations ─────────────────────────────
function combo(seq, D, targetIn = () => inp(), ticks = 260) {
  const s0 = stage(D);
  let started = 0;
  const r = run(s0, ticks, (t, s) => {
    const a = inp();
    if (started < seq.length && t % 3 === 0) { const [k, x] = seq[started]; a[k] = true; if (x) a.move.x = x; }
    return [a, targetIn(t, s)];
  }, (t, s) => { s.fighters[1].health = Math.max(s.fighters[1].health, 0.9); });
  // count starts as they happen (the closure above reads `started`): replay to fill
  return r;
}
function comboRun(seq, D, targetIn) {
  const s0 = stage(D);
  let s = s0, started = 0; const starts = [], res = [];
  let hpLost = 0;
  for (let t = 0; t < 300; t++) {
    const a = inp();
    if (started < seq.length && t % 3 === 0) { const [k, x] = seq[started]; a[k] = true; if (x) a.move.x = x; }
    const before = s.fighters[1].health;
    const r = sim.step(s, [a, targetIn ? targetIn(t, s) : inp()], cfg); s = r.state;
    hpLost += Math.max(0, before - s.fighters[1].health);
    s.fighters[1].health = 1; s.fighters[1].hurt = 0;
    for (const e of r.events) {
      if (e.side !== 0) continue;
      if (e.type === 'punchStart') { started++; starts.push({ t, punch: e.punch, tell: e.tell }); }
      else if (['punchLand', 'punchBlock', 'perfectBlock', 'punchWhiff'].includes(e.type)) res.push({ t, type: e.type, power: e.power ?? 0, grade: e.grade, loaded: s.fighters[0].punch.loaded });
    }
    if (res.length >= seq.length) break;
  }
  return { starts, res, hpLost };
}
console.log('\n== M2  four-punch combinations, pressed as fast as the game accepts (ticks from first press to each hit test; impulse N·s)');
const SEQS = {
  'jab x4': [['jab'], ['jab'], ['jab'], ['jab']],
  'cross x4': [['cross'], ['cross'], ['cross'], ['cross']],
  'hook x4 (neutral stick)': [['hook'], ['hook'], ['hook'], ['hook']],
  'hook x4 (same hand)': [['hook', 1], ['hook', 1], ['hook', 1], ['hook', 1]],
  'uppercut x4': [['uppercut'], ['uppercut'], ['uppercut'], ['uppercut']],
  'jab cross hook cross': [['jab'], ['cross'], ['hook'], ['cross']],
  'jab jab cross hook': [['jab'], ['jab'], ['cross'], ['hook']],
  'jab cross hook upper': [['jab'], ['cross'], ['hook'], ['uppercut']],
  'cross hook cross hook': [['cross'], ['hook'], ['cross'], ['hook']],
};
for (const [label, target] of [['on an open, standing man (all land)', null], ['on a held guard (all blocked)', () => inp({ block: true })]]) {
  console.log(`-- ${label}`);
  console.log(padr('sequence', 26) + pad('hit ticks', 22) + pad('total', 7) + pad('ticks/punch', 12) + pad('impulses', 26) + pad('health%', 9));
  for (const [nm, seq] of Object.entries(SEQS)) {
    const D = seq.some(q => q[0] === 'uppercut') ? 0.95 : 1.02;
    const r = comboRun(seq, D, target);
    const hits = r.res.map(q => q.t + 1), last = hits[hits.length - 1];
    console.log(padr(nm, 26) + pad(hits.join(' '), 22) + pad(last ?? '-', 7) + pad(last ? (last / hits.length).toFixed(1) : '-', 12) + pad(r.res.map(q => q.type === 'punchLand' ? Math.round(q.power) : (q.type === 'punchWhiff' ? 'miss' : 'blk')).join(' '), 26) + pad((100 * r.hpLost).toFixed(1), 9));
  }
}
console.log('-- thrown at air (target 2.4 m away: every punch misses)');
for (const nm of ['jab x4', 'cross x4', 'hook x4 (neutral stick)', 'jab cross hook cross']) {
  const r = comboRun(SEQS[nm], 2.4, null);
  const hits = r.res.map(q => q.t + 1), last = hits[hits.length - 1];
  console.log(padr(nm, 26) + pad(hits.join(' '), 22) + pad(last ?? '-', 7) + pad(last ? (last / hits.length).toFixed(1) : '-', 12));
}

// ───────────────────────────── M3: stamina ─────────────────────────────
console.log('\n== M3  stamina: 15 s of non-stop punching (pressed every 4 ticks). Stamina shown at 5 / 10 / 15 s; 1.00 = full');
function grind(seq, D, targetIn) {
  let s = stage(D), n = 0, thrown = 0, landed = 0; const marks = [];
  const capKeys = Object.keys(s.fighters[0]).filter(k => /cap|wear|work/i.test(k));
  for (let t = 0; t < 900; t++) {
    const a = inp();
    if (t % 4 === 0) { const k = seq[n % seq.length]; a[k] = true; }
    const r = sim.step(s, [a, targetIn ? targetIn(t, s) : inp()], cfg); s = r.state;
    s.fighters[1].health = 1; s.fighters[1].hurt = 0; s.fighters[1].stamina = 1;
    if (s.fighters[1].down) { s.fighters[1].down = false; }
    for (const e of r.events) if (e.side === 0) { if (e.type === 'punchStart') { thrown++; n++; } else if (e.type === 'punchLand') landed++; }
    if (t === 299 || t === 599 || t === 899) marks.push(s.fighters[0].stamina);
  }
  const caps = capKeys.map(k => `${k}=${typeof s.fighters[0][k] === 'number' ? s.fighters[0][k].toFixed(3) : JSON.stringify(s.fighters[0][k])}`).join(' ');
  return { marks, thrown, landed, caps };
}
console.log(padr('what', 44) + pad('thrown', 7) + pad('landed', 7) + pad('5 s', 6) + pad('10 s', 6) + pad('15 s', 6) + '  ceiling fields');
for (const [nm, seq] of [['jabs', ['jab']], ['crosses', ['cross']], ['hooks', ['hook']], ['cross-hook-uppercut', ['cross', 'hook', 'uppercut']], ['jab-cross-hook-cross', ['jab', 'cross', 'hook', 'cross']]]) {
  for (const [how, D, tgt] of [['all land', 1.0, null], ['all blocked', 1.0, () => inp({ block: true })], ['all miss', 2.4, null]]) {
    const r = grind(seq, D, tgt);
    console.log(padr(`${nm}, ${how}`, 44) + pad(r.thrown, 7) + pad(r.landed, 7) + r.marks.map(m => pad(m.toFixed(2), 6)).join('') + '  ' + r.caps);
  }
}
// single-punch cost
console.log('-- one punch, stamina spent (start 1.00, lowest point reached before it recovers)');
for (const k of ['jab', 'cross', 'hook', 'uppercut']) {
  const out = [];
  for (const [how, D, tgt] of [['land', k === 'uppercut' ? 0.95 : 1.0, null], ['blocked', k === 'uppercut' ? 0.95 : 1.0, () => inp({ block: true })], ['miss', 2.4, null]]) {
    const s0 = stage(D); s0.fighters[0].stamina = 0.8;   // below full so regen and cost both show
    const r = run(s0, 120, t => [inp({ [k]: t < 2 }), tgt ? tgt() : inp()]);
    const free = r.trace.find(q => q.t > 3 && q.post.fighters[0].punch.type === null);
    const atFree = free ? free.post.fighters[0].stamina : NaN;
    // the same span doing nothing, for the regen the punch cost him
    const idle = run(s0, free ? free.t + 1 : 60, () => [inp(), tgt ? tgt() : inp()]);
    out.push(`${how} ${(100 * (idle.s.fighters[0].stamina - atFree)).toFixed(2)}% over ${free ? free.t + 1 : '-'} ticks`);
  }
  console.log(padr(k, 10) + out.join('   |   '));
}

// ───────────────────────────── M4: hitting a man who is mid-punch ─────────────────────────────
console.log('\n== M4  the same shot on a set man vs a man who is punching (impulse N·s; health % taken; * = counter flag; R = rocked; KD = knockdown)');
function trade(myPunch, myBody, hisPunch, hisBody, D, off) {
  const s0 = stage(D);
  const t0 = 30;   // his press
  const r = run(s0, 140, t => [inp({ [myPunch]: t === t0 + off || t === t0 + off + 1, level: myBody && t >= t0 + off && t < t0 + off + 8 }),
    hisPunch ? inp({ [hisPunch]: t === t0 || t === t0 + 1, level: hisBody && t >= t0 && t < t0 + 8 }) : inp()]);
  const land = r.events.find(e => e.type === 'punchLand' && e.side === 0);
  const res = resolveOf(r.events, 0);
  const his = resolveOf(r.events, 1);
  const rocked = r.events.some(e => e.type === 'rocked' && e.side === 1), kd = r.events.some(e => e.type === 'knockdown' && e.side === 1);
  const stuffed = r.events.some(e => e.type === 'punchStuffed');
  let hp = 0; if (land) { const q = r.trace[land.t]; hp = q.pre.fighters[1].health - q.post.fighters[1].health; }
  return { land, res, his, rocked, kd, hp, stuffed, hisPhase: land ? r.trace[land.t].pre.fighters[1].punch.phase : null, vuln: land ? r.trace[land.t].pre.fighters[1].vuln : null };
}
for (const [label, mp, mb, hp_, hb, D] of [
  ['my cross vs his head hook', 'cross', false, 'hook', false, 1.05],
  ['my uppercut vs his BODY hook ("digging to the body")', 'uppercut', false, 'hook', true, 0.95],
  ['my hook vs his jab', 'hook', false, 'jab', false, 1.05],
  ['my cross vs his missed uppercut (he is 1.28 m away)', 'cross', false, 'uppercut', false, 1.28],
]) {
  const base = trade(mp, mb, null, false, D, 0);
  console.log(`-- ${label}.  On a set man: ${base.land ? Math.round(base.land.power) + ' N·s, ' + (100 * base.hp).toFixed(1) + '% health, ' + base.land.grade : (base.res ? base.res.type : 'no result')}`);
  const cells = [];
  for (let off = -18; off <= 26; off += 4) {
    const q = trade(mp, mb, hp_, hb, D, off);
    cells.push(`${off >= 0 ? '+' : ''}${off}: ` + (q.land ? `${Math.round(q.land.power)}${q.land.counter ? '*' : ''}${q.rocked ? 'R' : ''}${q.kd ? 'KD' : ''} (${(100 * q.hp).toFixed(1)}%, he was ${q.hisPhase ?? 'idle'}, vuln ${f2(q.vuln)})` : `${q.res ? q.res.type.replace('punch', '').toLowerCase() : 'nothing'}${q.stuffed ? ' (stuffed)' : ''}`));
  }
  console.log('   my press, ticks after his:  ' + cells.join('\n                               '));
}

// ───────────────────────────── M5: a clean power shot on an open man ─────────────────────────────
console.log('\n== M5  one clean shot on an open, standing man, by power rating (target chin 65). stop = hit-stop ticks; push = peak knock-back m/s; bar = his rock threshold');
console.log(padr('punch', 12) + padr('how', 12) + ['35', '65', '95'].map(p => pad(`power ${p}: N·s  hp%  stop  push  hurt`, 40)).join(''));
for (const k of ['jab', 'cross', 'hook', 'uppercut']) for (const walk of [false, true]) {
  const cells = [];
  for (const pw of [35, 65, 95]) {
    const D = k === 'uppercut' ? 0.95 : 1.05;
    const specs = [spec({ power: pw }), spec({ chin: 65 })];
    let s0 = stage(walk ? D + 0.45 : D, specs);
    let r;
    if (walk) {
      // walk in, press when the gap reaches D
      let pressed = -1;
      r = run(s0, 160, (t, s) => { const a = inp({ move: { x: 0, y: 1 } }); if (pressed < 0 && dist(s) <= D + 0.12) pressed = t; if (pressed >= 0 && t - pressed < 2) a[k] = true; return [a, inp()]; });
    } else r = run(s0, 120, t => [inp({ [k]: t < 2 }), inp()]);
    const land = r.events.find(e => e.type === 'punchLand' && e.side === 0);
    if (!land) { cells.push(pad('no land (' + (resolveOf(r.events, 0)?.type ?? 'none') + ')', 40)); continue; }
    const q = r.trace[land.t]; const hp = q.pre.fighters[1].health - q.post.fighters[1].health;
    const stop = r.trace.filter(x => x.t >= land.t && x.t < land.t + 30 && x.post.hitStop > 0).length;
    const push = Math.max(...r.trace.filter(x => x.t >= land.t && x.t < land.t + 30).map(x => Math.hypot(x.post.fighters[1].stagger.x, x.post.fighters[1].stagger.z ?? x.post.fighters[1].stagger.y ?? 0)));
    const hurt = r.events.some(e => e.type === 'knockdown' && e.side === 1) ? 'KD' : r.events.some(e => e.type === 'rocked' && e.side === 1) ? 'rocked' : '-';
    cells.push(pad(`${Math.round(land.power)} ${land.grade[0]}  ${(100 * hp).toFixed(1)}  ${stop}  ${push.toFixed(2)}  ${hurt}`, 40));
  }
  console.log(padr(k, 12) + padr(walk ? 'walking in' : 'standing', 12) + cells.join(''));
}
{
  const s0 = stage(1.05, [spec(), spec({ chin: 65 })]);
  const f = s0.fighters[1];
  const bar = (o) => { const g = { ...f, ...o }; return sim.stunThreshold(g, cfg); };
  console.log(`rock threshold (head) for chin 65: fresh ${Math.round(bar({}))}, health 0.5 ${Math.round(bar({ health: 0.5 }))}, health 0.2 + stamina 0.2 ${Math.round(bar({ health: 0.2, stamina: 0.2 }))};  chin 35 fresh ${Math.round(sim.stunThreshold({ ...f, ratings: { ...f.ratings, chin: 35 } }, cfg))}, chin 95 fresh ${Math.round(sim.stunThreshold({ ...f, ratings: { ...f.ratings, chin: 95 } }, cfg))}`);
  console.log(`body (winded) threshold: fresh ${Math.round(sim.bodyThreshold(f, cfg))}`);
}

// ───────────────────────────── M6: being tired ─────────────────────────────
console.log('\n== M6  the same cross and hook thrown fresh vs tired (attacker stamina pinned)');
for (const k of ['cross', 'hook']) for (const st of [1, 0.5, 0.25, 0.05]) {
  const s0 = stage(1.05); s0.fighters[0].stamina = st;
  const r = run(s0, 120, t => [inp({ [k]: t < 2 }), inp()], (t, s) => { if (s.fighters[0].punch.type === null && t < 2) s.fighters[0].stamina = st; });
  const start = r.events.find(e => e.type === 'punchStart' && e.side === 0), land = r.events.find(e => e.type === 'punchLand' && e.side === 0);
  console.log(`${padr(k, 7)} stamina ${st.toFixed(2)}: press-to-hit ${land ? land.t + 1 : '-'} ticks (tell ${start ? start.tell.toFixed(3) : '-'} s), impulse ${land ? Math.round(land.power) + ' ' + land.grade : 'no land'}`);
}
{
  let s = sim.createState([spec(), spec()], cfg, 3);
  for (let t = 0; t < 60; t++) s = sim.step(s, [inp(), inp()], cfg).state;
  for (const st of [1, 0.25, 0.05]) {
    const r = run(s, 80, () => [inp({ move: { x: 0, y: 1 } }), inp()], (t, q) => { q.fighters[0].stamina = st; });
    console.log(`walk speed at stamina ${st.toFixed(2)}: ${Math.max(...r.trace.map(q => Math.hypot(q.post.fighters[0].vel.x, q.post.fighters[0].vel.z))).toFixed(2)} m/s`);
  }
}
