# 08 · Milestone plan and acceptance criteria

Rule: a milestone is **done** only when its acceptance criteria have *evidence in this repo* (tests/measurements), not because code exists, a build passes, or one sample exported. Status below is as of this commit.

| M | Scope | Status |
|---|---|---|
| **M0** Specification | docs 01–10, ledger, ADRs, risk register | **Done** (this PR). Caveat: external-spec research could not be refreshed from primary sources (network allow-list) |
| **M1** Editorial foundation | project model, rational timing, tracks/clips, commands, history, native roundtrip | **Done** — evidence below |
| **M2** First complete edit | import, source/program monitors, basic playback, insert/overwrite, split, trim, verified export | **Done with limitations** — no audio playback, no GPU, no Windows verification (below) |
| M3 Playback reliability | audio-led sync, decode-ahead, cancellation, device change, dropped-frame/underrun metrics, native decoder | Open |
| M4 Visual composition | render graph, compositor (CPU ref + GPU), transform/opacity/crop/blur, dissolve, keyframes | Open |
| M5 Audio & colour foundation | real-time audio, meters, mix, managed colour, LUT | Open |
| M6 Engineering preview | proxies, image seq/stills, presets, queue, hardware encode, installer on Windows | Open |
| M7 Advanced editorial | rolling/slide/stretch/replace, nesting, multicam, speed | **Partly done**: rolling + slide commands verified (no UI gesture); stretch, replace, match frame, nesting, multicam, speed remain open |
| M8 Professional finishing | titles, captions, audio effects/loudness, scopes, HDR | **Partly done**: SRT/VTT library only; schema, UI, burn-in, titles, audio, scopes, HDR open |
| M9 Interchange & automation | OTIO/EDL/XML adapters + loss reports, macros, batch | **Partly done**: OTIO export and EDL export/import verified against an independent implementation, macros (library); FCP XML/AAF/OTIO import, macro UI and batch queue remain open |
| M10 Production hardening | perf at 4K, soak, licence audit, signing, crash reporting | Open |

## M1 acceptance → evidence
| Criterion | Evidence |
|---|---|
| Exact rational timing for 8 required rates; no drift; DF numbering only | `timeline-model/test` (18) |
| Half-open clips, source/sequence domains, audio sample time, mixed rates, speed/reverse mapping | same + `playback/test` audio tiling |
| Project model with stable ids, validation, versioned envelope, unknown-field preservation, migrations machinery | `project-model/test` (13) |
| Atomic save, rotating autosave, journal, missing-media handling, relative/absolute paths | `project-model/test`, `command-engine/test/engine.test.ts` sessions |
| Every edit via validated commands; atomic; exact undo/redo; gesture coalescing; bounded history | `command-engine/test` (46) incl. randomized model test |
| Locked-track, sync-lock, linked-media, source-bound rules for ripple operations | `edit.test.ts` (blocked ripple, locked sync-lock conflict, handle exhaustion) |
| Native round trip | session save→reopen deep-equal (acceptance 1) |
**Open in M1:** nested sequences, transitions/effects/keyframes in the model, VFR mapping, rolling/slide/stretch (moved to M4/M7).

## M2 acceptance → evidence
| Criterion | Evidence |
|---|---|
| Import files/folders, bins, probe, thumbnails, waveforms, offline + relink by content | `media.test`, `host.test`, UI e2e |
| Source & program monitors, play/pause/step/scrub/J-K-L/marks/loop/safe areas/timecode/dropped frames | UI e2e; unit tests for transport |
| Displayed seek result matches latest request | `playback.test` (scrambled completions), UI e2e rapid scrub |
| Insert/overwrite (+video-only/audio-only), split, trim (gesture), ripple, move, lift | `edit.test`, UI e2e |
| Verified export: decode OK, duration, frame count, audio present/format, expected content, sync | `export.test` (8), UI e2e export |
| Acceptance flows 1, 2, 5, 7 | e2e + engine tests (see `09`) |
| Acceptance 3 (title → animate → transition → export) | **Not met**: titles/animation/transitions do not exist (M4/M8). Only edit → export → inspection is verified |
| Acceptance 4 (proxy) | **Not met**: no proxy workflow (M6) |
| Acceptance 6 (batch failure preserves project) | **Not met**: no batch system (M9). Related property verified: export job failure/cancel leaves project and destination untouched |
**M2 limitations that remain open:** audio playback; GPU; Windows; cross-rate conform exactness in export; long-timeline command latency (see benchmarks).

## Work done beyond M2 this session (dependency order was deliberately relaxed for items verifiable without GPU/audio/Windows)
M7 rolling/slide, M8 caption library, M9 OTIO/EDL interchange + macros, keyboard remapping, golden timing vectors (`tests/golden/timing.json`, the contract for the future Rust port). **M3, M4, M5, M6, M10 are not started** because they need an audio device, GPU, a native decoder or Windows to be provable; they are not claimed complete.

## Next-milestone entry criteria (M3)
Native or at least separately-process decoder behind `media-contracts`; audio device path; measurement harness for startup/seek latency, dropped frames, underruns, drift, CPU/GPU/memory on the Windows reference machine; a decision on LGPL FFmpeg build.
