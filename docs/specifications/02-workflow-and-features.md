# 02 · End-to-end workflow and feature specification

Mission: a professional offline-first NLE for editing, sound, colour, titles, captions and delivery, targeting *familiar* editing workflows through independent engineering. **No Premiere equivalence and no `.prproj` compatibility is claimed.** Every capability below carries its class from `../feature-status.md`.

## 1. Primary workflow (what a user does) and its state
| Step | Behaviour | Class |
|---|---|---|
| Create/open project | `.fstudio`; recovery banner when unsaved edits were replayed | IV |
| Import | files/folders (folders → nested bins), probe, thumbnails, offline indicators, duplicate detection; drag-drop and Browse in the desktop shell | IV / IL |
| Inspect | codec, size, exact fps, audio rate/channels, rotation, colour tags (**unspecified ≠ guessed**), warnings (VFR, multiple audio streams) | IV |
| Mark & insert | Source monitor I/O, targeting, Insert (`,`) / Overwrite (`.`), V+A / video-only / audio-only | IV |
| Assemble & refine | razor, add edit (Ctrl+K), move/trim gestures, ripple trim toggle, lift / ripple delete, snapping, linked selection, locks, sync locks, markers | IV / IL |
| Review | Program monitor transport, scrub, J/K/L, loop, safe areas, timecode (DF/NDF) | IL (no audio) |
| Save / recover | Ctrl+S; journal + autosave + `.bak` | IV |
| Deliver | H.264/AAC MP4 (MOV/MKV muxers available in engine), range = in/out, progress, cancel, **verification report** shown in the UI | IV / IL |

## 2. Workspace UI (original design)
Built: project panel (search/sort, thumbnails, status, relink), source monitor, program monitor, timeline, export queue with job feedback, toolbar, status bar. Dark theme, original logo/icon (SVG in `apps/editor`). Every visible control works; features without an implementation are **absent** or labelled ("audio preview not available in this build"). Planned: workspace presets (Assembly, Editing, Color, Audio, Titles, Captions, Delivery), dockable/resizable panels with persisted layouts, effect controls, audio meters, tool palette extras.

## 3. Keyboard
Preset "Frame Studio default": V select · C razor · Space play/pause · J/K/L · I/O marks · X clear marks · M marker · ←/→ step (Shift = 5) · Home/End · `,` insert · `.` overwrite · Delete lift · Shift+Delete ripple delete · Ctrl+K add edit · Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y · Ctrl+S · Ctrl+I focus import. Shortcuts never fire in text fields (tested). **Not claimed Premiere-compatible:** the additional trim/insert/overwrite/export mappings must be verified against current Adobe documentation, which was unreachable this session. Planned: remapping, search, conflict detection, import/export of presets.

## 4. Feature areas — scope, state, next step
| Area | Built | Next |
|---|---|---|
| Ingest | probe, bins, relink | proxies, image sequences, stills, card structures, watch folders, consolidation (M6–M9) |
| Monitors | transport, marks, safe areas | comparison view, audio scrubbing, external/HDR output (M3–M8) |
| Timeline | tracks, 16 operations (spec 06) | rolling/slide/stretch/replace/match-frame, nesting, multicam, marquee, nudge (M7) |
| Playback | clock transport, sequential decoder | audio-led sync, decode-ahead per layer, native decoder, GPU present (M3) |
| Render/GPU | — | render graph + compositor + CPU reference (M4) |
| Effects/animation | — | transform/opacity/crop/blur/colour, keyframes, cross dissolve, fade-through-colour (M4) |
| Colour | metadata surfaced only | managed pipeline, LUT, scopes, HDR (M5, M8) |
| Audio | export mix | real-time engine, meters, buses, loudness (M5, M8) |
| Titles/captions | — | Unicode/bidi text, templates; SRT/VTT, burn-in (M8). Auto-transcription: evaluate local models/licences first; never display invented text as transcript |
| Export | H.264/AAC verified | presets, hardware encode, image sequences, audio-only, mezzanine, queue concurrency, loudness targets (M6–M8) |
| Interchange | — | OTIO/EDL/FCP XML/AAF research → adapters with fixtures and **explicit loss reports** (M9) |
| Automation/batch | command log is serializable and replayable (journal) | allowlisted macros, batch jobs (M9) |

## 5. Non-goals / Unsupported
`.prproj` read/write, proprietary template/plugin compatibility, account/cloud requirement, claims of real-time at any resolution without measurement, silent substitution of relinked media.
