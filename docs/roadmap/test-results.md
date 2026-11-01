# Test results (cloud container, Linux, Node 22.23, ffmpeg 6.1.1, Chromium 153 headless, Electron 33 on Xvfb)

`npx tsc -p tsconfig.json` clean. `npx vitest run` → **16 files, 158 tests, all passing**.

| Suite | Tests | Notes |
|---|---|---|
| timeline-model | 18 | DF vectors; every frame of 2 h @29.97 DF; 1 M frame conversion; 24→25 conform |
| project-model | 13 | format, validation, atomic save crash points, autosave rotation, journal torn tail |
| command-engine | 50 | 35 edit-semantics (incl. rolling/slide) + 15 engine/session/batch (incl. 60-seed randomized model test covering all 17 op kinds; 500 seeds × 80 ops run once manually before rolling/slide were added, 300 seeds after, 0 failures) |
| media-services | 12 | probe, malformed input, bounded subprocess, frame identity, relink |
| playback | 9 | transport + shared evaluator |
| export-engine | 8 | verified export, gaps, snapshot immutability, overwrite policy, missing media, cancel, damaged file, unsupported speed |
| integration (host API) | 9 | auth/origin, import, gestures, frame staleness, save/reopen, relink, export jobs |
| interchange | 6 | OTIO and EDL read back by **independent OpenTimelineIO 0.18.1 + otio-cmx3600-adapter** (Python, dev-only, tests skip if absent) |
| captions | 6 | property round-trips SRT/VTT, Unicode/RTL, validation |
| automation | 5 | macros: atomic, single undo, hostile input |
| unit (keymap) | 5 | |
| golden | 1 | timing vectors for a native port |
| e2e UI | 9 | acceptance 1, 2, 5; shortcuts-in-text-fields; real-time playback; rapid scrub; UI export |
| e2e Electron | 1 | renderer has no Node; bridge = 2 frozen functions; popup/navigation/network denied |
| performance | 5 | baselines only |

## Defects found by the tests during development (kept as regression tests)
1. Insert inside an L-cut left a linked pair out of sync → link-group normalisation (ADR-004).
2. Ripple delete/trim ignored a straddling clip on another sync-locked track → now `RippleBlocked`.
3. Export: `setpts` float truncation duplicated/dropped frames → explicit `round()`; audio `adelay` produced irregular timestamps that broke seeking in the output → timestamps regenerated from sample count.
4. History cost cap evicted everything on long timelines → cap raised; full-project validation made O(N) with bigint → memoised.
5. Test-harness mistakes (DF sign, fixture length, `-display_rotation` convention) were fixed in the tests, not the code.

6. Found by writing the macro test: inside one transaction a new clip could embed an immer draft proxy and `structuredClone` threw — only reachable through `batch`; `plain()` now unwraps drafts at any depth (regression test in engine tests).
7. Found by the independent OTIO reader: my first `Clip.2` output used the wrong media-reference fields (rejected by OpenTimelineIO) — fixed; this is exactly what the cross-check is for.

## Mutation sanity checks (manual, this session)
Off-by-one program frame in the host → UI acceptance 1 fails. Linked trim disabled in the engine → UI acceptance 1 fails. Both restored.

## What these results do **not** show
Audio playback/sync, GPU behaviour, Windows (any), real camera media, 1080p/4K speed, memory growth under long sessions, concurrent users of the host API, UI behaviour in browsers other than Chromium.
