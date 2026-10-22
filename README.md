# ShotCut

A local, CapCut-style video editor for Windows with accurate auto captions and text-based editing.
It runs offline: Electron for the window, FFmpeg for effects and export, and faster-whisper for speech to text.
The caption pipeline is reused from Transcript QC (`05_Review_QC/Transcript QC`).

Status: **0.2.0** (milestone M1 of [docs/plan.md](docs/plan.md), first half). It runs from source; there is no installer yet.

![ShotCut window with captions, transcript and timeline](docs/screenshot.png)

## What It Does

| Feature | How |
|:--------|:----|
| Import video and audio | MP4, MOV, MKV, WebM, AVI, MP3, WAV and more; files the preview can't play (HEVC, MKV, ProRes) get a 720p preview copy automatically |
| Timeline | Clips back to back; drag a clip's edge to trim (snaps to the playhead), drag a clip to reorder, split at the playhead, delete, speed 0.5×–2×, undo/redo |
| Preview | Gap-free across cuts and file changes: two video players take turns, the next clip pre-rolls muted |
| Auto captions | Transcribe with faster-whisper (word timings), then captions are built from the words that survive your cuts |
| Spoken-word highlight | The current word changes colour, or every word spoken so far (karaoke fill); optional pop (the spoken word grows); same in preview and export |
| Caption presets | Classic, Bold pop, Karaoke, Boxed, Subtitle, Neon; one click, then fine-tune |
| Caption style | Font, size, position, colours, outline or background box, bold, UPPERCASE, characters per caption |
| Glossary | `wrong => right` fixes for names and terms (e.g. `flora 2 => FLAURA2`), applied to every caption |
| Clean transcript import | Time a QC-cleaned transcript (one caption per line) against the audio with the Transcript QC aligner |
| Text-based editing | Click a word to jump there; Shift+click to select; **Cut** removes those words from the video; **Remove fillers** (um, uh, …); **Remove pauses** over N seconds |
| Colour | Brightness, contrast, saturation per clip |
| Transitions | 14 FFmpeg `xfade` transitions (fade, dip to black/white, wipes, slides, circle, pixelize, zoom…) |
| Export presets | YouTube 1080p, YouTube 4K, Shorts · Reels · TikTok (9:16), Instagram square, Small file; or custom frame, 720p–4K, 24–60 fps, quality High / Standard / Small |
| Output | Fit with bars or fill and crop; MP4 (H.264/AAC) with captions burned in; captions also as `.srt` |
| Encoders | Auto (first hardware encoder that really works: NVIDIA NVENC, Intel Quick Sync, AMD AMF; else x264), or pick one in Settings |

Not yet: transitions in the preview (they render in the export), thumbnails on clips, music, LUTs, overlay tracks, stickers.
See the milestones in [docs/plan.md](docs/plan.md).

## Requirements

- Windows 10/11, Node.js 20+ (tested on 24).
- FFmpeg 7.1 or newer on PATH (tested on 8.1), or set its path in Settings.
- Python 3.10+ with faster-whisper: `pip install -r asr/requirements.txt`.
- A Whisper model. The app finds the workspace's offline copy (`hf_cache/faster-whisper-small`) automatically; otherwise set a model folder in Settings, or leave `small` to download it once.

## Run

```bash
npm install
```

```bash
npm start
```

`npm start` builds the interface and opens the app.
For development with hot reload, use `npm run dev`.

## Use

1. **Import media** (top bar). Each file is added to the end of the timeline.
2. In **Media**, press **Transcribe**. Captions appear when it finishes.
3. Optional: **Clean transcript…** to replace the ASR text with a QC-cleaned transcript, timed to the audio.
4. Edit: **Transcript** tab to cut words, fillers and pauses; the timeline to split (S) and delete (Del); the **Clip** tab for trim, speed, colour and transitions.
5. Style captions in the **Captions** tab; add glossary fixes.
6. **Export** an MP4, or **Save captions as .srt**. Projects save as `.shotcut` (JSON; media is referenced, not copied).

Keys: Space play/pause · S split · Del delete clip · ←/→ one frame · Shift+←/→ one second · Ctrl+Z / Ctrl+Y · Ctrl+S.

## Files

| Path | What |
|:-----|:-----|
| `electron/main.js` | Window, dialogs, background jobs (preview copy, transcribe, align, export) |
| `electron/preload.cjs` | The `window.api` bridge (sandboxed, CommonJS) |
| `electron/mediaProtocol.js` | `media://` protocol: serves only allowed local files, with range requests for seeking |
| `electron/export.js`, `media.js`, `asr.js`, `tools.js`, `proc.js` | FFmpeg export, probe and proxies, the Python sidecar, settings and tool lookup, process runner (no Electron imports, so tests use them) |
| `core/` | Pure logic shared by preview, export and tests: project ops and layout, transcript ops, caption cues and ASS/SRT, FFmpeg graph, probe parsing |
| `src/` | React interface (Vite); `src/playback.js` is the two-video preview engine |
| `asr/transcribe.py` | faster-whisper word timings (from Transcript QC `run_asr.py`) |
| `asr/make_exact_srt.py` | Transcript QC aligner, copied unchanged |
| `asr/align.py` | Wraps the aligner to return timed words with caption breaks |
| `dev/` | Tests, sample maker, smoke and end-to-end checks, dev server launcher |
| `docs/plan.md` | Architecture, milestones, risks |

## Tests

```bash
npm run samples
```

```bash
npm test
```

- `npm run samples` makes `dev/samples/` (a Windows-voice speech clip, a talking test-pattern video, colour bars).
- `npm test` runs the `core/` unit tests, a real FFmpeg export (duration, frame size, caption pixels on screen), and a real transcription + alignment of the speech sample (skipped when Python, the model or the samples are missing).
- `npm run smoke` opens the real window on a sample project and saves `dev/out/smoke.png`. Options: `VCE_SMOKE_CLICK="Transcript,Captions"` clicks buttons first; `npm run smoke -- 3.0` seeks to 3 s.
- `npm run e2e` drives the real window over the DevTools protocol with real mouse input: drag-trim, drag-reorder, undo, text cut, gap-free playback (measures presented frames at a cut and at a file change, against a one-video baseline), caption and export presets, and the Settings tool check. Screenshots go to `dev/out/e2e-*.png`.

## How Export Works

One FFmpeg run: each clip is read with `-ss/-t`, scaled to the output frame, colour-adjusted (`eq`) and trimmed to whole frames.
Clips are joined with `xfade` + `acrossfade` (transitions) or `concat` (cuts), then captions are burned in with libass (`ass=captions.ass`).
The graph is written to `graph.txt` and passed with `-/filter_complex`, and FFmpeg runs inside the job folder, so long timelines never hit the Windows command-line limit and file paths never need escaping inside the graph.

## Limits

- `electron . project.shotcut` opens a project from the command line.
- Preview colour uses CSS filters, an approximation of FFmpeg's `eq`; the export is the reference.
- Burned-in fonts must be installed on the PC (the list uses Windows fonts).
- For distribution, bundle an LGPL FFmpeg build; the "full" builds are GPL.

## Licence

MIT, see [LICENSE](LICENSE). FFmpeg, Electron, React and faster-whisper keep their own licences.
