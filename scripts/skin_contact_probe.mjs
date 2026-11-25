// CONTACT IN LIVE PLAY, on the skinned mesh. A flow fight, the player's side on a scripted masher (walks in on the AI's
// feet, throws jab / cross / hook / uppercut in turn, every third one to the body), damage scaled down so nobody falls.
// Frame clock stepped by hand at 60 fps for argv[3] seconds (default 30). Every frame, in the page:
//   depth  = how far each man's glove vertices sit inside the other's head / torso (radial map from the part's centroid)
//   blocks = for 10 frames after a punchBlock, the gap between the punching glove's vertices and the nearest guard glove's
// Prints per punch type: lands, deepest-in-part (median / worst / over 2 cm / over 5 cm) and blocks, glove-to-glove gap.
// argv[2] = cfg overlay JSON or '-'.
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { until, bootReady } from './waits.js';
const CFG = process.argv[2] && process.argv[2] !== '-' ? JSON.parse(process.argv[2]) : {};
const SECS = +(process.argv[3] || 30);
const t0 = Date.now();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const logs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.addInitScript(() => {
  const raf = window.requestAnimationFrame.bind(window);
  let q = [], T = 0;
  window.__manual = false;
  window.requestAnimationFrame = cb => { if (window.__manual) { q.push(cb); return 1; } return raf(cb); };
  window.__goManual = () => { T = performance.now(); window.__manual = true; };
  window.__stepFrames = (n, ms) => { for (let i = 0; i < n; i++) { const cbs = q; q = []; T += ms; for (const c of cbs) c(T); } };
  window.__depth = (G, P) => {
    // centre: the centroid of the part's UPPER 60% by height (the 'head' set runs down the neck: its plain centroid sat
    // 11 cm off the head and every reading in a trade was inflated). Points below the centre's lower bound are not judged.
    let lo = 1e9, hi = -1e9; for (let i = 1; i < P.length; i += 3) { if (P[i] < lo) lo = P[i]; if (P[i] > hi) hi = P[i]; }
    const cut = lo + (hi - lo) * 0.4;
    let n = 0, cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < P.length; i += 3) { if (P[i + 1] < cut) continue; cx += P[i]; cy += P[i + 1]; cz += P[i + 2]; n++; }
    cx /= n; cy /= n; cz /= n;
    const NT = 24, NP = 12, R = new Float32Array(NT * NP);
    const bin = (x, y, z, d) => Math.min(NT - 1, Math.floor((Math.atan2(z, x) + Math.PI) / (2 * Math.PI) * NT)) * NP + Math.min(NP - 1, Math.floor(Math.acos(Math.max(-1, Math.min(1, y / d))) / Math.PI * NP));
    for (let i = 0; i < P.length; i += 3) { const x = P[i] - cx, y = P[i + 1] - cy, z = P[i + 2] - cz, d = Math.hypot(x, y, z) || 1e-9; const b = bin(x, y, z, d); if (d > R[b]) R[b] = d; }
    let deep = 0;
    for (let i = 0; i < G.length; i += 3) { if (G[i + 1] < cut) continue; const x = G[i] - cx, y = G[i + 1] - cy, z = G[i + 2] - cz, d = Math.hypot(x, y, z) || 1e-9; const k = R[bin(x, y, z, d)] - d; if (k > deep) { deep = k; if (k > 0.1) window.__depthDbg = `part height ${((hi - lo) * 100).toFixed(0)} cm, ${n} verts above the cut; deepest glove vertex ${(d * 100).toFixed(0)} cm from the centre (dy ${(y * 100).toFixed(0)}), part reaches ${(R[bin(x, y, z, d)] * 100).toFixed(0)} cm that way`; } }
    return deep;
  };
  window.__minGap = (A, B) => { let best = 1e9; for (let i = 0; i < A.length; i += 9) for (let j = 0; j < B.length; j += 9) { const d = (A[i] - B[j]) ** 2 + (A[i + 1] - B[j + 1]) ** 2 + (A[i + 2] - B[j + 2]) ** 2; if (d < best) best = d; } return Math.sqrt(best); };
  window.__run = frames => {
    const lands = [], blocks = [], open = [];   // open: events still being followed
    const body = { n: 0, over3: 0, over8: 0, worst: 0, at: 0, roped: 0, ropedOver3: 0 };
    const arms = { n: 0, both: 0, cross: 0, crossBoth: 0, deep: 0, cap: 0, cap5: 0, capClose: 0, close: 0, byKey: {}, dbg: 0, pops: 0, popWorst: 0 };
    let gp1 = null, gp2 = null;
    const form = { by: {}, prev: [null, null] };
    const cen = a => { let x = 0, y = 0, z = 0; const n = a.length / 3; for (let i = 0; i < a.length; i += 3) { x += a[i]; y += a[i + 1]; z += a[i + 2]; } return [x / n, y / n, z / n]; };
    let prevC = [0, 1].map(s => { const x = window.__humanMesh[s](); return { head: cen(x.head), torso: cen(x.torso) }; });
    for (let f = 0; f < frames; f++) {
      window.__humanStages = {}; window.__lateDbg = {};
      window.__stepFrames(1, 1000 / 60);
      if (window.__flow.state().screen !== 'fight') break;
      const m = [0, 1].map(s => window.__humanMesh[s]());
      const P = [0, 1].map(s => window.__humanProbe(s));
      for (const s of [0, 1]) for (const e of (P[s]?.events ?? [])) {
        window.__evN = (window.__evN | 0) + 1;
        if ((e.type !== 'punchLand' && e.type !== 'punchBlock' && e.type !== 'perfectBlock') || e.side !== s) continue;
        const leadL = P[s].gloves.lead[0] === P[s].gloves.left[0];
        // (a block event carries no hand: the sim's punch in flight has it. Without this every blocked LEAD punch was
        //  measured on the rear glove, at home 30-50 cm away)
        const hand = e.hand ?? window.__sim.state().fighters[s].punch.hand;
        const g = (hand === 'lead') === leadL ? 'L' : 'R';
        const rec = { f, s, g, hand: e.hand, punch: e.punch, part: e.part === 'head' ? 'head' : 'torso', land: e.type === 'punchLand', v: e.type === 'punchLand' ? 0 : 1e9, at: 0, n: 0, tl: P[1 - s].label, row: [] };
        // how far the drawing layers moved this glove off where the take alone had it, on the hit frame, cm
        { const L = window.__humanStages[s] ?? []; if (L.length > 1) { const a = L[0][g === 'L' ? 1 : 2], b = L[L.length - 1][g === 'L' ? 1 : 2]; rec.off = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 100;
          // (and the ARM's share: from after the body layers — lean, drop, turn — to the end)
          const im = L.find(x => x[0] === 'impact'); if (im) { const c = im[g === 'L' ? 1 : 2]; rec.offArm = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]) * 100;
            // which way the arm was pulled: toward him (+) / back, up (+) / down, to the puncher's right (+) / left
            const hs = [P[s].hips, P[1 - s].hips], fx = hs[1][0] - hs[0][0], fz = hs[1][2] - hs[0][2], fl = Math.hypot(fx, fz) || 1, d = [b[0] - c[0], b[1] - c[1], b[2] - c[2]];
            rec.offF = (d[0] * fx + d[2] * fz) / fl * 100; rec.offU = d[1] * 100; rec.offR = (d[0] * -fz + d[2] * fx) / fl * 100; rec.dist = fl * 100;
            // (the sideways pull, layer by layer: how far to his right the final glove is of where each layer left it; and
            //  what the animation side predicted: the target to the right of the take's contact-frame glove, his own frame)
            rec.sideBy = L.map(x => { const q = x[g === 'L' ? 1 : 2]; return [x[0], ((b[0] - q[0]) * -fz + (b[2] - q[2]) * fx) / fl * 100]; });
            const td = P[s].turnDbg; if (td) { rec.predR = -(td[0] - td[1]) * 100; rec.predF = (td[2] - td[3]) * 100; } } } }
        // how far the puncher's own facing (the sim's) is off the line to the other man on the hit frame, degrees
        { const F = window.__sim.state().fighters, a = Math.atan2(F[1 - s].pos.z - F[s].pos.z, F[1 - s].pos.x - F[s].pos.x) - F[s].yaw; rec.yawOff = Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) * 180 / Math.PI; }
        open.push(rec); (rec.land ? lands : blocks).push(rec);
      }
      for (const r of open) {
        const o = m[1 - r.s], G = m[r.s][r.g];
        if (r.land) {
          const d = window.__depth(G, o[r.part]); r.row.push(+(d * 100).toFixed(1)); if (d > r.v) { r.v = d; r.at = r.n; }
          // the first frame it is over 8 cm inside: where each drawing layer left this glove point, as distance to the part's centre as finally drawn
          if (d > 0.08 && !r.trace) {
            const hc = cen(o[r.part]);
            r.trace = `frame +${r.n}: ` + (window.__humanStages[r.s] ?? []).map(([n, L, R]) => `${n} ${(Math.hypot(...(r.g === 'L' ? L : R).map((v, k) => v - hc[k])) * 100).toFixed(0)}`).join(', ')
              + ` || ${window.__depthDbg} || ${(() => { const T = P[1 - r.s], d3 = (a, b) => (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 100).toFixed(0); if (!T.drawn) return `CHECK no drawn body (headTop ${!!T.headTop}); mesh head centre to head joint ${d3(hc, T.head)}`; const mid = T.headTop ? T.head.map((v, k) => (v + T.headTop[k]) / 2) : T.head, gp = P[r.s].gloves[r.g === 'L' ? 'left' : 'right'];
                return `CHECK mesh head centre to joint midpoint ${d3(hc, mid)}, to the keep-out sphere centre ${d3(hc, T.drawn.head)}; joint midpoint to sphere centre ${d3(mid, T.drawn.head)}; glove point to sphere centre ${d3(gp, T.drawn.head)}, to mesh centre ${d3(gp, hc)}, sphere R ${(T.drawn.headR * 100).toFixed(0)}`; })()} || target's ${r.part} centre moved ${(Math.hypot(...hc.map((v, k) => v - prevC[1 - r.s][r.part][k])) * 100).toFixed(1)} cm this frame, puncher ${P[r.s].label}`;
          }
        }
        else {
          const d = Math.min(window.__minGap(G, o.L), window.__minGap(G, o.R)); if (d < r.v) { r.v = d; r.at = r.n; }
          // (argv[4] = blockshots: stop on the 3rd frame of a block still over 8 cm from his gloves, for a picture)
          if (window.__shootBlock && r.n === 2 && r.v > 0.08 && !r.shot) { r.shot = true; r.n++; const gp = P[r.s].gloves[r.g === 'L' ? 'left' : 'right'], hc = cen(o.head), tc = cen(o.torso);
            return { lands, blocks, stop: `side ${r.s} ${r.punch} -> ${r.part} BLOCKED, glove ${(r.v * 100).toFixed(0)} cm from his nearer glove; glove point to his head centre ${(Math.hypot(...gp.map((v, k) => v - hc[k])) * 100).toFixed(0)} cm, to his torso centre ${(Math.hypot(...gp.map((v, k) => v - tc[k])) * 100).toFixed(0)} cm; layers ${(window.__humanStages[r.s] ?? []).map(([n, L, R]) => `${n} ${(Math.hypot(...(r.g === 'L' ? L : R).map((v, k) => v - hc[k])) * 100).toFixed(0)}`).join(', ')}; puncher ${P[r.s].label}, target ${P[1 - r.s].label}; SIM: apart ${(Math.hypot(window.__sim.state().fighters[0].pos.x - window.__sim.state().fighters[1].pos.x, window.__sim.state().fighters[0].pos.z - window.__sim.state().fighters[1].pos.z) * 100).toFixed(0)} cm, punch ${JSON.stringify((({ type, hand, phase, resolved, contact, variant }) => ({ type, hand, phase, resolved, variant, contact: contact && [contact.x, contact.y, contact.z].map(v => +v.toFixed(2)) }))(window.__sim.state().fighters[r.s].punch))}, glove point ${gp.map(v => +v.toFixed(2))}, his gloves ${JSON.stringify([P[1 - r.s].gloves.left, P[1 - r.s].gloves.right].map(a => a.map(v => +v.toFixed(2))))}, event hand ${r.hand}` }; }
        }
        r.n++;
      }
      // BODIES THROUGH BODIES: either man's head vertices inside the other's head or torso, every frame
      { const d = Math.max(window.__depth(m[0].head, m[1].head), window.__depth(m[0].head, m[1].torso), window.__depth(m[1].head, m[0].torso));
        body.n++; if (d > 0.03) body.over3++; if (d > 0.08) body.over8++; if (d > body.worst) { body.worst = d; body.at = f; }
        const ro = [0, 1].map(s => Math.hypot(...(window.__humanProbe(s).ropeOff ?? [0, 0]))); if (Math.max(...ro) > 0.03) { body.roped++; if (d > 0.03) body.ropedOver3++; } }
      // PUNCH FORM: per punching arm, the wrist bend (forearm line against the line from the wrist to the middle of the
      // glove's own mesh) and the elbow angle (shoulder - elbow - wrist), degrees, and how much each changed in a frame
      for (const s of [0, 1]) {
        const pn = window.__sim.state().fighters[s].punch; if (!pn.type) { form.prev[s] = null; continue; }
        const leadL = P[s].gloves.lead[0] === P[s].gloves.left[0], side = (pn.hand === 'lead') === leadL ? 'left' : 'right';
        const E = P[s].elbows[side], G = P[s].gloves[side], S = P[s].shoulders[side], gc = cen(m[s][side === 'left' ? 'L' : 'R']);
        const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / ((Math.hypot(...a) * Math.hypot(...b)) || 1)))) * 180 / Math.PI;
        const fa = sub(G, E), fl = Math.hypot(...fa), W = G.map((v, k) => v - fa[k] / fl * window.__cfg.humanGloveOffset);
        const wrist = ang(fa, sub(gc, W)), elbow = ang(sub(S, E), sub(W, E));
        const b = (form.by[pn.type] ??= { wrist: [], dW: [], elbow: [], dE: [] });
        b.wrist.push(wrist); b.elbow.push(elbow);
        if (form.prev[s] && form.prev[s].side === side) { b.dW.push(Math.abs(wrist - form.prev[s].wrist)); b.dE.push(Math.abs(elbow - form.prev[s].elbow)); }
        form.prev[s] = { side, wrist, elbow };
      }
      // GLOVE POPS (the cost of pushing arms about): a glove point off the midpoint of the frames either side by over 6 cm
      { const now = [0, 1].flatMap(s => [P[s].gloves.left, P[s].gloves.right]);
        if (gp2) now.forEach((p, k) => { const off = Math.hypot(gp1[k][0] - (p[0] + gp2[k][0]) / 2, gp1[k][1] - (p[1] + gp2[k][1]) / 2, gp1[k][2] - (p[2] + gp2[k][2]) / 2); if (off > 0.06) arms.pops++; if (off > arms.popWorst) arms.popWorst = off; });
        gp2 = gp1; gp1 = now; }
      // ARMS THROUGH ARMS: each man's forearms (elbow to glove point) against the other's, centre lines closer than 5 cm
      { const seg = s => ['left', 'right'].map(k => [P[s].elbows[k], P[s].gloves[k]]);
        const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const ss = ([p1, q1], [p2, q2]) => { const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), c = dot(d1, r), b = dot(d1, d2), den = a * e - b * b;
          let s = den > 1e-9 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0, t = (b * s + f) / e; if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); } else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
          return Math.hypot(...sub([p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s], [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t])); };
        let mn = 1e9; for (const A of seg(0)) for (const B of seg(1)) mn = Math.min(mn, ss(A, B));
        const both = !/^(idle|block|walk|guard|hit|down)/.test(P[0].label) && !/^(idle|block|walk|guard|hit|down)/.test(P[1].label);
        arms.n++; if (both) arms.both++; if (mn < 0.05) { arms.cross++; if (both) arms.crossBoth++; } if (mn < 0.02) arms.deep++;
        // AS CAPSULES (the game's own shapes: forearm 4.5 cm, glove = the sim's glove radius): overlap over 2 cm, by what
        // each arm is doing (0 guard, 1 a punch that will not land, 2 one that lands) and which parts
        const FA = window.__cfg.humanArmClearForearmR, GR = window.__sim.state().fighters[0].body.gloveR, S0 = seg(0), S1 = seg(1);
        let worst = 0, key = '';
        for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
          const a0 = P[0].armAct?.[i] ?? 0, a1 = P[1].armAct?.[j] ?? 0, acts = `${Math.max(a0, a1)}v${Math.min(a0, a1)}`;
          const cand = [['forearm-forearm', 2 * FA - ss(S0[i], S1[j])], ['glove-forearm', GR + FA - Math.min(ss([S0[i][1], S0[i][1]], S1[j]), ss(S0[i], [S1[j][1], S1[j][1]]))], ['glove-glove', 2 * GR - ss([S0[i][1], S0[i][1]], [S1[j][1], S1[j][1]])]];
          for (const [nm, pen] of cand) if (pen > worst) { worst = pen; key = `${acts} ${nm}`; }
        }
        if (worst > 0.02) { arms.cap++; arms.byKey[key] = (arms.byKey[key] || 0) + 1; if (worst > 0.05) arms.cap5++;
          const dst = Math.hypot(P[0].hips[0] - P[1].hips[0], P[0].hips[2] - P[1].hips[2]); if (dst < 0.8) arms.capClose++;
          arms.dbg = Math.max(arms.dbg, ...(P[0].armDbg ?? [0]), ...(P[1].armDbg ?? [0])); }
        if (Math.hypot(P[0].hips[0] - P[1].hips[0], P[0].hips[2] - P[1].hips[2]) < 0.8) arms.close++; }
      for (let i = open.length - 1; i >= 0; i--) if (open[i].n >= (open[i].land ? 24 : 10)) open.splice(i, 1);
      prevC = m.map(x => ({ head: cen(x.head), torso: cen(x.torso) }));
      if (window.__shootDeep) { const r = open.find(r => r.land && r.trace && !r.shot && r.row[r.row.length - 1] > 8); if (r) { r.shot = true; return { lands, blocks, stop: `side ${r.s} ${r.punch} -> ${r.part}, depth ${r.row[r.row.length - 1]}, target ${r.tl}; ${r.trace}` }; } }
    }
    const st = window.__sim.state();
    const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : NaN; };
    const formOut = Object.entries(form.by).map(([k, b]) => `  ${k.padEnd(8)} wrist bend median ${q(b.wrist, 0.5).toFixed(0)}, p95 ${q(b.wrist, 0.95).toFixed(0)}, max ${q(b.wrist, 1).toFixed(0)} deg; change a frame p95 ${q(b.dW, 0.95).toFixed(1)}, max ${q(b.dW, 1).toFixed(0)} | elbow min ${q(b.elbow, 0).toFixed(0)}, max ${q(b.elbow, 1).toFixed(0)}, over 172 on ${b.elbow.filter(x => x > 172).length}/${b.elbow.length} frames; change a frame p95 ${q(b.dE, 0.95).toFixed(1)}, max ${q(b.dE, 1).toFixed(0)}`);
    return { lands, blocks, body, arms, formOut, info: `screen ${window.__flow.state().screen}, sim t ${st.time.toFixed(1)}, phase ${st.round.phase}, ticks ${window.__tick.simTicks}, evs seen ${window.__evN | 0}` };
  };
});
await page.goto(`${DEV_URL}/?menu=1&human=1&ko=1`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await bootReady(page);
const key = async k => { await page.keyboard.press(k); await page.waitForTimeout(0); };
const on = s => until(page, x => window.__flow.state().screen === x, s, { label: `screen ${s}`, timeout: 60_000 });
await key('Enter'); await on('select');
await key('Enter'); await on('opponent');
await key('Enter'); await on('fight');
await until(page, () => !!window.__humanMesh?.[0] && !!window.__humanMesh?.[1] && window.__tick.simTicks > 5, undefined, { label: 'fight + mesh hook', timeout: 150_000 });
await page.evaluate(async ([CFG, MASH2, CLOSE, CIRCLE]) => {
  const c = window.__cfg; Object.assign(c, CFG); c.healthDamagePerImpulse *= 0.1; c.flowReplayOn = false; window.__flow.rounds(1, 900);
  const AI = await import('/src/ai/index.ts'), core = await import('/src/core/index.ts');
  const st = window.__sim.state(); const spec = core.ROSTER.find(r => r.id === st.fighters[0].specId);
  let ai = AI.createAi(0, 7, c, AI.styleFor(spec, c)), t = 0;
  const cyc = ['jab', 'cross', 'hook', 'uppercut', 'hook', 'cross'];
  window.__sim.drive(0, s => {
    const d = AI.aiStep(ai, s, c); ai = d.ai; t++;
    const i = { ...d.input, jab: false, cross: false, hook: false, uppercut: false, block: false, level: false };
    const k = Math.floor(t / 16);
    if (t % 16 === 0) i[cyc[k % cyc.length]] = true;
    if (k % 3 === 2 && t % 16 < 3) i.level = true;
    if (CLOSE) i.move = { x: 0, y: 1 };   // (argv[5] = close: both walk into each other the whole time, both mashing)
    // (argv[5] = circle: he PIVOTS — block held + a sideways flick — every second, alternate sides, and throws nothing:
    //  the other man's punches land on a man who has just taken an angle. Plain strafing never puts the puncher's
    //  facing off the line by more than 1 degree: measured 2026-11-25)
    if (CIRCLE) { const ph = t % 60; i.jab = i.cross = i.hook = i.uppercut = false; i.level = false; i.block = ph < 14; i.move = ph >= 4 && ph < 7 ? { x: Math.floor(t / 60) % 2 ? -1 : 1, y: 0 } : { x: 0, y: 0 }; }
    return i;
  });
  // argv[5] = mash2: the other man mashes too, half a beat off (close exchanges, both punching)
  if (MASH2) {
    const spec1 = core.ROSTER.find(r => r.id === st.fighters[1].specId);
    let ai1 = AI.createAi(1, 9, c, AI.styleFor(spec1, c)), t1 = 8;
    const cyc1 = ['cross', 'hook', 'jab', 'uppercut', 'jab', 'hook'];
    window.__sim.drive(1, s => {
      const d = AI.aiStep(ai1, s, c); ai1 = d.ai; t1++;
      const i = { ...d.input, jab: false, cross: false, hook: false, uppercut: false, block: false, level: false };
      if (t1 % 16 === 0) i[cyc1[Math.floor(t1 / 16) % cyc1.length]] = true;
      if (CLOSE) i.move = { x: 0, y: 1 };
      return i;
    });
  }
  window.__goManual();
}, [CFG, process.argv[5] === 'mash2' || process.argv[5] === 'close', process.argv[5] === 'close', process.argv[5] === 'circle']);
// throwaway frames, stepped from here until the sim is really running (the flow's own timers need real time to pass)
for (let i = 0; i < 200; i++) { const tk = await page.evaluate(() => { window.__stepFrames(2, 1000 / 60); return window.__tick.simTicks; }); if (tk > 60) break; }
if (process.argv[4] === 'shots' || process.argv[4] === 'blockshots') {
  await page.evaluate(b => { if (b) window.__shootBlock = true; else window.__shootDeep = true; }, process.argv[4] === 'blockshots');
  for (let k = 0; k < 4; k++) {
    const r = await page.evaluate(n => window.__run(n), 900);
    if (!r.stop) continue;
    await page.screenshot({ path: new URL(`./output/deep_${k}.png`, import.meta.url).pathname });
    console.log(`deep_${k}.png: ${r.stop}`);
  }
  await browser.close(); process.exit(0);
}
const { lands, blocks, info, body, arms, formOut } = await page.evaluate(n => window.__run(n), Math.round(SECS * 60));
console.log(info);
console.log('PUNCH FORM, the punching arm while a punch is out:\n' + formOut.join('\n'));
console.log(`ARMS: a forearm's centre line within 5 cm of one of the other man's on ${arms.cross}/${arms.n} frames (within 2 cm: ${arms.deep}); while BOTH are punching: ${arms.crossBoth}/${arms.both} frames`);
console.log(`ARMS AS CAPSULES: overlapping by over 2 cm on ${arms.cap}/${arms.n} frames (over 5 cm: ${arms.cap5}); hips within 80 cm on ${arms.close} frames, of those overlapping ${arms.capClose}. GLOVE POPS over 6 cm: ${arms.pops} glove-frames, worst ${(arms.popWorst * 100).toFixed(0)} cm. By what the two arms are doing (2 lands, 1 punch that will not, 0 guard) and parts: ${Object.entries(arms.byKey).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`BODIES: a head inside the other man's head or torso by over 3 cm on ${body.over3}/${body.n} frames, over 8 cm on ${body.over8}; worst ${(body.worst * 100).toFixed(1)} cm at f${body.at}. Frames with a man slid by the ropes over 3 cm: ${body.roped}, of those overlapping ${body.ropedOver3}`);
const pct = (a, q) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(q * b.length))] : NaN; };
console.log(`cfg ${JSON.stringify(CFG)}: ${lands.length} lands, ${blocks.length} blocks in ${SECS} s`);
console.log('LANDS, glove deepest inside the scored part in the 24 frames from the hit, cm');
for (const s of [0, 1]) for (const p of ['jab', 'cross', 'hook', 'uppercut']) for (const part of ['head', 'torso']) {
  const g = lands.filter(l => l.s === s && l.punch === p && l.part === part); if (!g.length) continue;
  const v = g.map(l => l.v * 100);
  console.log(`  side ${s} ${p.padEnd(8)} ${part.padEnd(5)} n ${String(g.length).padStart(2)}: median ${pct(v, 0.5).toFixed(1)}, worst ${Math.max(...v).toFixed(1)}, over 2 cm ${v.filter(x => x > 2).length}, over 5 cm ${v.filter(x => x > 5).length}`);
}
const all = lands.map(l => l.v * 100);
console.log(`  ALL: over 2 cm ${all.filter(x => x > 2).length}/${all.length}, over 5 cm ${all.filter(x => x > 5).length}/${all.length}`);
for (const l of [...lands].sort((a, b) => b.v - a.v).slice(0, 5)) console.log(`   worst: f${l.f} side ${l.s} ${l.punch} -> ${l.part}, target ${l.tl}; depth by frame from the hit: ${l.row.slice(0, 10).join(' ')}\n      layers, ${l.trace ?? 'none'}`);
console.log('OFF THE TAKE: how far the landing glove is from where the punch animation alone had it, on the hit frame, cm');
for (const p of ['jab', 'cross', 'hook', 'uppercut']) { const g = lands.filter(l => l.punch === p && l.off !== undefined).map(l => l.off); if (g.length) console.log(`  ${p.padEnd(8)} n ${String(g.length).padStart(2)}: median ${pct(g, 0.5).toFixed(0)}, p90 ${pct(g, 0.9).toFixed(0)}, max ${Math.max(...g).toFixed(0)}` + (() => { const h = lands.filter(l => l.punch === p && l.offArm !== undefined).map(l => l.offArm); return h.length ? ` | the arm's own share (after the body has leaned / turned): median ${pct(h, 0.5).toFixed(0)}, p90 ${pct(h, 0.9).toFixed(0)}, max ${Math.max(...h).toFixed(0)}` : ''; })()
  + (() => { const L = lands.filter(l => l.punch === p && l.offF !== undefined); if (!L.length) return ''; const md = k => pct(L.map(l => l[k]), 0.5).toFixed(0), rg = k => `${Math.min(...L.map(l => l[k])).toFixed(0)}..${Math.max(...L.map(l => l[k])).toFixed(0)}`;
    return `\n           which way (median, range): toward him ${md('offF')} (${rg('offF')}), up ${md('offU')} (${rg('offU')}), to his right ${md('offR')} (${rg('offR')}); sideways either way median ${pct(L.map(l => Math.abs(l.offR)), 0.5).toFixed(0)}, p90 ${pct(L.map(l => Math.abs(l.offR)), 0.9).toFixed(0)}; hips apart ${md('dist')} (${rg('dist')}); his facing off the line to the other man, deg: median ${md('yawOff')}, max ${Math.max(...L.map(l => l.yawOff)).toFixed(0)}`; })()); }
// THE SIDEWAYS AND FORWARD PULL, TRACED: per punch, what the animation side predicted against what the arm did, and
// the layer the sideways pull comes in at (median of: final glove to the right of where that layer left it, cm)
for (const p of ['jab', 'cross', 'hook', 'uppercut']) { const L = lands.filter(l => l.punch === p && l.predR !== undefined && l.sideBy); if (!L.length) continue;
  const names = L[0].sideBy.map(x => x[0]);
  console.log(`  TRACE ${p}: predicted right ${pct(L.map(l => l.predR), 0.5).toFixed(0)} (${Math.min(...L.map(l => l.predR)).toFixed(0)}..${Math.max(...L.map(l => l.predR)).toFixed(0)}) v arm right ${pct(L.map(l => l.offR), 0.5).toFixed(0)}; predicted forward ${pct(L.map(l => l.predF), 0.5).toFixed(0)} (${Math.min(...L.map(l => l.predF)).toFixed(0)}..${Math.max(...L.map(l => l.predF)).toFixed(0)}) v arm forward ${pct(L.map(l => l.offF), 0.5).toFixed(0)}; per land predicted-right minus arm-right: median ${pct(L.map(l => l.predR - l.offR), 0.5).toFixed(0)}, spread ${pct(L.map(l => Math.abs(l.predR - l.offR)), 0.9).toFixed(0)}`);
  console.log(`     sideways left to do after each layer: ${names.map(n => `${n} ${pct(L.map(l => (l.sideBy.find(x => x[0] === n) ?? [0, NaN])[1]).filter(v => !Number.isNaN(v)), 0.5).toFixed(0)}`).join(', ')}`); }
console.log('BLOCKS, smallest gap between the punching glove and his nearer guard glove in the 10 frames from the block, cm');
for (const s of [0, 1]) { const g = blocks.filter(b => b.s === s).map(b => b.v * 100); if (g.length) console.log(`  side ${s} n ${g.length}: median ${pct(g, 0.5).toFixed(1)}, p90 ${pct(g, 0.9).toFixed(1)}, worst ${Math.max(...g).toFixed(1)}, over 3 cm ${g.filter(x => x > 3).length}`); }
for (const b of [...blocks].sort((a, c) => c.v - a.v).slice(0, 4)) console.log(`   worst: f${b.f} side ${b.s} ${b.punch} -> ${b.part}, gap ${(b.v * 100).toFixed(1)}, target ${b.tl}`);
console.log(`console errors/warnings: ${logs.length}${logs.length ? ' — ' + logs.slice(0, 3).join(' | ') : ''}`);
console.log(`wall ${((Date.now() - t0) / 1000).toFixed(0)} s`);
await browser.close();
