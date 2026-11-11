# Boxing v2 — Architecture Contract

This file is the spec every agent builds against. `CLAUDE.md` governs *how you work*;
this file governs *what you build and where it lives*. Read both before touching code.
If something here is ambiguous, ask. If something here is wrong, propose a change under
"Contract additions" at the bottom — do not silently deviate.

---

## 0. What this is, and what it is not

A tactical, physics-driven boxing game in the browser. Free movement, four-punch diamond,
held block, flick-to-slip head movement, momentum-based punch force, counter windows.
The *feel* target is Fight Night: technical, analog, timing-and-distance. Not Punch-Out,
not a tap-zone game.

**v2 is a presentation rebuild, not a mechanics redesign.** v1 (Phaser, 2D, 39 commits,
Stage 19) already has the full technical core: per-punch timing, range gating, perfect
blocks, slips with punish windows, vulnerability curves, counters, hit-stop, stamina,
health, dummy AI, ~230 tunables, and a Playwright test suite. What v1 lacks is rendering
quality: square stance, flat shapes, three keyframes per punch, zero secondary motion.

v1 lives at `legacy/` in this repo (read-only, never edited, never imported at runtime;
`npm run legacy` serves it on port 5175). It is the **source of truth for mechanics**.
In particular:
- `legacy/src/config.js` — every tunable and its rationale comment. Port the keys and
  the values; if a key doesn't make sense in 3D, record why in `docs/PORT_NOTES.md`.
- `legacy/src/vulnerability.js`, `reaction.js`, `movement.js`, the `PUNCHES` table in
  `rig.js`, and the hit-resolution logic in `main.js` (`_resolveAttack`).
- `legacy/scripts/*_test.mjs` — the *assertions* in these are behavioural spec. A v2
  system is not "ported" until the equivalent assertion passes against it.
- `legacy/VISUALS.md` — the L1–L7 visual ladder. L5 (secondary motion) is the single
  biggest reason v1 looks stiff and is the primary thing v2's rig must solve.
- `spike/gym` — a throwaway three.js rig spike (branch `spike/three-gym`). Its
  `README.md` records the depth-axis finding and five assertions (rear glove behind the
  head, forearm never enters the torso, 180° turn is a rigid rotation, impulse from
  measured glove speed, slip moves the head not the feet). Reference for RIG; not
  extended.

**MVP scope (locked):** single player vs. AI, then friend-link multiplayer. No career
mode, no story mode, no meta layer. A fight is N rounds × M seconds (default 6 × 60s,
both tunable). Rounds end on the clock, a fight ends on KO, TKO, or decision.

---

## 1. Stack

- **three.js** (latest stable), **TypeScript** (strict), **Vite**. `npm run dev` starts a
  live-reload server. `npm run build` produces a static bundle deployable to any host.
- **No external art, audio, or font assets.** Every mesh, texture, and sound is generated
  in code at load time. This is a deliberate constraint (fast iteration, no pipeline, tiny
  bundle), same as turbo-kart-rush. Changing it requires an explicit decision recorded here.
- **lil-gui** for the tuning panel. **Playwright** for verification. Nothing else without
  asking.
- Target: 60 fps in mobile Safari on a 2022 iPhone, and on a 2020 laptop at 1080p.

---

## 2. Ownership

Each folder has exactly one owner (a workstream / sub-agent). Owners have exclusive write
access. Cross-folder needs go through the interfaces in `src/core` or an addition to this
contract — never by editing someone else's files.

| Workstream | Owns | Delivers |
| --- | --- | --- |
| **CORE** (frozen before others start) | `src/core` | Types, constants, seeded RNG, math, event bus, `FighterSpec`, `Config` schema |
| **SIM** | `src/sim`, `src/ai` | Deterministic fixed-step fight simulation, hit resolution, round/fight state machine, AI opponent |
| **RIG** | `src/rig` | Procedural fighter skeleton + mesh, IK, spring-chain secondary motion, hit reaction visuals, parametric body from `FighterSpec` |
| **RENDER** | `src/render` | Scene, ring, arena, lighting, broadcast camera, post-fx, ad surfaces, particles |
| **UI** | `src/ui`, `src/main.ts` | App shell, menus, fighter select, HUD, round cards, results, tuning panel wiring, input (touch joystick + keyboard + gamepad) |
| **AUDIO** | `src/audio` | Web Audio engine: impacts, whiffs, blocks, bell, crowd bed, between-round stings |
| **NET** (later, not MVP-1) | `src/net` | Friend-link WebRTC session, input exchange, rollback |
| **TEST** | `scripts/` | Verification harness, pose grid, greyscale, behavioural tests ported from `legacy/scripts` |

`src/core` is written first by the orchestrator, reviewed, and frozen. Everything else
imports from it. Nothing imports *into* it.

---

## 3. World conventions

- **Units:** metres and seconds. The sim is in SI; the renderer is 1 unit = 1 m.
- **Axes:** y up. The ring floor is the x/z plane at y = 0. +x is "ring right" from the
  broadcast camera's default view.
- **Ring:** 6.1 m (20 ft) square inside the ropes, 4 ropes, 0.9 m apron. Corners: red at
  (+x,+z), blue at (−x,−z). Ring bounds for movement are inset from the ropes by a
  configurable margin (`ringInset`).
- **Fixed timestep:** the sim runs at **60 Hz** (`SIM_DT = 1/60`), accumulator-driven.
  The renderer interpolates between the last two sim states. Never step the sim with
  frame delta.
- **Determinism:** the sim uses only `src/core/rng.ts` (seeded, xorshift or PCG) — never
  `Math.random`, `Date.now`, `performance.now`, or anything from `three`. Given the same
  seed and the same input sequence, two machines produce byte-identical state. This is
  what makes NET possible later; it is non-negotiable now.
- **Facing:** each fighter has `facing: 1 | -1` (which way along x they face). The rig is
  authored in "lead/rear" space and mirrored by facing. **Any directional visual
  treatment (light, rim, shadow offset) must be resolved in world space after the mirror**
  — v1's mirroring constraint, see `legacy/VISUALS.md`.
- **Orthodox/southpaw:** `FighterSpec.stance`. Southpaw flips lead/rear hand assignment;
  everything else derives.

---

## 4. Input → Sim → Render flow

```
InputManager (UI)  →  FrameInput  →  sim.step(state, [inputA, inputB], config)  →  SimState
                                                                                     ↓
                                                        Renderer.apply(prevState, nextState, alpha)
```

`FrameInput` (in `src/core/types.ts`):
```ts
interface FrameInput {
  move: { x: number; y: number };   // joystick vector, magnitude 0..1; y = forward/back
  jab: boolean; cross: boolean; hook: boolean; uppercut: boolean;  // edge-triggered by sim
  block: boolean;                   // level
}
```
Flick-vs-hold slip detection lives **in the sim**, driven by `move` history, not in the
input layer. Hook/uppercut hand selection reads the sign of `move.x` at press. Both per
`CLAUDE.md` locked mechanics.

The sim exposes exactly:
```ts
createState(specs: [FighterSpec, FighterSpec], config: Config, seed: number): SimState
step(state: SimState, inputs: [FrameInput, FrameInput], config: Config): { state: SimState; events: SimEvent[] }
```
`SimState` is a plain serialisable object (no classes with methods, no three objects).
`step` must not mutate its input — return a new state (structural sharing is fine).

`SimEvent` is a discriminated union: `punchStart`, `punchLand`, `punchBlock`,
`perfectBlock`, `punchWhiff`, `punchStuffed`, `slip`, `counter`, `knockdown`, `getUp`, `roundStart`,
`roundEnd`, `bell`, `ko`, `tko`, `decision`. RENDER, AUDIO, and UI subscribe to events;
they never poll sim internals for "did something just happen."

---

## 5. Fighter definition

```ts
interface FighterSpec {
  id: string; name: string; nickname: string; hometown: string;
  stance: 'orthodox' | 'southpaw';
  // body — drives both the rig mesh and sim hit geometry
  heightM: number;       // 1.60 – 2.00
  reachM: number;        // wingspan; sim uses it for range bands
  massKg: number;        // sim impulse; rig bulk
  build: 'lean' | 'athletic' | 'heavy';
  // look
  skin: string; trunksPrimary: string; trunksSecondary: string; trunksStyle: 'short' | 'long' | 'belt';
  gloves: string; boots: string;
  hair: 'none' | 'short' | 'afro' | 'braids' | 'long' | 'mohawk';
  facialHair: 'none' | 'goatee' | 'beard';
  tattoos?: ('chest' | 'back' | 'leftArm' | 'rightArm')[];
  // ratings 0–100
  power: number; speed: number; chin: number; stamina: number; defense: number;
  // AI tendency — how the opponent AI plays this fighter
  style: 'pressure' | 'counter' | 'outboxer' | 'swarmer' | 'slugger';
}
```
Roster is data in `src/core/roster.ts`. Ship 8 for MVP. Names and looks may be
tongue-in-cheek nods to real fighters (the New Star Games approach) — never real names,
never real trademarks, never a real logo on trunks.

**The drawn thing and the hit geometry must agree.** Head sphere, glove sphere, body
capsule radii are computed once from `FighterSpec` in `src/core/body.ts` and used by both
SIM and RIG. Never two sources of truth.

---

## 6. Rig (workstream RIG) — the whole visual risk lives here

Two procedural humans throwing punches at each other is the hardest thing in this game
and the *entire* visual surface. Everything else is scenery.

**Art direction — stylised, chunky, readable.** Think toy figure / low-poly: capsules
and boxes, oversized gloves (~1.6× anatomical), slightly small head, wide shoulders,
narrow waist, big boots. Flat or two-tone toon shading with a hard rim light. No
textures except procedural (skin tone, trunks pattern, tattoo stamps). It should look
like something you'd screenshot, not like a physics debug view.

**Skeleton:** hips → spine(2) → chest → neck → head; chest → L/R shoulder → upper arm →
forearm → glove; hips → L/R thigh → shin → boot. Authored in lead/rear space.

**Motion is layered, in this order:**
1. **Pose targets from sim.** Sim provides fist target positions, guard pose id, punch
   phase (cock/extend/recover) and progress, body lean, torso turn, slip offset, stagger
   velocity. RIG turns those into joint targets using 2-bone IK for arms and legs.
2. **Secondary motion — mandatory, this is L5.** Every joint chases its target through a
   spring-damper with **descending stiffness up the chain** (hips stiffest → head loosest)
   and a small per-joint phase offset. Hips lead, spine follows, shoulders follow, glove
   arrives last and overshoots. Left/right springs get slightly different constants so
   limbs never twin. Stiffness/damping per chain level are config tunables.
3. **Idle life.** Breathing oscillator on chest, subtle weight shift between feet, guard
   bob that scales with movement but never goes fully static.
4. **Hit reaction.** Port `legacy/src/reaction.js` (head/torso/tilt springs) but with
   per-level stiffness so the chain *lags*, not just scales. Impulse direction from sim.
5. **Impact framing (L6):** hit-stop from sim; contact squash on the *receiving* body
   part; glove squash on contact; camera punch-in scaled by impulse (RENDER).

**Validation is visual, not just "renders."** `scripts/pose_grid.mjs` (port from v1)
captures each punch × facing × 7 progress values into a contact sheet, plus a greyscale
sibling. Judge silhouette and motion from the sheet. See `CLAUDE.md` verification.

---

## 7. Render (workstream RENDER)

- **Camera:** broadcast 3/4 view — elevated ~25°, offset toward the player's side,
  tracking the midpoint of the two fighters, dolly distance and FOV tightening as they
  close. Small handheld drift. Punch-in on heavy impacts. Never a hard cut mid-round.
- **Ring:** posts, 4 ropes with slight sag, turnbuckle pads, canvas with grain, apron,
  steps. **Ad surfaces exist from day one** as placeholder textures (see §9).
- **Arena:** dark bowl, light rig overhead with visible beams and haze, crowd as
  instanced low-poly silhouettes with occasional camera-flash sparkles. Atmosphere is
  L7 — build the placeholder, don't polish it until the rig passes the post-a-clip test.
- **Lighting:** one key spot over the ring (shadow-casting), one fill, rim from behind.
  Single shadow map. Toon/flat material with a rim term.
- **Post:** bloom (light), vignette, slight chromatic aberration on KO. Toggle-able for
  mobile.
- Budget: ≤ 300 draw calls, ≤ 150k triangles, instancing for crowd/props, shadow map
  ≤ 2048, frustum culling on.

---

## 8. Game flow (workstream UI)

Title → Mode (Single Player / Fight a Friend [greyed in MVP-1]) → Fighter select (roster
grid, stats, style) → Opponent select + difficulty → Fight → Results (round-by-round
cards, stats) → Rematch / Menu.

**Fight loop:** intro (fighters to corners, name cards), bell, round timer, between-round
card (10s, shows scoring + sponsor slot), bell, … KO: 10-count with get-up chance based on
chin/damage; three knockdowns in a round = TKO (tunable). Decision: 10-point-must from a
simple per-round scoring of landed/power/control (SIM owns scoring; UI displays).

**HUD:** minimal. Health + stamina bars top corners, round + clock top centre, tiny
knockdown pips. No damage numbers. Nothing that reads as a mobile F2P game.

**Input:** on touch, a floating joystick on the left half and the punch diamond + block
on the right; on desktop, WASD/arrows + JKL;/space; gamepad supported. Input goes through
one `InputManager` that emits `FrameInput`.

**Tuning panel:** lil-gui, dev-only (`?tune=1`), every `Config` key bound live. Grouped
by system. This exists before gameplay systems are ported, same rule as v1.

---

## 9. Ad surfaces (design in now, sell later)

A `Sponsor` is data: `{ id, name, primary, secondary, logoSvg?: string, slots: SlotId[] }`.
Slots: `matCenter`, `matCorners`, `apronFront`, `apronSides`, `postPads`, `roundCard`,
`introBanner`. RENDER paints a sponsor into any slot from a `CanvasTexture` generated at
load. MVP ships with 3–4 fictional in-house sponsors so the surfaces are always populated
and the broadcast look is there from the first build. Real sponsors are a data swap.

---

## 10. Net (workstream NET — after MVP-1 ships)

Friend-link first: one player creates a room, gets a URL, the other opens it. WebRTC data
channel, no relay server beyond signalling. Lockstep with input delay as the first cut;
rollback (GGPO-style) using the deterministic `step` if latency needs it. Random
matchmaking comes after there are people to match, and always falls back to a bot.
Nothing in NET is built for MVP-1, but every sim rule in §3 exists so it *can* be.

---

## 11. Quality bar

- 60 fps on the targets in §1, measured, not assumed. A frame-time overlay in the tuning
  panel.
- Zero console errors or warnings in a full fight.
- Time-to-first-punch from cold load under 3 s on a mid-range phone.
- Every config value is a live slider. No magic numbers in `src/sim`, `src/rig`, `src/render`.
- Every v1 behavioural test has a v2 equivalent that passes.
- **The post-a-clip gate:** the vertical slice is not done until a 10-second clip of two
  fighters exchanging punches is something Nate would put on Instagram. This is judged by
  Nate, not by a script. Iterate art direction *here* before building anything past the
  slice.

---

## 12. Stage plan

| Stage | Deliverable | Gate |
| --- | --- | --- |
| **0** | Repo scaffold, `src/core` written and frozen, tuning panel, verify + greyscale + pose-grid scripts (`legacy/` is already in place) | Renders an empty ring at 60 fps; panel works |
| **1 — Vertical slice** | Ring + arena placeholder, broadcast camera, two rigs from `FighterSpec` with spring-chain motion, sim ported for: movement, jab, cross, block, hit reaction, hit-stop. Player vs. frozen-guard dummy | Post-a-clip gate |
| **2** | Full mechanics port: hook, uppercut, range gating, flick slip, perfect block, vulnerability/counter, stamina, health, knockdown. All v1 test assertions green | Feel-test parity with v1, but it looks good |
| **3** | Rounds, clock, bell, scoring, KO/TKO/decision, intro/results, HUD, menus, fighter select. AI opponent with 5 styles × 3 difficulties | A complete fight start to finish |
| **4** | Roster of 8, parametric body from spec, tattoos/hair/trunks variety, in-house sponsors on all slots, audio pass, atmosphere pass (L7) | Ship candidate |
| **5** | Deploy (static host), mobile touch polish, PWA manifest, share-a-clip button | **Public MVP-1** |
| **6** | Friend-link multiplayer | MVP-2 |

Within a stage, sub-agents work in parallel by workstream; between stages, Nate feel-tests.

---

## 13. Contract additions

Append here, dated, when a rule is added or changed. Never edit history above silently.

- 2026-09-02 — Initial contract.
- 2026-09-02 — v1 moved into `legacy/` (`src`, `scripts`, `index.html`, `VISUALS.md`) via
  `git mv`; `npm run legacy` added. Root `src/`/`scripts/` are now v2's.
- 2026-09-02 — **Facing is a yaw, not ±1.** Each fighter's `facing` is the unit
  direction on the floor toward the opponent (sim keeps it as an angle). The rig is
  authored in a local lead/rear frame and rotated by that yaw; there is no mirror.
  `FrameInput.move` is opponent-relative: y = toward/away from the opponent, x = lateral.
  Hook/uppercut hand selection: x < 0 at press = lead hand, x ≥ 0 = rear hand
  (supersedes §3 "facing: 1 | -1" and §4's "sign of move.x").
- 2026-09-02 — **The sim owns the glove.** Head, body, and glove hitboxes are sim state
  and are what the rig draws. The kinetic-chain springs that give punches lag and
  overshoot live in `src/sim` and are deterministic. RIG adds secondary motion only to
  non-hitbox parts (hips, spine, shoulders, head bob, idle life) and to squash/stretch.
  What you see hit is what hit (refines §5 and §6 step 2).
- 2026-09-02 — **Behavioural tests run in Node, not a browser.** Every port of a
  `legacy/scripts/*_test.mjs` assertion is a Node script that calls `createState`/`step`
  directly. Playwright is used only for render verification (`verify_check.mjs`,
  `pose_grid.mjs`) and input. Naming: `*_test.mjs` = Node, `*_check.mjs` = browser; the
  runner discovers both. The full suite must finish in under 60 s.
- 2026-09-02 — **Art direction: low-poly toy figure** (§6 as written). Outlines are a
  toggleable material layer so an ink look can be tried without a rebuild.
- 2026-09-02 — **Core freeze, refined.** `src/core/types.ts`, `math.ts`, `rng.ts`, `body.ts`,
  `events.ts` are frozen; changes go through the orchestrator. `config.ts` is append-only
  and each workstream appends only inside its own `group`. `roster.ts` is data and exempt.
  `fixtures.ts` is a stand-in for the sim and may be replaced by SIM's real trajectories.
- 2026-09-02 — **Determinism is same-engine** until NET. Sim code calls `core/math`
  wrappers (`sin`, `cos`, `atan2`), never `Math.*` directly, so the swap to polynomial
  approximations is one file. Refines §3.
- 2026-09-02 — **Hit-stop** is a global `SimState.hitStop` timer; while it runs the sim
  advances at `hitStopScale` × real rate (events, punches and the round clock all slow
  together); inputs are still sampled every tick. Port of v1's `hitStopTimeScale`.
- 2026-09-02 — **The fps gate is measured in a real browser** (the overlay), not headless.
  Headless numbers with the GPU path are reported for trend only.
- 2026-09-02 — **Root files** (`package.json`, `tsconfig.json`, `vite.config.ts`,
  `index.html`, `docs/`) are orchestrator-owned. Sub-agents never touch them.
- 2026-09-03 — **Close range: straights land, cramped.** Inside `smotherDist` a jab or
  cross still hits; its impulse scales from 1 at `smotherDist` down to
  `smotherPowerFloor` at `separationDist`. `punchSmother` is no longer emitted (the
  event type stays in the union for now). Supersedes v1's no-contact smother; the
  v1 `punch_test` smother assertions are replaced by reduced-power assertions.
- 2026-09-03 — **The glove stops at the body.** On a land or block the sim records
  the contact point (`PunchState.contact`) and holds the glove there through the
  punch's hold phase, sunk by `contactSquash` × glove radius. Hit geometry is
  unchanged; this is where the L6 contact squash hangs.
- 2026-09-03 — **Pose grid runs the sim** for ported punches (`__pose` steps a fresh
  state to the requested progress). Fixtures remain only for unported punches.
- 2026-09-09 — **A punch's impulse direction can follow the fist.** Each `PunchDef`
  has a `swing` weight: the impulse direction is the attacker→defender line blended
  with the glove's own travel direction at the resolve tick (hook 0.85, others 0).
  Momentum for the impulse magnitude is still measured along the attacker→defender
  line. Refines §7's "impulse into a spring-damped rig": a hook sends the head and
  the stagger sideways, not straight back.
- 2026-09-09 — **The held glove rests where it touched.** Refines the 2026-09-03
  contact rule: the contact point is on the struck sphere/capsule along the line from
  its centre to the glove, so a hook rests on the cheek and an uppercut under the
  chin. All four punches are in the sim table; the pose grid runs the sim for all of
  them and the fixture path is fallback only.
- 2026-09-09 — **`FighterState.crouch`** (core types, orchestrator change): metres the
  body sits down, + = down. The sim's `headBox`/`bodyBox` and glove targets ride it;
  the rig draws on the boxes so the knees bend with it. Punches set it (per-punch
  `dip`, v1's `PUNCHES.dip`); slips and ducks will. Per-punch `lean` and `sway`
  (lateral weight transfer, `FighterState.lean.lat`) join `turn` as the whole-body
  channels the rig reads. Nate's call, feel-test 2026-09-09: "too fake and upright".
- 2026-09-15 — **Slip is lateral, and a bend at the waist.** `SlipState.dir` is
  −1 lead / +1 rear; the head sphere moves by `slipHeadOffset`, the shoulder end of
  the body capsule and the resting guard by `slipShoulderFrac` of it, the hips not at
  all. A forward/back flick is not a slip (v1's duck is not ported; y is depth). A
  stick push present when a punch is pressed is that punch's hand selection and never
  a flick. The `slip` event fires at the flick (`dodged: false`) and again per punch
  it takes away (`dodged: true`). Refines §4 and CLAUDE.md "head movement".
- 2026-09-15 — **Perfect block needs a late read.** A guard is perfect when younger
  than min(`perfectBlockWindow`, `perfectBlockLateFrac` × the punch's cock + extend)
  at the impact; a guard raised on the punch's first tick is a reaction to the start,
  not a read (the AI's block was perfect every time otherwise). `perfectBlock` is
  emitted in place of `punchBlock`. Counters: a land on a target with `vuln` > 0 is
  a counter (`punchLand.counter`, a `counter` event), impulse × (1 + vuln ×
  `counterImpulseBonus`). A whiff stretches the recover phase per type; in v2 the
  guard waits for the punch to end, so the stretch locks the guard out too (v1 let
  the guard up mid-recovery — Nate's call pending).
- 2026-09-15 — **The fight state machine lives in the sim** (round.ts). Phases:
  `fighting` → `between` (rest, `betweenRoundSeconds`) → `fighting` …, `count` on a
  knockdown, `over` on decision / KO / TKO. The intro is presentation: the UI holds
  the sim until the bell; round 0 starts on tick 0. `RoundState` gains this round's
  `landed` / `power` tallies and the referee's `count`; `FighterState` gains
  `ratings` (spec 0–100; only `chin` is read). Scoring is 10-point-must from clean
  lands + impulse × `scorePowerWeight`, −1 per knockdown suffered; control is not
  scored yet. The count is `countTickSeconds` per count; the get-up count is rolled
  at the knockdown from chin, knockdowns this round and seeded jitter (≥ 10 = KO).
  `knockdownDuration` is gone. Between rounds fighters return to the corners with
  `betweenRound*Restore` of the missing bars and the round's knockdowns cleared.
- 2026-09-16 — **The pull: a back flick is head movement too.** `SlipState.dir` and
  the `slip` event gain `2` = back: the head sphere goes straight back by
  `slipBackOffset`, the shoulder end of the capsule and the resting guard by
  `slipShoulderFrac` of it, the hips stay. A lateral slip also dips the head by
  `slipDip`. A forward flick is still nothing (the step-in reads a forward push at a
  punch press). Nate's call, feel-test 2026-09-16 ("the torso and back winds back").
  Same session: **the weight transfer moves the body.** `punchLeanShift` moves the
  head and shoulder boxes and the glove targets forward per unit `lean.fwd` (hips
  half), so a punch reaches further and the head is out over the front knee; the hit
  test is swept along the extension. **Health regenerates** to a per-round cap that
  each hit lowers (`healthRegen`, `healthCapLoss`; the cap lives in `moveHist`).
- 2026-09-22 — **The interrupt.** A clean (unblocked) land on a fighter whose own
  punch has not reached its hit test breaks that punch. At or before
  `interruptStuffBefore` of its flight it is STUFFED: a new `punchStuffed` event
  (`side` = whose punch, `by` = who landed), the punch never resolves, its clock runs
  backwards at `interruptRewindRate` so every pose retraces (no jump), and neither a
  punch nor the guard can start until it is home (`phase` is never `recover`, so
  `canStartPunch` stays false). Later in the flight it still arrives, minus up to
  `interruptPowerLoss` of its impulse, fading to none at the arrival; a same-tick
  trade lands clean both ways. Nate's ask ("punching them mid wind-up should break
  their punch momentum"). `scripts/interrupt_test.mjs`.
- 2026-09-22 — **Test hooks** `window.__sim.place(dist)` (fighters `dist` apart,
  settled) and `window.__sim.script(side, inputs[])` (tick-exact input for one side,
  then back to live/AI) — so a browser check can stage a real exchange.
- 2026-09-22 — **A counter is slip-only.** `punchLand.counter` and the `counter`
  event fire only for a landing inside the punish window a SLIP opened; a perfect
  block's window and a punch's own exposure curve still scale the impulse
  (`counterImpulseBonus`) but are not counters. Nate's call ("I should only ever have
  a counter if I've successfully slipped a punch"). **`FighterView.highlight(strength)`**
  added: UI decides how exposed a fighter reads (0..1), RIG draws it (a warm rim).
- 2026-10-15 — **Stage 3 begins** (Nate: "feels fine, stop tweaking, make the other
  factors good"). Fights default to 3 × 30 s while the surfaces are built. **The fight
  flow** (`src/ui/flow.ts`): menu → select → tale of the tape → fight → results; the UI
  holds the sim behind every screen but the fight (§8's "intro is presentation"). Off
  under Playwright (`navigator.webdriver`) and `?menu=0`; `?menu=1` forces it. The HUD
  is the Fight Night bottom bar. `Hud.setFighters` and `main.startFight` rebuild the
  rigs for a new pairing; `views` is mutated in place because the read overlay holds it.
- 2026-10-15 — **The referee** (`src/ui/referee.ts`, config group `referee`): a third
  figure drawn by the fighter rig from a `FighterState` the UI walks each frame. Never in
  the sim: no hitbox, no collision (fighters walk through him — flagged). **`FighterSpec.
  outfit?`** (shirt / trousers / tie) dresses a figure; `createFighterView(…, opts)` takes
  a toon-material `key` and `probe: false` so a non-fighter never takes `window.__rig`.
  **`CameraShot`** (`render/stage.ts`): the host may ask `frame()` to hold a shot
  (the knockdown count: low, pushed in on the downed fighter, orbit frozen). **Knockdown
  slow motion** is host time scaling (`knockdownSlowMo`, main.ts): the sim is fed less
  time; determinism untouched. The count ticks are audible (`count` recipe).
- 2026-10-15 — **Feel-test fixes, same night.** The round clock RUNS through the count
  (was held; a round that runs out mid-count ends on the get-up). The referee keeps to
  the ropes and gives ground inside `refClear`; no counting gesture. The rest is a black
  card with a countdown. The count tick audio was removed.
- 2026-10-15 — **ROCKED** (`src/sim/stun.ts`, config group `stun`; Nate's design
  discussion, then "yeah I like this"). A clean head shot from a punch with
  `PunchDef.rocks` (not the jab) whose impulse clears `stunThreshold(target)` =
  `stunBase × chin × health × stamina` factors puts the target in the hurt state
  (`FighterState.hurt` / `hurtMax`, seconds): movement × `stunMoveScale`, the resting
  guard sags `stunGuardDrop`, the block absorbs `blockReduction × stunBlockScale`,
  exposure held at `stunVuln`, no punch for `stunPunchLock`. A rocking-capable clean head
  shot ≥ `stunFinishFrac × T` while rocked is a knockdown; one shot ≥ `stunFlashFrac × T`
  floors outright. `knockdown.cause` ('health' | 'finish' | 'flash') and a `rocked` event
  were added to §4. Deterministic (no rng). Head only until body shots exist. The AI
  treats rocked as stumbling (covers; presses a rocked opponent).
- 2026-10-15 — **Host time scaling is a presentation tool.** main.ts may feed the sim
  less than wall time (knockdown, counter and rock beats; the player's open counter
  window at `readWindowSlowMo`). The sim's clock, hit-stop and determinism are untouched;
  tests never see it. The hurt read (red edge + blur) is a DOM layer in `ui/read.ts`, not
  the post pass, so it costs nothing when clear.
- 2026-11-11 — **Overhaul run** (`docs/OVERHAUL.md`; Nate's brief). For this run:
  `src/core` is unfrozen; §6's toy-figure art direction is retired for a stylised
  athletic human; desktop budgets in §7 may rise behind a quality tier; §0's "no
  mechanics redesign" is lifted — the locked mechanics may be extended, not replaced.
- 2026-11-11 — **`FrameInput.level`**: the one new input, a held level modifier (drop
  the level; punches thrown under it go to the body or come up from underneath).
  Shift / left trigger / the LOW touch button. `window.__look(id, kind, yawDeg)` and
  `window.__roster()` test hooks (lookbook).
