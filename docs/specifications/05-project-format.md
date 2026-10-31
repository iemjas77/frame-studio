# 05 · Native project format `.fstudio` (schema v1)

Implemented in `packages/project-model` (types, `validate.ts`, `serialize.ts`, `node.ts`). Verified by `project-model/test`.

## Envelope
UTF-8 JSON, keys sorted recursively, 1-space indent, trailing newline:
```json
{ "format": "frame-studio-project", "schemaVersion": 1, "appVersion": "0.1.0", "savedAt": "…ISO…",
  "checksum": { "algo": "sha256", "value": "<sha256 of canonical JSON of `project`>" }, "project": { … } }
```
* **Open order:** parse → `format` check → `schemaVersion > supported` ⇒ refuse (`newer-schema`), **file untouched** → verify checksum (same-version files) → run migrations one version at a time → validate → load.
* Truncated/edited files are detected (`syntax` / `checksum`). A failed load never overwrites anything.

## `project`
| Field | Meaning |
|---|---|
| `id`, `name`, `createdAt` | identity (UUID), display name |
| `mediaPool{id→MediaRef}`, `mediaOrder[]` | **external** media references (Implemented). Source files are never modified or copied by default. Collected-package option: **Planned** |
| `bins{id→{id,name,parentId}}`, `binOrder[]` | nested bins; cycles rejected |
| `sequences{id→Sequence}`, `sequenceOrder[]`, `activeSequenceId` | |
| `exportPresets[]` | schema slot only (presets UI Planned) |
| `extensions{}` | reserved for forward-compatible data; preserved verbatim |
| *any unknown key* | preserved verbatim on load → save (tested at top level and inside sequences) |

**MediaRef:** `id,name,binId,path{absolute,relative?},fingerprint{size,headHash,tailHash}` (SHA-256 of first/last ≤1 MiB), `container`, `video{codec,width,height,rate{num,den},duration:Time(frames),rotation(clockwise°),par,pixFmt,colour{primaries,transfer,matrix,range},vfr,bitDepth}`, `audio{codec,sampleRate,channels,layout,duration:Time(samples)}`, `startTimecode?`, `interpretation?` (overrides; **no UI yet**), `proxy?{path,fingerprint,width,height,enabled}` (**schema only**), `metadata{}`.
**Sequence:** `id,name,rate{num,den},width,height,par,sampleRate,dropFrame,startFrame (timecode offset),videoTracks[],audioTracks[],markers[],inPoint,outPoint`.
**Track:** `id,kind,name,locked,muted,solo,visible,syncLock,targeted,height,clips[]` — clips are sorted, non-overlapping; **gaps are implicit** (no gap items).
**Clip:** `id,name,mediaId,stream('video'|'audio'),start,duration` (sequence frames, half-open) `,sourceIn:{ticks,rate}` (media domain; may be an exact rational domain after splits) `,speed{num,den}` (v1 always 1; model supports signed rationals), `linkGroupId?,enabled,gain?`.
**Marker:** `id,time,duration,name,color,comment`.

**Units are always explicit:** a `Time` carries its rate; sequence positions are frames of the sequence rate; audio is samples. IDs are stable strings; engine-generated IDs are deterministic from the transaction id (`clip_<tx8>_<n>`) so journal replay reproduces them exactly.

## Not in v1 (Planned — fields will be added with a migration)
Transitions, effects, keyframes (parameter identity, local time, interpolation), titles/graphics, captions, nested sequences, multicam definitions, audio channel mapping, colour-management settings, automation metadata. Until then these cannot be created, so nothing can be silently dropped by save.

## Validation (errors block save/load; warnings are shown)
Unique ids across tracks/clips/markers; key==id; references (media, bin, active sequence) exist; no bin cycles; clip start ≥ 0, duration ≥ 1 integers; **no overlap per track**; clip stream matches track kind; speed valid; **source range inside the media stream** (±1 source tick); drop-frame only at 29.97/59.94; in < out; link groups with a single member are warnings. Validation runs on every command result (memoised for unchanged clips).

## Persistence behaviour (`node.ts`, `session.ts`)
* **Atomic save:** write `<file>.tmp-<pid>-<rand>` in the same directory (`wx`) → `fsync` → copy previous to `<file>.bak` → `rename` over target → directory fsync (best effort). Crash points tested: before rename (old file intact, temp cleaned on error / ignored if left by a hard kill).
* **Rotating autosave:** `<file>.autosave/autosave-000123.fstudio`, newest highest, keeps 5, never touches the main file. The headless host autosaves every 60 s when dirty.
* **Recovery journal:** `<file>.journal`, JSON lines each prefixed by its own checksum; header records the **checksum of the saved base**. Every committed command (and undo/redo) is appended + fsynced. On open: load main → `.bak` → newest valid autosave; replay the journal only if its base checksum equals the loaded file's checksum (otherwise reported as `journalSkippedReason`, never replayed onto a wrong base); a torn final line is dropped and reported. A successful save restarts the journal.
* **Missing media:** project opens; media shows `missing` / `changed` (size differs); edits are untouched; relink verifies identity (identical / likely+confirm / mismatch) and then only updates the `MediaRef`.
* **Path resolution order:** project-relative first (survives moving a project with its media), then absolute. Windows-style and POSIX paths are handled by pure functions; real Windows filesystem behaviour (drive letters, UNC, long paths, case) is **unverified**.
* **Windows caveat:** `fs.rename` over an existing file is used; semantic equivalence with `MoveFileEx(REPLACE_EXISTING)` is expected but unverified here.

## Migration policy
Each migration `N→N+1` is a pure function over the raw project object, must preserve unknown fields, is registered in `MIGRATIONS`, and ships with a fixture of the old version and a test. Newer files are refused, never downgraded or rewritten. No real migration exists yet.
