/**
 * record_test.mjs — a fighter's record (core/record.ts): counts, knockouts, streak, the 20-fight cap,
 * the line of text, malformed input, and that applying a fight never mutates the old record.
 */
import { load } from './load.mjs';
import { check, done } from './check.js';

const [{ emptyRecord, applyFight, recordLine, parseRecord, RECORD_HISTORY }] = await load('/src/core/index.ts');
const e = (result, method = 'decision', extra = {}) => ({ opponent: 'Ray Castellano', result, method, round: 3, when: 1000, ...extra });
const fold = (...es) => es.reduce((r, x) => applyFight(r, x), emptyRecord());

const z = emptyRecord();
check('empty record is all zeros with no history', z.wins === 0 && z.losses === 0 && z.draws === 0 && z.koWins === 0 && z.koLosses === 0 && z.streak === 0 && z.history.length === 0);
check('emptyRecord returns a fresh object each time', emptyRecord() !== emptyRecord() && emptyRecord().history !== emptyRecord().history);

const r = fold(e('W', 'KO'), e('W', 'TKO'), e('W'), e('L', 'KO'), e('D'));
check('counts: 3 wins, 1 loss, 1 draw', r.wins === 3 && r.losses === 1 && r.draws === 1, JSON.stringify([r.wins, r.losses, r.draws]));
check('knockout wins count KO and TKO, not decisions', r.koWins === 2, `${r.koWins}`);
check('knockout losses count only stoppages', r.koLosses === 1 && fold(e('L')).koLosses === 0 && fold(e('L', 'TKO')).koLosses === 1);
check('a decision win is not a knockout win', fold(e('W')).koWins === 0);

check('streak: wins running are positive', fold(e('W'), e('W'), e('W')).streak === 3);
check('streak: losses running are negative', fold(e('L'), e('L')).streak === -2);
check('streak: a loss after wins starts at -1, a win after losses at +1', fold(e('W'), e('W'), e('L')).streak === -1 && fold(e('L'), e('L'), e('W')).streak === 1);
check('streak: a draw resets it to 0', fold(e('W'), e('W'), e('D')).streak === 0);

const many = fold(...Array.from({ length: 27 }, (_, i) => e('W', 'decision', { opponent: `Opp ${i}`, when: i })));
check('history is capped at 20, newest last, oldest dropped', RECORD_HISTORY === 20 && many.history.length === 20 && many.history[19].opponent === 'Opp 26' && many.history[0].opponent === 'Opp 7');
check('the totals still count every fight past the cap', many.wins === 27 && many.streak === 27);
check('entries keep opponent, result, method, round and when', JSON.stringify(fold(e('L', 'TKO', { round: 5, when: 42 })).history[0]) === JSON.stringify({ opponent: 'Ray Castellano', result: 'L', method: 'TKO', round: 5, when: 42 }));

check('recordLine: empty is "0-0"', recordLine(z) === '0-0');
check('recordLine: "3-1 (2 KO)" with no draws shown', recordLine(fold(e('W', 'KO'), e('W', 'KO'), e('W'), e('L'))) === '3-1 (2 KO)', recordLine(fold(e('W', 'KO'), e('W', 'KO'), e('W'), e('L'))));
check('recordLine: draws appear only when non-zero', recordLine(fold(e('W'), e('D'))) === '1-0-1' && recordLine(fold(e('W'))) === '1-0');
check('recordLine: no "(0 KO)" when there are none', recordLine(fold(e('L', 'KO'))) === '0-1');
check('recordLine: draws and knockouts together', recordLine(fold(e('W', 'TKO'), e('D'))) === '1-0-1 (1 KO)');

const before = JSON.stringify(r);
const again = applyFight(r, e('W', 'KO'));
check('applyFight does not mutate its input (counts or history)', JSON.stringify(r) === before && again !== r && again.history !== r.history && again.wins === r.wins + 1);
const entry = e('W'); const withEntry = applyFight(z, entry); entry.opponent = 'changed';
check('the stored entry is a copy of the one passed in', withEntry.history[0].opponent === 'Ray Castellano');

check('parseRecord round-trips a record through JSON', JSON.stringify(parseRecord(JSON.stringify(r))) === before);
const bad = [null, undefined, '', 'nope', '{', '[]', '42', '{}', '{"wins":-1,"losses":0,"draws":0,"koWins":0,"koLosses":0,"streak":0,"history":[]}',
  '{"wins":"3","losses":0,"draws":0,"koWins":0,"koLosses":0,"streak":0,"history":[]}', '{"wins":1,"losses":0,"draws":0,"koWins":5,"koLosses":0,"streak":1,"history":[]}',
  '{"wins":1,"losses":0,"draws":0,"koWins":0,"koLosses":0,"streak":1}', 12, [], 'null'];
check('parseRecord: anything malformed gives an empty record', bad.every(b => JSON.stringify(parseRecord(b)) === JSON.stringify(z)), bad.filter(b => JSON.stringify(parseRecord(b)) !== JSON.stringify(z)).join(' | '));
const junk = parseRecord(JSON.stringify({ ...r, history: [...r.history, { nonsense: 1 }, null, 'x'] }));
check('parseRecord: bad history entries are dropped, the rest kept', junk.history.length === r.history.length && junk.wins === 3);

done();
