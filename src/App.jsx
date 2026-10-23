import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { captionsAs, mediaCues, parseSubtitles, projectCues, toSrt } from '../core/captions.js';
import {
  addItem, addMedia, addTrack, appendClip, createProject, elementSpan, findElement, frameSize, isVisual, itemSpan, layout,
  mediaKind, moveClipTo, moveItem, newId, removeClip, removeElement, removeItem, removeMedia, removeSubtitles, setSubtitles,
  splitAt, splitItem, totalDuration, updateElement, updateMedia,
} from '../core/project.js';
import { timelineWords } from '../core/transcript.js';
import { api } from './api.js';
import { initialState, reducer } from './state.js';
import { ExportDialog } from './components/ExportDialog.jsx';
import { Inspector } from './components/Inspector.jsx';
import { JobsBar } from './components/JobsBar.jsx';
import { MediaBin } from './components/MediaBin.jsx';
import { Player } from './components/Player.jsx';
import { SettingsDialog } from './components/SettingsDialog.jsx';
import { Timeline } from './components/Timeline.jsx';
import { TopBar } from './components/TopBar.jsx';
import { TranscriptPanel } from './components/TranscriptPanel.jsx';

/** Element fields copied when a clip moves between the main track and a layer. */
const CARRY = ['speed', 'adjust', 'transform', 'crop', 'keyframes', 'anim', 'volume', 'audioFade'];

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [leftTab, setLeftTab] = useState('media');
  const [showSettings, setShowSettings] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const { project, time, jobs } = state;
  const stateRef = useRef(state);
  stateRef.current = state;

  const items = useMemo(() => layout(project), [project]);
  const total = useMemo(() => totalDuration(project), [project]);
  const words = useMemo(() => timelineWords(project), [project]);
  const cues = useMemo(() => projectCues(words, project), [words, project]);
  const cuesRef = useRef(cues);
  cuesRef.current = cues;

  const edit = useCallback((fn, coalesce) => dispatch({ type: 'edit', fn, coalesce }), []);
  const seek = useCallback((t) => {
    const end = totalDuration(stateRef.current.project);
    dispatch({ type: 'time', time: Math.min(Math.max(t, 0), end) });
  }, []);

  // ----- jobs -----
  const startJob = useCallback(async (kind, label, payload, meta = {}) => {
    try {
      const id = await api.startJob(kind, label, payload);
      dispatch({ type: 'job', job: { id, kind, label, status: 'running', progress: 0, ...meta } });
    } catch (err) {
      alert(err.message);
    }
  }, []);

  useEffect(() => api.onJob((job) => {
    dispatch({ type: 'job', job });
    if (job.status !== 'done') return;
    const r = job.result;
    if (job.kind === 'proxy') dispatch({ type: 'patchAll', fn: (p) => updateMedia(p, r.mediaId, { proxyPath: r.proxyPath }) });
    if (job.kind === 'transcribe' || job.kind === 'align') dispatch({ type: 'edit', fn: (p) => updateMedia(p, r.mediaId, { words: r.words }) });
    if (job.kind === 'cutout') {
      dispatch({
        type: 'edit',
        fn: (p) => {
          const src = p.media[r.mediaId];
          if (!src) return p;
          const id = newId('media');
          const kind = mediaKind(src);
          const cut = {
            ...src, id, path: r.path, name: `${src.name} (no background)`, cutoutOf: src.id, proxyPath: null,
            ...(kind === 'video' ? { alpha: true, videoCodec: 'vp9', audioCodec: src.hasAudio ? 'opus' : null } : {}),
          };
          const next = addMedia(p, cut);
          return findElement(next, r.elementId) ? updateElement(next, r.elementId, { mediaId: id }) : next;
        },
      });
    }
  }), []);

  // Read-only hook for debugging and the end-to-end checks (dev/tools/e2e.mjs).
  useEffect(() => {
    window.__vce = { get state() { return stateRef.current; }, get cues() { return cuesRef.current; }, dispatch };
  }, []);

  useEffect(() => api.onProjectLoaded(({ project: p, filePath, time: t }) => dispatch({ type: 'load', project: p, filePath, time: t })), []);

  // ----- commands -----
  const commands = useMemo(() => ({
    newProject() {
      if (stateRef.current.dirty && !confirm('Discard unsaved changes?')) return;
      dispatch({ type: 'load', project: createProject() });
    },
    async open() {
      if (stateRef.current.dirty && !confirm('Discard unsaved changes?')) return;
      try {
        const res = await api.openProject();
        if (res) dispatch({ type: 'load', project: res.project, filePath: res.filePath });
      } catch (err) {
        alert(err.message);
      }
    },
    async save(saveAs = false) {
      const { project: p, filePath } = stateRef.current;
      try {
        const saved = await api.saveProject({ project: p, filePath, saveAs });
        if (saved) dispatch({ type: 'saved', filePath: saved });
      } catch (err) {
        alert(err.message);
      }
    },
    /** Videos go to the main track, images and GIFs to a layer (or the main track while it is empty), audio to an audio track, subtitles to the caption track. */
    async importMedia() {
      let infos;
      try {
        infos = await api.pickMedia();
      } catch (err) {
        alert(err.message);
        return;
      }
      const failed = infos.filter((i) => i.error);
      if (failed.length) alert(failed.map((f) => `${f.path}\n${f.error}`).join('\n\n'));
      for (const info of infos.filter((i) => !i.error)) {
        if (info.kind === 'subtitles') {
          const subs = parseSubtitles(info.text);
          if (!subs.length) alert(`${info.name}: no subtitles found.`);
          else if (!stateRef.current.project.subtitles?.length || confirm(`Replace the ${stateRef.current.project.subtitles.length} imported subtitle lines with ${info.name}?`)) {
            edit((p) => setSubtitles(p, subs));
          }
          continue;
        }
        const id = newId('media');
        const { needsProxy, ...rest } = info;
        const at = stateRef.current.time;
        edit((p) => {
          const next = addMedia(p, { ...rest, id });
          const kind = mediaKind(rest);
          if (kind === 'video' || (isVisual(rest) && !p.clips.length)) return appendClip(next, id);
          return addItem(next, id, kind === 'audio' && !p.clips.length && !totalDuration(p) ? 0 : at);
        });
        if (needsProxy) startJob('proxy', `Preview copy: ${info.name}`, { mediaId: id, info: rest }, { mediaId: id });
      }
    },
    addToTimeline(mediaId) {
      edit((p) => appendClip(p, mediaId));
    },
    addAsLayer(mediaId) {
      edit((p) => addItem(p, mediaId, stateRef.current.time));
    },
    removeMedia(mediaId) {
      edit((p) => removeMedia(p, mediaId));
    },
    transcribe(mediaId) {
      const m = stateRef.current.project.media[mediaId];
      startJob('transcribe', `Transcribe ${m.name}`, { mediaId, path: m.path }, { mediaId });
    },
    async importTranscript(mediaId) {
      const m = stateRef.current.project.media[mediaId];
      if (!m.words?.length) {
        alert('Transcribe the file first: the clean transcript is timed against its words.');
        return;
      }
      const text = await api.pickTranscript();
      if (text) startJob('align', `Align transcript: ${m.name}`, { mediaId, text, words: m.words }, { mediaId });
    },
    exportVideo() {
      if (!totalDuration(stateRef.current.project)) alert('Add something to the timeline first.');
      else setShowExport(true);
    },
    async exportTo() {
      setShowExport(false);
      const { project: p, filePath } = stateRef.current;
      const name = `${baseName(filePath) ?? 'export'}.mp4`;
      const output = await api.pickExportPath({ name });
      if (output) startJob('export', `Export ${output.split(/[\\/]/).pop()}`, { project: p, output });
    },
    /** Timeline captions (after cuts, with overrides and imported subtitles) in a download format. */
    async exportCaptions(format = 'srt') {
      const { project: p, filePath } = stateRef.current;
      const list = cuesRef.current;
      if (!list.length) {
        alert('There are no captions yet: transcribe a clip or import subtitles first.');
        return;
      }
      await api.saveCaptions({ text: captionsAs(format, list, p.captions.style, frameSize(p)), name: `${baseName(filePath) ?? 'captions'}.${format}`, format });
    },
    /** One file's own captions, timed to the file (what its transcription produced). */
    async exportMediaCaptions(mediaId) {
      const p = stateRef.current.project;
      const m = p.media[mediaId];
      const list = mediaCues(p, mediaId);
      if (!list.length) return;
      await api.saveCaptions({ text: toSrt(list, p.captions.style), name: `${m.name.replace(/\.[^.]+$/, '')}.srt`, format: 'srt' });
    },
    splitAtPlayhead() {
      const { project: p, time: t, selectedClipId: id } = stateRef.current;
      const found = findElement(p, id);
      if (found?.kind === 'item') {
        const span = itemSpan(found.el, p.fps || 30);
        if (t > span.start && t < span.end) {
          edit((x) => splitItem(x, id, t));
          return;
        }
      }
      edit((x) => splitAt(x, t));
    },
    deleteSelected() {
      const { selectedClipId: id, selectedCues: keys } = stateRef.current;
      if (id) {
        edit((p) => removeElement(p, id));
        dispatch({ type: 'select', clipId: null });
        return;
      }
      const subs = cuesRef.current.filter((c) => keys.includes(c.key) && c.source === 'srt').map((c) => c.srtId);
      if (subs.length) {
        edit((p) => removeSubtitles(p, subs));
        dispatch({ type: 'selectCues', keys: [] });
      }
    },
    togglePlay() {
      const s = stateRef.current;
      const end = totalDuration(s.project);
      if (!end) return;
      if (!s.playing && s.time >= end - 0.05) dispatch({ type: 'time', time: 0 });
      dispatch({ type: 'play', playing: !s.playing });
    },
    removeBackground(elementId, method, key) {
      const p = stateRef.current.project;
      const found = findElement(p, elementId);
      const m = found && p.media[found.el.mediaId];
      if (!m) return;
      const info = { path: m.path, kind: mediaKind(m), width: m.width, height: m.height, fps: m.fps, duration: m.duration };
      startJob('cutout', `Remove background: ${m.name}`, { mediaId: m.id, elementId, info, method, key }, { mediaId: m.id, elementId });
    },
    restoreBackground(elementId) {
      edit((p) => {
        const found = findElement(p, elementId);
        const m = found && p.media[found.el.mediaId];
        return m?.cutoutOf && p.media[m.cutoutOf] ? updateElement(p, elementId, { mediaId: m.cutoutOf }) : p;
      });
    },
    /** Move a layer item to the next layer in front (+1) or behind (-1); in front of the top layer makes a new one. */
    shiftLayer(itemId, dir) {
      edit((p) => {
        const found = findElement(p, itemId);
        if (found?.kind !== 'item') return p;
        const layers = p.tracks.filter((t) => t.kind === 'layer');
        const target = layers[layers.indexOf(found.track) + dir];
        if (target) return moveItem(p, itemId, { trackId: target.id });
        if (dir < 0) return p;
        const id = newId('track');
        return moveItem(addTrack(p, 'layer', { id }), itemId, { trackId: id });
      });
    },
    /** Lift a main clip onto a layer at the same time (picture-in-picture); the main track closes up. */
    toLayer(clipId) {
      edit((p) => {
        const span = elementSpan(p, clipId);
        const clip = p.clips.find((c) => c.id === clipId);
        if (!span || !clip) return p;
        const id = newId('item');
        const next = addItem(removeClip(p, clipId), clip.mediaId, span.start, { id, in: clip.in, out: clip.out });
        return updateElement(next, id, Object.fromEntries(CARRY.map((k) => [k, clip[k]])));
      });
    },
    /** Put a layer item onto the main track, at the place nearest its time. */
    toMainTrack(itemId) {
      edit((p) => {
        const found = findElement(p, itemId);
        if (found?.kind !== 'item') return p;
        const it = found.el;
        const id = newId('clip');
        let next = appendClip(removeItem(p, itemId), it.mediaId, { id, in: it.in, out: it.out });
        next = updateElement(next, id, Object.fromEntries(CARRY.map((k) => [k, it[k]])));
        const index = layout(next).filter((x) => x.clip.id !== id && x.start + x.duration / 2 < it.start).length;
        return moveClipTo(next, id, index);
      });
      dispatch({ type: 'select', clipId: null });
    },
  }), [edit, startJob]);

  // ----- keyboard -----
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const step = (e.shiftKey ? 1 : 1 / (stateRef.current.project.fps || 30));
      if (e.code === 'Space') commands.togglePlay();
      else if (ctrl && e.key.toLowerCase() === 'z') dispatch({ type: e.shiftKey ? 'redo' : 'undo' });
      else if (ctrl && e.key.toLowerCase() === 'y') dispatch({ type: 'redo' });
      else if (ctrl && e.key.toLowerCase() === 's') commands.save(e.shiftKey);
      else if (!ctrl && e.key.toLowerCase() === 's') commands.splitAtPlayhead();
      else if (e.key === 'Delete' || e.key === 'Backspace') commands.deleteSelected();
      else if (e.key === 'Escape') {
        dispatch({ type: 'crop', id: null });
        dispatch({ type: 'select', clipId: null });
        dispatch({ type: 'selectCues', keys: [] });
      } else if (e.key === 'ArrowLeft') seek(stateRef.current.time - step);
      else if (e.key === 'ArrowRight') seek(stateRef.current.time + step);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commands, seek]);

  return (
    <div className="app">
      <TopBar
        state={state}
        commands={commands}
        onUndo={() => dispatch({ type: 'undo' })}
        onRedo={() => dispatch({ type: 'redo' })}
        onSettings={() => setShowSettings(true)}
      />
      <div className="main">
        <aside className="panel left">
          <div className="tabs">
            <button className={leftTab === 'media' ? 'on' : ''} onClick={() => setLeftTab('media')}>Media</button>
            <button className={leftTab === 'transcript' ? 'on' : ''} onClick={() => setLeftTab('transcript')}>Transcript</button>
          </div>
          {leftTab === 'media'
            ? <MediaBin project={project} jobs={jobs} commands={commands} />
            : <TranscriptPanel project={project} words={words} time={time} edit={edit} onSeek={seek} />}
        </aside>
        <Player state={state} items={items} cues={cues} total={total} dispatch={dispatch} edit={edit} onTogglePlay={commands.togglePlay} />
        <aside className="panel right">
          <Inspector state={state} items={items} cues={cues} edit={edit} dispatch={dispatch} commands={commands} onSeek={seek} />
        </aside>
      </div>
      <Timeline state={state} items={items} cues={cues} total={total} dispatch={dispatch} onSeek={seek} commands={commands} />
      <JobsBar jobs={jobs} dispatch={dispatch} commands={commands} />
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showExport && <ExportDialog project={project} edit={edit} onCancel={() => setShowExport(false)} onExport={commands.exportTo} />}
    </div>
  );
}

function baseName(filePath) {
  return filePath ? filePath.split(/[\\/]/).pop().replace(/\.shotcut$/, '') : null;
}
