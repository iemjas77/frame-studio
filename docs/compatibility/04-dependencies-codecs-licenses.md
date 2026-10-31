# 04 · Dependency, codec and licence assessment

**Not legal advice.** Software licences are distinct from codec patent licensing; neither is resolved by this document. No unrestricted-commercial-distribution promise is made.

## 1. Direct dependencies (exact versions installed in this repo, licences read from `package.json`)
| Package | Version | Licence | Role |
|---|---|---|---|
| react / react-dom | 18.3.1 | MIT | UI |
| immer | 10.2.0 | MIT | command engine patches |
| vite / @vitejs/plugin-react / esbuild | 6.4.5 / 4.7.0 / 0.25.12 | MIT | build |
| typescript | 5.9.3 | Apache-2.0 | typecheck |
| vitest / fast-check | 2.1.9 / 3.23.2 | MIT | tests |
| playwright | 1.64.1 | Apache-2.0 | UI e2e (dev only) |
| electron | 33.4.11 | MIT (bundles Chromium + Node; see `LICENSES.chromium.html` shipped inside the package) | desktop shell |
Transitive licences have **not** been audited; do it with a licence scanner before any release (Planned, M10). Lockfile: `package-lock.json`.

## 2. FFmpeg (external process today)
* Not bundled, not linked. Frame Studio executes whatever `ffmpeg`/`ffprobe` is on `PATH`.
* **Audited build on the development machine** (`ffmpeg -L`, `-buildconf`): `ffmpeg 6.1.1-3ubuntu5`, **GPL v2+** (`--enable-gpl`), with `libx264`, `libx265`, `libvpx`, `libopus`, `libmp3lame`, `libxvid`, `libxml2`; no `--enable-nonfree`. Encoders used: `libx264`, `aac` (native). Decoders exercised: h264, aac, pcm_s16le.
* **Consequences.** (a) Running a GPL ffmpeg as a separate process does not make Frame Studio GPL, but **shipping that binary with the app** brings GPL source-offer/notice obligations for the binary. (b) For a closed-source product the plan is an **LGPL-only FFmpeg build** (no `--enable-gpl`, no x264/x265) linked dynamically, with H.264/HEVC encode via platform encoders (Windows Media Foundation, NVENC, Quick Sync, AMF) — **Planned; unverified**; that changes the export engine's encoder set and must be re-tested. (c) The distribution build configuration must be recorded and audited per release (script: Planned M10).
* **Patents.** H.264/HEVC/AAC patent pools are independent of FFmpeg's licence; the product owner must assess them (or rely on OS-provided codecs) before distribution. Not assessed here.

## 3. Codec/container capability (measured in this session unless noted)
See `07-compatibility-matrix.md` §1. Only generated fixtures were available; **no camera-original media was tested**.

## 4. Other candidates (Researched — prior knowledge, not re-verified this session)
| Component | Licence (as understood) | Use / note |
|---|---|---|
| OpenTimelineIO | Apache-2.0 | interchange target, not native format |
| MLT | LGPL core, some GPL modules | comparison oracle only (ADR-001) |
| OpenColorIO | BSD-3 | candidate colour engine (M5); config/licensing of ACES configs to review |
| Rust crates (`ffmpeg-next`/`ffmpeg-sys`, `wgpu`, `cpal`) | MIT/Apache (wrappers); wrap FFmpeg licence | M3–M5 candidates; check each crate's FFmpeg linkage |
| HarfBuzz/ICU/FreeType | MIT-style / ICU / FreeType-or-GPL | titles shaping/bidi (M8) |
| Local ASR (e.g. Whisper-family) | model licences vary | evaluate hardware + licences before any feature (M8) |
| AAF SDK | check current licence | optional adapter only if licence allows |
| VST3 / plugin hosting | Steinberg VST3 licence terms | M8+, behind validated process boundary |

## 5. Assets
All icons, branding, UI and sample media are original / generated at test time. Nothing is copied from Adobe or other products.
