/**
 * ui/audio/map.ts — which sounds an event asks for. Pure functions of the
 * event and the config: the live game (ui/audio.ts) and the offline renderer
 * (scripts/audio_render.mjs) both call these, so what is measured is what
 * plays.
 *
 * A request names a recipe and bends it: `power` (level), `pitch`, `length`
 * (stretch on hold + decay), `delay` (seconds after the event).
 */
import type { Config, HitZone, PunchType, PunchVariant, SimEvent } from '../../core';
import type { Reaction } from '../../render/mood';

/** `level` (polish phase) is a plain linear gain on the voice — `power` only moves it ±2 dB. `seed` 0..1 makes it exact: no random jitter, noise layers start where the seed says. */
export interface VoiceReq { name: string; power?: number | undefined; pitch?: number | undefined; length?: number | undefined; delay?: number | undefined; level?: number | undefined; seed?: number | undefined }

/** What the sound remembers between events: how nerfed each side's punch in flight is (punchStart says; punchWhiff does not). The live shell and the offline renderer each keep one. */
export interface VoiceMemory { nerf: [number, number] }
export const newVoiceMemory = (): VoiceMemory => ({ nerf: [0, 0] });

/** How the hit zone bends an impact (× audioZoneDepth): pitch and length of the impact, the breath after a body shot, one small extra layer. */
const ZONE: Record<HitZone, { pitch?: number; length?: number; breath?: number; extra?: string; extraPitch?: number; extraLevel?: number }> = {
  chin: { pitch: 1.05, extra: 'zoneSnap' },                                            // teeth
  jaw: { pitch: 0.97, extra: 'zoneKnock', extraLevel: 0.7 },
  temple: { pitch: 0.92, length: 1.12, extra: 'zoneKnock', extraPitch: 0.72 },         // low and hollow
  nose: { pitch: 1.08, length: 0.9, extra: 'zoneSnap', extraPitch: 0.7, extraLevel: 1.1 },
  forehead: { pitch: 0.9, length: 0.82, extra: 'zoneKnock', extraPitch: 1.3, extraLevel: 1.1 },   // hard, short: the worst place to hit a man
  solar: { breath: 1.5 },                                                              // all the air
  ribs: { pitch: 1.12, length: 0.85, extra: 'zoneRib' },
  liver: { pitch: 0.93, length: 1.1 },
  belly: { pitch: 0.86, length: 1.15, breath: 0.8 },                                   // the dullest
};
const frac = (v: number): number => v - Math.floor(v);

/** The beat of ducked crowd an event asks for (a flush land, a finisher), or null. */
export function duckForEvent(e: SimEvent, c: Config): { depth: number; hold: number } | null {
  if (e.type !== 'punchLand' || !c.showSoundTiersOn || c.audioFlushDuck >= 1) return null;
  const fin = c.showFinisherOn && e.finisher === true && e.grade !== 'glancing';
  if (e.grade !== 'flush' && !fin) return null;
  return { depth: c.audioFlushDuck, hold: c.audioFlushDuckSeconds * (fin ? 1.5 : 1) };
}

/** counterFeelV2: the low thud with the long tail under a counter's impact, scaled by the landed power. */
function counterThud(out: VoiceReq[], power: number, c: Config, delay: number): void {
  if (!c.counterFeelV2 || c.counterThudGain <= 0) return;
  out.push({ name: 'counterThud', power, level: c.counterThudGain, delay: delay + c.counterThudDelay });
}

/** A landed punch with the tiers pushed apart (showSoundTiersOn). The overhaul's version is the `else` in voicesForEvent. */
function landVoices(x: Partial<Extract<SimEvent, { type: 'punchLand' }>> & { power: number; punch: PunchType }, c: Config): VoiceReq[] {
  const out: VoiceReq[] = [];
  const grade = x.grade === 'glancing' || x.grade === 'flush' ? x.grade : 'clean';
  const v = VARIANT[x.variant ?? 'jab'] ?? {};
  const body = x.part === 'body';
  const heavy = v.heavy === true || PUNCH_CLASS[x.punch] === 'impactHeavy';
  const delay = x.through ? c.audioThroughGap : 0;
  const z = (x.zone ? ZONE[x.zone] : undefined) ?? {};
  const depth = c.audioZoneDepth;
  const bend = (m: number | undefined): number => 1 + ((m ?? 1) - 1) * depth;
  // The land's seeded variation, spread into three numbers: pitch, length, and which small layers join.
  const vary = typeof x.vary === 'number' ? Math.max(-1, Math.min(1, x.vary)) : null;
  const v2 = vary === null ? 0 : frac(Math.abs(vary) * 9.7 + 0.31) * 2 - 1;
  const v3 = vary === null ? 0.5 : frac(Math.abs(vary) * 23.3 + 0.17);
  const seed = vary === null ? undefined : frac(Math.abs(vary) * 51.7 + (vary < 0 ? 0.5 : 0));
  const nerf = c.showNerfOn ? Math.max(0, Math.min(1, x.nerf ?? 0)) : 0;
  let pitch = (v.pitch ?? 1) * bend(z.pitch) * (1 + c.audioVaryPitch * (vary ?? 0));
  let length = (v.length ?? 1) * bend(z.length) * (1 + c.audioVaryLength * v2) * (1 - nerf * c.audioNerfImpact / 3);
  let level = 1 - nerf * c.audioNerfImpact;
  const power = x.power * (v.power ?? 1);
  if (x.through) out.push({ name: 'gloveTick', power: x.power, level });

  if (grade === 'glancing') {
    // A miss that touched: one scuff, nothing under it, no breath, no zone, no combination.
    out.push({ name: body ? 'scuffBody' : heavy ? 'scuffHeavy' : 'scuffSharp', power, pitch, length, level: level * c.audioScuffGain, delay });
  } else {
    const combo = x.combo ?? 1, k = Math.min(4, Math.max(0, combo - 1));
    const fin = c.showFinisherOn && x.finisher === true;
    const wrong = x.wrongWay === true;
    const flush = grade === 'flush' || wrong || fin;
    if (fin) { pitch *= c.audioFinisherPitch; length *= 1.25; }
    else { pitch *= 1 + c.audioComboPitch * k; level *= 1 + c.audioComboWeight * k; }   // the combination rises…
    out.push({ name: (body ? 'impactBody' : heavy ? 'impactHeavy' : 'impactSharp') + (flush ? 'Flush' : ''), power, pitch, length, level, delay });
    if (flush && body) out.push({ name: 'flushBodyWet', power, pitch, level: level * c.audioFlushTail, delay });
    else if (flush) {
      out.push({ name: 'flushCrack', power, pitch, level: level * c.audioFlushCrack * (heavy ? 1.8 : 1), delay });   // a hook's crack has far more low end to be heard over
      out.push({ name: 'flushTail', power, pitch, level: level * c.audioFlushTail, delay });
    }
    if (fin) out.push({ name: 'impactFinisher', power, pitch: body ? 0.9 : 1, level: level * c.audioFinisherGain, delay });   // …and the last punch lands low
    if (v.tail) out.push({ name: 'impactTail', power, level, delay: delay + 0.03 });
    if (wrong) out.push({ name: 'impactWrong', power: x.power, level, delay });
    if (body) {
      const breath = x.power * c.audioExhaleGain * (flush ? 1.4 : 1);
      out.push({ name: 'bodyExhale', power: breath, level: level * bend(z.breath), delay });
      if (flush) out.push({ name: 'bodyGrunt', power: breath, level: level * bend(z.breath), delay });
      if (x.liver) out.push({ name: 'liverThud', power: x.power, level, delay });
    }
    if (z.extra && depth > 0) out.push({ name: z.extra, pitch: z.extraPitch, level: level * Math.min(2, depth) * (z.extraLevel ?? 1), delay: delay + (v3 > 0.67 ? 0.008 : 0) });
    if (vary !== null && v3 < 0.34) out.push({ name: 'impactGrit', pitch: 1 + 0.2 * v2, level, delay });
    if (combo >= 2 && !fin) {
      const kk = Math.min(combo, 6) - 2;
      out.push({ name: 'comboRise', level: level * (0.45 + 0.18 * kk), pitch: 1 + c.audioComboStep * kk, delay });
    }
    if (x.counter) { out.push({ name: 'counter', delay }); out.push({ name: 'counterWeight', power: x.power, delay }); counterThud(out, x.power, c, delay); }
  }
  if (seed !== undefined) out.forEach((r, i) => { r.seed = frac(seed + i * 0.137); });
  return out;
}

const PUNCH_CLASS: Record<PunchType, string> = { jab: 'impactSharp', cross: 'impactSharp', hook: 'impactHeavy', uppercut: 'impactHeavy' };
const SUFFIX = { glancing: 'Glance', clean: '', flush: 'Flush' } as const;

/** How a variant bends its class's recipe: an overhand is heavier and its weight arrives late; shovel and inside punches are short and dull. */
const VARIANT: Partial<Record<PunchVariant, { pitch?: number; length?: number; power?: number; heavy?: boolean; tail?: boolean }>> = {
  stepJab: { pitch: 1.04, power: 1.1 },
  retreatJab: { pitch: 1.06, power: 0.85, length: 0.85 },
  overhand: { heavy: true, pitch: 0.88, length: 1.25, power: 1.2, tail: true },
  checkHook: { pitch: 1.06, length: 0.85 },
  shovelHook: { pitch: 0.82, length: 0.6 },
  insideUppercut: { pitch: 0.84, length: 0.6 },
  risingHook: { pitch: 0.95, length: 1.15, power: 1.1 },
  risingUppercut: { pitch: 0.93, length: 1.2, power: 1.15 },
};

const SLIP_PITCH = { slip: 1, pull: 0.82, roll: 0.68 } as const;

/** The sounds for one sim event. `player` = whose ears this is (the counter-window ping is the player's alone). */
export function voicesForEvent(e: SimEvent, c: Config, player = 0, mem?: VoiceMemory): VoiceReq[] {
  const out: VoiceReq[] = [];
  switch (e.type) {
    case 'punchStart': if (mem && (e.side === 0 || e.side === 1)) mem.nerf[e.side] = Math.max(0, Math.min(1, e.nerf ?? 0)); break;
    case 'punchLand': {
      // Defensive reads: this ran against the old event shape first and must not throw on a missing field.
      const x = e as Partial<typeof e> & { power: number; punch: PunchType };
      if (c.showSoundTiersOn) { out.push(...landVoices(x, c)); break; }
      const grade = x.grade === 'glancing' || x.grade === 'flush' ? x.grade : 'clean';
      const v = VARIANT[x.variant ?? 'jab'] ?? {};
      const body = x.part === 'body';
      const wrong = x.wrongWay === true && grade !== 'glancing';
      const suffix = wrong ? 'Flush' : SUFFIX[grade];
      const base = body ? 'impactBody' : v.heavy ? 'impactHeavy' : PUNCH_CLASS[x.punch];
      const delay = x.through ? c.audioThroughGap : 0;
      const power = x.power * (grade === 'glancing' ? c.audioGlanceGain : 1) * (v.power ?? 1);
      if (x.through) out.push({ name: 'gloveTick', power: x.power });
      out.push({ name: base + suffix, power, pitch: v.pitch, length: v.length, delay });
      if (v.tail && grade !== 'glancing') out.push({ name: 'impactTail', power, delay: delay + 0.03 });
      if (wrong) out.push({ name: 'impactWrong', power: x.power, delay });
      if (body && grade !== 'glancing') {
        const breath = x.power * c.audioExhaleGain * (grade === 'flush' ? 1.4 : 1);
        out.push({ name: 'bodyExhale', power: breath, delay });
        if (grade === 'flush') out.push({ name: 'bodyGrunt', power: breath, delay });
        if (x.liver) out.push({ name: 'liverThud', power: x.power, delay });
      }
      const combo = x.combo ?? 1;
      if (combo >= 2 && grade !== 'glancing') {
        const k = Math.min(combo, 6) - 2;
        out.push({ name: 'comboRise', power: 0.7 + 0.3 * k, pitch: 1 + c.audioComboStep * k, delay });
      }
      if (x.counter) { out.push({ name: 'counter', delay }); out.push({ name: 'counterWeight', power: x.power, delay }); counterThud(out, x.power, c, delay); }
      break;
    }
    case 'punchBlock': {
      // Leather on leather — duller and heavier as the guard wears, and heavier again when health got through.
      const x = e as Partial<typeof e>;
      const worn = (1 - Math.min(1, Math.max(0, x.guard ?? 1))) * c.audioGuardWear;
      const chip = Math.min(1, (x.chip ?? 0) * 25);
      out.push({ name: 'impactBlocked', power: 0.8 + 0.7 * worn + 0.4 * chip, pitch: (x.part === 'body' ? 0.85 : 1) * (1 - 0.28 * Math.min(1, worn)) });
      if (worn > 0.35 || chip > 0) out.push({ name: 'blockHeavy', power: 0.5 + worn + chip });
      break;
    }
    case 'perfectBlock': out.push({ name: 'parryTick' }); break;
    case 'punchWhiff': {
      // A nerfed punch (thrown while being hit) moves less air: duller, shorter, quieter.
      const n = c.showNerfOn && mem && (e.side === 0 || e.side === 1) ? mem.nerf[e.side] * c.audioNerfWhoosh : 0;
      out.push(n > 0 ? { name: 'whiff', level: 1 - n, length: 1 - n, pitch: 1 - 0.8 * n } : { name: 'whiff' });
      break;
    }
    case 'feint': out.push({ name: 'whiff', power: 0.25, pitch: 1.25, length: 0.6 }); break;
    case 'punchSmother': case 'punchStuffed': out.push({ name: 'clothMove', power: 0.8 }); break;
    case 'slip': {
      const x = e as Partial<typeof e> & { dodged: boolean; side: number };
      const pitch = SLIP_PITCH[x.kind ?? 'slip'] * (1 + 0.07 * Math.max(0, (x.chain ?? 1) - 1));
      if (x.dodged) {
        // The glove passes the ear: the close whoosh, brighter down a chain; the player also gets the window's ping.
        out.push({ name: 'slipNear', pitch });
        if (x.side === player) out.push({ name: 'counterOpen' });
      } else out.push({ name: 'clothMove', power: 0.5, pitch });
      break;
    }
    case 'burst': out.push({ name: 'shoeScuff' }); break;
    case 'pivot': out.push({ name: 'shoeSqueak' }); break;
    case 'pushOff': out.push({ name: 'shove', power: e.hit ? 1.3 : 0.5 }); break;
    case 'clinch': out.push({ name: 'clinchThud' }); break;
    case 'clinchBreak': out.push(e.reason === 'referee' ? { name: 'breakTap' } : e.reason === 'pushOff' ? { name: 'shove', power: 0.9 } : { name: 'clothMove' }); break;
    case 'guardBreak': out.push({ name: 'guardCrack' }); break;
    case 'bodyHurt': out.push({ name: 'bodyGroan', power: 1.2, pitch: e.liver ? 0.9 : 1, length: e.liver ? 1.3 : 1 }); break;
    case 'getUpPhase': if (e.phase === 'slump') out.push({ name: 'knockdown', power: 0.3, pitch: 1.2, length: 0.6 }); break;
    case 'knockdown': {
      // The canvas, by the kind of knockdown: a knee is a knee on the canvas, not a body; a man who is out lands late and all at once.
      const kind = c.showKindsOn ? e.kind : undefined;
      if (kind === 'knee') out.push({ name: 'knockdown', power: 0.3, pitch: 1.25, length: 0.5, level: 0.5 });
      else if (kind === 'out') out.push({ name: 'knockdown', pitch: 0.9, length: 1.2, level: 1.25, delay: c.audioOutThudDelay });
      else if (kind === 'flash') out.push({ name: 'knockdown', length: 0.8 });
      else out.push({ name: 'knockdown' });
      break;
    }
    case 'hurtStyle': {
      if (!c.showKindsOn) break;
      if (e.kind === 'head') {
        // Rocked, three ways: the legs go (his feet scrabble), he reaches (a breath through the teeth), he covers (gloves clamp on the head).
        if (e.style === 'legs') { out.push({ name: 'shoeScuff', level: 1.6, delay: 0.12 }); out.push({ name: 'shoeScuff', level: 1.3, pitch: 0.85, delay: 0.34 }); }
        else if (e.style === 'reach') out.push({ name: 'hurtBreath', delay: 0.06 });
        else if (e.style === 'cover') out.push({ name: 'coverUp', delay: 0.05 });
      } else if (e.kind === 'body') {
        // Winded: the delayed one is the breath going a beat after the shot; an elbow clamped down is a short grunt, sinking to a knee a long low one.
        if (e.late) out.push({ name: 'breathGone', level: 1.2 });
        if (e.style === 'elbow') out.push({ name: 'bodyGrunt', pitch: 1.15, length: 0.7, level: 1.3 });
        else if (e.style === 'knee') out.push({ name: 'bodyGrunt', pitch: 0.85, length: 1.5, level: 1.2, delay: 0.1 });
      }
      break;
    }
    case 'rocked': out.push({ name: 'rocked' }); break;
    case 'bell': out.push({ name: 'bell' }); break;
    default: break;
  }
  return out;
}

/** The crowd's voice for a reaction from the mood. Small ones are left to the bed (it has already risen). */
export function voicesForReaction(r: Reaction, c?: Config): VoiceReq[] {
  const s = r.strength;
  // A flush shot's answer comes after an intake of breath (polish phase); without the config, at once, as before.
  const wait = c && c.showCrowdTiersOn ? c.audioFlushAnswerDelay : 0;
  const intake: VoiceReq[] = wait > 0 ? [{ name: 'crowdIntake', power: s }] : [];
  switch (r.kind) {
    case 'land': return s >= 0.5 ? [{ name: 'crowdOh', power: s }] : [];
    case 'flush': return [...intake, { name: 'crowdOoh', power: s, delay: wait }];
    case 'bodyFlush': return [...intake, { name: 'crowdOof', power: s, level: 1.2, delay: wait }];
    // The finisher: the house pops — a shout with an edge, and a short roar behind it.
    case 'finisher': return [...intake, { name: 'crowdCheer', power: 1.3 * s, level: 1.2, delay: wait }, { name: 'crowdRoar', power: s, length: 0.6, delay: wait + 0.1 }];
    // Knockdowns by kind. Flash: a shout, a gasp, then surprise turning to noise — no eruption. A knee: a murmur. Out: the gasp, the roar cut short, then the mood drops it away.
    case 'flashDown': return [{ name: 'crowdOh', power: 2, pitch: 1.2, level: 1.8 }, { name: 'crowdGasp', power: 1.5, delay: 0.05 }, { name: 'crowdLaugh', power: s, delay: 0.45 }];
    case 'kneeDown': return [{ name: 'crowdMurmur', power: s }];
    case 'out': return [{ name: 'crowdGasp', power: 2, pitch: 0.85, length: 1.5, level: 1.4 }, { name: 'crowdEruption', power: s, length: 0.5, delay: 0.5 }];
    // Kinds of hurt: the legs going gets a rising "ooh" over the roar; reaching, a gasp; a late fold, the gasp of a house that had not seen it; sinking to a knee, a groan.
    case 'hurtLegs': return [{ name: 'crowdOoh', power: 1.2, pitch: 1.1, delay: 0.15 }];
    case 'hurtReach': return [{ name: 'crowdGasp', power: 1.2, delay: 0.1 }];
    case 'lateFold': return [{ name: 'crowdGasp', power: 1.2 }];
    case 'hurtKnee': return [{ name: 'crowdGroan', power: 1, delay: 0.2 }];
    case 'body': return [{ name: 'crowdOof', power: s }];
    case 'liver': return [{ name: 'crowdOof', power: 1.2, pitch: 0.9 }];
    case 'bodyHurt': return [{ name: 'crowdOooh', power: s }];
    case 'nearMiss': return [{ name: 'crowdGasp', power: s }];
    case 'ole': return [{ name: 'crowdOle', power: s, pitch: 0.9 + 0.12 * s }];
    case 'counter': {
      const base: VoiceReq[] = [{ name: 'crowdCheer', power: 1.4 * s }, { name: 'crowdRoar', power: s, delay: 0.1 }];
      // counterFeelV2: a short swell a beat after the hit; the mood sends strength > 1 when the counter rocked him.
      if (c && c.counterFeelV2 && c.counterSwellGain > 0) base.push({ name: 'crowdRoar', power: s, length: 0.6, level: c.counterSwellGain * (s > 1 ? c.counterRockSwell : 1), delay: c.counterSwellDelay });
      return base;
    }
    case 'guardBreak': return [{ name: 'crowdCheer', power: s }];
    case 'rocked': return [{ name: 'crowdRoar', power: s }];
    case 'knockdown': return [{ name: 'crowdEruption', power: s }];
    case 'shock': return [{ name: 'crowdGasp', power: 1.8 }, { name: 'crowdEruption', power: s, delay: 0.4 }];
    case 'wince': return [{ name: 'crowdGroan', power: 1.3 }, { name: 'crowdOooh', power: s, delay: 0.1 }];
    case 'ko': return [{ name: 'crowdEruption', power: s * 1.2 }, { name: 'crowdOvation', power: s }];
    case 'knee': return [{ name: 'crowdRoar', power: 0.6, length: 0.6 }];
    case 'slump': return [{ name: 'crowdGroan', power: 1 }];
    case 'rise': return [{ name: 'crowdRoar', power: 0.9 }];
    case 'getUp': return [{ name: 'crowdApplause', power: s }];
    case 'escape': return [{ name: 'crowdApplause', power: 0.4, length: 0.5 }];
    case 'grumble': return [{ name: 'crowdGrumble', power: s }];
    case 'bell': return [{ name: 'crowdApplause', power: s }];
    case 'decision': return [{ name: 'crowdOvation', power: s }];
  }
}
