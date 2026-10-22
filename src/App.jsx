import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { projectCues, toSrt } from '../core/captions.js';
import {
  addMedia, appendClip, createProject, layout, newId, removeClip, removeMedia, splitAt, updateMedia,
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

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [leftTab, setLeftTab] = useState('media');
  const [showSettings, setShowSettings] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const { project, time, playing, selectedClipId, jobs } = state;
  const stateRef = useRef(state);
  stateRef.current = state;

  const items = useMemo(() => layout(project), [project]);
  const total = items.length ? items[items.length - 1].end : 0;
  const words = useMemo(() => timelineWords(project), [project]);
  const cues = useMemo(() => projectCues(words, project), [words, project]);

  const edit = useCallback((fn, coalesce) => dispatch({ type: 'edit', fn, coalesce }), []);
  const seek = useCallback((t) => {
    const end = layout(stateRef.current.project).at(-1)?.end ?? 0;
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
  }), []);

  // Read-only hook for debugging and the end-to-end checks (dev/tools/e2e.mjs).
  useEffect(() => {
    window.__vce = { get state() { return stateRef.current; }, dispatch };
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
        const id = newId('media');
        const { needsProxy, ...rest } = info;
        edit((p) => appendClip(addMedia(p, { ...rest, id }), id));
        if (needsProxy) startJob('proxy', `Preview copy: ${info.name}`, { mediaId: id, info: rest }, { mediaId: id });
      }
    },
    addToTimeline(mediaId) {
      edit((p) => appendClip(p, mediaId));
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
      if (!stateRef.current.project.clips.length) alert('Add a clip to the timeline first.');
      else setShowExport(true);
    },
    async exportTo() {
      setShowExport(false);
      const { project: p, filePath } = stateRef.current;
      const name = `${(filePath?.split(/[\\/]/).pop() ?? 'export').replace(/\.shotcut$/, '')}.mp4`;
      const output = await api.pickExportPath({ name });
      if (output) startJob('export', `Export ${output.split(/[\\/]/).pop()}`, { project: p, output });
    },
    async exportSrt() {
      const text = toSrt(cues, stateRef.current.project.captions.style);
      if (!cues.length) alert('There are no captions yet: transcribe a clip first.');
      else await api.saveSrt({ text, name: 'captions.srt' });
    },
    splitAtPlayhead() {
      edit((p) => splitAt(p, stateRef.current.time));
    },
    deleteSelected() {
      const id = stateRef.current.selectedClipId;
      if (id) edit((p) => removeClip(p, id));
    },
    togglePlay() {
      const s = stateRef.current;
      if (!s.project.clips.length) return;
      const end = layout(s.project).at(-1).end;
      if (!s.playing && s.time >= end - 0.05) dispatch({ type: 'time', time: 0 });
      dispatch({ type: 'play', playing: !s.playing });
    },
  }), [edit, startJob, cues]);

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
      else if (e.key === 'ArrowLeft') seek(stateRef.current.time - step);
      else if (e.key === 'ArrowRight') seek(stateRef.current.time + step);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commands, seek]);

  const selectedClip = project.clips.find((c) => c.id === selectedClipId) ?? null;

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
        <Player
          project={project}
          items={items}
          cues={cues}
          time={time}
          total={total}
          playing={playing}
          dispatch={dispatch}
          onTogglePlay={commands.togglePlay}
        />
        <aside className="panel right">
          <Inspector project={project} clip={selectedClip} time={time} edit={edit} commands={commands} />
        </aside>
      </div>
      <Timeline
        project={project}
        items={items}
        cues={cues}
        total={total}
        time={time}
        selectedClipId={selectedClipId}
        dispatch={dispatch}
        onSeek={seek}
        commands={commands}
      />
      <JobsBar jobs={jobs} dispatch={dispatch} />
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showExport && <ExportDialog project={project} edit={edit} onCancel={() => setShowExport(false)} onExport={commands.exportTo} />}
    </div>
  );
}
