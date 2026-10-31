# Checklist for the Windows 10/11 PC (everything here was **not** verified in the cloud session)

Record results in `roadmap/test-results.md` under a "Windows" heading with machine info.

**Setup** — `ffmpeg`/`ffprobe` on PATH; `npm install`; `npm run build`; `npm test`. Note which tests fail on Windows (expect path/rename/process-kill differences). Run `npx vitest run tests/performance` and keep `benchmarks.json`.

**Desktop shell** — `npm start`: window opens, no console errors; Browse… dialog returns absolute paths; drag-drop files and a folder into Project panel; confirm the renderer cannot reach the network and `window.require`/`process` are undefined (DevTools console); **remove `--no-sandbox` reliance** (the Linux test used it because the container runs as root) and confirm the renderer sandbox is really active (e.g. `process.sandboxed` inside the preload, or `chrome://sandbox` in a DevTools-attached tab).

**Files** — project on a path with spaces/Unicode, on another drive, and on a network share: save, kill the process during save (Task Manager) and reopen (journal + `.bak`), AV/indexer interference with temp-file rename; media on another drive: relative/absolute resolution after moving the project folder; long paths > 260; case-insensitivity in relink; locked (in-use) media files.

**Media** — real camera files (H.264/HEVC 8/10-bit, 1080p and 4K, long-GOP, VFR phone clips, interlaced, ProRes, DNxHD, MXF, image sequences, rotated phone video, multi-audio, 5.1): probe correctness, seek accuracy, frame identity at cuts, relink identity, warnings.

**Playback & audio (needs sound hardware)** — no audio playback exists yet: this is M3. Record baseline dropped frames at 1080p/4K with the current reference decoder.

**Export** — H.264/AAC verification report on 1080p and 4K sequences; cancel mid-encode and confirm no stray temp files; destination on a different drive; read-only destination; very long timeline (≥ 200 clips); open outputs in two independent players and compare duration/audio sync; run with a **LGPL** FFmpeg build (no x264) to see what breaks.

**Hardware** — GPU model/driver noted; nothing is GPU-accelerated yet, so only record CPU/RAM.
