# Feature status ledger (single source of truth)

Classes: **IV** Implemented and verified · **IL** Implemented with limitations · **R** Researched (not built) · **P** Planned · **U** Unsupported (explicitly not offered).
"Verified" means an automated test in this repo passes **in the Linux cloud container** (no GPU, no audio device, no Windows). Anything that only a Windows desktop, GPU or sound card can confirm is listed in `handover/unverified-on-windows.md`.
Test counts: see `roadmap/test-results.md`.

## M1 – editorial foundation
| Capability | Class | Evidence / limitation |
|---|---|---|
| Exact rational timing (24000/1001 … 60), explicit rounding, half-open intervals | IV | `packages/timeline-model/test` (24 h and 1 M-frame drift tests) |
| Drop-frame / non-drop timecode (29.97, 59.94), invalid-label rejection | IV | known vectors + every frame of 2 h round-trips |
| Source ↔ sequence mapping (mixed rates, half speed, reverse) | IV (function) / P (editing UI for speed) | mapping tested; no command creates non-1× clips; export refuses them |
| Audio boundaries sample-exact, no drift (29.97 → 48 kHz) | IV | boundary-tiling test |
| VFR timestamp mapping | P | VFR is detected and warned; nominal rate is used |
| Native `.fstudio` format v1: IDs, validation, canonical JSON, checksum, unknown-field preservation | IV | `project-model/test` |
| Migration policy + machinery | IV (machinery) | no real migration exists yet (v1 is first schema); newer files refused untouched |
| Atomic save, `.bak`, rotating autosave, recovery journal, fallback open | IV (Linux) | crash-injection tests; Windows rename semantics unverified |
| Relative/absolute path resolution (POSIX + Windows styles) | IV (pure functions) | real Windows filesystem unverified |
| Command engine: validated atomic commands, exact undo/redo, gestures (1 history entry), bounded history, rollback | IV | engine tests + 60 randomized runs/CI (500 runs × 80 ops manually, no failures) |
| Insert, overwrite, append, split/razor, lift, ripple delete, remove gap, move, trim, ripple trim, slip, link/unlink, markers, track props | IV | `command-engine/test` |
| Locked-track / sync-lock / linked-media / source-bounds rules | IV | dedicated tests incl. blocked-ripple and locked-sync-lock conflict |
| Rolling edit, slide, rate stretch, replace, match frame, reveal source, duplicate | P | M7 |
| Nested sequences, multicam | P | model has no nested clips yet (M7) |
| Transitions, effects, keyframes, titles, captions | P | not in model v1 |

## M2 – first complete edit
| Capability | Class | Evidence / limitation |
|---|---|---|
| File and folder import (folders → nested bins), per-file errors, duplicate detection | IV | host integration + UI e2e |
| Probe: streams, exact rational fps, audio samples, rotation, PAR, colour tags (never guessed), start time, VFR/B-frame flags | IV | against generated CFR/NTSC/long-GOP/rotated/offset/audio-only fixtures |
| Malformed media handling (empty, missing, truncated, huge output, hang, shell metacharacters in names) | IV | bounded subprocess tests |
| Relink by content identity (identical / likely-needs-confirm / mismatch) | IV | unit + API + UI e2e |
| Thumbnails, waveform peaks | IL | ffmpeg subprocess per request; no cache; first audio stream only |
| Source monitor + program monitor (play/pause, frame step, scrub, J/K/L, in/out, loop, safe areas, timecode, dropped-frame counter) | IL | works in headless Chromium; **no audio**, **no GPU**, MJPEG over localhost; clock-driven only |
| Seek-generation stale-frame rejection (client and server) | IV | unit + e2e rapid-scrub test |
| Insert/overwrite with source marks, V/A/video-only/audio-only, targeting | IV | UI e2e |
| Timeline UI: tracks, lock/sync/target/mute/solo/visibility, move/trim drag gestures, snapping, razor, markers, zoom, waveforms | IL | no marquee, no keyboard nudge, no track-height change UI, single audio stream per clip |
| Preview ↔ export share one evaluator (`packages/playback/evaluate.ts`) | IV | export content oracle compares decoded output to evaluator |
| Export H.264/AAC MP4/MOV/MKV from immutable snapshot; temp file → independent validation → atomic finalize; no silent overwrite; cancel; progress; missing/changed-media preflight | IV (same-rate sources) / IL | cross-rate conform uses ffmpeg `fps` filter and is **not** guaranteed identical to preview mapping; no speed/reverse; no effects/titles; colour untagged/unmanaged; software x264 only |
| Export validation: container, streams, resolution, rate, frame count, audio format/duration/sample count, full decode, content oracle | IV | damaged-file test proves validator independence from exit code |
| Electron shell: no Node in renderer, context isolation, sandbox flag, preload bridge of 2 functions, popup/navigation/foreign-network denied | IL | verified on Linux/Xvfb with `--no-sandbox` (container root); Windows + OS sandbox unverified |
| Engine host API (token, origin/host checks, CSP, body limits, path validation) | IV | integration tests |
| Keyboard preset (V C Space J K L I O M arrows Ctrl+Z/Shift+Z/S/I, `,` `.` Delete Shift+Delete Ctrl+K) | IL | works; **not claimed Premiere-compatible** (docs not reachable this session) ; no remapping UI, no conflict detection |
| Audio playback / meters / mixing preview | P | M5 (no audio device here) |
| Hardware/GPU decode, render, GPU compositor | P | none implemented. The UI is **CPU-decoded JPEG drawn to a 2D canvas**; nothing is GPU-accelerated by us |
| Proxy create/attach/toggle, proxy ↔ source mapping | P | `ProxyRef` exists in the schema only |
| Batch/actions/macros, watch folders, background transcode | P | M9 |
| Image sequences, stills, camera-card structures, spanned clips | P | |
| Interchange (OTIO, EDL, FCP XML, AAF), captions SRT/VTT | P | researched only (`compatibility/07`) |
| `.prproj` import/export | U | no claim, no adapter |
| HDR, colour management, LUTs, scopes | P | |
| Auto-transcription | P | evaluation first |
