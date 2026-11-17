// rest skeleton of each body glb: head / hand / foot / hips heights and arm length (FK over node TRS, scene root included)
import { readFileSync } from 'fs';
const qmul = (a, b) => [a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1], a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0], a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3], a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
const qrot = (q, v) => { const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]); return [p[0], p[1], p[2]]; };
for (const f of ['boxer.glb', 'boxer_v2.glb', 'boxer_m1.glb']) {
  const buf = readFileSync('/Users/nathanielwalker/repos/boxinggame/.claude/worktrees/human/public/fighter/' + f);
  const js = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
  const nodes = js.nodes, parent = new Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => (n.children || []).forEach(c => (parent[c] = i)));
  const W = [];
  const world = i => {
    if (W[i]) return W[i];
    const n = nodes[i], t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
    if (parent[i] < 0) return (W[i] = { p: t, q: r, s });
    const P = world(parent[i]), rp = qrot(P.q, [t[0] * P.s[0], t[1] * P.s[1], t[2] * P.s[2]]);
    return (W[i] = { p: [P.p[0] + rp[0], P.p[1] + rp[1], P.p[2] + rp[2]], q: qmul(P.q, r), s: [P.s[0] * s[0], P.s[1] * s[1], P.s[2] * s[2]] });
  };
  const at = suf => { const i = nodes.findIndex(n => n.name.replace(/^mixamorig\d*[:_]?/, '') === suf); return i < 0 ? null : world(i).p; };
  const fmt = v => v ? v.map(x => x.toFixed(3)).join(' ') : '-';
  const sh = at('LeftArm'), el = at('LeftForeArm'), ha = at('LeftHand');
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  console.log(`${f.padEnd(14)} hips ${fmt(at('Hips'))} | head ${fmt(at('Head'))} | headTop ${fmt(at('HeadTop_End'))} | lfoot ${fmt(at('LeftFoot'))} | upper ${d(sh, el).toFixed(3)} fore ${d(el, ha).toFixed(3)}`);
}
