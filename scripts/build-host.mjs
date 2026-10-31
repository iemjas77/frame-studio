import { build } from 'esbuild';
await build({ entryPoints: ['apps/desktop/src/main-cli.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'apps/desktop/dist/host.mjs', tsconfig: 'tsconfig.json', sourcemap: true,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }, logLevel: 'info' });
await build({ entryPoints: ['apps/desktop/src/electron-main.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: 'apps/desktop/dist/electron-main.cjs', tsconfig: 'tsconfig.json', sourcemap: true, external: ['electron'], logLevel: 'info' });
(await import('node:fs')).copyFileSync('apps/desktop/electron/preload.cjs', 'apps/desktop/dist/preload.cjs');
