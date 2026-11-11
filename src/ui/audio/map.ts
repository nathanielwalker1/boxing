/**
 * ui/audio/map.ts — which sounds an event asks for. Pure functions of the
 * event and the config: the live game (ui/audio.ts) and the offline renderer
 * (scripts/audio_render.mjs) both call these, so what is measured is what
 * plays.
 *
 * A request names a recipe and bends it: `power` (level), `pitch`, `length`
 * (stretch on hold + decay), `delay` (seconds after the event).
 */
import type { Config, PunchType, PunchVariant, SimEvent } from '../../core';
import type { Reaction } from '../../render/mood';

export interface VoiceReq { name: string; power?: number | undefined; pitch?: number | undefined; length?: number | undefined; delay?: number | undefined }

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
export function voicesForEvent(e: SimEvent, c: Config, player = 0): VoiceReq[] {
  const out: VoiceReq[] = [];
  switch (e.type) {
    case 'punchLand': {
      // Defensive reads: this ran against the old event shape first and must not throw on a missing field.
      const x = e as Partial<typeof e> & { power: number; punch: PunchType };
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
      if (x.counter) { out.push({ name: 'counter', delay }); out.push({ name: 'counterWeight', power: x.power, delay }); }
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
    case 'punchWhiff': out.push({ name: 'whiff' }); break;
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
    case 'knockdown': out.push({ name: 'knockdown' }); break;
    case 'rocked': out.push({ name: 'rocked' }); break;
    case 'bell': out.push({ name: 'bell' }); break;
    default: break;
  }
  return out;
}

/** The crowd's voice for a reaction from the mood. Small ones are left to the bed (it has already risen). */
export function voicesForReaction(r: Reaction): VoiceReq[] {
  const s = r.strength;
  switch (r.kind) {
    case 'land': return s >= 0.5 ? [{ name: 'crowdOh', power: s }] : [];
    case 'flush': return [{ name: 'crowdOoh', power: s }];
    case 'body': return [{ name: 'crowdOof', power: s }];
    case 'liver': return [{ name: 'crowdOof', power: 1.2, pitch: 0.9 }];
    case 'bodyHurt': return [{ name: 'crowdOooh', power: s }];
    case 'nearMiss': return [{ name: 'crowdGasp', power: s }];
    case 'ole': return [{ name: 'crowdOle', power: s, pitch: 0.9 + 0.12 * s }];
    case 'counter': return [{ name: 'crowdCheer', power: 1.4 * s }, { name: 'crowdRoar', power: s, delay: 0.1 }];
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
