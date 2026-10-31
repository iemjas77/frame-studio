# 01 · Architecture specification

Status of each part is in `../feature-status.md`. This document says what the architecture **is** and marks what is built vs planned.

## 1. Principles
1. **One source of editorial truth.** The project model owns persistent intent; everything else is derived and disposable.
2. **Mutations only through commands.** UI gesture → validated command → new immutable project revision → invalidation → evaluation → monitor/audio/export. Panels never mutate the timeline.
3. **Rendering never mutates editorial state.** Save, automation and export read the *same* model; export receives an immutable (deep-frozen) snapshot.
4. **Exact time.** Integer/rational coordinates only (see spec 06). No accumulated float seconds.
5. **Untrusted inputs.** Media and project files are untrusted; subprocesses are bounded; the renderer is untrusted.
6. **Never claim what is not verified.** GPU, audio and Windows behaviour are separate, explicit.

## 2. Ownership
| Concern | Owner | Built as |
|---|---|---|
| Selection, panel layout, transient gestures, source marks | UI (`apps/editor`) | IL |
| Persistent editorial intent | project model (`packages/project-model`) | IV |
| Validated mutations, history, gestures, journal | command engine (`packages/command-engine`) | IV |
| Time arithmetic, timecode, mapping | `packages/timeline-model` | IV |
| Inspection/decoding/thumbnails/waveforms | media services (`packages/media-services`) | IL (ffmpeg subprocess reference impl) |
| Transport, seek generations, "what is visible now" | playback (`packages/playback`) | IL (clock only; no audio clock) |
| Visual evaluation (graph) | render graph | **P** – today `videoLayersAt` returns "topmost opaque layer" |
| Audio evaluation/mixing | audio engine | **P** – today only export-time mixing via ffmpeg (`audioSegments` + `amix`) |
| Export from snapshot | export engine (`packages/export-engine`) | IL/IV |
| Derived data (thumbs, peaks, proxies, frame caches) | cache engine | **P** (today: bounded in-memory ring only; nothing persisted) |

## 3. Process model (as built)
```
 ┌──────────── Electron main (apps/desktop/src/electron-main.ts) ────────────┐
 │  BrowserWindow: sandbox, contextIsolation, no Node, CSP, nav/popup denied │
 │  preload bridge: pickMedia(), pathForFile()  (frozen, 2 functions)        │
 │  Engine host (same process today): ProjectSession → CommandEngine         │
 │     media-services · playback evaluator · export jobs                     │
 └──────────────▲────────────────────────────────────────────────────────────┘
                │ HTTP on 127.0.0.1, per-launch token, Host/Origin checks
                │ JSON: state, commands, gestures, jobs      BINARY: JPEG frames
 ┌──────────────┴──────────┐        ┌───────────────────────────┐
 │ Renderer: React editor  │        │ ffmpeg/ffprobe subprocesses│ (structured args, timeouts, output caps)
 └─────────────────────────┘        └───────────────────────────┘
```
* Messages are typed (`Command` union, `Snapshot`, `ExportProgress`) and versioned via `MEDIA_CONTRACT_VERSION` / schema version. **Frames never travel as JSON.**
* The same host runs headless (`node apps/desktop/dist/host.mjs`), which is how the UI is tested in a browser. That is architecture option C (browser-first contract validation) — kept as a test harness, never as the product.
* **Target** (Planned): host logic moves into a separate engine process (Rust) behind the same contracts; the renderer talks to it over the same typed channel (named pipe/loopback with token), frames via shared memory/GPU texture handles.

## 4. Data flow: an edit
1. Gesture in timeline → `api.gesture('begin'|'update'|'commit')` or `api.command(cmd)`.
2. `CommandEngine.execute`: apply command to an immer draft → run `assertInvariants` on the **frozen result** (overlaps, bounds, refs, link groups) → on any `CommandError` nothing changes → push one `HistoryEntry` (patches + inverse patches) → `journalAppend` → emit `Change {revision, touchedSequences, dirty range}`.
3. UI receives the new snapshot; program monitor re-requests its frame because `revision` changed.
4. Host `/api/frame/program`: `videoLayersAt(snapshot, seq, frame)` → top layer → `SequentialFrameSource.get(sourceFrame)` (one ffmpeg per media, restarted only on seek) → JPEG.
5. Save: canonical JSON + checksum → temp file → fsync → `.bak` → atomic rename → journal restarted against the new base checksum.
6. Export: `engine.state` (frozen snapshot) → `planExport` (uses the same evaluator functions) → ffmpeg filter graph → temp file → `validateExport` → rename.

## 5. Playback architecture
Built: timeline → `videoLayersAt` → source frame (centre sampling, spec 06) → `SequentialFrameSource` (bounded 24-frame ring, 48-frame look-ahead with back-pressure, abortable, restart on seek) → JPEG → canvas, gated by `Transport.present(generation, frame)`; the server also answers `409 Stale` for a superseded request. Position is derived from an anchor on each read (no per-tick accumulation); without audio the monotonic clock is master.
Planned: audio-led sync (audio clock re-anchors via `Transport.syncTo`), decode-ahead queues per active layer, device-change handling, GPU texture presentation, long-GOP seek-to-keyframe policy in a native decoder (the ffmpeg CLI already does keyframe-seek-and-decode-forward on restart). **No production path spawns a process per displayed frame** (sequential source); cold seeks do spawn one process (~90–160 ms measured).

## 6. Render graph / GPU — Planned
Target semantics (not implemented): deterministic DAG (source frame → colour interpretation → transform/crop → effect nodes → blend → nested sequences → output), explicit pixel formats and alpha convention (premultiplied linear float working space), dependency-hashed cache keys from `(node params, input revisions)`, CPU reference evaluator + GPU backend with output-agreement tests, GPU-loss recovery by re-evaluating from the model. Today there is **no compositor**: the program monitor shows the topmost clip; the exporter overlays opaque layers with ffmpeg. We make **no GPU acceleration claim**.

## 7. Audio — Planned (export mixing only today)
Target: dedicated real-time callback with lock-free queues, no I/O/allocation in the callback, sample-accurate placement from `audioSegments` (already sample-tiling), track/master mix, meters, resampling tests. Built today: sample-exact segment computation + ffmpeg export mix (`aresample`, `aformat stereo`, `adelay …S`, `amix normalize=0`).

## 8. Security (as built; checks in tests)
Electron: no Node integration; context isolation; sandbox flag; narrow IPC validated against sender origin; will-navigate/window-open/webview denied; permission requests denied; network requests outside the host origin cancelled; CSP `default-src 'self'`. Host: loopback bind, token, Host/Origin allow-list, 1 MB body cap, JSON-only commands validated by type, paths must be absolute (+NUL rejected), import limits (2000 files, depth 8, symlinks skipped). Media: `execFile` with argument arrays, timeout, `maxBuffer`, file-size cap; decoder failures surface as typed errors and never touch project state. Residual risk and Windows specifics: `../handover/10-risks-and-handover.md`.

## 9. Repository layout vs the brief
Created because they contain working code: `apps/desktop`, `apps/editor`, `packages/{timeline-model,project-model,command-engine,media-contracts,media-services,playback,export-engine}`, `tests/{integration,e2e,performance,fixtures(generated)}`, `docs/*`.
**Not created (would be empty):** `crates/*`, `packages/{automation,interchange,ui}`, `tests/{golden,interchange}`. They appear when their milestone starts.
