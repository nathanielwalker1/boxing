/** worker.mjs — loads the rules once, then runs { p0, p1, seed, tag, cfg? } fight jobs it is sent. */
import { parentPort } from 'node:worker_threads';
import { makeEnv, fight } from './env.mjs';

const env = makeEnv();
parentPort.on('message', m => {
  if (m.done) process.exit(0);
  const r = fight(env, m.p0, m.p1, m.seed, m.cfg || null);
  parentPort.postMessage({ ...m, r });
});
parentPort.postMessage({ ready: true });
