# Frame Studio

A professional desktop non-linear video editor (Windows 10/11 target, offline-first, no account). Independent engineering; original branding and sample media; **no Adobe code, assets or file-format claims**. It does not depend on Vector Studio or Pixel Studio.

> **Status: engineering preview (M0–M2 done).** It is a verified editing *core* with a working first edit workflow, not a finished editor. Read `docs/feature-status.md` before assuming a feature exists.

## What works today (and how we know)
Import → source in/out → insert/overwrite → split/trim/ripple/move → save → reopen → export, with an exported file that is **decoded back and checked** (frame count, audio, frame identity, tones) before it is accepted. 158 automated tests pass in the Linux cloud container, including a real-UI Playwright suite and a real Electron launch under Xvfb. See `docs/roadmap/test-results.md`.

**Not verified here (no GPU, no audio device, no Windows desktop):** audio playback/sync, GPU anything, Windows packaging/filesystem/sandbox behaviour, real-world camera media, 4K. See `docs/handover/unverified-on-windows.md` for the checklist to run on a Windows PC.

## Run it
Requirements: Node ≥ 22, `ffmpeg` and `ffprobe` on PATH (a system FFmpeg is used as a separate process; none is bundled — see `docs/compatibility/04-dependencies-codecs-licenses.md`).
```bash
npm install
npm run build            # bundles engine host + Electron main, builds the editor UI
npm run start:host       # headless engine host; prints FRAME_STUDIO_URL (open it in Chromium/Chrome)
npm start                # Electron desktop shell (needs a display)
```
`node apps/desktop/dist/host.mjs <project.fstudio>` opens or creates a project. Media is imported by absolute path (typed/pasted; **Browse…** and drag-drop appear in the Electron shell only).

## Test it
```bash
npm run typecheck
npm test                 # everything (≈90 s): unit, integration, UI e2e (needs built editor), Electron/Xvfb (auto-skips if unavailable), benchmarks
npx vitest run packages  # fast unit/integration only
```
Fixtures are generated on demand by `ffmpeg` (synthetic, redistributable; every frame carries its frame number as pixels, each clip a distinct tone).

## Repository map
`packages/` timeline-model (exact timing) · project-model (schema, validation, `.fstudio`, persistence) · command-engine (commands, history, recovery) · media-contracts · media-services (probe/decode/fixtures/relink — *reference implementation over ffmpeg*) · playback (shared evaluator + transport) · export-engine · interchange (OTIO/EDL + loss reports) · captions (SRT/VTT library) · automation (macros) · `apps/desktop` (engine host + Electron shell) · `apps/editor` (React UI) · `tests/` · `docs/`.
`crates/` (Rust engine) and `packages/ui` do not exist yet — it is Planned (see ADR-001). We do not create empty modules for show.

## Documents
`docs/feature-status.md` (ledger) · `docs/architecture/` (01 architecture, 03 decisions) · `docs/specifications/` (02 workflow/features, 05 project format, 06 timing & commands) · `docs/compatibility/` (04 dependencies/licences, 07 matrices) · `docs/roadmap/` (08 milestones, 09 testing/performance, results) · `docs/handover/` (10 risks/handover, Windows checklist, next tasks).
