import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  resolve: { alias: {
    '@fs/timeline-model': r('./packages/timeline-model/src/index.ts'),
    '@fs/project-model/node': r('./packages/project-model/src/node.ts'),
    '@fs/project-model': r('./packages/project-model/src/index.ts'),
    '@fs/command-engine/node': r('./packages/command-engine/src/session.ts'),
    '@fs/command-engine': r('./packages/command-engine/src/index.ts'),
    '@fs/media-contracts': r('./packages/media-contracts/src/index.ts'),
    '@fs/media-services': r('./packages/media-services/src/index.ts'),
    '@fs/playback': r('./packages/playback/src/index.ts'),
    '@fs/export-engine': r('./packages/export-engine/src/index.ts'),
  } },
  test: { include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'], testTimeout: 60000 },
});
