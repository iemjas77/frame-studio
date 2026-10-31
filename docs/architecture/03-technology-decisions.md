# 03 · Technology comparison and architecture decisions

**Research caveat.** The cloud session could not reach ffmpeg.org, mltframework.org, electronjs.org or the OTIO docs (network allow-list). Statements about third-party projects below are **Researched = from prior knowledge, not re-verified against current primary documentation in this session**. Anything we *measured* is marked as such.

## ADR-001 Primary production architecture: **A — custom modular engine** (decision)
Electron + React + TypeScript UI; renderer-independent document/timeline/command layers; native (Rust) media/render/audio engine over FFmpeg libraries; GPU compositor behind an abstraction; dedicated real-time audio path.

| Criterion | A. Custom modular engine | B. MLT (or similar) | C. Browser-first reference |
|---|---|---|---|
| Timing correctness | We own exact rational timing (built, tested: 24 h/1 M-frame drift, DF vectors) | MLT timing is frame/`position`-based integer with profile fps (R); sub-frame audio edits and mixed-rate nesting need care; we could not verify here | Whatever we implement |
| GPU integration | Direct control of textures, colour, cache keys | Movit (GPU) is optional/limited; compositing is CPU by default (R) | WebGL/WebGPU possible but no decoding control |
| Audio routing | Dedicated engine; sample-exact placement already modelled | JACK/SDL-style consumers; routing is fixed by MLT's graph (R) | Web Audio, no pro latency/device control |
| Extensibility | Full | Plugin "services" are extensible, but edit semantics (ripple/sync/links) would live outside MLT anyway | Limited |
| Platform support | We choose Windows-first | Good on Linux/macOS; Windows supported but build/packaging burden (R) | Any browser |
| Licensing | Our code + LGPL FFmpeg possible | MLT core LGPL, some modules GPL; Qt/Shotcut-style stack (R). Mixed licences complicate closed distribution | n/a |
| Preview/export consistency | One evaluator by construction (built: `packages/playback/evaluate.ts` feeds both) | Same engine renders both (good) but our command/history/format layers would still need a bridge | Divergence risk (this is why C is not the product) |
| Debug/maintenance cost | Highest up-front | Lower up-front, opaque graph internals later | Lowest, but a dead end for pro playback |

**Decision.** A is the production architecture because exact timing, preview/export identity, the edit-semantics layer and licence control are the product's core. B is **rejected as the core** (its model would sit *under* our command/format layer and fight it) but remains a **comparison oracle**: Planned task — export MLT XML from a project and compare decoded output against ours (interchange test). C is **kept only as a test harness** (`apps/editor` driven in headless Chromium; same host). 
**Reference implementations behind stable interfaces (today):** media services, decoder, exporter and waveform code are TypeScript over the ffmpeg CLI behind `media-contracts` types; they are explicitly replaceable by native crates.

## ADR-002 Command engine on immer patches (decision, built)
Alternatives: hand-written inverse commands; full-state snapshots. Chosen: immer `produceWithPatches` → atomic rollback (throw discards the draft), exact inverse patches, structural sharing (cheap immutable snapshots for export), deep-frozen state. Cost: patch generation is O(shifted clips) for ripples; measured p50 ≈ 100 ms per insert at 4 000 clips (`roadmap/benchmark-results.json`). Mitigation Planned: per-track persistent structures, dirty-range validation.

## ADR-003 Project format: canonical JSON + checksum (decision, built)
Chosen for diffability, debuggability, unknown-field preservation, trivial migration. Binary/streaming formats rejected for v1 (size at 4 000 clips = 1.7 MB, parse+validate 46 ms measured). Revisit if projects exceed ~50 k clips.

## ADR-004 Link groups are sync groups (decision, built)
When an operation shifts part of a group (e.g. inserting inside an L-cut), the pieces no longer in sync with the largest in-sync cluster leave the group (new group, or unlinked if alone). Rationale: no hidden offsets, simple invariant "linked ⇒ same sync offset", found by the randomized model test. Alternative (keep linked, show out-of-sync badge) is a possible later policy.

## ADR-005 Time model (decision, built) — see spec 06
Sequence time = integer frames at the sequence rate; source time = exact `Time` (ticks + rate, may use an exact rational domain after splits); audio positions derived from exact boundaries. Sub-frame **audio clip edit points** are not representable yet (clip start/duration are frame-aligned) — Planned.

## ADR-006 FFmpeg as separate process now, libraries later (decision)
Today: `ffmpeg`/`ffprobe` executables found on PATH, invoked with argument arrays. Pros: licence isolation (no linking), fastest path to verified behaviour. Cons: process-per-seek, no frame-exact control of hardware paths, packaging. Target: LGPL FFmpeg libraries (no GPL components) loaded by the Rust engine; encoders via platform APIs (Media Foundation, NVENC/QSV/AMF) — see doc 04.

## ADR-007 Electron shell hosts the engine in-process for now (decision)
Simplest verified path. Security boundary is the HTTP+token API and the sandboxed renderer. Moving the host to a child process is mechanical because the UI only speaks the HTTP contract.

## Rejected / deferred
Tauri/native UI (WebView2 differences, no Chromium pin), Qt (licence + UI cost), Web-only product (no real-time audio or GPU decode control), MLT-as-core (ADR-001), OTIO as the *native* format (it cannot express our effects/keyframes/sync semantics; it is an interchange target).
