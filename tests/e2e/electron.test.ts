/**
 * Verifies the real Electron shell under Xvfb (Linux, software GL): window loads the editor from the host, the renderer has no Node,
 * only the narrow bridge is exposed, popups/navigation to foreign origins are denied. Skipped where electron/Xvfb are unavailable.
 * NOT a substitute for checking the packaged app on Windows 10/11 (see docs/handover/unverified-on-windows.md).
 */
import { describe, it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path'; import { createRequire } from 'node:module';
const req = createRequire(import.meta.url); const { chromium } = req('playwright') as typeof import('playwright');
const root = path.resolve(__dirname, '../..');
const electronBin = (() => { try { return req('electron') as string; } catch { return null; } })();
const haveXvfb = (() => { try { execFileSync('which', ['Xvfb']); return true; } catch { return false; } })();
const built = fs.existsSync(path.join(root, 'apps/desktop/dist/electron-main.cjs')) && fs.existsSync(path.join(root, 'apps/editor/dist/index.html'));

describe.skipIf(!electronBin || !haveXvfb || !built)('electron shell (Linux/Xvfb)', () => {
  it('launches, loads the editor, and enforces the renderer security boundary', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-el-')); const port = 9333 + Math.floor(Math.random() * 500);
    const xvfb = spawn('Xvfb', [':97', '-screen', '0', '1600x1000x24'], { stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 800));
    const el = spawn(electronBin!, ['--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, path.join(root, 'apps/desktop/dist/electron-main.cjs'), `--project=${path.join(dir, 'p.fstudio')}`, `--static=${path.join(root, 'apps/editor/dist')}`],
      { env: { ...process.env, DISPLAY: ':97', ELECTRON_ENABLE_LOGGING: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; el.stdout.on('data', (d) => (log += d)); el.stderr.on('data', (d) => (log += d));
    try {
      let browser: import('playwright').Browser | null = null;
      for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise((r) => setTimeout(r, 500)); } }
      expect(browser, `electron did not expose CDP.\n${log.slice(-1500)}`).toBeTruthy();
      const page = (await (async () => { for (let i = 0; i < 40; i++) { const pg = browser!.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('http://127.0.0.1')); if (pg) return pg; await new Promise((r) => setTimeout(r, 500)); } return null; })())!;
      expect(page, `no editor page\n${log.slice(-1500)}`).toBeTruthy(); await page.getByTestId('app').waitFor({ timeout: 20_000 });
      const probe = await page.evaluate(() => ({ req: typeof (window as any).require, proc: typeof (window as any).process, mod: typeof (window as any).module, bridge: Object.keys((window as any).frameStudio ?? {}).sort(), frozen: Object.isFrozen((window as any).frameStudio) }));
      expect(probe).toEqual({ req: 'undefined', proc: 'undefined', mod: 'undefined', bridge: ['pathForFile', 'pickMedia'], frozen: true });
      // the Browse button exists only because the bridge exists
      await page.getByTestId('btn-browse').waitFor({ timeout: 5000 });
      // popup denied
      const before = browser!.contexts().flatMap((c) => c.pages()).length; await page.evaluate(() => { window.open('https://example.com/'); }); await new Promise((r) => setTimeout(r, 800));
      expect(browser!.contexts().flatMap((c) => c.pages()).length).toBe(before);
      // navigation to a foreign origin denied
      const here = page.url(); await page.evaluate(() => { location.href = 'https://example.com/'; }).catch(() => undefined); await new Promise((r) => setTimeout(r, 1200)); expect(page.url().startsWith('http://127.0.0.1')).toBe(true); expect(here.startsWith('http://127.0.0.1')).toBe(true);
      // foreign network requests blocked
      const blocked = await page.evaluate(async () => { try { await fetch('https://example.com/', { mode: 'no-cors' }); return false; } catch { return true; } }); expect(blocked).toBe(true);
      await browser!.close();
    } finally { el.kill('SIGKILL'); xvfb.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);
});
