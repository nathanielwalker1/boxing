# Anim 2.4 log: hit-stop instead of slow motion

- Toggle `hitStopV2` (default true; false = old behaviour). Tick table (60 Hz): glancing 1, clean 3, flush 5, blocked / perfect block 2, body glancing/clean/flush 1/2/4, counter +3, rock +3, cap 10, slip 0. Chosen from the brief's starting values; the budget and combo/jab scaling are bypassed under V2.
- Removed in live play (behind the toggle): slip freeze, 0.6x read window, 0.3x counter, rocked and finisher slow-mo (rule in src/ui/slowmo.ts, shared by main.ts, tests and anim_measure). Kept: knockdown slow motion and its stunHitStop (exempt from the cap), replay. No flush-counter hold kept.
- Input: a press during a stop is buffered (stepActions inStop) and fires on the first tick after it at full speed; the buffer (0.3 s) outlasts the cap. The `counter` event is the hook for sound/crowd/reaction layers.
- Not done (cut by Nate): defender shake (hitStopDefenderShake key exists, unused, 0), full suite, gpu_check, browser checks. Measured numbers: `node scripts/anim_measure.mjs B` prints V2 off and on.
- Tests: hitstop_test.mjs (25 checks); combo, counter, grade, reaction, slip, interrupt, flow pinned `hitStopV2 = false` (they assert the old seconds-based freezes / 5% clock).
