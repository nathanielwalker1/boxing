/**
 * gui.js — the config object, generated into controls.
 *
 * Nothing here hand-writes a slider for a specific number. The panel is walked
 * out of config.js, so adding a channel to a punch adds seven controls for it
 * automatically and the "every timing number is live" rule cannot rot.
 */
import GUI from 'lil-gui';
import { EASE_NAMES } from './ease.js';

const isPos = path => path.includes('.position.');
const rng   = path => (isPos(path) ? [-0.6, 0.6, 0.001] : [-3.2, 3.2, 0.005]);

/** Every key of a flat path->number dict, as sliders, in one folder. */
function dictFolder(parent, dict, label) {
  const f = parent.addFolder(label).close();
  for (const path of Object.keys(dict)) {
    const [lo, hi, st] = rng(path);
    f.add(dict, path, lo, hi, st).name(path);
  }
  return f;
}

export function buildGui(config, hooks) {
  const gui = new GUI({ title: '3D GYM', width: 330 });
  gui.domElement.style.maxHeight = '96vh';
  gui.domElement.style.overflowY = 'auto';

  // ── Gym ───────────────────────────────────────────────────────────────────
  const g = gui.addFolder('Gym');
  g.add(config.gym, 'timescale', 0.05, 2, 0.01);
  g.add(config.gym, 'paused').listen();
  g.add(config.gym, 'hold').name('hold (scrub owns time)').listen();
  g.add(config.gym, 'scrub', 0, 1, 0.001).name('scrub 0..1').listen()
    .onChange(() => { config.gym.hold = true; });
  const steps = {
    'step back  [,]':    () => hooks.step(-1),
    'step fwd   [.]':    () => hooks.step(+1),
    'reset to rest [R]': () => hooks.reset(),
    'clear trail':       () => hooks.clearTrail(),
  };
  for (const k of Object.keys(steps)) g.add(steps, k);
  g.add(config.gym, 'trails');
  g.add(config.gym, 'trailFrames', 10, 400, 1);
  g.add(config.gym, 'trailBoth').name('trail both gloves');
  g.add(config.gym, 'skeleton');
  g.add(config.gym, 'axesSize', 0.01, 0.2, 0.005);
  g.add(config.gym, 'grid');
  g.add(config.gym, 'hud');

  // ── Punch triggers ────────────────────────────────────────────────────────
  const t = gui.addFolder('Throw');
  const throws = {
    'jab   [J]':   () => hooks.punch('jab'),
    'cross [K]':   () => hooks.punch('cross'),
    'hook  [H]':   () => hooks.punch('hook'),
  };
  for (const k of Object.keys(throws)) t.add(throws, k);

  // ── Camera ────────────────────────────────────────────────────────────────
  const c = gui.addFolder('Camera');
  const presets = {
    'SIDE     [1]': () => hooks.preset('SIDE'),
    'THREE_Q  [2]': () => hooks.preset('THREE_Q'),
    'OVER     [3]': () => hooks.preset('OVER'),
    'FREE     [4]': () => hooks.preset('FREE'),
    'save to preset': () => hooks.savePreset(),
  };
  for (const k of Object.keys(presets)) c.add(presets, k);
  const camCtrls = [
    c.add(config.camera, 'preset').listen().disable(),
    c.add(config.camera, 'az', -180, 180, 0.5).listen().onChange(hooks.camDirty),
    c.add(config.camera, 'el', -20, 80, 0.5).listen().onChange(hooks.camDirty),
    c.add(config.camera, 'dist', 0.8, 12, 0.01).listen().onChange(hooks.camDirty),
    c.add(config.camera, 'fov', 15, 90, 1).listen().onChange(hooks.camDirty),
    c.add(config.camera, 'targetY', 0, 2.2, 0.01).listen().onChange(hooks.camDirty),
    c.add(config.camera, 'targetMix', 0, 1, 0.01).name('target: player..dummy').listen().onChange(hooks.camDirty),
  ];

  // ── Punches ───────────────────────────────────────────────────────────────
  for (const [name, p] of Object.entries(config.punches)) {
    const f = gui.addFolder(`Punch: ${name}`).close();
    f.add(p, 'hold', 0, 200, 1).name('contact hold (ms)');
    f.add({ throw: () => hooks.punch(name) }, 'throw').name(`▶ throw ${name}`);
    for (const chn of p.channels) {
      const cf = f.addFolder(chn.path).close();
      const [lo, hi, st] = rng(chn.path);
      cf.add(chn, 'amp', lo, hi, st).name('amp');
      cf.add(chn, 't0', 0, 500, 1).name('t0  start (ms)');
      cf.add(chn, 't1', 0, 700, 1).name('t1  peak (ms)');
      cf.add(chn, 'ease', EASE_NAMES).name('ease');
      cf.add(chn, 'ant', 0, 1, 0.01).name('anticipation');
      cf.add(chn, 'over', 0, 1, 0.01).name('overshoot');
      cf.add(chn, 'rec', 20, 600, 1).name('recover (ms)');
    }
  }

  // ── Stance, slip, dummy, body, colors ─────────────────────────────────────
  dictFolder(gui, config.rest, 'Stance (rest pose)');

  const s = gui.addFolder('Slip').close();
  s.add(config.slip, 'attack', 2, 60, 0.5);
  s.add(config.slip, 'release', 2, 60, 0.5);
  s.add(config.slip, 'damping', 0.5, 30, 0.1);
  dictFolder(s, config.slip.lead, 'lead-side pose');
  dictFolder(s, config.slip.rear, 'rear-side pose');

  const d = gui.addFolder('Dummy').close();
  d.add(config.dummy, 'z', 0.6, 3.5, 0.01).onChange(hooks.moveDummy);
  d.add(config.dummy, 'impulseScale', 0, 0.6, 0.001);
  d.add(config.dummy, 'headBias', 0, 2, 0.01);
  d.add(config.dummy, 'bodyBias', 0, 2, 0.01);
  d.add(config.dummy, 'headHitR', 0.05, 0.5, 0.005);
  d.add(config.dummy, 'chestHitR', 0.05, 0.6, 0.005);
  d.add(config.dummy, 'maxLin', 0.02, 1, 0.01);
  d.add(config.dummy, 'maxAng', 0.1, 3, 0.01);
  for (const lvl of ['pelvis', 'chest', 'head']) {
    const lf = d.addFolder(`${lvl} spring`).close();
    lf.add(config.dummy[lvl], 'k', 5, 600, 1).name('stiffness');
    lf.add(config.dummy[lvl], 'c', 0.5, 60, 0.1).name('damping');
    lf.add(config.dummy[lvl], 'lin', 0, 1.5, 0.01).name('linear share');
    lf.add(config.dummy[lvl], 'ang', 0, 20, 0.1).name('angular share');
  }
  d.add({ reset: () => hooks.resetDummy() }, 'reset').name('reset dummy');

  const b = gui.addFolder('Proportions').close();
  for (const k of Object.keys(config.body)) {
    b.add(config.body, k, 0.01, 1.2, 0.001).onFinishChange(hooks.rebuild);
  }

  const col = gui.addFolder('Colors').close();
  for (const k of Object.keys(config.colors)) {
    if (typeof config.colors[k] === 'number') col.add(config.colors, k, 0, 3, 0.01).onChange(hooks.relight);
    else col.addColor(config.colors, k).onChange(hooks.rebuild);
  }

  return { gui, camCtrls };
}
