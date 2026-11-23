/**
 * flow_check.mjs — the fight flow (src/ui/flow.ts) in the real app, forced on
 * with ?menu=1 (under Playwright it is off by default so the other checks
 * drive the sim directly). Walks it end to end with the keyboard, the rounds
 * shortened through window.__flow.rounds:
 *   title → select (turntable) → opponent (difficulty) → ring walk (three
 *   beats, sim held) → fight → pause → the corner card between rounds (sim
 *   held, stats, advice; a button runs the rest off) → results (scorecard +
 *   punch stats) → rematch
 *   ladder: a new one is saved, a saved one is picked up at its rung
 *   gym: the drill list, a drill running with its panel, back out
 *   controls card
 * Screenshots (+ greyscale) → scripts/output/flow_*.png. Console must be clean.
 * The knockdown replay has its own check (replay_check.mjs).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, until as untilFor, frames } from './waits.js';
import { greyscaleCopy } from './greyscale.js';
import { check, done } from './check.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output');
mkdirSync(OUT, { recursive: true });

// Every state wait gets three minutes: headless software GL under a parallel suite draws about a frame a second, and
// the frame clamp makes that a quarter of a second of sim, so a wait bounded in tens of seconds is a flake.
const until = (page, fn, arg = undefined, opts = {}) => untilFor(page, fn, arg, { ...opts, timeout: 180000 });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const logs = [];
page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
await page.goto(`${DEV_URL}/?menu=1`, { waitUntil: 'networkidle', timeout: 60_000 });
await bootReady(page);
await page.evaluate(() => {
  const c = window.__cfg;
  // Short rounds; the walk and the corner card are held open so a slow headless frame rate still sees them, and skipped by key.
  window.__flow.rounds(2, 8);
  c.resultsDelaySeconds = 0.3; c.flowWalkSeconds = 600; c.flowStareSeconds = 600; c.flowCornerSeconds = 600;
  try { localStorage.removeItem('longcount.ladder.v1'); } catch { /* no storage */ }
});
const st = () => page.evaluate(() => window.__flow.state());
const ticks = () => page.evaluate(() => window.__tick.simTicks);
const key = async (k, n = 1) => { for (let i = 0; i < n; i++) { await page.keyboard.press(k); await frames(page, 1); } };
const on = screen => until(page, s => window.__flow.state().screen === s, screen, { label: `screen ${screen}`, timeout: 90000 });
const shot = async (name) => { const p = `${OUT}/flow_${name}.png`; await page.screenshot({ path: p }); console.log(`     ${name} → ${p}\n              ${await greyscaleCopy(page, p)}`); };
const heldFor = async (n = 8) => { const a = await ticks(); await frames(page, n); return (await ticks()) === a; };

// ── 1. Title: the sim is held ────────────────────────────────────────────────
await frames(page, 6);
check('boots to the title with the sim held', (await st()).screen === 'title' && await heldFor());
check('the HUD is hidden on the title', await page.evaluate(() => document.getElementById('hud').hidden));
check('title: Fight / Ladder / Gym / Controls / Create fighter', await page.evaluate(() => [...document.querySelectorAll('#flow .title .btn')].map(b => b.textContent).join('|')) === 'Fight|Ladder|Gym|Controls|Create fighter');
await shot('title');

// ── 2. Fighter select ────────────────────────────────────────────────────────
await key('Enter'); await on('select');
check('Enter → fighter select: a plate per roster fighter and a random slot', await page.evaluate(() => document.querySelectorAll('#flow .select .plate').length) === 9);
await key('ArrowRight');
check('→ moves the pick to the second plate', await page.evaluate(() => document.querySelectorAll('#flow .select .plate')[1].classList.contains('sel')));
await until(page, () => window.__flow.state().shown === 'blue', undefined, { label: 'his body on the turntable', timeout: 30000 });
const info = await page.evaluate(() => { const i = document.querySelector('#flow .select .info'); return { name: i.querySelector('.fname').textContent, bars: i.querySelectorAll('.ratings .bar').length, widths: [...i.querySelectorAll('.ratings .fill')].map(f => f.style.width).join(), sizes: i.querySelectorAll('.sizes .bar').length, lines: i.querySelectorAll('.style li').length, style: i.querySelector('.sname').textContent, facts: i.querySelector('.sfacts').textContent, head: i.querySelector('.style .lhead').textContent }; });
const okafor = await page.evaluate(() => { const f = window.__rosterSpec('blue'); return [f.power, f.speed, f.chin, f.stamina, f.defense].map(v => v + '%').join(); });
check(`the panel shows him: ${info.name}, the five ratings as he really has them (${info.widths}), three size bars against the roster`, info.name === 'Desmond Okafor' && info.bars === 5 && info.widths === okafor && info.sizes === 3, JSON.stringify(info));
check(`…and his style for the man picking him: ${info.style}, ${info.facts}, three lines under "${info.head}"`, info.style === 'Out-boxer' && /Long guard/.test(info.facts) && /arm.s length/i.test(info.facts) && info.lines === 3 && /how he fights/i.test(info.head), JSON.stringify(info));
const guardShape = await page.evaluate(() => window.__flow.state().turnGuard);
check(`he stands on the turntable in HIS guard (${guardShape})`, guardShape === 'long');
const az0 = await page.evaluate(() => window.__camAz());
await frames(page, 6);
check('the lens circles him (the turntable) at close range', (await page.evaluate(() => window.__camAz())) !== az0 && (await page.evaluate(() => window.__camDist())) < 3.2);
await shot('select');

// ── 3. Opponent select ───────────────────────────────────────────────────────
await key('Enter'); await on('opponent');
const opp = await page.evaluate(() => ({ off: [...document.querySelectorAll('#flow .opponent .plate')].findIndex(p => p.classList.contains('off')), sel: [...document.querySelectorAll('#flow .opponent .plate')].findIndex(p => p.classList.contains('sel')), opts: document.querySelectorAll('#flow .opponent .opt').length }));
check('opponent select: your own fighter cannot be picked; difficulty and rounds are offered', opp.off === 1 && opp.sel !== 1 && opp.opts === 2, JSON.stringify(opp));
await key('ArrowDown'); await key('ArrowRight');
const mu = await page.evaluate(() => ({ text: document.querySelector('#flow .opponent .matchup')?.textContent ?? '', head: document.querySelector('#flow .opponent .style .lhead')?.textContent ?? '' }));
check(`the opponent's sheet has the matchup in plain words and how to beat him ("${mu.text.slice(12, 60)}…")`, /You out-reach him by 34 cm/.test(mu.text) && /You are taller by 23 cm/.test(mu.text) && /how to beat him/i.test(mu.head), JSON.stringify(mu));
check('↓ → sets the difficulty to Hard', await page.evaluate(() => document.querySelector('#flow .opponent .opt .ch.sel').textContent) === 'Hard');
await shot('opponent');

// ── 4. The ring walk ─────────────────────────────────────────────────────────
await key('Enter'); await on('walk');
await until(page, () => window.__flow.state().beat === 'walk1', undefined, { label: 'the opponent\'s walk' });
const w1 = await page.evaluate(() => ({ card: document.querySelector('#flow .namecard')?.textContent ?? '', name0: document.querySelector('#hud .side.l .name')?.textContent, hud: document.getElementById('hud').hidden, diff: window.__cfg.aiDifficulty, rounds: window.__cfg.roundCount }));
check('confirm → the ring walk: the opponent\'s name card first, the picked fighter as side 0, difficulty stored', /BRASK/i.test(w1.card) && w1.name0 === 'Desmond Okafor' && w1.hud && w1.diff === 2 && w1.rounds === 2, JSON.stringify(w1));
check('the sim is held through the walk', await heldFor(10));
const x0 = await page.evaluate(() => window.__states()[1].pos.x);
await frames(page, 6);
check('the game\'s own sim state is untouched by the walk (tick 0)', (await page.evaluate(() => window.__sim.state().tick)) === 0 && (await page.evaluate(() => window.__states()[1].pos.x)) === x0);
await shot('walk');
await key('Enter');
await until(page, () => window.__flow.state().beat === 'walk0', undefined, { label: 'the player\'s walk' });
check('a button → the player\'s name card', /OKAFOR/i.test(await page.evaluate(() => document.querySelector('#flow .namecard')?.textContent ?? '')));
await key('Enter');
await until(page, () => window.__flow.state().beat === 'stare', undefined, { label: 'the stare-down' });
const tape = await page.evaluate(() => document.querySelector('#flow .tapecard')?.textContent ?? '');
check('a button → the stare-down card with both names', /OKAFOR/i.test(tape) && /BRASK/i.test(tape) && /2 × 0:08/.test(tape), tape.slice(0, 80));
check('the referee is in the ring for it', await page.evaluate(() => window.__ref() !== null));
await shot('stare');

// ── 5. The fight, and the pause ──────────────────────────────────────────────
await key('Enter'); await on('fight');
await until(page, () => window.__tick.simTicks > 5, undefined, { label: 'the sim running' });
const hard = await page.evaluate(() => ({ key: window.__cfg.aiDifficulty, mistake: window.__ai.state().style?.mistake, delay: window.__ai.state().style?.attackDelayMin }));
check(`Hard reached the AI: aiDifficulty ${hard.key}, the opponent's own style at that difficulty (attack gap ${hard.delay?.toFixed(2)} s)`, hard.key === 2 && hard.mistake === 0 && hard.delay > 0, JSON.stringify(hard));
check('a button → the fight: the sim runs and the HUD is up', !(await page.evaluate(() => document.getElementById('hud').hidden)));
await key('Escape');
const p1 = await st();
check('Esc pauses: Resume / Controls / Quit, the sim held', p1.paused && await heldFor() && await page.evaluate(() => [...document.querySelectorAll('#flow .pause .btn')].map(b => b.textContent).join('|')) === 'Resume|Controls|Quit');
await key('Escape');
const tp = await ticks();
await until(page, t => window.__tick.simTicks > t, tp, { label: 'the sim to resume' });
check('Esc resumes', !(await st()).paused);

// ── 6. Between rounds: the corner card ───────────────────────────────────────
await until(page, () => window.__flow.state().card, undefined, { label: 'the corner card', timeout: 30000 });
await frames(page, 2);
const card = await page.evaluate(() => { const c = document.querySelector('#flow .corner'); return { on: c.classList.contains('on'), text: c.textContent, bars: c.querySelectorAll('.cond .bar').length, advice: c.querySelector('.advice')?.textContent ?? '', hud: document.getElementById('hud').hidden, phase: window.__sim.state().round.phase }; });
check('the rest is a corner card: END OF ROUND 1, punch stats, 8 condition bars, a line of advice', card.on && /end of round 1/i.test(card.text) && /Landed \/ thrown/i.test(card.text) && card.bars === 8 && card.advice.length > 20 && card.hud && card.phase === 'between', JSON.stringify({ ...card, text: card.text.slice(0, 60) }));
check('no judges\' scores on it', !/\b10\s*[-–]\s*9\b/.test(card.text));
check('the sim is held behind the card', await heldFor());
await shot('corner');
await key('Enter');
await until(page, () => window.__sim.state().round.phase !== 'between', undefined, { label: 'the rest to be run off', timeout: 20000 });
await frames(page, 2);
check('a button closes the card and the next round starts at once', !(await st()).card && (await page.evaluate(() => window.__sim.state().round.index)) === 1);

// ── 7. Results ───────────────────────────────────────────────────────────────
await on('results');
const res = await page.evaluate(() => ({ phase: window.__sim.state().round.phase, winner: document.querySelector('#flow .winner')?.textContent, method: document.querySelector('#flow .method')?.textContent, rows: document.querySelectorAll('#flow table.cards tr').length, rounds: document.querySelectorAll('#flow table.rounds tr').length, stats: document.querySelector('#flow .sgrid')?.textContent ?? '', btns: [...document.querySelectorAll('#flow .results .btn')].map(b => b.textContent).join('|') }));
check(`results after the last bell: "${res.winner}" ${res.method}, the round-by-round cards and the punch stats`, res.phase === 'over' && !!res.winner && res.rows === 3 && /Jabs/.test(res.stats) && /Accuracy/.test(res.stats) && /Knockdowns/.test(res.stats) && res.rounds === 5 && res.btns === 'Rematch|New fight|Menu', JSON.stringify({ ...res, stats: res.stats.slice(0, 40) }));
await shot('results');

// ── 8. Rematch, and back out to the title ────────────────────────────────────
await key('Enter'); await on('walk');
const re = await page.evaluate(() => ({ tick: window.__sim.state().tick, round: window.__sim.state().round.index, phase: window.__sim.state().round.phase }));
check('rematch → a fresh fight behind a new ring walk', re.tick === 0 && re.round === 0 && re.phase === 'fighting', JSON.stringify(re));
await key('Escape'); await on('opponent');
await key('Escape'); await on('select');
await key('Escape'); await on('title');
check('Esc walks back out to the title', true);

// ── 9. Ladder ────────────────────────────────────────────────────────────────
await key('ArrowDown'); await key('Enter'); await on('select');
await key('Enter'); await on('ladder');
const l1 = await page.evaluate(() => ({ rungs: document.querySelectorAll('#flow .rung').length, next: document.querySelector('#flow .rung.next i')?.textContent, save: localStorage.getItem('longcount.ladder.v1'), st: window.__flow.state().ladder }));
check('a new ladder: seven rungs, the first one next, saved', l1.rungs === 7 && l1.next === '1' && l1.st.wins === 0 && l1.st.fighter === 'blue' && /"fighter":"blue"/.test(l1.save ?? ''), JSON.stringify(l1));
await shot('ladder');
await page.evaluate(() => localStorage.setItem('longcount.ladder.v1', JSON.stringify({ fighter: 'blue', wins: 3, losses: 1 })));
await key('Escape'); await on('title');
await key('ArrowDown'); await key('Enter'); await on('ladder');
const l2 = await page.evaluate(() => ({ next: document.querySelector('#flow .rung.next i')?.textContent, rec: document.querySelector('#flow .rec')?.textContent, won: document.querySelectorAll('#flow .rung.won').length, tag: document.querySelector('#flow .ladder .tag')?.textContent }));
check(`saved progress is picked up: ${l2.rec}, rung ${l2.next} next (${l2.tag})`, l2.next === '4' && l2.won === 3 && /3 – 1/.test(l2.rec) && /Medium/.test(l2.tag), JSON.stringify(l2));
await page.evaluate(() => localStorage.removeItem('longcount.ladder.v1'));
await key('Escape'); await on('title');

// ── 10. Gym ──────────────────────────────────────────────────────────────────
await key('ArrowDown', 2); await key('Enter'); await on('gym');
const g1 = await page.evaluate(() => ({ items: document.querySelectorAll('#flow .ditem').length, last: [...document.querySelectorAll('#flow .ditem .t')].pop()?.textContent }));
check(`the gym lists the thirteen drills and free sparring (${g1.items}; "${g1.last}" last)`, g1.items === 14 && g1.last === 'Free sparring');
await shot('gym');
await key('ArrowUp', 2);   // wraps: Back, then the last drill — the built-in one
await key('Enter'); await on('fight');
await until(page, () => window.__sim.state().tick > 40, undefined, { label: 'the drill running', timeout: 30000 });
const g2 = await page.evaluate(() => ({ drill: window.__flow.state().drill, panel: document.querySelector('#flow .drill').classList.contains('on'), text: document.querySelector('#flow .drill').textContent, stat: window.__flow.state().drillStat, secs: window.__cfg.roundSeconds, d: Math.abs(window.__sim.state().fighters[0].pos.x - window.__sim.state().fighters[1].pos.x) }));
check('a drill runs: its panel shows the goal, a live stat and the way back; one long round; the two men placed', g2.drill === 'free-sparring' && g2.panel && /passive partner/i.test(g2.text) && /0 \/ 20/.test(g2.stat) && /Esc/.test(g2.text) && g2.secs === 180 && g2.d < 1.6, JSON.stringify(g2));
await shot('drill');
await until(page, () => window.__sim.state().tick > 240, undefined, { label: 'the drill a few seconds in', timeout: 30000 });
await key('KeyR');
await until(page, () => window.__sim.state().tick < 240, undefined, { label: 'the drill restarted' });
check('R restarts the drill', true);
await key('Escape'); await on('gym');
check('Esc → back to the gym, the round length put back', (await page.evaluate(() => window.__cfg.roundSeconds)) === 8);
await key('Escape'); await on('title');

// ── 11. Controls ─────────────────────────────────────────────────────────────
await key('ArrowDown', 3); await key('Enter'); await on('controls');
const ctl = await page.evaluate(() => document.querySelector('#flow .controls').textContent);
check('the controls card covers every move', ['Slip', 'Burst', 'Roll under', 'Pivot', 'Push-off', 'Take a knee', 'Feint', 'Chained slip', 'overhand', 'Keyboard', 'Gamepad', 'Touch'].every(w => ctl.includes(w)));
await shot('controls');
await key('Escape'); await on('title');

// ── 12. Create your fighter: the reveal poster, then the select screen ───────
await page.locator('#flow .title .btn', { hasText: 'Create fighter' }).click(); await on('create');
check('before stepping in, the height and weight sliders are enabled', await page.evaluate(() => [...document.querySelectorAll('#flow .mk input[type=range]')].length === 2 && [...document.querySelectorAll('#flow .mk input[type=range]')].every(r => !r.disabled)));
await page.locator('#flow .mk input[type=text]').nth(0).fill('Poster Test');
await page.locator('#flow .mk input[type=text]').nth(2).fill('Duluth');
await page.locator('#flow .screen.create .btn', { hasText: 'Step into the ring' }).click();
await until(page, () => !!document.querySelector('#flow .poster'), undefined, { label: 'the fight poster' });
const poster = await page.evaluate(() => document.querySelector('#flow .poster').textContent);
check('the reveal poster shows the typed name, the home town and a 0 – 0 record', poster.includes('Poster Test') && poster.includes('fighting out of Duluth') && poster.includes('0-0'), poster.slice(0, 90));
check('…and it stays up until a key is pressed (still the create screen)', (await st()).screen === 'create');
await key('KeyJ'); await on('select');
check('a key press moves on to the select screen with him picked', (await st()).player === 'my-fighter' && (await page.evaluate(() => !document.querySelector('#flow .screen.create.on'))));
const total = r => r.wins + r.losses + r.draws;
check('the select card shows his record, 0-0 before a fight', await page.evaluate(() => document.querySelector('#flow .select .recline')?.textContent ?? '') === 'Record 0-0' && total(await page.evaluate(() => window.__record())) === 0);

check('his own select card has no AI style block', await page.evaluate(() => !document.querySelector('#flow .select .style')));
await key('ArrowRight');
check('a roster fighter\'s card still has the style block ("How he fights")', await page.evaluate(() => /How he fights/.test(document.querySelector('#flow .select .style')?.textContent ?? '')));
await key('ArrowLeft');

// His fight: the result goes into his record once.
await key('Enter'); await on('opponent'); await key('Enter'); await on('walk');
await until(page, () => window.__flow.state().beat === 'walk1', undefined, { label: 'the opponent\'s walk' }); await key('Enter');
await until(page, () => window.__flow.state().beat === 'walk0', undefined, { label: 'the player\'s walk' }); await key('Enter');
await until(page, () => window.__flow.state().beat === 'stare', undefined, { label: 'the stare-down' }); await key('Enter');
await on('fight');
await until(page, () => window.__flow.state().card, undefined, { label: 'the corner card', timeout: 60000 }); await key('Enter');   // the corner card is held open in this script
await on('results');
const rec1 = await page.evaluate(() => window.__record());
const line1 = await page.evaluate(() => document.querySelector('#flow .results .recline')?.textContent ?? '');
check('a real fight as the created fighter writes his record once (one fight, one history entry)', total(rec1) === 1 && rec1.history.length === 1 && rec1.history[0].opponent === 'Benny Brask', JSON.stringify(rec1));
check('the results screen shows the line "<his name>\'s record …" after the fight', /'s record \d+-\d+/.test(line1), line1);
await frames(page, 30);
check('…and it is not written again while the results stay up', total(await page.evaluate(() => window.__record())) === 1);
await key('Enter'); await on('walk');   // Rematch: a new fight, nothing finished yet
check('a rematch that has not been fought does not add to the record', total(await page.evaluate(() => window.__record())) === 1);
await key('Escape'); await on('opponent'); await key('Escape'); await on('select'); await key('Escape'); await on('title');

// A gym session writes nothing.
await page.locator('#flow .title .btn', { hasText: 'Edit fighter' }).click(); await on('create');
await page.locator('#flow .screen.create .btn', { hasText: 'Try him in the gym' }).click(); await on('gym');
await page.locator('#flow .ditem').first().click(); await on('fight');
await until(page, () => window.__sim.state().tick > 120, undefined, { label: 'the drill running', timeout: 60000 });
await key('Escape'); await on('gym'); await key('Escape'); await on('create');
check('a gym session as the created fighter does not touch his record', total(await page.evaluate(() => window.__record())) === 1);
check('after stepping in, the sliders are disabled and the line says his body is set', await page.evaluate(() => [...document.querySelectorAll('#flow .mk input[type=range]')].every(r => r.disabled) && /His body is set/.test(document.querySelector('#flow .mk .lockline')?.textContent ?? '')));
await page.locator('#flow .mk .retlink', { hasText: 'Retire him' }).click();
await page.locator('#flow .mk .retlink', { hasText: 'Keep him' }).click();
check('Keep him changes nothing (draft and record stay)', await page.evaluate(() => !!localStorage.getItem('boxing.fighter.v1') && window.__roster().includes('my-fighter')) && total(await page.evaluate(() => window.__record())) === 1);
await page.locator('#flow .mk .retlink', { hasText: 'Retire him' }).click();
await page.locator('#flow .mk .retlink', { hasText: /^Retire$/ }).click(); await on('create');
check('Retire clears the saved draft and the record, drops him from the roster and unlocks a fresh create screen', await page.evaluate(() => localStorage.getItem('boxing.fighter.v1') === null && !window.__roster().includes('my-fighter') && [...document.querySelectorAll('#flow .mk input[type=range]')].every(r => !r.disabled)) && total(await page.evaluate(() => window.__record())) === 0);
await page.evaluate(() => { try { localStorage.removeItem('boxing.fighter.v1'); localStorage.removeItem('boxing.record.v1'); } catch { /* no storage */ } });
await key('Escape'); await on('title');

const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
bad.forEach(m => console.log(`  [${m.type}] ${m.text}`));
check(`console clean (${bad.length} error/warning)`, bad.length === 0);
await browser.close();
done();
