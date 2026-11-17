/**
 * mocap_bands.mjs — shared by mocap_geo_test and mocap_geo_probe: throw one punch at a standing, non-blocking
 * opponent from a set centre-to-centre distance and read what happened; sweep that for the landing band.
 */
export const PUNCHES = [
  { name: 'jab', btn: 'jab', x: 0 }, { name: 'cross', btn: 'cross', x: 0 },
  { name: 'lead hook', btn: 'hook', x: -1 }, { name: 'rear hook', btn: 'hook', x: 1 },
  { name: 'lead upper', btn: 'uppercut', x: -1 }, { name: 'rear upper', btn: 'uppercut', x: 1 },
];

export function makeBands(core, sim) {
  const { NULL_INPUT, cloneInput, ROSTER } = core;
  const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
  const NONE = inp();
  const base = ROSTER[0];
  const specsFor = dh => [base, { ...ROSTER[1], heightM: base.heightM + dh, reachM: base.reachM * (base.heightM + dh) / base.heightM, massKg: base.massKg, stance: base.stance, style: ROSTER[1].style }];

  /** One throw. low = hold the level (body variants). Returns { type, part, power, tick, s, glove, at } of the first outcome, or { type: 'none' }. */
  function throwAt(cfg, dist, p, low, dh, trace) {
    const specs = specsFor(dh);
    let s = sim.createState(specs, cfg, 1);
    s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
    s.fighters[0].yaw = 0; s.fighters[1].yaw = Math.PI;
    const lv = low ? { level: true } : {};
    for (let i = 0; i < 40; i++) s = sim.step(s, [inp(lv), NONE], cfg).state;
    const start = { a: s.fighters[0].pos.x, d: s.fighters[1].pos.x };
    for (let i = 0; i < 90; i++) {
      const prev = s;
      const r = sim.step(s, [inp({ ...lv, [p.btn]: i === 0, move: { x: i === 0 ? p.x : 0, y: 0 } }), NONE], cfg);
      s = r.state;
      if (trace) trace(prev, s, r.events, i);
      const e = r.events.find(e => e.side === 0 && (e.type === 'punchLand' || e.type === 'punchWhiff' || e.type === 'punchBlock'));
      if (e) return { type: e.type, part: e.part, power: e.power, variant: e.variant, tick: i, s, prev, start, dist: Math.abs(start.d - start.a) };
    }
    return { type: 'none', s };
  }
  /** The landing band [lo, hi] (centre to centre, m, the distance actually set) for the intended part; step 1 cm. */
  function band(cfg, p, low, dh, from = 0.4, to = 2.2) {
    let lo = null, hi = null, lands = 0, n = 0;
    for (let d = from; d <= to + 1e-9; d += 0.02) {
      const o = throwAt(cfg, d, p, low, dh);
      n++;
      const ok = o.type === 'punchLand' && o.part === (low ? 'body' : 'head');
      if (ok) { lands++; if (lo === null) lo = o.dist; hi = o.dist; }
    }
    return { lo, hi, lands, n };
  }
  return { throwAt, band, specsFor, inp, NONE };
}
