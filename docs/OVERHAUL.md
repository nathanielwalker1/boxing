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
| B — bodies and variance (rig, roster, generator) | in progress (RIG workstream) |
| C — styles, the four unread ratings, AI difficulty, drill opponents | in progress (SIM workstream, phase 2) |
| D — arena, lighting, haze, crowd, post, audio | merged 2026-11-11 (see `docs/OVERHAUL_SHOW.md`); audio unheard, polish list below |
| D — title, select, cards, ring walk, replay, ladder | after A + B integrate |

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

## Interface changes (also recorded in CONTRACT §13)

- `FrameInput.level: boolean` — the level modifier.
- Test hooks: `window.__look(id, kind, yawDeg)`, `window.__roster()`.

## Not done / below standard

(Filled in as the run goes.)

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
