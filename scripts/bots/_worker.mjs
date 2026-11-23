/** bots/_worker.mjs — a worker thread for bot_ladder.mjs: loads the sim once, then runs {a, b, seed} fight jobs it is sent. */
import { parentPort } from 'node:worker_threads';
import { makeEnv, participants, aiParticipants, fight } from './fight.mjs';

const env = await makeEnv();
const by = Object.fromEntries([...participants(), ...aiParticipants(env.AI)].map(p => [p.id, p]));
parentPort.on('message', m => {
  if (m.done) { process.exit(0); }
  const r = fight(env, by[m.a], by[m.b], m.seed);
  parentPort.postMessage({ ...m, r });
});
parentPort.postMessage({ ready: true });
