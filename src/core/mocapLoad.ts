/**
 * core/mocapLoad.ts — the browser's one-time load of the mocap library for cfg.mocapGeo (main.ts, human mode). Not
 * used by the sim: it only fetches the baked files and injects them (core/mocap.ts setMocapLib). Resolves true when
 * the library is in; false (and logs) if a file is missing, so the caller leaves mocapGeo off.
 */
import type { BakeIndex, Roles } from './mocapClip';
import { buildMocapLib, mocapLib, setMocapLib } from './mocap';

/** (bodyFile: the glb whose skeleton the takes are fitted to — the body that is DRAWN, see cfg.mocapGeoDrawnBody) */
export async function loadMocapGeo(base = '/fighter', bodyFile = 'boxer.glb'): Promise<boolean> {
  if (mocapLib()) return true;
  try {
    const [index, bin, roles, glb] = await Promise.all([
      fetch(`${base}/clips/index.json`).then(r => r.json() as Promise<BakeIndex>),
      fetch(`${base}/clips/clips.bin`).then(r => r.arrayBuffer()),
      fetch(`${base}/clips/roles.json`).then(r => r.json() as Promise<Roles>),
      fetch(`${base}/${bodyFile}`).then(r => r.arrayBuffer()),
    ]);
    setMocapLib(buildMocapLib(index, bin, roles, glb));
    return true;
  } catch (e) {
    console.error('mocapGeo: clip library failed to load, the sim keeps its own gloves', e);
    return false;
  }
}
