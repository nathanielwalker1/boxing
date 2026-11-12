/**
 * ui/controls.ts — the controls card (title screen and pause): the whole
 * scheme in plain words for keyboard, gamepad and touch. The bindings are
 * ui/input.ts's; the combinations and what each button throws are the input
 * tables of docs/OVERHAUL_SIM.md. Text only: if a binding changes there, it
 * changes here by hand.
 */

const BASICS: readonly (readonly [string, string, string, string])[] = [
  ['Move', 'W A S D or arrows', 'Left stick or d-pad', 'Drag on the left half'],
  ['Jab', 'J', 'Y (top)', 'JAB (top)'],
  ['Cross', 'K', 'B (right)', 'CRS (right)'],
  ['Hook', 'L', 'X (left)', 'HOK (left)'],
  ['Uppercut', ';', 'A (bottom)', 'UPP (bottom)'],
  ['Block (hold)', 'Space', 'LB, RB or RT', 'BLOCK'],
  ['Low (hold)', 'Shift', 'LT', 'LOW'],
  ['Pause', 'Esc', 'Start', 'II, top corner'],
];

const MOVES: readonly (readonly [string, string, string])[] = [
  ['Slip', 'Flick to the side', 'Your head moves off the line. The hand on that side is loaded for a moment: the next punch from it is faster and harder.'],
  ['Pull back', 'Flick away from him', 'Lean back out of range. Loads the rear hand.'],
  ['Chained slip', 'Flick the other way while slipped', 'Up to three in a row. The last one can be a roll.'],
  ['Roll under', 'Hold Low + flick to the side', 'Head down and across, under a hook. You come up ready to throw a rising hook or uppercut.'],
  ['Burst', 'Flick, then push the same way again', 'A quick hop forward, back or sideways.'],
  ['Pivot', 'Hold Block + flick to the side', 'Turn off your front foot. A man close to you is left facing the wrong way for a moment.'],
  ['Push-off', 'Hold Block + flick toward him', 'Shove him back with both gloves.'],
  // (The clinch was taken out in the polish phase — clinchOn is off; its row comes back with it.)
  ['Take a knee', 'Hold Block + Low while hurt', 'Go down on purpose to clear your head. It counts as a knockdown on the cards.'],
  ['Feint', 'Tap Block just after you start a punch', 'The punch is pulled back before it commits. Most of its stamina comes back.'],
];

const THROWS: readonly (readonly [string, string])[] = [
  ['Jab', 'Jab. Stick toward him: step-in jab. Stick away: jab on the retreat. Low held: jab to the body.'],
  ['Cross', 'Cross. Low held: cross to the body. Low + stick toward him: overhand.'],
  ['Hook', 'Hook. Stick away: check hook. Chest to chest: shovel hook. Low held: hook to the body. Just after you let Low go: rising hook.'],
  ['Uppercut', 'Uppercut. Chest to chest: inside uppercut. Low held, or just after you let it go: rising uppercut.'],
];

const row = (cells: readonly string[], tag = 'td'): string => `<tr>${cells.map((c, i) => `<${tag}${i === 0 ? ' class="k"' : ''}>${c}</${tag}>`).join('')}</tr>`;

export function controlsHtml(): string {
  // Two columns on a wide screen so all three tables are on screen at once; one column on a phone.
  return '<div class="ctl"><div class="col">' +
    '<h3>The basics</h3>' +
    `<table class="ctl-basics">${row(['', 'Keyboard', 'Gamepad', 'Touch'], 'th')}${BASICS.map(r => row(r)).join('')}</table>` +
    '<p class="note">A <b>flick</b> is a quick tap of the stick or a direction key: push and let go straight away. Holding it walks. ' +
    'He is always to your right: toward him is right, away is left, to the side is up or down. ' +
    'Jab and cross always use the same hand. For a hook or an uppercut, hold the stick to one side as you press to pick the hand.</p>' +
    '<h3>What each button throws</h3>' +
    `<table class="ctl-throws">${THROWS.map(r => row(r)).join('')}</table>` +
    '</div><div class="col">' +
    '<h3>Moves</h3>' +
    `<table class="ctl-moves">${MOVES.map(r => row(r)).join('')}</table>` +
    '</div></div>';
}
