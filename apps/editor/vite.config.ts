import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  root: r('.'), plugins: [react()], base: './',
  resolve: { alias: {
    '@fs/timeline-model': r('../../packages/timeline-model/src/index.ts'), '@fs/project-model': r('../../packages/project-model/src/index.ts'),
    '@fs/playback': r('../../packages/playback/src/index.ts'), '@fs/command-engine': r('../../packages/command-engine/src/index.ts'), '@fs/media-contracts': r('../../packages/media-contracts/src/index.ts'),
  } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true, target: 'es2022' },
});
