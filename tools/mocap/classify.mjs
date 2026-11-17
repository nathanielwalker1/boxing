// Auto label + one-line description from clipStats, then overrides.json (label/note/usable per slug) on top.

// Thresholds read off the contact sheets (Body Jab Cross's cross crosses the centreline by 0.25 m yet its
// path stays within 4 cm of a straight chord, elbow 146-174 deg; real hooks bow 0.2-0.4 m off the chord).
// Head or body by ABSOLUTE wrist height at the peak (Y Bot metres): a standing opponent's chin is ~1.45 m and
// sternum ~1.25 m. Measured against the puncher's own shoulder it read head-high for Mixamo's ducking jabs
// that land at 1.0 m (seen on the real bodies in proof.html, 2026-11-16).
const BODY_BELOW = 1.18;
const punchType = (p, lead) => {
  const body = p.wristY < BODY_BELOW;
  let kind;
  if (p.curve >= 0.15) kind = 'hook';
  else if (p.lift >= 0.2 && p.elbow < 140) kind = 'uppercut';
  else if (p.elbow >= 130) kind = lead ? 'jab' : 'cross';
  else kind = 'hook';
  if (kind === 'hook' || kind === 'uppercut') kind = (lead ? 'lead ' : 'rear ') + kind;
  return (body ? 'body ' : '') + kind;
};

export function punchList(s) {
  const leadSide = s.stance.includes('southpaw') ? 'Right' : 'Left';
  const all = [];
  // a short bent-arm forward flick (ext < 0.6, no arc, no lift) is an arm flail in a hit reaction, not a punch
  for (const side of ['Left', 'Right']) for (const p of s.hands[side].punches) {
    if (p.ext < 0.6 && p.curve < 0.15 && p.lift < 0.2) continue;
    all.push({ ...p, side, type: punchType(p, side === leadSide) });
  }
  return all.sort((a, b) => a.frame - b.frame);
}

export function classify(s, clip, ov) {
  const punches = punchList(s);
  const loop = s.loopAngle < 6 && s.loopOffset < 0.1;
  const inPlace = s.peakTravel < 0.25;
  let label, desc;
  const down = s.minHip < 0.6 || (s.headDir.startsWith('down') && s.headPeak > 0.8);
  // No block clip existed to calibrate a motion rule against (2026-11-16), so a block is recognised by its
  // file name (Mixamo names it "Block..."), confirmed by the guard staying up; check the sheet when one lands.
  if (/block/i.test(clip.file) && !down && s.peakTravel < 0.4) {
    label = /hit|react|receiv/i.test(clip.file) ? 'block reaction' : /body/i.test(clip.file) ? 'block (body)' : 'block';
    desc = `named ${clip.file}; guard up ${Math.round(s.guardFrac * 100)}%, head ${s.headPeak} m ${s.headDir}`;
  } else if (down) {
    const start = s.hipY0 < 0.6, end = s.hipYEnd < 0.6;
    label = start && !end ? 'get up' : !start && end ? 'knockdown fall' : start && end ? 'down' : 'knockdown and get up';
    desc = `hips drop to ${Math.round(s.minHip * 100)}% of standing at ${s.minHipT}s, head ${s.headPeak} m down`;
  } else if (s.netTravel > 0.8 && s.guardFrac < 0.3) {
    // a plain walk: arm swing reads as punches to the reach detector
    label = 'walk ' + s.travelDir;
    desc = `travels ${s.netTravel} m ${s.travelDir} in ${s.seconds}s, guard ${Math.round(s.guardFrac * 100)}%`;
  } else if (punches.length) {
    label = punches.length === 1 ? punches[0].type : 'combo: ' + punches.map((p) => p.type).join(', ');
    desc = punches.map((p) => `${p.side[0]} ${p.type} @${p.t}s (f${p.from}-${p.to})`).join('; ');
  } else if (Math.abs(s.yawNet) > 30 && s.netTravel < 1.0) {
    label = s.yawNet > 0 ? 'pivot (turns right)' : 'pivot (turns left)';
    desc = `body turns ${Math.abs(s.yawNet)} deg, travel ${s.netTravel} m ${s.travelDir}`;
  } else if (s.netTravel > 0.15) {
    label = (s.guardFrac > 0.3 ? 'step ' : 'walk ') + s.travelDir;
    desc = `travels ${s.netTravel} m ${s.travelDir} in ${s.seconds}s, guard ${Math.round(s.guardFrac * 100)}%`;
  } else if (s.headPeak > 0.15) {
    const body = s.headDir.startsWith('forward') || s.headDir === 'down+forward';
    const level = s.headPeak < 0.25 ? 'light' : s.headPeak < 0.45 ? 'medium' : 'heavy';
    label = body ? 'hit body' : 'hit head ' + level;
    desc = `head moves ${s.headPeak} m ${s.headDir} at ${s.headPeakT}s`;
  } else if (s.guardFrac > 0.6) {
    label = 'fight idle';
    desc = `guard up ${Math.round(s.guardFrac * 100)}%, head sway ${s.headPeak} m`;
  } else {
    label = 'other';
    desc = `guard ${Math.round(s.guardFrac * 100)}%, head ${s.headPeak} m ${s.headDir}`;
  }
  const auto = label;
  let usable = inPlace || label.startsWith('step') || label.startsWith('walk') || label.startsWith('pivot') ? 'yes' : 'with trimming';
  let note = desc;
  if (ov) { if (ov.label) label = ov.label; if (ov.note) note = ov.note + ' [auto: ' + auto + ']'; if (ov.usable) usable = ov.usable; }
  return { label, auto, note, usable, loop, inPlace, punches };
}

// Same clip downloaded twice, or Mixamo's mirror tickbox. Compares raw head positions frame by frame.
export function findDuplicates(rows, raws) {
  const mirrorIdx = (bones) => bones.map((b) => bones.indexOf(b.startsWith('Left') ? 'Right' + b.slice(4) : b.startsWith('Right') ? 'Left' + b.slice(5) : b));
  const diff = (a, b, mirror) => {
    const n = Math.min(a.frames.length, b.frames.length);
    const mi = mirrorIdx(a.bones);
    let sum = 0, cnt = 0;
    for (let f = 0; f < n; f += 2) for (let i = 0; i < a.bones.length; i++) {
      const p = a.frames[f].p[i], q = b.frames[f].p[mirror ? mi[i] : i];
      sum += Math.hypot(p[0] - (mirror ? -q[0] : q[0]), p[1] - q[1], p[2] - q[2]); cnt++;
    }
    return sum / cnt;
  };
  // near-duplicate: same motion after time-normalising both clips and removing hips travel
  // (catches the same Mixamo clip downloaded with different trim / speed / in-place settings)
  const shape = (a, b) => {
    const N = 24;
    let sum = 0, cnt = 0;
    for (let k = 0; k < N; k++) {
      const fa = a.frames[Math.round((k * (a.frames.length - 1)) / (N - 1))].p, fb = b.frames[Math.round((k * (b.frames.length - 1)) / (N - 1))].p;
      for (let i = 0; i < a.bones.length; i++) {
        sum += Math.hypot(fa[i][0] - fa[0][0] - (fb[i][0] - fb[0][0]), fa[i][1] - fb[i][1], fa[i][2] - fa[0][2] - (fb[i][2] - fb[0][2])); cnt++;
      }
    }
    return sum / cnt;
  };
  for (const r of rows) { r.dupOf = null; r.mirrorOf = null; r.similarTo = null; }
  for (let i = 0; i < rows.length; i++) for (let j = 0; j < i; j++) {
    const a = raws[rows[i].slug], b = raws[rows[j].slug];
    if (Math.abs(a.frames.length - b.frames.length) <= 2) {
      if (diff(a, b, false) < 0.01 && !rows[i].dupOf) { rows[i].dupOf = rows[j].slug; continue; }
      if (diff(a, b, true) < 0.02 && !rows[i].mirrorOf) { rows[i].mirrorOf = rows[j].slug; continue; }
    }
    const d = shape(a, b);
    if (d < 0.015 && (!rows[i].similarTo || d < rows[i].similarD)) { rows[i].similarTo = rows[j].slug; rows[i].similarD = Math.round(d * 1000) / 10; }
  }
}
