# Benchmark results (baselines — not performance claims)
Machine: Intel Xeon @ 2.8 GHz, 4 cores, 16 GB, Linux 6.18 (cloud container), Node 22.23, **no GPU**. Media: synthetic 640×360 H.264. Raw data: `benchmark-results.json`. Re-run: `npx vitest run tests/performance` (writes `test-results/benchmarks.json`).

| Measurement | Result |
|---|---|
| Command latency, 400 clips total (200/track V+A), p50: insert / split / ripple delete / undo | ≈ 18 / 3 / 16 / 5 ms |
| Command latency, 4 000 clips total (2 000/track), p50: insert / split / ripple delete / undo | ≈ 102 / 25 / 90 / 41 ms — **O(N) per command; acceptable for hundreds of clips, a known limitation for long-form** |
| Building 2 000 clips by 2 000 overwrites | 26 s |
| Save (serialize) / open (parse+validate) at 4 000 clips | 61 ms / 46 ms, 1.7 MB |
| One-shot cold seek (ffmpeg subprocess) | p50 ≈ 91 ms |
| Sequential decode, next frame (reference, 640×360 long-GOP) | p50 ≈ 1.2 ms, p95 ≈ 2.9 ms; stream startup ≈ 110 ms; restart-seek p50 ≈ 160 ms |
| Host `/api/frame/program` sequential | p50 ≈ 1.7 ms, p95 ≈ 6 ms (≈ 290 fps achievable for tiny frames); random seek p50 ≈ 96 ms |
| UI playback in headless Chromium (software) | advanced within the expected frames for the wall time; dropped frames reported by the UI counter (value logged in `perf.json` with `FS_KEEP=1`) |
| Export 300 frames, 6 clips, 640×360, x264 veryfast crf18, incl. validation | 2.9 s ≈ 105 fps |
Not measured: 1080p/4K, memory, GPU, audio underruns, drift over long playback.
