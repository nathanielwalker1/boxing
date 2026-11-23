# High-IQ Boxing: the design on one page

Agreed with Nate 2026-11-22. Design only; nothing here is built yet. Numbers are to be
measured and tuned, not taken from this page.

## What the game is

A ranked online boxing game where the smarter fighter wins. Precise, subtle, tactical.
Timing, distance and reading decide fights. Mashing, spamming and running never do.
The feeling to copy is online chess: you fight people at your own rating, every fight
moves your number, and the number is something you are proud of.

## The seven principles (every change is checked against these)

1. **Skill decides, visibly.** The better player wins for reasons both players can see.
   Anything that pays for pressing more is a bug.
2. **Distance is the main skill.** Three ranges, each its own game: outside (jab and
   pendulum), pocket (everything lands), inside (straights weak, hooks and uppercuts
   full power).
3. **Feet are a commitment.** Walking is slow and free. A step is quick, small, and has
   a planted moment after it. Going back is slower than coming forward, a second step
   back is shorter, and the ropes end a retreat. You cannot run.
4. **Every outcome is a scale.** The sim knows how close every punch and every evade
   was, in centimetres: missed by a mile, past the nose, clipped, clean, flush. Damage,
   sound and the body's reaction follow that number smoothly.
5. **Closeness is the reward.** A narrow evade leaves you in range to answer; a wide one
   is safe and earns nothing. Lean (feet stay, small margin, instant counter) and step
   (safer, but you must come back in) are different bets on different inputs.
6. **Missing is the cost.** Buttons respond instantly and punches chain fast when they
   land. A miss or a blocked punch leaves you exposed in proportion to how badly it
   failed, and costs stamina.
7. **Same rules for everyone.** Styles come from the body (reach, weight, hand speed,
   engine), never from different rules or timings. No randomness decides a fight.

8. **The game is self-expression.** Every style can win, and a player should be able to
   fight like themselves: there is no one right way. Mechanics that narrow the game to
   one best style are bugs.
9. **Pure avoidance is slightly punished.** Moving, slipping and countering are skill;
   refusing to fight is not. The penalty is light and comes from boxing itself: slower
   backward feet, the ropes, and judges who score the fighter making the fight when
   rounds are close. Never a heavy or artificial penalty.

Feedback stays in the world during a fight (fighter, time, sound): no words, flashes or
glows. Numbers and reviews belong after the bell.

## Styles: all three must be fun

The spacing triangle gives the three boxing styles from one rule set:
- A punch stuck out beats a man walking in (the **boxer**).
- Walking in beats a man waiting to counter (the **swarmer**).
- Waiting to counter beats a punch stuck out (the **counter-puncher**).

The swarmer is not punished by committed feet; the runner is. The swarmer's tools:
duck under the jab while stepping in, cut off the ring sideways, and body shots that
slow the other man's feet for the rest of the fight.

## Reading, not reflexes

A jab cannot be reacted to (about 0.23 s, before network delay). So the jab is beaten by
position and rhythm: being on the way out when it arrives. Crosses, hooks and uppercuts
are slow enough to see, so they need a setup. Each punch has a job.

## Ranked: the chess.com feeling

- **One number per weight division**, shown everywhere, moving after every fight
  (the amount shown: +8, -7).
- **Matchmaking inside your rating range**, so most fights are close.
- **Short fights** (60 s rounds) so "one more" is always possible, with a rematch button.
- **A rating graph, a record, and named tiers** to climb through; leaderboards global,
  by country and by division.
- **Fight review after the bell**, like a chess game review, built from the closeness
  number: accuracy, cleanest punch, closest evade, counters landed, the moment the
  fight turned.
- **Fair play:** leaving a fight is a loss; identical rules both corners; fights are
  replayable from inputs, so results can be checked.

## How we prove it without a second human

Bots, run in their thousands in Node:
- **Cheat bots** (masher, runner, turtle). If any of them beats a competent bot, the
  design is broken. Checked before Nate plays.
- **Fair bots**, one per style, with human reaction delay and no input-reading.
- **A bot ladder with ratings.** Cheat bots must sit at the bottom; the three styles
  must beat each other in a circle.

Single-player against bots and AI stays a full part of the game.

## Build order (each slice playable in about 30 minutes)

1. The closeness number, measured and logged (changes no rules).
2. Cheat bots and the bot ladder (changes no rules).
3. Feet: slow walk, committed step, back slower than forward. Experiment, Nate judges.
4. The cost of missing.
5. Swarmer tools: duck-in, ring cutting, body investment.
6. Feedback by closeness (body, sound).
7. Styles from body numbers.
8. Fight review screen.

Slices 1 to 8 are gameplay, animation and physics. That is the whole job for now.

## Later, not now: online

Ranked is LIVE fights between real people (Nate, 2026-11-22). No networking is built
until the gameplay is nailed. The only thing online asks of today's work is what the
rules already demand: a deterministic sim, same rules both corners, no randomness in
outcomes. "Ghosts" (a bot built from how a player fights) is a side idea for practice,
not the ranked mode.

## Open

- The uncommitted retreat rule in worktree `human` (`mocapStepRecede`): test or discard.
- Changes to the locked "free 2D movement" rule go into CLAUDE.md once the feet
  experiment is accepted.
