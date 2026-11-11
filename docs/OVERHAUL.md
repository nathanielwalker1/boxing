# Overhaul — fight and look

Branch `overhaul/fight-and-look`, started 2026-11-11. This file is the running
record: what the audit found, the plan in order, the risks, every decision made
on Nate's behalf, and what is done / not done. Kept current as the work lands.

## Status

| Part | State |
| --- | --- |
| Baseline (lookbook + 3 filmstrips, `docs/overhaul/*_before.png`) | done |
| Core: `FrameInput.level` + bindings | done |
| A — the fighting (sim, AI, tests) | sim side merged 2026-11-11, 36/36 green (`docs/OVERHAUL_SIM.md`); nothing new is DRAWN or HEARD yet; AI too easy (phase 2 running) |
| B — bodies and variance (rig, roster, generator) | merged 2026-11-11 (`docs/OVERHAUL_RIG.md`, `docs/overhaul/lookbook_after.png`); weak spots listed below |
| Reads: the new fight state drawn on the new bodies | first pass merged 2026-11-11 (41/41 green); about a third wired but never filmed — RIG phase 3 is filming and fixing each |
| C — styles, the four unread ratings, AI difficulty, drill opponents | merged 2026-11-11, 40/40 green; not yet connected to the menus (UI workstream) or the rig's stance (RIG phase 2) |
| Balance on the roster of eight, punch heights, the loaded counter, fight length | phase 3 merged 2026-11-11 (heights, counter retune, fight length, three difficulty matrices); balance still breaks the brief in three places — phase 4 running |
| D — arena, lighting, haze, crowd, post, audio | merged 2026-11-11 (see `docs/OVERHAUL_SHOW.md`); audio unheard, polish list below |
| D — title, select, cards, ring walk, replay, ladder, gym, controls card | merged 2026-11-11, both phases (`docs/OVERHAUL_UI.md`): eight drills verified one by one, mouse / touch / stubbed-gamepad paths checked, one difficulty key (`aiDifficulty`) |
| Sound for the new events; arena polish | merged 2026-11-11 (`docs/OVERHAUL_SHOW.md` phase 2); audio rendered and measured, still unheard |

Workstream logs (each agent keeps its own, merged into this file at integration):
`docs/OVERHAUL_SIM.md`, `docs/OVERHAUL_RIG.md`, `docs/OVERHAUL_SHOW.md`.

## Audit (2026-11-11, before any change)

Suite: 27/27 green (20 Node sim tests, 7 browser checks) once the runner spawns
its own dev server. Port 5173 on this machine is held by another project's dev
server (`~/repos/promoter`), and the runner reuses whatever answers there, so
every browser check timed out at boot. Run with `TEST_NO_REUSE=1 npm test`.

**What a player sees** (`docs/overhaul/lookbook_before.png`)
- Two mannequins built from the same parts: capsule limbs, an octagonal prism
  for a torso with a visible seam where chest meets waist, a ball on each
  shoulder, a sphere head with a box brow and box nose, white box boots.
- They differ by skin colour, 6 cm of height, a hair cap and a goatee block.
  In the greyscale sheet the two silhouettes are the same shape.
- Every part is hard-weighted to one bone (`src/rig/mesh.ts`), so elbows and
  knees are two capsules overlapping, not one skin.
- `FighterSpec.build` is three steps (lean / athletic / heavy) that scale two
  radii. `tattoos` is declared and drawn by nothing. Roster is 2.

**What makes fights differ**
- `FighterSpec.style` is read only by the menu text (`ui/flow.ts`). The AI
  plays one way for everyone.
- Of the five ratings only `chin` is read (`sim/resources.ts` get-up roll,
  `sim/stun.ts` threshold). `power`, `speed`, `stamina`, `defense` do nothing.
- A fighter's own mass and reach do matter (impulse, arm length from
  `core/body.ts`), but with two near-identical bodies it does not show.

**The fighting (against the brief's A1–A7)**
- A1 movement: momentum glide with step-drag feet drawn by the rig. No pivot,
  no burst, no rope or corner mechanic (the ring edge is a position clamp),
  no flat-footed state beyond `moveTiredScale`.
- A2 ranges: one range band. Inside `smotherDist` straights lose power; hooks
  and uppercuts are unchanged. No posture change, no level change, no
  contextual punches except the forward-stick step-in. The jab roots less
  than the others but movement during a punch is not a designed thing.
- A3 landing: one grade. Hit-stop scales with power only; no clean / flush
  tier in sound, reaction or camera. Combos chain faster but do not build.
- A4 defence: block is free while held (no stun, wear or chip; nothing splits
  or goes round it). Perfect block exists. Slip exists with a counter window
  and a read; slips do not chain, there is no roll, and slipping into a punch
  costs nothing extra. `strip_slip_counter_before.png` shows the slip-counter
  working mechanically.
- A5 danger: ROCKED exists (head only, not the jab). Knockdown is a drawn fall
  timeline in the rig; getting up is a timer.
- A6 body: there is no way to throw a body shot. The only body lands happen
  when the target slips the wrong way into a straight
  (`strip_body_before.png`). Nothing tracks body damage.
- A7 fatigue: stamina scales movement speed and the idle bounce. Missing
  stretches recovery. Punch speed, guard height and the face do not change.

**The show**
- Arena: a dark bowl, an instanced crowd that never reacts, random camera
  flashes, a truss with beam cones, fog. Post-processing exists, off by default.
- Audio: synthesized impacts, whiff, bell, rocked, knockdown. No crowd bed.
- Flow: menu → select (text cards) → tale of the tape → fight → results.
  No turntable, no ring walk, no replay, no ladder.

## Plan, in order

1. **Baseline** — lookbook + filmstrip scripts, before sheets. Done.
2. **Core** — `FrameInput.level` (Shift / left trigger / LOW touch button).
   Done. Further core growth is made by the workstream that needs it, each in
   its own region of `types.ts` / `config.ts`, recorded in CONTRACT §13.
3. **A and B in parallel**, each in its own git worktree, merged here:
   - SIM (`src/sim`, `src/ai`, sim tests): A1–A7 as mechanics, each behind a
     config toggle, each with a Node test; feel specs as numbers in FEEL.md;
     scripted player bots and the bot-versus-style table harness.
   - RIG (`src/rig`, `core/body.ts`, `core/roster.ts`, look fields of
     `FighterSpec`): procedural anatomy with blended skinning, skin shading,
     head/face, gloves, trunks cloth, continuous build morphs, roster of
     eight, seeded generator. Judged from the lookbook.
4. **Integrate**, full suite, after-lookbook, filmstrips.
5. **Reads for A in the rig / audio / camera** — grade tiers, body-shot
   reactions, fatigue and damage on the body and face, posture per range.
6. **C styles** — a style table (guard shape, stance, rhythm, range, punch
   mix, combos, ring use, hurt / tired behaviour, tells) read by sim, AI and
   rig; the four unread ratings wired so each is felt in 30 s.
7. **Gym mode** — one drill per feeling, in the order Nate should test them.
8. **D the show** — lighting, haze, reactive crowd, ring walk, cards, replay,
   post on by default on desktop with a quality tier; title / select with a
   turntable / results; ladder if there is room.
9. **Report** — after sheets, strips, bot table, feel-test order.

Priority if time runs short: A, then B, then C, then D.

## Risks

- **Feel cannot be verified here.** Everything in A is measured (press-to-
  contact, hit-stop, displacement) and filmed, never felt. Every new system
  has a toggle so a wrong one can be switched off without a revert.
- **Sim tests pin 2 cm margins** (`slip_test`, `punch_test`). Body-morph work
  must leave the first two roster fighters' sim-facing `BodyDims` unchanged,
  or those tests move for the wrong reason.
- **Two workstreams touch `types.ts` and `config.ts`.** Kept to separate
  regions; merged by hand here.
- **fps.** A skinned, higher-poly body with a custom skin shader costs more
  than capsules. Needs a quality tier and a measured number in a real browser
  (headless GL numbers are trend only, CONTRACT 2026-09-02).
- **Scope.** This is several stages of work in one run. Anything not finished
  or below standard is listed under "Not done / below standard", not dropped.

## Decisions (made for Nate, with reasons)

1. **Two briefs arrived in one message; the second is the one followed.** It
   is a superset of the first, puts the fighting first, and explicitly
   replaces the first's "don't retune punch timing, reaction springs or the
   camera band" with "everything in FEEL.md marked NOT yet feel-tested is
   provisional". Branch name from the second: `overhaul/fight-and-look`. The
   camera band was the one thing Nate's 2026-10-15 "gameplay is fine" covered
   and nothing in the second brief asks for it to change, so it is left alone.
2. **Tests run on a spawned server** (`TEST_NO_REUSE=1`). The other project's
   server on 5173 is not ours to stop.
3. **The level input is Shift** (either), **left trigger** on a pad (the
   other three shoulders still block), and a **LOW** touch button in the free
   corner below the hook. Hold, like block. Reason: it has to be reachable
   while a punch finger and the stick are busy.
4. **Baseline body-shot strip is the wrong-way slip**, because the baseline
   has no deliberate body shot to film.
5. **Lookbook lens stays inside the ropes** (2.8 m, 46° FOV) and the fighter
   turns, because from outside the near ropes cut across the figure.

6. **Three workstreams run at once, each in its own git worktree** (SIM, RIG,
   SHOW), merged here. The brief allowed A and B in parallel; the arena and
   audio half of D was added because it touches neither's folders and would
   otherwise sit idle. The menu half of D waits, because it needs the new
   fighter specs.

7. **One quality tier.** The arena's tier and the fighter mesh's tier were
   built separately; the mesh now follows the stage's tier (main.ts). Headless
   checks therefore draw the low-tier fighters; the lookbook and filmstrip
   scripts force the desktop mesh so the sheets show what a desktop sees.
8. **Second phases went back to the same agents** (sim → styles, ratings,
   difficulty, drills; rig → drawing the new fight state) because each already
   holds the context of what it built. A fourth workstream (UI) builds the
   menus, ring walk, replay, ladder and gym shell against adapters, so it does
   not wait for the style table or the drills.
9. **Toon banding is retired for fighters** (RIG's call, kept): the brief asks
   for skin that looks like skin under ring light.

## Interface changes (also recorded in CONTRACT §13)

- `FrameInput.level: boolean` — the level modifier.
- Test hooks: `window.__look(id, kind, yawDeg)`, `window.__roster()`.

## Not done / below standard

(Filled in as the run goes.)

**Bodies (RIG, merged)** — full list in `docs/OVERHAUL_RIG.md`. Seen at full
size in the after-lookbook cells:
- With the arms hanging (the portrait pose) the shoulders are cylinders with a
  hard seam against the chest. In guard and block they flow into the pec.
- The nose bridge is a flat plane; the jaw is soft in profile; everyone has
  the same neutral expression.
- Ab lines look painted on in close-up. The heavy fighter's punching arm is a
  balloon. Boots are the weakest part.
- **The stance is squarer than the bladed one Nate accepted.** The chest now
  turns with the sim's shoulder joints (the old rig yawed the chest 38° and
  left the new deltoids floating 15 cm off it). Phase 2 is trying to get the
  blade back without moving hit geometry.
- The drawn waist sits 3–4 cm inside the hit capsule on lean fighters.
- Not inspected by anyone yet: deep crouch, the knockdown on the canvas, the
  get-up, the cloth and hair springs in motion, the jab / uppercut pose grids.
- Triangles per fighter about 3,000 → 16,500 (high) / 7,700 (low); still one
  draw call plus one for the shadow.

**The fighting (SIM, merged)** — full list and the 15 decisions it made are in
`docs/OVERHAUL_SIM.md`; the new controls table is there too.
- First bot table (20 seeded fights each, default AI): jab-and-move 20–0,
  inside fighter 18–2 (17 stoppages, average 32 s), counter puncher 18–2,
  turtle 0–20, masher 6–14. The masher and turtle lose as asked, but the
  default AI is far too easy for any competent plan and the masher still wins
  30%. Phase 2 is fixing this per style.
- "Inside is earned" is not yet a rule: nothing stops a fighter walking in.
- In open ring the third punch of a combination usually misses because the
  first two knock the target out of reach; combinations build on the ropes.
- The clinch is minimal (both freeze; a punch in flight pops home).
- Punch lanes ignore height differences under 8 cm (to keep the two pinned
  fighters' tests); to be re-measured once the roster of eight is in.
- None of the new state is drawn or heard yet (variants, grades, guard wear,
  body damage, the get-up struggle). That is step 5 of the plan.

**Reads (RIG phase 2, merged)** — `docs/OVERHAUL_RIG.md`, phase 2 section.
- Seen and good: `strip_flush_counter_after.png` (slip, loaded hook, head
  whip with the mouth open, arms flung apart, the fall); the level drop and
  body-shot bend; the roll as a U under a hook; the two knockdowns and the
  get-up (head: falls back, props on an arm, a knee, rises; body: sags to a
  knee with a hand down).
- Seen and weak: the burst's hop does not read; the clinch has the heads
  apart and arms passing through the other man; the sweat spray is barely
  visible; the winded buckle is subtle; a downed man lies knees-up.
- Wired but never looked at when merged: glancing vs clean vs flush side by
  side; block stun, guard break and guard droop; the bounce, flat feet and
  the ropes posture; most punch variants (step / retreat jab, overhand,
  rising punches, check hook, feint); swelling, cuts and the open mouth at
  play distance; the get-up slump. Phase 3 films each.
- The blade is partly back: the ribcage turns 20° while the shoulder joints
  stay on the sim's, hips still 12° (were 28°). A full blade at the shoulders
  needs the sim's shoulder placement changed.
- The drawn arms leave the sim's joints in the clinch and the push-off (the
  sim keeps the gloves at the guard for both) — an exception to "drawn = hit
  geometry", harmless today because neither can be hit there, but it should
  be the sim's to place.
- In play framing a downed man drops out of the bottom of the frame; the
  knockdown shot covers it live.

**Menus and flow (UI, merged)** — `docs/OVERHAUL_UI.md`; captures
`docs/overhaul/ui_*.png`. Working title LONG COUNT.
- Never run by anyone: gamepad menus and all tap / click input (the checks
  drive the keyboard).
- The title's ring is empty and the wordmark is a system font; the stare-down
  card and the results panel cover the fighters; the corner card covers the
  ring; the debug fps overlay sits over the menus; skipping a card with a
  punch button throws that punch when the fight resumes; pause does not
  silence the crowd.
- The replay interrupts the count at 2 (`flowReplayAtCount`, `flowReplayOn`);
  cloth and feet may jump on its first frames; its KO path has no check.
- Scores are hidden until the results; the corner card shows punch stats,
  condition and one line of advice.
- No stool or corner men in the rest; the ring walk is short (1.6 m, no
  tunnel).

**Menus, second pass (UI phase 2, merged)** — supersedes the list above where
it fixed things: the title has two men sparring and a drawn wordmark; cards
no longer cover the fighters; the fps overlay is off in the flow; a held
button is ignored when the fight resumes; pause ducks the crowd; results have
accuracy and a per-round table; `flowShowScores` (default off) puts the
judges' running cards on the corner card.
- Still below standard: the wordmark is a monoline first pass; no stool or
  corner men in the rest; the ring walk is short with no lighting change; the
  replay is silent and still interrupts the count at 2; the HUD's round clock
  is meaningless in a drill; on a phone held sideways the drill strip covers
  the player's own fighter from the waist up (the worst screen in the set);
  results are a wall of small numbers.
- No real gamepad or finger has touched it. A stubbed pad and an emulated
  touch context prove the code paths, not the feel.
- A stoppage with no count used to freeze the loser upright (a sim gap:
  `downT` only advanced during a count). Patched in presentation in main.ts;
  the sim fix is in phase 4.
- Drill problems found by the checks and sent to the sim: `survive` floors an
  idle player in about a second; `cut-off` finishes in four seconds by walking
  at him; drill partners get floored and take a dead count.
- Free sparring cuts damage to a fifth for its length (the passive partner
  was down after six clean punches) and puts it back on leaving.
- The suite is now about ten minutes of wall time (44 scripts). The four flow
  checks are the slow ones on headless software GL.

**Styles, ratings, difficulty (SIM phase 2, merged)** — `docs/OVERHAUL_SIM.md`
"Phase 2".
- Style → guard: pressure = high, outboxer = long, counter = shell, swarmer =
  peek-a-boo, slugger = hands low. The player's fighter gets his style's
  guard too. All five ratings are read; the neutral rating is 65.
- Bot × style matrix, medium, 10 fights a cell, win % for the bot:

  | Bot | pressure | outboxer | counter | swarmer | slugger | avg |
  | --- | --- | --- | --- | --- | --- | --- |
  | jab-and-move | 20 | 100 | 90 | 30 | 70 | 62 |
  | inside fighter | 90 | 100 | 100 | 80 | 40 | 82 |
  | counter puncher | 70 | 70 | 100 | 30 | 100 | 74 |
  | turtle | 0 | 0 | 0 | 0 | 0 | 0 |
  | masher | 0 | 10 | 0 | 0 | 0 | 2 |

  Different plans beat the swarmer (inside) and the outboxer (jab-and-move),
  and the masher and turtle lose. Below standard: the counter style loses
  90–100% to every real plan; the outboxer and counter lose every fight to the
  inside fighter; the inside fighter wins 82% overall; cells are ±15 points;
  all five styles were fought on one body; easy and hard are untested.
  Phase 3 is on these.
- In a scripted probe one flush loaded counter floors a fresh fighter every
  time. Being retuned so a fresh man is badly rocked and a worn one goes down.

**Balance on the real roster (SIM phase 3, merged)** — `docs/OVERHAUL_SIM.md`
"Phase 3". Each style fought on its own roster body, 20 fights a cell on
medium, win % for the bot ("AI" = the AI's share against the three real plans):

  | Bot | pressure | outboxer | counter | swarmer | slugger | avg |
  | --- | --- | --- | --- | --- | --- | --- |
  | jab-and-move | 0 | 0 | 100 | 65 | 0 | 33 |
  | inside fighter | 75 | 100 | 90 | 65 | 80 | 82 |
  | counter puncher | 65 | 0 | 100 | 0 | 95 | 52 |
  | turtle | 0 | 0 | 0 | 0 | 0 | 0 |
  | masher | 5 | 0 | 0 | 20 | 15 | 8 |
  | AI | 43 | 67 | 3 | 50 | 42 | |

  Easy averages 84% for the real plans, hard 45% (10 fights a cell).
- Breaks the brief: **stick-and-move is not a complete way to win** (0 of 60
  against pressure, outboxer and slugger); **the counter style cannot fight**
  (3%); **the tall outboxer cannot keep a man off him** (0 of 20 against the
  inside fighter). The inside fighter wins 82% overall. Phase 4 is on these.
- About 3 knockdowns a fight on average — too many for a Fight Night-style
  game; being brought down in phase 4.
- Met: one flush loaded counter now rocks a fresh fighter (2.6 s) and floors a
  worn one, a weak chin or anyone hit by a heavy puncher; a second clean shot
  while rocked finishes. Punches aim at the real head and body of a 1.63 m or
  1.98 m opponent (`heights_test`, 56 pairs × 7 punches; one known limit: an
  uppercut thrown down at the 1.63 m man lands on his chest). Fights reaching
  the last round 57% → 77%; stopped in round 1 26% → 10%.
- New rules a player will notice: a jab is capped in power; the 112 kg man
  walks through jabs; a rocked man cannot be finished by the rest of the same
  combination; a man gets up with half a bar and some wind.

**Sound for the new events and arena polish (SHOW phase 2, merged)**
- Every new event has a sound (grades, combination build, variants, body
  shots with an exhale, the liver thud, the delayed buckle, guard wear and
  break, slips by kind, burst, pivot, push-off, clinch, the get-up, footfalls,
  rope creak) and the crowd reacts to them. Nobody has heard any of it.
- It was rendered to WAV and measured (`scripts/audio_render.mjs`, table in
  `docs/OVERHAUL_SHOW.md`). The numbers caught real faults, now fixed: the
  slip whoosh was the loudest sound in the game; the crowd bed was as loud as
  a clean cross at full excitement; most crowd reactions were inaudible under
  the bed; the worst overlap clipped. Flush is now louder and longer than
  clean than glancing in every class; a flush counter hook is the heaviest
  thing in the mix and is held to −1 dBFS by a soft clipper — whether that
  reads as heavy or as distortion needs ears.
- Arena: tunnel mouths instead of orange rectangles; warm and cool crowd; the
  near corner post dissolves near the lens; the scoreboard shows round and
  clock; a fighters' entrance. Still wrong: the lower bowl is brighter, so a
  dark-skinned fighter separates from it less in greyscale; post dither shows
  as speckle from the low camera; the white rope is faintly pink; the near
  ropes still cross the frame at the diagonals; ringside figures are simple.
- `flow_check` times out in the full parallel run (a wall-clock wait for a
  round to end on software GL) and passes alone; being made load-proof by the
  UI pass.

**Arena and audio (SHOW, merged)** — full list in `docs/OVERHAUL_SHOW.md`.
- Every audio level and recipe (crowd bed, reactions, the three impact
  grades) is a first guess that nobody has heard. Structure is checked
  (`audio_check`), sound is not.
- Seen in `arena_after_play.png`: the two doorways are flat orange
  rectangles; the whole crowd carries one blue-violet cast; ringside people
  are a box with a ball on top; at the four diagonal camera angles the near
  corner post sits bottom-centre of frame.
- The low tier has no haze, so low and high look different. Headless checks
  (verify, lookbook, filmstrip) render the LOW tier, because software GL is
  treated as a low-tier device; a script that wants the desktop look sets
  `qualityTier = 2`.
- Not built: ring ambience (footfalls, canvas squeak), a fighter entrance
  tunnel, rope sag changes. The scoreboard cube exists but shows sponsor art
  only and was never in a captured frame.
- fps on the real GPU (M1, headless Metal, vsync-capped): 60 at 960×600 on
  both tiers; 60 at 1440×900 on a 2× display at the shipped default (pixel
  ratio 1.5, MSAA 2). Headroom under the cap unknown; no "before" number on
  the real GPU. Draw calls 30 → 41 (low) / 55 (high); triangles 77k → 117k /
  150k.
- The full suite now takes about 4 minutes of wall time (was 77 s): the
  arena is slow on headless software GL. Boot and frame waits were lengthened
  to match. CONTRACT's "suite under 60 s" no longer holds.
