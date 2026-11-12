# Polish phase — SHOW workstream log (sound, camera, crowd, time)

2026-11-11. Nate's brief: "Landing is 'almost there'. Push the difference
between glancing, clean and flush further in sound, reaction and camera, and
make the last punch of a clean combination the biggest moment in it."
Nothing goes on the screen.

**Kind of done: measured, tests green, NOT heard and NOT seen.** I cannot
hear. Every claim below is a number from `PORT=<port> node
scripts/audio_render.mjs`, which renders the game's own audio modules to WAV
(`scripts/output/audio/`, gitignored) and prints the tables. The run was cut
short by Nate ("wrap up"), so parts 1–5 are built and measured and part 6 is
half done (see the end).

## Toggles (group `polish: show`; on = new, off = the overhaul)

| Toggle | What it switches |
| --- | --- |
| `showSoundTiersOn` | scuff / flush layers, the duck, hit zone, seeded variation, the combination's rise |
| `showCamTiersOn` | the camera's answer by grade |
| `showCrowdTiersOn` | glancing = nothing, the combination counts up, the intake before a flush answer |
| `showFinisherOn` | the finisher in sound, camera, crowd and slow motion |
| `showNerfOn` | the nerfed punch's whoosh and impact |
| `showKindsOn` | kinds of hurt and of knockdown in sound and crowd |
| `showSlowAfterStop` | slow motion waits for the hit-stop to end |
| `refWaveOffOn` | the referee waves off a KO that had no count |

The "before" column everywhere below is the same script with the first six
toggles off, so the toggles are proven to restore the old behaviour.
`scripts/output/audio/before/` and `events/` hold the two sets for an A/B by
ear.

## 1. What was measured before

Energy = the whole sound's summed square, dB (fair across lengths). Peak in
dBFS on the impact bus, before the limiter.

Where two tiers were too close (under ~3 dB and no change of character):
- **Clean → flush on a hook / uppercut: 4 dB, same sound.** 95% of both is
  under 200 Hz, centroid 145 → 137 Hz, 1.5× the length. Not a tier.
- **Clean → flush on a body shot: 5 dB, same sound**, same length.
- **Glancing → clean on a jab / cross: 9 dB but one character** (a 10 ms
  tick against a 40 ms snap, both 80–99% above 2 kHz).
- **A glancing hook had a body**: 64% of it under 200 Hz. Not "a miss that
  touched".
- **A combination did not build**: −38 → −34.4 → −34.3 → −33.9 dB. The
  second punch jumped, then flat.
- **The finisher was nothing**: −28.4 dB, quieter than a flush hook.
- **Camera: every land pushed in the same 25 cm.** The punch-in was
  `impulse × camPunchIn` capped at 0.25 m, and impulse is in N·s (a glancing
  jab is 117), so the cap was always hit. A clean jab and a clean hook were
  the same move; a glancing land still moved the lens 6 cm.
- **Crowd**: a glancing land still nudged the house; all knockdown kinds but
  the body one erupted the same; a waved-off KO got an ovation.

## 2. Sound tiers, before → after

| | Before: peak / energy / length / centroid / low% | After |
| --- | --- | --- |
| jab glancing | −14.9 / −47.7 / 0.01 s / 13.7 kHz / 0 | −20.5 / −52.4 / 0.02 s / 7.6 kHz / 0 |
| jab clean | −8.3 / −39.1 / 0.04 / 10.4 k / 1 | −7.8 / −39.5 / 0.04 / 10.0 k / 1 |
| jab flush | −3.7 / −29.4 / 0.13 / 1.6 k / 80 | −3.4 / −26.2 / 0.27 / 0.85 k / 89 |
| cross glancing | −14.6 / −47.5 / 0.01 / 13.7 k / 0 | −20.1 / −52.0 / 0.02 / 7.6 k / 0 |
| cross clean | −7.6 / −38.4 / 0.04 / 10.4 k / 1 | −7.1 / −38.9 / 0.04 / 10.0 k / 1 |
| cross flush | −2.1 / −27.9 / 0.13 / 1.6 k / 80 | −1.9 / −24.7 / 0.27 / 0.85 k / 89 |
| hook glancing | −13.2 / −41.7 / 0.03 / 226 Hz / 64 | −15.1 / −47.5 / 0.02 / 6.7 k / 0 |
| hook clean | −9.0 / −29.7 / 0.14 / 145 / 96 | −9.2 / −29.8 / 0.13 / 145 / 96 |
| hook flush | −2.6 / −25.5 / 0.20 / 137 / 95 | +0.2 / −22.9 / 0.26 / 228 / 95 |
| uppercut | as the hook, within 0.2 dB | as the hook |
| body glancing | −19.0 / −48.6 / 0.03 / 405 / 30 | −18.7 / −48.7 / 0.02 / 1.6 k / 0 |
| body clean | −7.5 / −29.4 / 0.17 / 385 / 92 | −8.0 / −29.7 / 0.18 / 402 / 93 |
| body flush | −3.3 / −24.2 / 0.19 / 215 / 95 | −0.7 / −22.4 / 0.24 / 162 / 97 |

| Gap, dB energy | glancing → clean | clean → flush | flush length ÷ clean |
| --- | --- | --- | --- |
| jab | 8.7 → 12.9 | 9.7 → 13.3 | 3.4 → 7.4 |
| cross | 9.1 → 13.1 | 10.5 → 14.2 | 3.3 → 7.4 |
| hook / uppercut | 12.0 → 17.6 | 4.2 → 7.0 | 1.5 → 2.0 |
| body | 19.2 → 19.0 | 5.2 → 7.3 | 1.1 → 1.4 |

What changed in kind, not just level:
- **Glancing** is a new recipe per class (`scuffSharp` / `scuffHeavy` /
  `scuffBody`): leather brushing, a slower attack and a sweeping band,
  nothing under 200 Hz (the hook's went from 64% low to 0), no breath, no
  zone layer, no combination layer.
- **Clean** is untouched: the reference.
- **Flush** adds `flushCrack` (a flush hook's energy above 2 kHz: −54 →
  −42 dB; it had no top end) and `flushTail` (a long sub and low noise); a
  body shot gets `flushBodyWet` instead (no crack: the body family stays
  under 2 kHz). The crowd bus ducks to `audioFlushDuck` 0.3 for
  `audioFlushDuckSeconds` 0.16 s, the house takes a breath (`crowdIntake`)
  and its "ooh" comes `audioFlushAnswerDelay` 0.18 s late.
- **Zone**: chin and nose add a snap, jaw / temple / forehead a pitched
  knock, ribs a slap; solar plexus more breath; belly the dullest. Five head
  zones measure as five centroids (6.8 / 5.3 / 4.1 / 6.7 / 3.9 kHz on a
  clean cross).
- **Variation**: `vary` bends pitch ±7% and length ±12%, adds a small grit
  layer on about a third of lands, and seeds the noise. The same land
  renders bit-identical twice; impacts no longer take the random jitter.
- **Still weak, plainly**: a body shot's clean → flush is 7 dB and 1.4× the
  length, the smallest change of character of the four. A flush jab / cross
  kept the crack it had; what it gained is the tail.

Mix: clean 1-2-3 with its finisher over a warm bed −2.8 dBFS; the worst
overlap (a flush counter that is also a finisher + eruption + knockdown +
full bed) −2.8; 20 s AI fight −2.5. Ceiling is −1.

## Camera tiers (punch-in cm / shake mm / jolt cm)

| | Before | After |
| --- | --- | --- |
| any glancing | 6.3 / 1.4–3.1 / 0 | 0 / 0 / 0 |
| jab clean | 25 / 9.6 / 0 | 14.3 / 9.6 / 0 |
| cross clean | 25 / 13.4 / 0 | 19.9 / 13.4 / 0 |
| hook clean | 25 / 19.2 / 0 | 25 / 19.2 / 0 |
| jab flush | 37.5 / 16.2 / 0 | 25.8 / 17.3 / 2.7 |
| cross flush | 37.5 / 30.4 / 0 | 40 / 32.4 / 5.1 |
| hook flush | 37.5 / 37.5 / 0 | 40 / 40 / 6 |
| finisher | 25 / 20–29 / 0 | 50 / 48 / 8 |
| fully nerfed cross | 25 / 13.4 / 0 | 10 / 6.7 / 0 |

The jolt is new: the lens is shoved along the punch and let back (a kick in
the direction of the blow, not the sinusoid shake). `camFlushShake` is 1.6
(at 2 a flush hook out-shook the finisher). A flush land's shake is only
7% over the old one: the flush camera gain is the jolt and the power
scaling, not the shake. For scale: a counter is
40 cm, a rock 50, a knockdown 70 cm / 36 mm.

## Crowd tiers (excitement nudge from rest; what it voices)

| | Before | After |
| --- | --- | --- |
| glancing | 0.01–0.02, silent | 0, silent, and the lull clock keeps running |
| clean jab / cross / hook | 0.06 / 0.08 / 0.11, "oh" from a cross up | same |
| flush jab / cross / hook | 0.19 / 0.36 / 0.44, "ooh" | same nudge; intake, then the "ooh" |
| finisher (hook) | 0.17, "oh" | 0.60: intake, a cheer, a short roar |
| later punches of a combination | flat | +25% per punch (`exciteComboStep`) |

## 3. The finisher

Sound: its class's flush recipe pitched down to 0.86 and 1.25× long, the
crack and tail, plus `impactFinisher` (a boom falling 118 → 25 Hz over
0.75 s, a knock, a crack, a long tail). −18.8 dB energy against −33.5 for a
fourth punch and −22.9 for a flush hook; before it was −28.4. The
combination under it now rises: −38.7 → −37.3 → −35.2 → −33.5 dB, each
pitched up 4%, and the finisher drops. Camera: the table above. Crowd: the
pop. Time: `showFinisherSlowMo` 0.45 for `showFinisherSlowMoSeconds` 0.3 s;
`main.ts` now takes the slowest of counter / rock / finisher instead of the
last one in the frame (a rock at 0.4 used to overwrite a counter at 0.3).

Needs ears: the finisher sums to +2.3 to +3.4 dBFS before the limiter (two
runs), so it is squashed about 5 dB; a flush hook now sits at 0 dBFS. Whether that is "heaviest" or distortion I cannot tell.

## 4. The nerfed punch

Impact: −38.7 → −41.5 (half nerfed) → −45.1 dB (full), a third shorter.
Whoosh: −40.4 → −49.4 dB, 0.11 → 0.06 s, centroid 2.0 k → 1.1 k Hz. The
whiff event carries no `nerf`, so the audio remembers it from `punchStart`
per side. The camera halves its move for a fully nerfed land.

## 5. Kinds of hurt and knockdown

| Event | Ring | Crowd |
| --- | --- | --- |
| rocked, legs | two shoe scuffs | a rising "ooh" over the roar |
| rocked, reach | a breath through the teeth | a gasp |
| rocked, cover | two glove pats | — |
| winded, elbow | a short grunt | — |
| winded, knee | a long low grunt | a groan |
| body, late | `breathGone`: a long falling wheeze | a gasp (then the "oooh" `bodyHurt` already gives) |
| knockdown, heavy | canvas thud | eruption, hush after 1.6 s (unchanged) |
| knockdown, flash | shorter thud | a shout, a gasp, bursts of chatter; lifts to 0.8, never hushed; 0.25 three seconds on (a heavy one: 0.66) |
| knockdown, knee | a knee on the canvas, half level | a murmur; lifts only to 0.35 |
| knockdown, out | thud `audioOutThudDelay` 0.45 s late | gasp, a roar cut to half length, then after `showOutDropAfter` 2.6 s excitement falls to 0.08 and the hush goes to 1 |
| `ko.waved` | — | nothing: no ovation over a man who is not moving |

No count sound exists anywhere (`countTick` is silent and stays so; the
check asserts it).

**Referee**: on `ko.waved` he crosses both arms over his head for
`refWaveSeconds` 2.4 s at `refWaveHz` 1.5 as he walks to the man, instead of
standing as if to count. The rig took the pose through his `FighterState`
(hands and `solveArm`), nothing new needed. `window.__refGesture()` reports
it. **Not looked at: no screenshot was taken of the wave**, so whether the
arms cross cleanly or pass through the head is unknown.

## 6. Hit-stop — half done

Found and fixed: the freeze is counted in sim ticks and the host's slow
motion slows the ticks, so slow motion stretched the freeze. By arithmetic,
a counter's 130 ms freeze under 0.3× is about 375 ms of a still picture.
`showSlowAfterStop` holds the slow motion (and its timer) until
`SimState.hitStop` is 0. **This number is computed, not measured in the
browser.**

Checked by reading the code: audio and camera key off events only; the
camera's punch-in, shake and jolt run on wall time (`stage.frame` gets the
unslowed `dt`), so they keep moving through a freeze.

Not done: the per-frame camera travel through a flush land was not
measured. `window.__show.cam()` (punch-in, shake, jolt, position) is there
for it.

## Calls made without asking

- A new config group `polish: show` placed after `flow` rather than keys
  appended to `show` / `audio`: the config test requires groups to be
  contiguous.
- `camFinisherShake` 48 mm is over a knockdown's 36 mm.
- The flash knockdown has no hush; taking a knee keeps it.
- `scripts/audio_check.mjs` now expects `scuffSharp` for a glancing land.
- `scripts/audio_render.mjs` design checks were rewritten around energy
  instead of RMS (RMS falls when a sound gains a tail).

## Not possible in my folders

- `punchWhiff` has no `nerf` field; I carry it from `punchStart`. A field on
  the event would be cleaner.
- The out-cold thud is on a timer (`audioOutThudDelay`); an event or a
  `FighterState` flag for "the body reached the canvas" would let it sit on
  the fall the rig draws.
- The count UI on a waved-off KO is in `ui/hud.ts` / `ui/flow.ts`: not
  checked.
