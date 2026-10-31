# 09 · Testing and performance plan

## 1. Strategy
| Layer | What | Where | Run |
|---|---|---|---|
| Unit | rational/rounding, mapping, timecode, intervals, ripple/linked semantics, undo/redo, project validation, transport | `packages/*/test` | `npx vitest run packages` |
| Property/model | 80-op random command sequences × N seeds: invariants, linked sync, atomic failure, undo-all/redo-all equality, journal replay determinism | `command-engine/test/engine.test.ts` (`FS_RUNS=500` for stress) | included |
| Integration | probe/decode on fixtures, bounded subprocess, relink, export + independent validation, host HTTP API, crash recovery | `packages/media-services`, `export-engine`, `tests/integration` | included |
| End-to-end | real UI in headless Chromium against real host; real Electron under Xvfb | `tests/e2e` | `npm run build && npx vitest run tests/e2e` |
| Performance | baselines with machine info | `tests/performance` → `test-results/benchmarks.json` | included (≈70 s) |
Planned layers: CPU/GPU agreement, preview/export pixel diff, golden images, interchange round trips, long soak, fuzzing of project/probe parsers, Windows CI.

## 2. Fixtures (generated, redistributable — `packages/media-services/src/fixtures.ts`)
Synthetic H.264/AAC with the **frame number encoded as a 16-bit black/white strip in every frame** and a distinct **sine tone per clip**, so decoded output is identified exactly, even after lossy encode. Covered: CFR 25, NTSC 23.976 and 29.97, long-GOP + B-frames, intra-ish GOP, rotation metadata, non-zero start timestamp, mono 44.1 kHz audio, empty / truncated / missing. **Not covered yet:** VFR, interlaced, alpha, 10-bit, HDR/log, multichannel, ProRes/HEVC/DNx, real camera files, image sequences.

## 3. Independent export validation (what "verified export" means)
`validateExport` reads the file back with ffprobe/ffmpeg (never trusting ffmpeg's exit code): container/streams, resolution, exact frame rate, **decoded frame count**, audio format, audio-vs-video duration (≤1.5 frames), decoded sample count, **full decode with zero errors**, and an optional **content oracle** (expected source-frame identity at sampled frames, computed from the *project* via the shared evaluator). Tests additionally measure tone frequency per segment (440/1000/440 Hz at edit points) and silence in gaps. A damaged file is shown to fail; a mutation of the picture mapping is shown to fail the e2e.

## 4. Results — see `test-results.md` and `benchmark-results.json`
## 5. Performance policy
* Publish hardware + fixture characteristics with every number (done in the JSON). 1080p first, then 4K — **only 640×360 synthetic media has been measured; no 1080p/4K numbers exist yet.**
* No universal real-time claims. Measured today: sequential reference decode ≈ 1–3 ms/frame at 640×360 (not representative of HD/long-GOP camera media); cold seek ≈ 90–220 ms.
* Targets to be set after M3 on the Windows reference PC: startup latency, seek latency (cold/warm), dropped frames, audio underruns, A/V drift, CPU/GPU/RAM during playback and export.
