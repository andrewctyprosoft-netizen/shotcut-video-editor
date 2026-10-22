# Changelog

## 0.2.0 — 2026-10-22

- Timeline: drag a clip's edge to trim (live preview, snaps to the playhead and clip starts, playhead follows the edge); drag a clip to reorder (drop marker); each drag is one undo step.
- Gap-free preview: two video players take turns and the next clip pre-rolls muted 0.3 s before the boundary (presented-frame gap at a cut 0–17 ms, was 50–67 ms).
- Caption presets: Classic, Bold pop, Karaoke, Boxed, Subtitle, Neon. New effects: karaoke fill (spoken words stay highlighted) and pop (the spoken word grows), in preview and export.
- Export dialog with presets (YouTube 1080p/4K, Shorts · Reels · TikTok, Instagram square, Small file), resolution 720p–4K, quality levels; encoder Auto picks the first hardware encoder that really encodes (FFmpeg lists NVENC/AMF even without the GPU).
- Fix: export failed when a cut was followed by a transition (`concat` timebase 1/1000000 vs `xfade` 1/fps).
- Fix: tool errors now lead with the telling FFmpeg lines instead of the generic tail.
- Opens a `.shotcut` passed on the command line. New `npm run e2e` (18 checks in the real window).

## 0.1.0 — 2026-10-22

- First scaffold (milestone M0): Electron 45 + Vite 8 + React 19 app with a media bin, preview with caption overlay, timeline, inspector, transcript panel, background jobs and settings.
- Auto captions with faster-whisper word timings and the Transcript QC aligner for clean transcripts; glossary fixes; spoken-word highlight.
- Text-based editing: cut selected words, remove fillers, remove pauses.
- Export to MP4 with FFmpeg: fit/fill to 16:9, 9:16 or 1:1, speed, colour, 14 `xfade` transitions, captions burned in with libass; `.srt` export.
- Tests: 30 unit tests for `core/`, a real FFmpeg export test and a real ASR + alignment test; Electron smoke test with screenshot.
