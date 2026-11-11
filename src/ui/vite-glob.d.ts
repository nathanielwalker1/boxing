/**
 * ui/vite-glob.d.ts — the one piece of Vite's client typing the UI uses
 * (tsconfig has `types: []`). `import.meta.glob` resolves to `{}` when the
 * file does not exist, which is how the UI codes against modules another
 * workstream has not merged yet (core/styles.ts, ai/drills.ts) without
 * breaking the build.
 */
interface ImportMeta {
  glob(pattern: string, opts: { eager: true }): Record<string, unknown>;
  glob(pattern: string): Record<string, () => Promise<unknown>>;
}
