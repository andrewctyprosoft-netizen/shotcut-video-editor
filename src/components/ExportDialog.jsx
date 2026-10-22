import { useEffect, useState } from 'react';
import { ENCODER_NAMES } from '../../core/exportPlan.js';
import { EXPORT_PRESETS, applyExportPreset, matchingExportPreset } from '../../core/presets.js';
import { ASPECTS, QUALITIES, RESOLUTIONS, frameSize, totalDuration } from '../../core/project.js';
import { formatClock } from '../../core/time.js';
import { api } from '../api.js';

const QUALITY_LABELS = { high: 'High', standard: 'Standard', small: 'Small file' };
const RES_LABELS = { 720: '720p', 1080: '1080p', 1440: '1440p (2K)', 2160: '2160p (4K)' };

/** Pick an export target (preset or custom), then choose where to save. Settings are part of the project (undoable). */
export function ExportDialog({ project, edit, onCancel, onExport }) {
  const [encoder, setEncoder] = useState(null);
  useEffect(() => {
    api.exportEncoder().then(setEncoder, () => setEncoder('libx264'));
  }, []);

  const set = (patch) => edit((p) => ({ ...p, ...patch }));
  const setExport = (patch) => edit((p) => ({ ...p, export: { ...p.export, ...patch } }));
  const active = matchingExportPreset(project);
  const [W, H] = frameSize(project);
  const quality = project.export?.quality ?? 'high';

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal export-dialog">
        <h2>Export video</h2>
        <div className="export-presets">
          {EXPORT_PRESETS.map((p) => (
            <button key={p.id} className={`export-preset${active === p.id ? ' on' : ''}`} onClick={() => edit((x) => applyExportPreset(x, p.id))}>
              <span className={`frame-icon a${(p.aspect ?? project.aspect).replace(':', 'x')}`} />
              <span className="export-preset-name">{p.name}</span>
              <span className="hint">{p.hint}</span>
            </button>
          ))}
        </div>
        <h4>Custom</h4>
        <div className="export-grid">
          <label className="field">
            <span>Frame</span>
            <div className="seg">
              {Object.keys(ASPECTS).map((a) => (
                <button key={a} className={project.aspect === a ? 'on' : ''} onClick={() => set({ aspect: a })}>{a}</button>
              ))}
            </div>
          </label>
          <label className="field">
            <span>Resolution</span>
            <select value={project.export?.resolution ?? 1080} onChange={(e) => setExport({ resolution: Number(e.target.value) })}>
              {RESOLUTIONS.map((r) => <option key={r} value={r}>{RES_LABELS[r]}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Frame rate</span>
            <select value={project.fps} onChange={(e) => set({ fps: Number(e.target.value) })}>
              {[24, 25, 30, 50, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}
            </select>
          </label>
          <label className="field">
            <span>Quality</span>
            <select value={quality} onChange={(e) => setExport({ quality: e.target.value })}>
              {QUALITIES.map((q) => <option key={q} value={q}>{QUALITY_LABELS[q]}</option>)}
            </select>
          </label>
        </div>
        <p className="export-summary">
          {W} × {H} · {project.fps} fps · {QUALITY_LABELS[quality]} · {formatClock(totalDuration(project))}
          {' · '}
          {encoder ? ENCODER_NAMES[encoder] ?? encoder : 'checking encoder…'}
          {project.captions.enabled ? ' · captions burned in' : ''}
        </p>
        <p className="hint">Changing the frame also changes the preview. The encoder is chosen in Settings (Auto picks a working hardware encoder).</p>
        <div className="row-buttons end">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onExport}>Export…</button>
        </div>
      </div>
    </div>
  );
}
