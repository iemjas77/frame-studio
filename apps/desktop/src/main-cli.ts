/** Headless host launcher: `node dist/host.mjs <project.fstudio> [--port N]` prints the URL (with token). Used by e2e and by the Electron shell. */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from './host.ts';

const args = process.argv.slice(2); const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('usage: host <project.fstudio> [--port N] [--static DIR]'); process.exit(2); }
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const here = path.dirname(fileURLToPath(import.meta.url));
const h = await startHost({ projectFile: path.resolve(file), port: opt('port') ? Number(opt('port')) : 0, staticDir: opt('static') ?? path.resolve(here, '../../editor/dist') });
console.log(`FRAME_STUDIO_URL ${h.url}`);
setInterval(() => { try { if (h.session.dirty) h.autosave(); } catch { /* reported via log */ } }, 60_000).unref();
process.on('SIGTERM', async () => { await h.close(); process.exit(0); });
