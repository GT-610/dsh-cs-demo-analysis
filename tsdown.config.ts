/**
 * Build the two entry points the Harness loads.
 *
 * The plugin entry is the single ES module `exports["."]` resolves to. The
 * parse worker is a separate entry because `new Worker(url)` loads a real file
 * from the output directory at runtime — bundling it inline would leave the
 * worker thread with nothing to run.
 *
 * `@laihoe/demoparser2` stays external: it is an N-API addon, and the worker
 * loads it through `createRequire` so npm can resolve the platform prebuild.
 */
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    plugin: 'src/plugin.ts',
    'parse-worker': 'src/parse-worker.ts',
  },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // `plugin.js` / `plugin.d.ts`, not the fixed `.mjs` / `.d.mts` pair.
  fixedExtension: false,
  dts: true,
  clean: true,
  sourcemap: true,
});
