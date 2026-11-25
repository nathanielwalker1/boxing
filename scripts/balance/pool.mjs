/** pool.mjs — run a list of fight jobs across worker threads; resolves with the results (order not kept). */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

export function runJobs(jobs, workers = 3, onProgress = null) {
  return new Promise((resolve, reject) => {
    const results = [];
    if (!jobs.length) return resolve(results);
    let next = 0, finished = 0;
    const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
    for (let w = 0; w < Math.min(workers, jobs.length); w++) {
      const worker = new Worker(workerPath);
      const feed = () => { if (next < jobs.length) worker.postMessage(jobs[next++]); else worker.postMessage({ done: true }); };
      worker.on('message', m => {
        if (m.ready) return feed();
        results.push(m);
        finished++;
        if (onProgress) onProgress(finished, jobs.length);
        if (finished === jobs.length) resolve(results); else feed();
      });
      worker.on('error', reject);
    }
  });
}
