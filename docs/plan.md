# ShotCut — Plan

A local, CapCut-style video editor for Windows built from free, open-source parts.
Its edge over other free editors: accurate captions and text-based editing, reusing the Transcript QC pipeline (faster-whisper word timings plus clean-transcript alignment).

## Goals

- Cut a talking-head or screen video into a short, captioned clip without leaving the app.
- Captions that are right the first time: word-level timing, a glossary for names and drug terms, and import of a QC-cleaned transcript.
- Everything runs offline on a normal laptop (CPU only; hardware encoders when present).
- MIT-licensed source, so nothing GPL is linked or copied in.

## Non-goals (for now)

- Multi-track compositing with keyframes, stickers, templates or a cloud asset store.
- Mac and Linux builds (the code stays portable, but only Windows is tested).
- Copying CapCut assets, templates or branding.

## Architecture

```text
┌──────────── Renderer (React, Vite) ─────────────┐
│ Media bin · Player + caption overlay · Inspector │
│ Timeline · Transcript panel · Jobs · Settings    │
│      state = project JSON + undo history        │
└───────────────┬─────────────────────────────────┘
                │ window.api (preload, contextBridge)
┌───────────────┴──────── Main (Electron, ESM) ───┐
│ media:// protocol (range reads, allow-list)     │
│ jobs: probe · proxy · transcribe · align · export│
└──────┬───────────────────────┬──────────────────┘
       │ spawn                 │ spawn
   ffmpeg / ffprobe       python asr/transcribe.py, asr/align.py
                          (faster-whisper; Transcript QC aligner)

core/  pure ESM shared by both sides: project ops, layout, transcript ops,
       caption cues, ASS/SRT writers, FFmpeg filter-graph builder.
```

- **Single source of truth:** the project JSON.
  The preview and the export both derive from `core/` functions, so timing (clip layout, caption cues) is computed once and used everywhere.
- **Captions are derived, not stored:** media files keep their ASR words; caption cues are built from the words that survive the current cuts.
  Trimming, splitting or deleting words never leaves captions out of sync.
- **Text-based editing:** deleting words, fillers or pauses removes those source ranges from every clip of that media.
- **Export:** one FFmpeg run with a filter graph written to a file (`-/filter_complex`, FFmpeg ≥ 7.1), captions burned in through libass (`ass=`), run with `cwd` set to the job folder so Windows paths never need escaping inside the graph.
- **Preview:** HTML `<video>` with a DOM caption overlay styled to match the ASS output.
  Files Chromium cannot play (HEVC, ProRes, MKV) get a 720p H.264 proxy on import; export always reads the original.

## Data Model (project file `*.shotcut`, JSON)

| Field | Meaning |
|:------|:--------|
| `aspect`, `fit`, `fps` | Output frame (16:9, 9:16, 1:1), fit-with-bars or fill-and-crop, frame rate |
| `media{id}` | Path, probe info, optional proxy path, ASR `words[]` (`text`, `start`, `end`, optional `br` cue break) |
| `clips[]` | `mediaId`, source `in`/`out`, `speed`, `adjust` (brightness, contrast, saturation), `transition` into this clip |
| `captions` | On/off, style (font, size, colours, word highlight, position, box, uppercase), cue limits |
| `glossary[]` | `from` → `to` whole-word fixes applied to caption text (e.g. `flora` → `FLAURA`) |

## Reuse From Transcript QC

| Transcript QC file | Becomes | Change |
|:-------------------|:--------|:-------|
| `scripts/run_asr.py` | `asr/transcribe.py` | Takes paths and options as arguments, prints JSON-line progress, same `words.json` format |
| `scripts/make_exact_srt.py` | `asr/make_exact_srt.py` (copied unchanged) + `asr/align.py` | `align.py` imports its aligner and returns words with cue breaks instead of an `.srt` |
| QC rules (terminology, 30–55 character lines) | Glossary + cue builder limits | Glossary is user-editable per project |
| Local model `hf_cache/faster-whisper-small` | Default model when found | Offline flags set, per lesson L-python-007 |

## Open-Source Building Blocks

| Need | Library | Licence |
|:-----|:--------|:--------|
| Desktop shell | Electron | MIT |
| UI | React, Vite | MIT |
| Decode, effects, transitions, encode | FFmpeg (`xfade`, `acrossfade`, `eq`, `lut3d`, `ass`) | LGPL build to ship; the dev machine's GPL "full" build is fine for local use |
| Speech to text | faster-whisper (CTranslate2) | MIT |
| WebGL transitions for preview (M2) | gl-transitions | MIT |
| Background removal (M3) | MediaPipe selfie segmentation | Apache-2.0 |

VLC is not used: it is a player, not an editing engine, and is GPL.

## Milestones

### M0 — Scaffold (this session)

- [x] Plan.
- [x] Electron + Vite + React shell, secure preload, `media://` protocol with range support.
- [x] `core/`: project ops, layout, locate, transcript ops, cue builder, ASS/SRT, export graph, probe parsing.
- [x] Python sidecar: transcribe + align, reusing Transcript QC code.
- [x] UI: media bin, player with caption overlay, timeline, inspector, transcript panel, jobs, settings.
- [x] Tests: unit tests for `core/`, FFmpeg export integration test, ASR test on a generated speech sample.
- [x] Smoke screenshot of the real window; real transcription + export of a sample clip.

Not exercised by automation yet: the native file dialogs (import, open, save, export) and the Settings dialog.

### M1 — Usable MVP

- [x] Drag to reorder and drag-trim clip edges on the timeline (live preview, snaps to the playhead, one undo step). (0.2.0)
- [x] Gap-free playback across clips: two alternating `<video>` elements with a muted 0.3 s pre-roll. (0.2.0)
- [x] Caption style presets (Classic, Bold pop, Karaoke fill, Boxed, Subtitle, Neon) with pop and karaoke-fill effects. (0.2.0)
- [x] Export presets (YouTube 1080p/4K, Shorts/Reels/TikTok, square, small file), resolution and quality, hardware encoder auto-pick. (0.2.0)
- [ ] Thumbnails strip on timeline clips.
- [ ] Font picker with bundled open fonts (OFL); today the list uses fonts installed with Windows.
- [ ] LUT import (`.cube`), more transitions in the picker, background music track with ducking (`sidechaincompress`).
- [ ] Portable build (electron-builder or a zip of `electron-packager` output) with an LGPL FFmpeg and a bundled Python + model.

Gap-free playback, measured by `npm run e2e` on the sample (presented-frame gap at the boundary): one video with a seek, 50–67 ms; two videos without pre-roll, 17–100 ms (starting a paused element costs a decoder and audio start-up); two videos with pre-roll, 0–17 ms.

### M2 — Closer to CapCut

- Overlay track: text titles, images, picture-in-picture, with keyframed position and scale.
- WebGL preview of transitions and colour (gl-transitions) so preview matches export.
- Text animations (fade/slide/pop per word) in both preview and ASS.

### M3 — Smart features

- Background removal, auto-reframe to 9:16 (face tracking), noise reduction toggle (`arnndn`), loudness normalisation (`loudnorm`).
- Translate captions (bilingual subtitles) using the Transcript QC translation workflow.

## Risks

| Risk | Mitigation |
|:-----|:-----------|
| Preview and export look different (CSS filters vs `eq`, DOM vs libass text) | One style model drives both; M2 moves preview to WebGL; export is the reference |
| Frame-rate drift between layout and FFmpeg | Clip durations are rounded to whole frames in `layout()`, which both sides use |
| Long filter graphs exceed the Windows command-line limit | Graph written to a file (`-/filter_complex`) |
| Python setup on other PCs | Settings dialog checks tools; M1 bundles an embedded Python with faster-whisper |
| Whisper model download stalls | Use a local model path and `HF_HUB_OFFLINE=1` when a path is given |

## Testing

- `npm test` runs `node --test` over `dev/tests/` (core unit tests, FFmpeg integration, ASR when Python and the model are available).
- `npm run smoke` launches the real Electron window with a sample project and saves a screenshot.
