# 07 · Compatibility matrix

## 1. Media capability (measured with generated fixtures on `ffmpeg 6.1.1`, Linux)
| Case | Fixture | Import/probe | Frame-exact decode | Export | Notes |
|---|---|---|---|---|---|
| H.264 25 fps CFR, AAC 48k stereo | A | IV | IV (frame-number strip) | IV | |
| H.264 23.976 (24000/1001) | B | IV | IV | IL | cross-rate onto 25 fps sequence: fps-filter conform, not identical to preview mapping |
| H.264 29.97 long-GOP (GOP 250) + B-frames | C | IV | IV | IL | seek restarts ≈ 160–220 ms (measured) |
| PCM mono 44.1 kHz audio-only | D | IV | n/a | IL | resampled to 48 kHz stereo (mono duplicated) |
| Display rotation metadata | E | IV (270° cw reported) | IL | P | rotation applied by ffmpeg autorotate in export/preview decode; not separately verified |
| Non-zero start timestamp (+3.5 s) | G | IV (start reported) | IV (frame 0 = first frame) | — | ffmpeg `-ss` is start-relative |
| Truncated file | F | typed error or partial | — | — | tested to not crash |
| Zero-byte / missing / directory | Z | typed errors | — | — | |
| VFR | — | detected + warned | P | P | no VFR mapping |
| Interlaced, alpha, 10-bit, HDR/log, ProRes/DNx, HEVC, camera RAW, image sequences, MXF | — | **untested** | untested | untested | do not assume support; P |
| Hardware decode/encode | — | P | P | P | no GPU here |

## 2. Interchange / loss matrix
**Implemented and verified:** OTIO JSON *export* and CMX3600 EDL *export + cuts-only import*, each read back by an independent implementation (OpenTimelineIO 0.18.1 and its cmx_3600 adapter) with identical timing; every export returns a loss report that the UI displays. **Not implemented:** OTIO import, FCP XML/FCPXML, AAF, collection packages, `.prproj`. The table below is the *expected* capability of each format (Researched, unverified this session) — Frame Studio-side status is in the first two columns' notes above.
| Feature | Native `.fstudio` | OTIO (JSON) | CMX3600 EDL | FCP7 XML / FCPXML | AAF | `.prproj` |
|---|---|---|---|---|---|---|
| Cuts/gaps, tracks | ✓ | ✓ | video/audio events, limited tracks | ✓ | ✓ | **U** |
| Source ranges, rational timing | ✓ | ✓ (RationalTime) | timecode, 1-frame granularity | ✓ | ✓ | U |
| Transitions | P | ✓ (basic) | dissolve/wipe codes | ✓ | ✓ | U |
| Speed changes | P | linear time warp effect | M2 comment | ✓ | ✓ | U |
| Audio gain/pan | P | via effect metadata | no | ✓ | ✓ | U |
| Nested sequences | P | stack/track nesting | no | ✓ | ✓ | U |
| Markers | ✓ | ✓ | comments | ✓ | ✓ | U |
| Effects/titles/captions | P | metadata only | no | partial | partial | U |
**Policy:** every adapter must ship a fixture corpus, round-trip through an independent implementation where available, and emit an explicit **loss report**; nothing is dropped silently. `.prproj`, proprietary templates and plugins are separate research with **no** compatibility promise.

## 3. Platform
| Platform | State |
|---|---|
| Linux x64 (cloud container, Node 22, Electron 33 under Xvfb) | IV for everything marked IV |
| Windows 10/11 | **target; entirely unverified** — checklist in `../handover/unverified-on-windows.md` |
| macOS | not a target |
