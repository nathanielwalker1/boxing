import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames, settled } from './waits.js';

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
await bootReady(page);

/**
 * Hold a direction until the fighter has actually stopped moving on that axis,
 * then screenshot where it came to rest.
 *
 * This used to hold each key for a hand-tuned 3–5 s and assume that was long
 * enough to cross the ring. It is the clamp that this test is about, so "held
 * until the clamp stopped it" is the real condition — and waiting on it is both
 * faster (the fighter arrives well inside the old budget) and correct on a
 * loaded machine, where 5 s of wall clock is nowhere near 5 s of travel.
 */
async function pinAgainst(key, axis, shot) {
  await page.keyboard.down(key);
  const read = axis === 'x'
    ? () => window.__game.scene.keys.RingScene.fighter.x
    : () => window.__game.scene.keys.RingScene.fighter.y;
  await settled(page, read,
    { epsilon: 0.05, stableFrames: 6, timeout: 25000, label: `fighter.${axis} to reach the rope` });
  await page.keyboard.up(key);
  await frames(page, 3);
  await page.screenshot({ path: `scripts/output/${shot}.png` });
}

await pinAgainst('ArrowRight', 'x', 'boundary_right');   // right rope
await pinAgainst('ArrowLeft',  'x', 'boundary_left');    // cross to the left rope
await pinAgainst('ArrowUp',    'y', 'boundary_top');     // top rope
await pinAgainst('ArrowDown',  'y', 'boundary_bottom');  // bottom rope

await browser.close();
console.log('Page errors:', errors.length ? errors : 'none');
console.log('Boundary screenshots saved.');
if (errors.length) {
  console.error(`FAILED — ${errors.length} page error(s).`);
  process.exit(1);
}
