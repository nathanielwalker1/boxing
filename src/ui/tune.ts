/**
 * ui/tune.ts — the tuning panel. Walks core SCHEMA and binds every key of the
 * live Config object, grouped into folders. Dev-only: mounted when the URL has
 * `?tune=1`. Sliders write straight into `cfg`; nothing caches config values,
 * so a drag is visible on the next frame.
 */
import GUI from 'lil-gui';
import { SCHEMA, configGroups, type Config, type ConfigKey } from '../core';

export interface TuningPanel { gui: GUI; refresh(): void; destroy(): void }

export function mountTuningPanel(cfg: Config, onChange?: (key: ConfigKey) => void): TuningPanel {
  const gui = new GUI({ title: 'tune', width: 300 });
  const folders = new Map<string, GUI>();
  for (const g of configGroups()) {
    const f = gui.addFolder(g);
    f.close();
    folders.set(g, f);
  }
  for (const key of Object.keys(SCHEMA) as ConfigKey[]) {
    const e = SCHEMA[key];
    const folder = folders.get(e.group)!;
    let ctrl;
    if (e.kind === 'number') ctrl = folder.add(cfg, key, e.min, e.max, e.step);
    else if (e.kind === 'bool') ctrl = folder.add(cfg, key);
    else ctrl = folder.addColor(cfg, key);
    ctrl.name(key);
    ctrl.onChange(() => onChange?.(key));
  }
  // lil-gui's own hidden scrollbar cuts off ~230 rows at desktop height.
  gui.domElement.style.maxHeight = '95vh';
  gui.domElement.style.overflowY = 'auto';
  return {
    gui,
    refresh: () => gui.controllersRecursive().forEach(c => c.updateDisplay()),
    destroy: () => gui.destroy(),
  };
}
