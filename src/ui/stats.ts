/**
 * ui/stats.ts — punch stats for the cards (between rounds, results), counted
 * from the sim's events. Presentation only: nothing here feeds the sim.
 * Per round and for the fight: thrown / landed per punch button, the three
 * grades, head / body, counters, knockdowns scored. A feint is not a punch
 * thrown. `advice` turns one round of it into one honest line.
 */
import type { PunchType, SimEvent, SimState, Side } from '../core';

export const PUNCHES: readonly PunchType[] = ['jab', 'cross', 'hook', 'uppercut'];

export interface SideStats {
  thrown: Record<PunchType, number>;
  landed: Record<PunchType, number>;
  glancing: number; clean: number; flush: number;
  head: number; body: number;
  counters: number;
  /** Knockdowns this fighter SCORED. */
  knockdowns: number;
}

const zero = (): SideStats => ({
  thrown: { jab: 0, cross: 0, hook: 0, uppercut: 0 }, landed: { jab: 0, cross: 0, hook: 0, uppercut: 0 },
  glancing: 0, clean: 0, flush: 0, head: 0, body: 0, counters: 0, knockdowns: 0,
});

export const thrownOf = (s: SideStats): number => PUNCHES.reduce((n, p) => n + s.thrown[p], 0);
export const landedOf = (s: SideStats): number => PUNCHES.reduce((n, p) => n + s.landed[p], 0);

export class FightStats {
  rounds: [SideStats, SideStats][] = [];
  total: [SideStats, SideStats] = [zero(), zero()];

  reset(): void { this.rounds = []; this.total = [zero(), zero()]; }

  round(i: number): [SideStats, SideStats] {
    while (this.rounds.length <= i) this.rounds.push([zero(), zero()]);
    return this.rounds[i]!;
  }

  add(events: readonly SimEvent[], roundIndex: number): void {
    if (!events.length) return;
    const r = this.round(Math.max(0, roundIndex));
    const both = (side: Side, f: (s: SideStats) => void): void => { f(r[side]); f(this.total[side]); };
    for (const e of events) {
      if (e.type === 'punchStart') both(e.side, s => { s.thrown[e.punch]++; });
      else if (e.type === 'feint') both(e.side, s => { s.thrown[e.punch] = Math.max(0, s.thrown[e.punch] - 1); });
      else if (e.type === 'punchLand') both(e.side, s => {
        s.landed[e.punch]++;
        s[e.grade ?? 'clean']++;
        s[e.part]++;
      });
      else if (e.type === 'counter') both(e.side, s => { s.counters++; });
      else if (e.type === 'knockdown') both(e.side === 0 ? 1 : 0, s => { s.knockdowns++; });
    }
  }
}

const pct = (x: number): number => Math.round(x * 100);

/** One line from the corner for `me`, from this round's numbers and where both fighters stand. Only says what the numbers say. */
export function advice(r: [SideStats, SideStats], s: SimState, me: Side): string {
  const him: Side = me === 0 ? 1 : 0;
  const a = r[me], b = r[him];
  const fa = s.fighters[me], fb = s.fighters[him];
  const myThrown = thrownOf(a), myLanded = landedOf(a);
  const hisCapLoss = 1 - (fb.staminaCap ?? 1), myCapLoss = 1 - (fa.staminaCap ?? 1);
  if (b.knockdowns > 0) return 'You went down. Stay behind your guard and keep moving until your legs come back.';
  if (a.knockdowns > 0) return `You put him down${a.knockdowns > 1 ? ` ${a.knockdowns} times` : ''}. He is hurt: stay on him, but pick your shots.`;
  if (b.body >= 3 && myCapLoss >= 0.08) return `He is working your body: ${b.body} body shots, and your stamina ceiling is down ${pct(myCapLoss)}%. Keep your elbows in, or tie him up.`;
  if (a.body >= 3 && hisCapLoss >= 0.05) return `Your body work is slowing him: ${a.body} body shots, his stamina ceiling is down ${pct(hisCapLoss)}%.`;
  if (b.flush >= 3) return `He landed ${b.flush} flush shots. Get your guard up or slip. Do not stand still in front of him.`;
  if (myThrown >= 8 && myLanded / myThrown < 0.3) return `You threw ${myThrown} and landed ${myLanded}. Every miss costs stamina: get closer before you punch.`;
  if (myThrown < 6) return `You threw ${myThrown} punch${myThrown === 1 ? '' : 'es'} all round. Judges score what lands: let your hands go.`;
  if (a.body === 0 && myLanded >= 4) return `All ${myLanded} of your punches went to the head. Hold LOW and go to the body: it takes his stamina away.`;
  const hisLanded = landedOf(b);
  if (myLanded > hisLanded) return `You landed ${myLanded} to his ${hisLanded}. Same again.`;
  if (myLanded < hisLanded) return `He landed ${hisLanded} to your ${myLanded}. You need this next round.`;
  return `Level round: ${myLanded} landed each.`;
}
