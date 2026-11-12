/**
 * ai/drills.ts — drill opponents for a gym mode (overhaul phase 2). One drill
 * per feeling, in the order a player should meet them. The host (UI) builds
 * the mode; this file is data plus pure functions:
 *
 *   const s0 = drillState(drill, [playerSpec, opponentSpec], cfg, seed);   // placed, set up
 *   each tick: input1 = drill.policy(state, tick, seed, cfg);              // side 1's FrameInput — PURE: no memory,
 *              state = step(state, [playerInput, input1], cfg).state        //   the same (state, tick, seed) always gives the same input
 *   any time:  { progress, stat } = drill.metric(eventsSinceStart, state, cfg)
 *
 * The player is side 0, the drill opponent side 1. `tick` counts from 0 at the
 * drill's start. Policies press punches on scheduled ticks (a hash of the seed
 * and the beat number), so cadences vary but replay exactly. `metric` is a
 * pure function of every event since the drill began and the current state:
 * progress 0..1 and a short stat line (numbers only — the host decides how, or
 * whether, to show it).
 */
import {
  NULL_INPUT, RING_HALF, SIM_HZ, cloneInput, v2dist,
  type Config, type FighterSpec, type FrameInput, type PunchType, type SimEvent, type SimState, type Vec2,
} from '../core';
import { createState } from '../sim';

export interface Drill {
  id: string;
  title: string;
  /** One sentence: what the player is practising. */
  goal: string;
  /** Suggested length, s. */
  seconds: number;
  /** Where the two start (floor positions, m; ring centre is 0,0). They face each other. */
  placement(cfg: Config): { player: Vec2; opponent: Vec2 };
  /** Changes to the opponent's spec for this drill (a taller man, a style). */
  opponent?: Partial<FighterSpec>;
  /** Mutate the freshly placed state (start hurt, start tired). */
  setup?(state: SimState, cfg: Config): void;
  /** Config the drill runs under (polish phase): a partner who does not fall over, a quick count so nobody stands through a dead ten. The host merges it over the live config and puts it back afterwards. */
  tune?(cfg: Config): Partial<Config>;
  /** Side 1's input this tick. Pure. */
  policy(state: SimState, tick: number, seed: number, cfg: Config): FrameInput;
  /** Progress 0..1 and a stat line, from every event since the drill began and the state now. Pure. */
  metric(events: readonly SimEvent[], state: SimState, cfg: Config): { progress: number; stat: string };
}

// ── Helpers (pure) ───────────────────────────────────────────────────────────
/** A deterministic 0..1 from the seed and an integer (the beat number). */
function hash01(seed: number, k: number): number {
  let h = (seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const inp = (o: Partial<FrameInput> = {}): FrameInput => ({ ...cloneInput(NULL_INPUT), ...o });
const dist = (s: SimState): number => v2dist(s.fighters[0].pos, s.fighters[1].pos);
const T = (sec: number): number => Math.round(sec * SIM_HZ);
/**
 * A beat schedule: beats are `period` seconds long; in each, one press lands
 * `lo..hi` of the way through (hashed). Returns the beat number if this tick
 * is that beat's press tick, else −1.
 */
function beat(tick: number, seed: number, period: number, lo = 0.2, hi = 0.8): number {
  const n = T(period), k = Math.floor(tick / n);
  const at = k * n + Math.floor((lo + (hi - lo) * hash01(seed, k)) * n);
  return tick === at ? k : -1;
}
const landsBy = (events: readonly SimEvent[], side: 0 | 1, pred: (e: Extract<SimEvent, { type: 'punchLand' }>) => boolean = () => true): number =>
  events.reduce((n, e) => n + (e.type === 'punchLand' && e.side === side && pred(e) ? 1 : 0), 0);
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const centre = (d: number) => (): { player: Vec2; opponent: Vec2 } => ({ player: { x: -d / 2, z: 0 }, opponent: { x: d / 2, z: 0 } });
const HEAVY: readonly PunchType[] = ['cross', 'hook'];
/** Ticks the telegraph (a dip of the level) shows before the punch is pressed. */
const DIP_TICKS = 10;
/** Ticks he stands back up before the press (0.33 s). */
const RISE_TICKS = 20;

/**
 * The telegraphed single shots the two slip drills share: one heavy punch
 * every 1.3–2.3 s from close mid range, each announced by a DIP (he drops his
 * level for DIP_TICKS, then throws as he comes up) — a tell a person can read.
 */
function telegraphed(state: SimState, tick: number, seed: number): FrameInput {
  const d = dist(state);
  // Hold the range: step in if the player backs off, give ground if he crowds.
  const move = { x: 0, y: d > 0.8 ? 0.6 : d < 0.66 ? -0.5 : 0 };
  // Is a press scheduled in the next DIP_TICKS? Then he is dipping; on the tick itself he throws.
  // (He is back UP for RISE_TICKS before the press, so the punch goes to the HEAD — a cross, or a hook coming up —
  // the ones a slip or a roll beats. Pressed with the level still down it would be a body shot, which no slip beats.)
  for (let ahead = 0; ahead <= DIP_TICKS + RISE_TICKS; ahead++) {
    const k = beat(tick + ahead, seed, 1.8, 0.1, 0.9);
    if (k < 0) continue;
    if (ahead > RISE_TICKS) return inp({ level: true, move });
    if (ahead > 0) return inp({ move });
    if (d < 0.9 && state.fighters[1].punch.type === null) {
      const p = HEAVY[Math.floor(hash01(seed + 77, k) * HEAVY.length)]!;
      return inp({ [p]: true, move: { x: hash01(seed + 5, k) < 0.5 ? -1 : 1, y: 0 } });
    }
  }
  return inp({ move });
}

export const DRILLS: readonly Drill[] = [
  {
    id: 'jab-and-move',
    title: 'Stick and move',
    goal: 'He walks you down and never hits hard: land the jab and be gone before he gets to you.',
    seconds: 40,
    placement: centre(1.3),
    opponent: { style: 'pressure' },
    policy(state, tick, seed) {
      const d = dist(state);
      const k = beat(tick, seed, 1.6);
      // A slow walk forward; a light jab when he is close enough; nothing else.
      if (k >= 0 && d < 0.95 && state.fighters[1].punch.type === null) return inp({ jab: true });
      return inp({ move: { x: 0, y: d > 0.7 ? 0.5 : 0 } });
    },
    metric(events) {
      const jabs = landsBy(events, 0, e => e.punch === 'jab' && e.grade !== 'glancing'), taken = landsBy(events, 1);
      return { progress: clamp01(jabs / 12) * (1 - clamp01(taken / 8)), stat: `${jabs} jabs landed · ${taken} taken` };
    },
  },
  {
    id: 'cut-off',
    title: 'Cutting off the ring',
    goal: 'He circles away and will not fight: take the ring away and put his back on the ropes.',
    seconds: 40,
    placement: centre(1.4),
    opponent: { style: 'outboxer' },
    policy(state, tick, seed, cfg) {
      const me = state.fighters[1];
      // Away and round, changing direction every few seconds. (Polish phase: he used to back straight into the ropes
      // and stay there — walking at him ended the drill in four seconds. Now, inside a metre and a bit of the ropes,
      // he goes ALONG them toward the open side of the ring, at full speed, and only backs up when there is room.)
      const half = RING_HALF - cfg.ringInset;
      const edge = Math.min(half - Math.abs(me.pos.x), half - Math.abs(me.pos.z));
      let dir = hash01(seed, Math.floor(tick / T(2.5))) < 0.5 ? -1 : 1;
      if (edge < CUT_OFF_ROOM) {
        // His right, in the world (he faces the player): the side whose step takes him nearer the middle is the open one.
        const rx = -Math.sin(me.yaw), rz = Math.cos(me.yaw);
        dir = me.pos.x * rx + me.pos.z * rz > 0 ? -1 : 1;
        return inp({ move: { x: dir, y: edge < 0.35 ? 0.15 : -0.2 } });
      }
      return inp({ move: { x: dir * 0.8, y: -0.6 } });
    },
    metric(events, state, cfg) {
      const opp = state.fighters[1];
      const half = RING_HALF - cfg.ringInset;
      const edge = Math.min(half - Math.abs(opp.pos.x), half - Math.abs(opp.pos.z));
      // (Polish phase: it is not done by standing near him once. The work is punches landed on him WHILE he is on the
      // ropes — each land is placed by where it landed.)
      const onRopes = landsBy(events, 0, e => Math.min(half - Math.abs(e.at.x), half - Math.abs(e.at.z)) < CUT_OFF_ROPES);
      const trapped = opp.ropes > 0.5 && dist(state) < 1.1;
      return { progress: clamp01(onRopes / 5), stat: `${onRopes} landed with his back on the ropes · ${edge.toFixed(1)} m from them now${trapped ? ' · trapped' : ''}` };
    },
  },
  {
    id: 'get-inside',
    title: 'Getting inside',
    goal: 'A taller man with a long jab: get past it — behind your guard, under it, or off a slip — to his chest.',
    seconds: 40,
    placement: centre(1.5),
    opponent: { style: 'outboxer', heightM: 1.93, reachM: 2.02 },
    policy(state, tick, seed, cfg) {
      const d = dist(state);
      const k = beat(tick, seed, 0.7, 0.1, 0.6);
      // He stands his ground behind the jab and gives a little when crowded.
      if (k >= 0 && d < 1.12 && d > cfg.rangeInside && state.fighters[1].punch.type === null) return inp({ jab: true });
      return inp({ move: { x: 0, y: d < 0.85 ? -0.4 : 0 } });
    },
    metric(events, state, cfg) {
      const inside = landsBy(events, 0, e => e.variant === 'shovelHook' || e.variant === 'insideUppercut' || (e.part === 'body' && e.variant !== 'bodyJab'));
      const there = dist(state) < cfg.rangeInside;
      return { progress: clamp01(inside / 6), stat: `${inside} landed inside${there ? ' · inside now' : ''} · ${landsBy(events, 1)} jabs taken` };
    },
  },
  {
    id: 'slip-timing',
    title: 'Slip timing',
    goal: 'One big punch at a time, never on the beat, each after a dip: read it and flick your head off the line.',
    seconds: 40,
    placement: centre(0.85),
    opponent: { style: 'slugger' },
    policy: telegraphed,
    metric(events) {
      const slipped = events.reduce((n, e) => n + (e.type === 'slip' && e.side === 0 && e.dodged ? 1 : 0), 0), taken = landsBy(events, 1);
      return { progress: clamp01(slipped / 6), stat: `${slipped} slipped · ${taken} taken` };
    },
  },
  {
    id: 'slip-counter',
    title: 'Slip, then counter',
    goal: 'The same punches: slip one and pay him with the hand the slip loaded, inside the window.',
    seconds: 40,
    placement: centre(0.85),
    opponent: { style: 'slugger' },
    policy: telegraphed,
    metric(events) {
      const counters = events.reduce((n, e) => n + (e.type === 'counter' && e.side === 0 ? 1 : 0), 0);
      const slipped = events.reduce((n, e) => n + (e.type === 'slip' && e.side === 0 && e.dodged ? 1 : 0), 0);
      return { progress: clamp01(counters / 4), stat: `${counters} counters landed · ${slipped} slipped` };
    },
  },
  {
    id: 'body-work',
    title: 'Body work',
    goal: 'He holds a high guard and waits: go downstairs until the guard comes apart.',
    seconds: 40,
    placement: centre(0.8),
    opponent: { style: 'pressure' },
    policy(state) {
      const d = dist(state);
      return inp({ block: true, move: { x: 0, y: d > 0.85 ? 0.5 : 0 } });
    },
    metric(events, state, cfg) {
      const body = landsBy(events, 0, e => e.part === 'body');
      const wear = state.fighters[1].damage.body / Math.max(1e-6, cfg.bodyWearFull);
      const breaks = events.reduce((n, e) => n + (e.type === 'guardBreak' && e.side === 1 ? 1 : 0), 0);
      return { progress: clamp01(Math.max(body / 10, wear)), stat: `${body} body shots · body wear ${Math.round(clamp01(wear) * 100)}% · ${breaks} guard breaks` };
    },
  },
  {
    id: 'survive',
    title: 'Surviving hurt',
    goal: 'You are rocked and in the corner and he is coming to finish it: move, cover, tie him up — get through it.',
    seconds: 12,
    placement(cfg) {
      const c = RING_HALF - cfg.ringInset - 0.25;
      return { player: { x: -c, z: -c }, opponent: { x: -c + 0.62, z: -c + 0.62 } };
    },
    opponent: { style: 'swarmer' },
    setup(state) {
      const p = state.fighters[0];
      p.hurt = 3; p.hurtMax = 3; p.hurtKind = 'head';
      p.health = Math.min(p.health, 0.55);
    },
    policy(state, tick, seed) {
      const d = dist(state), me = state.fighters[1];
      const k = beat(tick, seed, 0.55, 0.1, 0.7);
      // Walk him down and throw: crosses and hooks, in range, as fast as they come (after a half-second's grace).
      if (k >= 0 && tick >= T(0.6) && d < 0.95 && me.punch.type === null && !me.clinch.active) {
        const r = hash01(seed + 3, k);
        return r < 0.4 ? inp({ cross: true }) : inp({ hook: true, move: { x: r < 0.7 ? -1 : 1, y: 0 } });
      }
      return inp({ move: { x: 0, y: d > 0.72 ? 0.85 : 0 } });
    },
    metric(events, state) {
      // (Polish phase: a knee taken by choice is not "went down" — it is one of the ways through. And standing there
      // taking it is not surviving: every clean shot taken costs progress.)
      const downs = events.reduce((n, e) => n + (e.type === 'knockdown' && e.side === 0 && e.kind !== 'knee' ? 1 : 0), 0);
      const knees = events.reduce((n, e) => n + (e.type === 'knockdown' && e.side === 0 && e.kind === 'knee' ? 1 : 0), 0);
      const t = state.time, taken = landsBy(events, 1, e => e.grade !== 'glancing');
      return { progress: downs > 0 ? 0 : clamp01(t / 12) * (1 - clamp01(taken / 12)), stat: `${t.toFixed(1)} s survived${downs ? ' · went down' : ''}${knees ? ' · took a knee' : ''} · ${taken} taken clean` };
    },
    // The count after a knee (or a knockdown) is quick here: the drill is the twelve seconds, not the ten.
    tune: cfg => ({ countTickSeconds: cfg.countTickSeconds * DRILL_COUNT }),
  },

  // ── Polish phase (2026-11-11): one drill per fix, so each can be judged in a couple of minutes ──────────────
  {
    id: 'combinations',
    title: 'Combinations',
    goal: 'He stands in front of you and comes back when you move him: throw the 1-2-3 and the 1-2-body-hook and finish them.',
    seconds: 45,
    placement: centre(0.8),
    opponent: { style: 'pressure' },
    policy: partnerInFront,
    metric: comboMetric,
    tune: durablePartner,
  },
  {
    id: 'combinations-ropes',
    title: 'Combinations on the ropes',
    goal: 'The same man with his back on the ropes and nowhere to go: put the combination together and end it with the big one.',
    seconds: 45,
    placement(cfg) { const c = RING_HALF - cfg.ringInset; return { player: { x: c - 0.85, z: 0 }, opponent: { x: c - 0.05, z: 0 } }; },
    opponent: { style: 'pressure' },
    policy: () => inp(),
    metric: comboMetric,
    tune: durablePartner,
  },
  {
    id: 'trading',
    title: 'Trading',
    goal: 'He hits you on a steady beat — jab, cross, jab, hook: throw back through it. Your punches still come out; they are slower, shorter and weaker for a moment.',
    seconds: 45,
    placement: centre(0.8),
    opponent: { style: 'pressure' },
    policy(state, tick) {
      const d = dist(state), me = state.fighters[1];
      const n = T(TRADE_BEAT), k = Math.floor(tick / n);
      // On the beat, whatever is going on (that is the point): jab, cross, jab, hook.
      if (tick % n === 0 && tick > 0 && d < 1.0 && me.punch.type === null) return inp({ [TRADE_SEQ[k % TRADE_SEQ.length]!]: true });
      return inp({ move: { x: 0, y: d > 0.84 ? 0.6 : d < 0.68 ? -0.4 : 0 } });
    },
    metric(events) {
      let thrown = 0, landed = 0, stuffed = 0, biggest = 0;
      for (const e of events) {
        if (e.type === 'punchStart' && e.side === 0 && (e.nerf ?? 0) > 0) { thrown++; biggest = Math.max(biggest, e.nerf ?? 0); }
        else if (e.type === 'punchLand' && e.side === 0 && (e.nerf ?? 0) > 0) landed++;
        else if (e.type === 'punchStuffed' && e.side === 0) stuffed++;
      }
      return { progress: clamp01(landed / 8), stat: `${thrown} thrown while being hit · ${landed} of them landed · ${stuffed} stuffed · ${landsBy(events, 1)} taken` };
    },
    tune: cfg => ({ healthDamagePerImpulse: cfg.healthDamagePerImpulse * 0.25, stunBase: cfg.stunBase * 3, bodyHurtBase: cfg.bodyHurtBase * 3 }),
  },
  {
    id: 'stamina-pace',
    title: 'A round at pace',
    goal: 'One minute, a partner who blocks some and takes some and never hits back: work at your own pace and watch what the tank does.',
    seconds: 60,
    placement: centre(0.8),
    opponent: { style: 'pressure' },
    policy(state, tick) {
      const d = dist(state);
      // Guard up for two seconds in every four; he holds the range.
      return inp({ block: Math.floor(tick / T(2)) % 2 === 1, move: { x: 0, y: d > 0.86 ? 0.6 : d < 0.66 ? -0.4 : 0 } });
    },
    metric(events, state) {
      const p = state.fighters[0];
      let thrown = 0, missed = 0;
      for (const e of events) { if (e.type === 'punchStart' && e.side === 0) thrown++; else if (e.type === 'punchWhiff' && e.side === 0) missed++; }
      return { progress: clamp01(thrown / 40), stat: `${thrown} thrown · ${missed} missed · tank ${Math.round(p.stamina * 100)}% of a ${Math.round(p.staminaCap * 100)}% ceiling${p.fatigue > 0 ? ' · tired' : ''}` };
    },
    tune: durablePartner,
  },
  {
    id: 'stamina-guard',
    title: 'Behind the guard',
    goal: 'Hold your guard: fifteen seconds of jabs on it, then hooks and crosses. Light shots cost next to nothing; heavy ones cost the arms.',
    seconds: 35,
    placement: centre(0.78),
    opponent: { style: 'pressure' },
    policy(state, tick) {
      const d = dist(state), me = state.fighters[1];
      const heavy = tick >= T(GUARD_LIGHT_SECONDS);
      const n = T(heavy ? 0.85 : 0.5), k = Math.floor(tick / n);
      if (tick % n === 0 && tick > 0 && d < 1.0 && me.punch.type === null) return inp(heavy ? (k % 2 ? { hook: true, move: { x: k % 4 === 1 ? -1 : 1, y: 0 } } : { cross: true }) : { jab: true });
      return inp({ move: { x: 0, y: d > 0.82 ? 0.6 : d < 0.66 ? -0.4 : 0 } });
    },
    metric(events, state) {
      const p = state.fighters[0];
      let light = 0, heavy = 0;
      for (const e of events) if ((e.type === 'punchBlock' || e.type === 'perfectBlock') && e.side === 1) { if (e.punch === 'jab') light++; else heavy++; }
      return { progress: clamp01((light + heavy) / 30), stat: `${light} jabs and ${heavy} heavy shots on the guard · tank ${Math.round(p.stamina * 100)}% · guard ${Math.round(p.guardHp * 100)}% · ${landsBy(events, 1)} got through` };
    },
    tune: cfg => ({ healthDamagePerImpulse: cfg.healthDamagePerImpulse * 0.25 }),
  },
  {
    id: 'hurt',
    title: 'Hurting him',
    goal: 'A worn man at the end of a hard fight who can still be hurt every way there is: rock him, fold him with the body shot, put him down.',
    seconds: 60,
    placement: centre(0.85),
    opponent: { style: 'pressure' },
    setup(state) {
      const o = state.fighters[1];
      o.health = 0.6; o.stamina = 0.55; o.damage.body = 0.7; o.damage.head = 0.5;
    },
    policy(state, tick, seed) {
      const d = dist(state), me = state.fighters[1];
      const k = beat(tick, seed, 2.2);
      // He holds his ground behind a lazy jab — nothing that will hurt you — and stands still while he is being hit.
      const busy = me.hitT > 0 || me.hurt > 0 || state.fighters[0].punch.type !== null;
      if (k >= 0 && d < 0.98 && me.punch.type === null && !busy) return inp({ jab: true });
      return inp({ move: { x: 0, y: !busy && d > 0.9 ? 0.5 : 0 } });
    },
    metric(events) {
      const seen = new Set<string>();
      let rocked = 0, winded = 0, downs = 0;
      for (const e of events) {
        if (e.type === 'hurtStyle' && e.side === 1) { seen.add(e.style); if (e.kind === 'head') rocked++; else winded++; }
        else if (e.type === 'knockdown' && e.side === 1) { downs++; seen.add(`down:${e.kind ?? 'heavy'}`); }
      }
      const kinds = [...seen].sort().join(', ');
      return { progress: clamp01(seen.size / 5), stat: `rocked ${rocked} · winded ${winded} · floored ${downs}${kinds ? ` · seen: ${kinds}` : ''}` };
    },
    // He gets up every time, quickly: the drill is the ways of being hurt, not the wait.
    tune: cfg => ({ countTickSeconds: cfg.countTickSeconds * DRILL_COUNT, knockdownsForTko: 99, getUpCountWorst: 6, stunOutFrac: 99, stunOutFinishFrac: 99 }),
  },
];

/** How far from the ropes the cut-off partner starts running along them instead of backing up, and how near a land must be to count as "on the ropes", m. Shape. */
const CUT_OFF_ROOM = 1.15, CUT_OFF_ROPES = 0.95;
/** A drill's count runs this many times faster than a fight's (nobody stands through a dead ten). Shape. */
const DRILL_COUNT = 0.3;
/** Trading: seconds between the partner's punches, and what he throws. Shape. */
const TRADE_BEAT = 0.9;
const TRADE_SEQ: readonly PunchType[] = ['jab', 'cross', 'jab', 'hook'];
/** Behind the guard: seconds of light shots before the heavy ones. Shape. */
const GUARD_LIGHT_SECONDS = 15;

/** A partner who stands in front of the player with his hands at rest and walks back into range when he has been moved. */
function partnerInFront(state: SimState): FrameInput {
  const d = dist(state), me = state.fighters[1];
  // He stands still while he is being worked on (walking onto the third punch smothers it) and comes back once it is over.
  const busy = me.hitT > 0 || state.fighters[0].punch.type !== null;
  return inp({ move: { x: 0, y: !busy && d > 0.9 ? 0.7 : !busy && d < 0.64 ? -0.4 : 0 } });
}
/** Combinations: finishers landed, and the longest clean combination. */
function comboMetric(events: readonly SimEvent[]): { progress: number; stat: string } {
  let finishers = 0, best = 0, threes = 0;
  for (const e of events) if (e.type === 'punchLand' && e.side === 0) { best = Math.max(best, e.combo); if (e.finisher) finishers++; if (e.combo === 3) threes++; }
  return { progress: clamp01(finishers / 5), stat: `${finishers} combinations finished · ${threes} reached a third clean punch · longest ${best}` };
}
/** A partner for working on: a punch takes a fifth of its health, he cannot be rocked or dropped by ordinary shots, and a count (if it comes to that) is quick. */
function durablePartner(cfg: Config): Partial<Config> {
  return { healthDamagePerImpulse: cfg.healthDamagePerImpulse * 0.2, stunBase: cfg.stunBase * 3, bodyHurtBase: cfg.bodyHurtBase * 3, liverMinImpulse: cfg.liverMinImpulse * 3, countTickSeconds: cfg.countTickSeconds * DRILL_COUNT };
}

/** A fresh state for a drill: the pair placed and facing each other, the opponent's spec overridden, the drill's setup applied. */
export function drillState(drill: Drill, specs: [FighterSpec, FighterSpec], cfg: Config, seed: number): SimState {
  const opp: FighterSpec = { ...specs[1], ...(drill.opponent ?? {}) };
  const s = createState([specs[0], opp], cfg, seed);
  const p = drill.placement(cfg);
  const [a, b] = s.fighters;
  a.pos = { x: p.player.x, z: p.player.z }; b.pos = { x: p.opponent.x, z: p.opponent.z };
  a.yaw = Math.atan2(b.pos.z - a.pos.z, b.pos.x - a.pos.x);
  b.yaw = Math.atan2(a.pos.z - b.pos.z, a.pos.x - b.pos.x);
  drill.setup?.(s, cfg);
  return s;
}

export function drillById(id: string): Drill | undefined { return DRILLS.find(d => d.id === id); }
