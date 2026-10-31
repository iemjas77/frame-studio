# 06 · Timeline timing and command semantics

Code: `packages/timeline-model`, `packages/command-engine/src/edit.ts`. Every rule below has a test unless marked Planned.

## A. Timing
* **Rates** are reduced `{num,den}` of safe integers: 24000/1001, 24, 25, 30000/1001, 30, 50, 60000/1001, 60 (and any rational).
* **Exact arithmetic:** `Frac` on BigInt. Floats only for display.
* **Rounding is always explicit** (`floor | ceil | nearest | trunc`); `nearest` = half away from zero.
* **Half-open intervals** `[start, end)`; adjacent clips do not overlap.
* **Domains:** sequence = integer frames; source = `Time {ticks, rate}` (video frames, audio samples, or an exact rational domain); audio sample positions come from independent exact boundaries, so a clip split at any frame yields segments that tile with **no gap, overlap or drift** (tested at 29.97 → 48 kHz: 1601/1602-sample frames, 48 048 000 samples per 30 000 frames).
* **Timecode:** `sequence.startFrame` offsets display. Non-drop at any integer-nominal rate; **drop-frame only 29.97 (drop 2) and 59.94 (drop 4)**. DF changes numbering, never speed (a DF hour label is 3.6 ms behind real time by definition; tested). Non-existent labels (`00:01:00;00`) rejected. Fixed-point round trip tested for every frame of 2 h.
* **Mixed rates:** displayed source frame for sequence frame *k* = frame containing the **centre** of `[k,k+1)` after mapping (`sourceVideoFrameAt`). Identity at equal rate; 24→25 repeats 1 frame per 25 (tested); no drift over 1 h.
* **Speed (mapping only):** signed rational `speed` = source seconds per sequence second. 0 is invalid (freeze = a hold, **Planned**). Reverse counts down (tested). No command creates speed ≠ 1; export refuses it.
* **Proxy → source:** `proxyToSource` re-expresses via seconds with explicit rounding; proxies are assumed same timeline (**mapping function only; no proxy workflow**, Planned).
* **Nested sequences, transition handles, VFR timestamp mapping:** **Planned**; VFR media is flagged and treated at nominal rate.
* **Duration chosen at insert:** `floor((out − in) × seqRate)` limited by the **shortest used stream**, so a clip never references past the media; a source of 25 fps on a 29.97 sequence is therefore slightly shorter in frames than in seconds-rounded-up.

## B. Command engine
All editorial changes are serializable `Command` objects (`commands.ts`, 24 types). `execute(cmd)`:
1. apply to an immer draft (throws `CommandError{code}` on a failed precondition);
2. validate the frozen result (`Invariant` on violation);
3. commit as **one** history entry with inverse patches; append to journal; bump `revision`; emit `Change`.
On any error **the previous state object is returned unchanged** (identity-tested). `dryRun` evaluates without committing.
* **Gestures:** `beginGesture → updateGesture* → commitGesture | cancelGesture`. Each update is evaluated from the gesture *base* (updates never accumulate); a failing update keeps the last good preview; commit pushes exactly one entry (tested: 4 previews = 1 undo). Other commands are refused during a gesture.
* **History:** bounded by entry count (500) and approximate cost (60 M chars); undo/redo exact (deep-equal tested, plus randomized undo-all/redo-all); a new edit clears redo.
* **Ids:** `ctx.newId` is deterministic from the transaction id, so **journal replay reproduces the exact state** (randomized test).

## C. Edit semantics (precise)
**Common:** clips never overlap on a track. A *locked* target ⇒ `LockedTrack` error. *Affected* (rippling) tracks = unlocked tracks with `syncLock` + tracks the command explicitly edits. A **locked track with `syncLock` that has content after the edit point makes ripple/insert fail** (`LockedTrackConflict`) — never a silent desync; a locked track with `syncLock=false` is untouched by design.
**Links:** commands expand the selection to the whole link group unless `ignoreLinks`. After an operation that shifts/splits part of a group, clips no longer sharing the group's **sync offset** (timeline time − source time, tolerance ½ sample) leave it (ADR-004).

| Operation | Rule |
|---|---|
| **insert** (V/A/video-only/audio-only) | creates linked clips on targeted tracks; splits every clip spanning the time on affected tracks (right part gets a new link group and an exact source-in) and shifts later content right by the new length |
| **overwrite** | replaces exactly `[t, t+len)` on target tracks only (splits/trims/removes); nothing shifts |
| **append** | overwrite at the end of the targets |
| **split** (`clipIds` or `allTracks`) | strictly inside `(start,end)` else `NothingToDo`; explicit selection on a locked track errors; `allTracks` skips locked tracks; linked clips split together |
| **lift** | removes clips (+linked), leaves gaps |
| **ripple delete** | deletes clips (+linked) and closes the vacated range on affected tracks. **Strict:** if any remaining clip overlaps the vacated range or lacks room on an affected track ⇒ `RippleBlocked` (unless `allowPartial`, which deletes and shifts by what is possible, possibly 0) |
| **remove gap** | closes the empty gap containing a time on one track, rippling affected tracks, same blocking rule |
| **move** | linked group by `deltaFrames` and optional per-kind `trackDelta`; `strict` ⇒ `Collision` on overlap; `overwrite` ⇒ clears destinations; never before frame 0 |
| **trim** (start/end) | non-ripple: extension limited by neighbour (`Collision`) and by source handle (`InsufficientHandle`); minimum 1 frame; linked members get the same edge delta (atomic: one failure aborts all). **Unavailable handles are rejected, not clamped, by the command**; `trimLimits()` gives UI the legal range |
| **ripple trim** | end: shortening closes the gap (same strict blocking rule), lengthening splits/shifts others. start: clip start stays, source-in advances, later content shifts |
| **slip** | shifts source-in under a fixed placement within handles; linked clips slip together |
| **link / unlink** | merge / dissolve groups; singletons are dissolved |
| **markers, in/out range, track properties** | simple commands; `out > in` enforced |

**Partial selection:** a selection containing locked-track clips fails as a whole (atomic). **Planned:** rolling edit, slide, rate stretch, replace, match frame, reveal source, duplicate, extract-range, keyboard nudge, marquee.

## D. Monitors and seeks
`Transport` keeps a `generation` bumped by every seek/play/pause/direction change. A frame is displayable only if `present(gen, frame)` is true; the host additionally answers `409 Stale` to superseded `(monitor, generation)` requests. Tested with scrambled completion order (unit) and rapid scrubbing in the real UI (e2e).
J/K/L: L from stopped/reverse ⇒ forward 1×; repeated L ⇒ 2×, 4×, 8× (cap); J mirrors; K pauses. End of sequence stops on the last frame or wraps in loop mode.
