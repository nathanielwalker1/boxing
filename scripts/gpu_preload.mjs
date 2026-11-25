// Preload (node --import ./scripts/gpu_preload.mjs, or set by run_tests.mjs for every script): every Playwright
// chromium.launch draws on the machine's real GPU (Metal on the M1) instead of SwiftShader, the CPU fallback headless
// Chromium picks by default. MEASURED 2026-11-24 on the human fight: 632 ms -> 4.8 ms a drawn frame (131x), boot 13 s -> 2 s,
// renderer "ANGLE Metal Renderer: Apple M1" — the same GPU path Nate plays on. GPU=0 in the environment turns it off.
import { chromium } from 'playwright';

const GPU_ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
if (process.env.GPU !== '0' && process.platform === 'darwin' && !chromium.__gpuPatched) {
  const launch = chromium.launch.bind(chromium);
  chromium.launch = (opts = {}) => launch({ ...opts, args: [...(opts.args ?? []), ...GPU_ARGS] });
  chromium.__gpuPatched = true;
}
