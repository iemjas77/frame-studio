# 10 · Risk register and handover

## Risk register
| # | Risk | Likelihood / impact | Mitigation / status |
|---|---|---|---|
| R1 | **Windows behaviour unverified** (atomic rename, paths, Electron sandbox, installer, codecs) | High / High | Checklist `unverified-on-windows.md`; run before any claim |
| R2 | **Audio**: no device here; A/V sync, latency, underruns, meters untested | High / High | M3/M5 with measurement harness on Windows hardware |
| R3 | **GPU/HDR/colour**: nothing implemented; preview is CPU JPEG on 2D canvas | Certain / High | M4/M5; no acceleration claims until measured |
| R4 | **FFmpeg licensing**: dev FFmpeg is GPL; shipping it or x264 constrains distribution; codec patents separate | Medium / High | LGPL build + platform encoders plan (doc 04); legal review before release |
| R5 | Process-per-seek ffmpeg reference decoder: cold seek 90–220 ms; HD/4K long-GOP will be far slower than the 640×360 numbers | High / Medium | native decoder in M3; never extrapolate current numbers |
| R6 | **Command latency O(N)** (≈100 ms at 4 000 clips) | Medium / Medium | per-track structures, dirty-range validation (M3/M6) |
| R7 | Cross-rate export conform differs from preview mapping | Medium / Medium | warning emitted; native exporter must use evaluator frame map (M4) |
| R8 | Model lacks nesting/transitions/effects/keyframes: adding them needs schema migrations and new invalidation | Medium / Medium | migration machinery exists; first real migration will exercise it |
| R9 | Real-world media variety (VFR, interlaced, odd timestamps, 10-bit, rotation, broken files) untested beyond generated cases | High / Medium | broaden fixtures; fuzz probe/parsers (M6/M10) |
| R10 | Local HTTP API is an attack surface (token in launch URL, loopback); other local processes/users | Low–Medium / Medium | token, Host/Origin checks, CSP, body caps; move to a pipe/stdio channel in M3+ |
| R11 | Keyboard preset compatibility unverified against Adobe docs | Certain / Low | not claimed; verify when docs reachable |
| R12 | Single-author spec: external format research (OTIO/EDL/FCPXML/AAF) not refreshed | Medium / Medium | re-verify against primary docs at M9 start |
| R13 | Journal/autosave only under the app's control: external edits to the `.fstudio` while open | Low / Medium | checksum catches post-save edits; no file watching yet |
| R14 | Link normalisation (ADR-004) may surprise users used to out-of-sync badges | Medium / Low | revisit with user testing |
| R15 | Memory: frozen-state history cap is by approximate size; unmeasured over long sessions | Medium / Medium | soak test in M10 |

## Known defects / limitations (not yet fixed)
* No audio playback; mute/solo/gain affect export only.
* Timeline: no marquee, nudge, track-height UI, vertical drag cannot create tracks; only first audio stream used; audio clip edit points are frame-aligned.
* Source monitor for audio-only media shows no picture and uses a 25-fps notional timeline.
* Export: speed/reverse unsupported (refused); overlap of audio clips on different tracks is summed without limiter (`amix normalize=0`; may clip); colour untagged; MOV/MKV muxers exist in the engine but only MP4 is exposed in the UI and tested; ≥ ~200 clips per export untested (one ffmpeg input per clip).
* Thumbnails/waveforms not cached; `MediaRef.interpretation` / proxy fields have no UI.
* Electron shell: no menu, no Open/Save As dialog (autosave every 60 s when dirty exists in both shells but is not covered by an automated test), default project path `Documents/Frame Studio/Untitled Project.fstudio`.
* Headless host binds a random port each launch; UI imports need absolute paths typed/pasted in a browser.

## Exact next tasks (dependency order)
1. **Windows verification pass** (checklist) — fix whatever it finds before new features.
2. Open/Save As + recent projects in the Electron shell; project-level interpret-footage UI.
3. M3: define `DecodeService`/`AudioDevice` contracts in `media-contracts`; implement a separate-process decoder (Rust `crates/decode-engine` over LGPL FFmpeg libs) with decode-ahead queues and cancellation; audio output via `cpal`; audio-led `Transport.syncTo`; metrics harness (startup/seek/dropped/underruns/drift).
4. Cache engine: persisted thumbnails/waveforms/proxies keyed by `(fingerprint, params)`.
5. Per-track data structures + dirty-range validation to remove O(N) command cost.
6. M4: render graph + CPU reference evaluator + wgpu compositor; transforms/opacity/crop; cross-dissolve; keyframe model (needs schema v2 migration — first real migration).
7. Port `timeline-model` to Rust (`crates/media-core`) validated against golden vectors exported from the TS implementation (add `tests/golden`).
8. Licence scanner over transitive deps; record exact FFmpeg build config in release process.
9. Keyboard remapping UI + conflict detection; verify mappings against Adobe docs when reachable before using the word "compatible".

## How to continue safely
* Read `../feature-status.md` first; update it in the same commit as any behaviour change.
* Keep the three invariants: commands are the only mutation path; renders/exports read frozen snapshots; nothing is claimed without a test or a measurement.
* Run `npm run build && npm test` before pushing; for risky timeline changes run the randomized model test with `FS_RUNS=500`.
