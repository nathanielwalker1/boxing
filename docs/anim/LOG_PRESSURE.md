# Pressure / smother fix (anim/pressure)

Nate: brawler AIs "absolutely come forward and smother you; jabbing should keep them at bay". Toggle `aiRespectV2` (default on; off = old AI).

What it does (all in src/ai, keys in src/core/config.ts, panel group "ai"):
1. Working distance floor = smotherDist + aiRespectMargin (0.05); steps inside only in bursts (aiRespectBurstRate/Time). smotherDist itself untouched.
2. A jab that lands on the AI checks its advance (aiRespectCheck x difficulty x brawler scale, seeded +/- aiRespectVary; blocked = aiRespectBlocked; second clean jab extends; stands off by aiRespectGive while checked). Ends early on: its own jab thrown, an approach slip, his miss, or time.
3. Guard cap aiGuardCap (2.2 s +/- 10%), then it drops for aiGuardGap (0.35 s) and the next throw is due.

Probe: `node scripts/ai_feel_probe.mjs styles=swarmer,pressure,slugger diff=medium,hard brief=1 respect=0|1` (6 seeds; ~5 min per difficulty under load).

Measured (Medium, off -> on), swarmer: inside smother vs jabber 84% -> 30%, vs mixer 35% -> 13%; smothered share of the human's punches (jabber/mixer) 13/23% -> 5/10%.
Clean-jab gap at +30 ticks (cm): swarmer +6 -> +20, pressure +12 -> +24, slugger -13 -> +2. Reclose (ticks): swarmer 21 -> 43, pressure 25 -> 54, slugger 45 -> 83.
Hard swarmer vs jabber: 86% -> 30% inside smother; AI wins 5/6 -> 6/6 (jabbing alone does not beat them).
Longest guard hold: swarmer 29 s -> 2.5 s; pressure 2.65 s (macros such as clinch/push hold block outside the cap).
Outboxer/counter at Medium: unchanged within noise.

Below target / open: slugger gap (+2 cm, target +15; its standoff already sits near where the jab leaves it); pressure guard max 2.65 s vs cap 2.42; Hard swarmer vs mixer AI lands fell about 29% (target 25%); ai_human_test calibration (medium AI 64 punches a minute, bots beat medium 73-80%) moved with the floor, expectations widened and flagged.
Pre-existing: ai_human "counter rate 8-20%" reads 21.8% with the toggle off.
