# Changelog

## Unreleased

- Fix: zoomed out, captions and short clips were drawn wider than their time (padding made every block at least 14 px, about 50 s on a 70-minute timeline), so the caption track looked longer than the audio. Narrow blocks now drop their padding.
- Fix: audio stuttered or repeated when the timeline had no video under the playhead (audio on an audio track, with images): pressing play jumped the timeline ahead by the time it had sat paused (or since the last seek), and the audio was cut to catch up. Play now starts at the playhead.
- Audio and video layers now follow the timeline by easing their speed (up to 6%, pitch kept) instead of seeking at every 0.25 s of drift; they seek only when more than 0.75 s off, at most once per 1.5 s, and the timeline waits (up to 5 s) for them to start or buffer. Paused audio is no longer pulled back a few hundredths, which replayed them on resume.
- Images and GIFs can be stretched to any length (the limit was one hour).
- Fix: Ctrl/Shift+click on a clip, image or audio item dropped the captions picked with a box select, and Ctrl/Shift+click on a caption dropped the picked clips; now both kinds stay. Ctrl/Shift+click on a clip's trim edge (most of a short clip when zoomed out) replaced the selection; it now adds or removes the clip too.
- Box select: drag on empty timeline space (or across auto captions) to draw a box; every clip, layer item and caption it touches, on any track, is selected live, and the view scrolls at the edges. Ctrl/Shift+drag adds to the selection; a click on empty space still clears it and seeks. Delete removes the selected clips, items and imported subtitle lines in one undo step.
- Crop window: **Crop** in the timeline toolbar (next to Split) crops the selected layers, one or several (Ctrl/Shift+click on the timeline or in the preview); ratio presets keep their shape while dragging; other layers are untouched. Replaces the crop mode in the preview.
- Multi-select: Ctrl/Shift+click adds clips and items; the preview outlines every selected layer; Delete removes them all.
- Import any time: **+ Import** stays at the top of the Media panel, and files dropped from Explorer on the window are imported. Into an empty timeline files are placed as before; later imports wait in Media until added (+ Main / + Layer / + Audio) or dragged onto a track.
- Drag a file from Media onto the main track, a layer, an audio track, or the caption row (new layer) to place it at that time.
- The timeline fits itself when added media makes it longer; editor keys are off while a dialog is open.
- Timeline zoom: Ctrl + mouse wheel or touchpad pinch zooms at the pointer, − / + buttons and keys (1.5× steps), Fit (0) shows the whole timeline; range 0.02–400 px/s on a log slider (a 70-minute recording fits a laptop screen; it stopped at about 16 minutes); one screen of room after the end.
- Opening a project fits the timeline to the window.
- Ruler labels are drawn only around the visible part, so a zoomed-in long timeline stays light.
- Fix: a preview drag that stalled for over a second became several undo steps.
- Fix: a zoomed-in timeline widened the window instead of scrolling (app grid column could grow with its content).
- The time ruler stays visible when the tracks scroll.

## 0.3.0 — 2026-10-23

- Layers: layer tracks over the main track and audio tracks under it; stacking order, hide, mute, reorder, delete; drag items in time and between layers (above the top layer = a new layer; emptied layers are removed); Bring forward / Send backward; lift a main clip to a layer and back.
- Import images (PNG, JPG, WebP, BMP), GIF and APNG (loop, any length), audio to an audio track, and SRT/VTT subtitles to the caption track.
- Preview: click to select, drag to move with centre snap, corner resize, crop box with eight handles (also typed values and ratio presets); canvas ratio picker with 4:5 and 4:3.
- Keyframes for position, size and opacity with curves (linear, ease in/out/in-out, hold); in/out effects (fade, slides, zoom, pop).
- Transitions now show in the preview (CSS look-alikes of the 14 `xfade` types); both clips play through the overlap with an audio cross-fade.
- Audio: volume from mute to +20 dB (Web Audio above 0 dB in the preview), fade in/out, per-track mute; mixed in the export.
- Background removal: AI (rembg's U²-Net family ONNX models, offline, downloaded once) or colour key; transparent PNG/APNG/VP9 copies; restore original.
- Captions: drag the caption box in the preview (move, width, text size); All captions or only the selected ones (Ctrl+click); per-caption timing by dragging edges; caption fade in/out and pop; download as SRT, WebVTT, ASS or text, per file or for the timeline.
- Export: layers with per-frame expressions in `t` for keyframes and effects (deterministic; `sendcmd` was tried and placed moving overlays a few frames off in 2 of 20 runs), stills, GIFs, alpha WebM, `amix` of all audio, one ASS style per caption look.
- Fix: a job that finishes at once (cached result) no longer loses its target clip or sticks as running.
- Fix: renaming finished files falls back to copy + delete on EXDEV.
- `ShotCut.bat`: double-click launcher (first-run install, interface rebuild, opens a dropped `.shotcut`); `.gitattributes` keeps it CRLF.
- Tests: 74 (unit, real FFmpeg exports, background removal with a stand-in model, ASR); `npm run e2e` runs 18 + 28 checks in the real window. 0.2 projects open unchanged.

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
