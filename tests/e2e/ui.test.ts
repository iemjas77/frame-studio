/**
 * End-to-end acceptance through the real UI (headless Chromium, software rendering) against the real engine host.
 * Covers acceptance 1, 2, 5, 7 and parts of 3/4 as described in docs/roadmap/test-results.md.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs'; import * as os from 'node:os'; import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ensureFixtures } from '@fs/media-services';
import { startHost } from '../../apps/desktop/src/host.ts';
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
import type { Browser, Page } from 'playwright';

const STATIC = path.resolve(__dirname, '../../apps/editor/dist');
let dir: string, fx: Record<string, string>, browser: Browser, host: Awaited<ReturnType<typeof startHost>>, page: Page; const file = () => path.join(dir, 'proj', 'e2e.fstudio');
const perf: Record<string, unknown> = {};
/** Playwright's own download when present; else a pre-installed Chromium (cloud container); FS_CHROMIUM overrides. */
function pickChromium(): string | undefined {
  if (process.env.FS_CHROMIUM) return process.env.FS_CHROMIUM;
  const root = '/opt/pw-browsers'; if (!fs.existsSync(root)) return undefined;
  for (const d of fs.readdirSync(root).filter((n) => n.startsWith('chromium-')).sort().reverse()) for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) { const p = path.join(root, d, sub); if (fs.existsSync(p)) return p; }
  return undefined;
}

const tid = (id: string) => page.getByTestId(id);
/** frame identity from the canvas strip (same encoding as the fixtures) */
const identity = (id: 'source' | 'program') => page.evaluate((t) => {
  const c = document.querySelector<HTMLCanvasElement>(`[data-testid=canvas-${t}]`); if (!c || !c.width) return null; const g = c.getContext('2d')!;
  let sum = 0, n = 0; for (let y = Math.floor(c.height * 0.4); y < c.height * 0.9; y += 6) for (let x = 0; x < c.width; x += 10) { const d = g.getImageData(x, y, 1, 1).data; sum += (d[0]! + d[1]! + d[2]!) / 3; n++; }
  if (sum / n < 6) return -1; const cell = c.width / 16; let v = 0;
  for (let b = 0; b < 16; b++) { const d = g.getImageData(Math.floor(cell * b + cell / 2), 2, 1, 1).data; if ((d[0]! + d[1]! + d[2]!) / 3 > 128) v |= 1 << b; } return v;
}, id);
const waitIdentity = async (id: 'source' | 'program', want: number) => { await expect.poll(() => identity(id), { timeout: 15_000, message: `frame identity in ${id}` }).toBe(want); };
const clips = () => page.$$eval('[data-testid^=clip-]', (els) => els.map((e) => ({ track: (e as HTMLElement).dataset.track!, start: +(e as HTMLElement).dataset.start!, dur: +(e as HTMLElement).dataset.dur!, src: +(e as HTMLElement).dataset.sourcein!, media: (e as HTMLElement).dataset.media! })).sort((a, b) => a.track.localeCompare(b.track) || a.start - b.start));
const open = async (h = host) => { await page.goto(h.url); await tid('app').waitFor({ timeout: 15_000 }); };
const importPaths = async (...p: string[]) => { await tid('import-paths').fill(p.join('\n')); await tid('btn-import').click(); };
const hint = () => tid('hint').textContent();
const shows = (id: string, timeout = 15_000) => tid(id).first().waitFor({ state: 'visible', timeout });
const textOf = (id: string) => tid(id).first().textContent();
const textHas = async (id: string, part: string, timeout = 15_000) => { await expect.poll(async () => (await textOf(id)) ?? '', { timeout }).toContain(part); };
const textIs = async (id: string, want: string, timeout = 15_000) => { await expect.poll(async () => (await textOf(id)) ?? '', { timeout }).toBe(want); };

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-e2e-')); fx = ensureFixtures(path.join(dir, 'media'));
  if (!fs.existsSync(path.join(STATIC, 'index.html'))) throw new Error('build the editor first: npm run build:editor');
  host = await startHost({ projectFile: file(), staticDir: STATIC }); browser = await chromium.launch({ executablePath: pickChromium(), args: ['--no-sandbox'] }); page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
  page.on('pageerror', (e) => { throw e; });
}, 120_000);
afterAll(async () => { await browser?.close(); await host?.close().catch(() => undefined); fs.writeFileSync(path.join(dir, 'perf.json'), JSON.stringify(perf, null, 1)); if (process.env.FS_KEEP) console.log('kept', dir, JSON.stringify(perf)); else fs.rmSync(dir, { recursive: true, force: true }); });

describe('UI acceptance flows', () => {
  it('loads with token, strips it from the URL, and rejects a bare page load', async () => {
    const bare = await page.goto(host.origin + '/'); expect(bare!.status()).toBe(401);
    await open(); expect(new URL(page.url()).search).toBe(''); expect(await tid('status').textContent()).toContain('audio preview not available');
  });

  it('acceptance 1: import -> source in/out -> insert -> trim -> save -> reopen', async () => {
    await importPaths(fx.A!, fx.H!);
    await shows('media-A_25fps_10s.mp4'); await shows('media-H_25fps_6s_1k.mp4');
    await expect.poll(() => page.$eval('[data-testid="media-A_25fps_10s.mp4"] img', (i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);   // thumbnail decoded
    await tid('media-A_25fps_10s.mp4').click(); await waitIdentity('source', 0);
    for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowRight');       // source frame 50
    await waitIdentity('source', 50); await page.keyboard.press('i');
    for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('ArrowLeft'); await waitIdentity('source', 99); await page.keyboard.press('o');
    await tid('btn-insert').click(); await expect.poll(async () => (await clips()).length).toBe(2);
    expect(await clips()).toEqual([{ track: 'A1', start: 0, dur: 50, src: 50 * 1920, media: 'A_25fps_10s.mp4' }, { track: 'V1', start: 0, dur: 50, src: 50, media: 'A_25fps_10s.mp4' }]);
    await waitIdentity('program', 50);                                                // program monitor shows source frame 50 at timeline frame 0
    await tid('scrub-program').fill('25'); await waitIdentity('program', 75);
    // trim the end by dragging the right edge of the V1 clip ~15 frames left (gesture = one history entry)
    const box = (await page.locator('[data-testid^=clip-][data-track=V1]').boundingBox())!; const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width - 3, y); await page.mouse.down(); await page.mouse.move(box.x + box.width - 3 - 30, y, { steps: 6 }); await page.mouse.move(box.x + box.width - 3 - 60, y, { steps: 6 }); await page.mouse.up();
    const c = await clips(); const v = c.find((x) => x.track === 'V1')!, a = c.find((x) => x.track === 'A1')!; expect(v.dur).toBeLessThan(50); expect(a.dur).toBe(v.dur);   // linked audio trimmed with the video
    const trimmed = v.dur; await tid('btn-undo').click(); await expect.poll(async () => (await clips()).find((x) => x.track === 'V1')!.dur).toBe(50);   // ONE undo restores the whole drag
    await tid('btn-redo').click(); await expect.poll(async () => (await clips()).find((x) => x.track === 'V1')!.dur).toBe(trimmed);
    await page.keyboard.press('Control+s'); await textIs('btn-save', 'Save');
    if (process.env.FS_SHOT) await page.screenshot({ path: process.env.FS_SHOT });
    const before = await clips(); await page.close(); page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage(); await host.close();
    host = await startHost({ projectFile: file(), staticDir: STATIC }); await open(); expect(await clips()).toEqual(before);                 // reopen
  }, 120_000);

  it('acceptance 2: linked A/V -> razor split -> ripple delete -> undo -> sync verified', async () => {
    const before = await clips(); const v0 = before.find((x) => x.track === 'V1')!;
    await tid('tool-razor').click(); const box = (await page.locator('[data-testid^=clip-][data-track=V1]').first().boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height / 2); await tid('tool-select').click();
    await expect.poll(async () => (await clips()).length).toBe(4);                      // V1+A1 both split (linked)
    let c = await clips(); expect(c.filter((x) => x.track === 'V1').length).toBe(2); const [l, r] = c.filter((x) => x.track === 'V1'); expect(l!.start + l!.dur).toBe(r!.start);
    const ra = c.filter((x) => x.track === 'A1'); expect(ra[1]!.start).toBe(r!.start); expect(ra[1]!.src - ra[0]!.src).toBe((r!.src - l!.src) * 1920);          // audio source offset == video source offset (sync)
    await page.locator(`[data-testid^=clip-][data-track=V1]`).first().click({ position: { x: 5, y: 10 } }); await page.keyboard.press('Shift+Delete');
    await expect.poll(async () => (await clips()).length).toBe(2);
    c = await clips(); expect(c.find((x) => x.track === 'V1')!.start).toBe(0); expect(c.find((x) => x.track === 'A1')!.start).toBe(0);                // rippled closed on both tracks
    await tid('btn-undo').click(); await tid('btn-undo').click(); await expect.poll(async () => JSON.stringify(await clips())).toBe(JSON.stringify(before));
    expect(v0.dur).toBeGreaterThan(0);
  }, 60_000);

  it('keyboard shortcuts do not fire inside text fields; J/K/L, space and frame step work elsewhere', async () => {
    await tid('import-paths').focus(); await page.keyboard.type('c i o m '); expect((await tid('tool-razor').getAttribute('class')) ?? '').not.toMatch(/\bon\b/); expect(await tid('import-paths').inputValue()).toBe('c i o m ');
    await tid('import-paths').fill(''); await page.locator('body').click({ position: { x: 5, y: 5 } });
    await tid('monitor-program').click(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await textIs('pos-program', '2');
    await page.keyboard.press('l'); await page.waitForTimeout(300); await page.keyboard.press('k'); const p = Number(await tid('pos-program').textContent()); expect(p).toBeGreaterThan(2);
  });

  it('playback: real-time transport, stale frames never shown, final frame matches final position', async () => {
    await tid('monitor-program').click(); await page.keyboard.press('Home'); await page.keyboard.press('Space'); const t0 = Date.now(); await page.waitForTimeout(1500); await page.keyboard.press('Space');
    const ms = Date.now() - t0; const pos = Number(await tid('pos-program').textContent()); const dropped = Number((await tid('dropped-program').textContent())!.replace(/\D/g, ''));
    perf.playback = { wallMs: ms, framesAdvanced: pos, expectedAt25fps: Math.round(ms / 40), droppedReported: dropped, note: 'headless Chromium, software rendering, 640x360 MJPEG over localhost, no audio clock' };
    expect(pos).toBeGreaterThan(Math.round(ms / 40) * 0.5); expect(pos).toBeLessThanOrEqual(Math.round(ms / 40) + 3);
    await page.waitForTimeout(500); const stop = await tid('pos-program').textContent(); expect(await page.$eval('[data-testid=canvas-program]', (c) => (c as HTMLCanvasElement).dataset.shown)).toBe(stop);
    // rapid scrubbing: only the latest requested frame may remain displayed
    for (const f of [3, 40, 7, 33, 12, 28, 20]) await page.evaluate((v) => { const el = document.querySelector<HTMLInputElement>('[data-testid=scrub-program]')!; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; setter.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); }, f);
    await textIs('pos-program', '20'); await waitIdentity('program', 50 + 20);
    expect(await page.$eval('[data-testid=canvas-program]', (c) => (c as HTMLCanvasElement).dataset.shown)).toBe('20');
  }, 60_000);

  it('acceptance 3 (UI part): export through the UI is verified by decoding it back', async () => {
    const dest = path.join(dir, 'ui-export.mp4'); await tid('export-dest').fill(dest); await tid('btn-export').click();
    await shows('job-result', 60_000); await textHas('job-result', 'Done'); expect(await page.$$eval('.checks .warn', (e) => e.length)).toBe(0);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames,width,height', '-of', 'json', dest]).toString()); const v = probe.streams.find((s: any) => s.codec_type === 'video');
    const seqFrames = Math.max(...(await clips()).map((c) => c.start + c.dur)); expect(Number(v.nb_read_frames)).toBe(seqFrames); expect(probe.streams.some((s: any) => s.codec_type === 'audio')).toBe(true);
    await tid('export-dest').fill(dest); await tid('btn-export').click(); await expect.poll(async () => (await page.$$('[data-testid=job-result]')).length + (await page.$$('[data-testid=export-msg]')).length, { timeout: 30_000 }).toBeGreaterThan(1);
    expect(fs.statSync(dest).size).toBeGreaterThan(1000);                    // existing file untouched by the refused second export
  }, 120_000);

  it('interchange via the UI shows what the format cannot carry', async () => {
    const dest = path.join(dir, 'ui-cut.otio'); await tid('ix-dest').fill(dest); await tid('btn-otio').click(); await shows('ix-loss'); await textHas('ix-loss', 'linked A/V clips'); expect(fs.existsSync(dest)).toBe(true);
    await tid('btn-otio').click(); await shows('ix-msg'); await textHas('ix-msg', 'already exists');
  }, 30_000);

  it('configurable shortcuts: search, conflict warning, replace, persistence across reload, no firing while the dialog is open', async () => {
    await tid('btn-shortcuts').click(); await shows('shortcuts');
    await tid('shortcuts-search').fill('razor'); expect((await page.$$('[data-testid^=key-]')).length).toBe(1); await tid('shortcuts-search').fill('');
    await tid('add-toolRazor').click(); await page.keyboard.press('m'); await shows('shortcuts-clash'); await textHas('shortcuts-clash', 'Add marker');     // M is taken by Add marker
    await page.getByRole('button', { name: 'Keep existing' }).click(); expect((await page.$$('[data-testid=shortcuts-clash]')).length).toBe(0);
    await tid('add-toolRazor').click(); await page.keyboard.press('b'); await textHas('shortcuts-msg', 'Bound B');
    await tid('shortcuts-close').click(); await page.locator('body').click({ position: { x: 5, y: 5 } }); await page.keyboard.press('b'); expect(await tid('tool-razor').getAttribute('class')).toMatch(/\bon\b/); await page.keyboard.press('v');
    await open(); await page.locator('body').click({ position: { x: 5, y: 5 } }); await page.keyboard.press('b'); expect(await tid('tool-razor').getAttribute('class')).toMatch(/\bon\b/);   // persisted in localStorage
    await page.keyboard.press('v'); await tid('btn-shortcuts').click(); await tid('add-toolRazor').click(); await page.keyboard.press('m'); await tid('shortcuts-replace').click(); await tid('shortcuts-close').click();
    const markers = async () => (await page.$$('[data-testid=marker]')).length; const m0 = await markers(); await page.locator('body').click({ position: { x: 5, y: 5 } }); await page.keyboard.press('m'); await page.waitForTimeout(300); expect(await markers()).toBe(m0); expect(await tid('tool-razor').getAttribute('class')).toMatch(/\bon\b/);
    await tid('btn-shortcuts').click(); await tid('shortcuts-reset').click(); await tid('shortcuts-close').click(); await page.keyboard.press('v');
  }, 60_000);

  it('acceptance 5: missing media shows offline, relink refuses an imposter, accepts the identical file, edit preserved', async () => {
    const hidden = path.join(dir, 'hidden_A.mp4'); fs.renameSync(fx.A!, hidden); await open();
    await textHas('status-A_25fps_10s.mp4', 'OFFLINE'); const before = await clips();
    await tid('relink-A_25fps_10s.mp4').click(); await tid('relink-path').fill(fx.H!); await tid('relink-go').click(); await textHas('relink-msg', 'Refused');
    await tid('relink-path').fill(hidden); await tid('relink-go').click(); await expect.poll(async () => (await page.$$('[data-testid="status-A_25fps_10s.mp4"]')).length).toBe(0); expect(await clips()).toEqual(before);
    fs.renameSync(hidden, fx.A!); await tid('media-A_25fps_10s.mp4').click(); await tid('relink-A_25fps_10s.mp4').count();
  }, 60_000);
});
