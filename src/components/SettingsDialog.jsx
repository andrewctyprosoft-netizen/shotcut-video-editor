import { useEffect, useState } from 'react';
import { api } from '../api.js';

const ENCODERS = [
  ['auto', 'Auto (hardware if it works, else software)'],
  ['libx264', 'H.264 software (works everywhere)'],
  ['h264_qsv', 'Intel Quick Sync'],
  ['h264_nvenc', 'NVIDIA NVENC'],
  ['h264_amf', 'AMD AMF'],
];

/** Tool paths and preferences, with a live check of FFmpeg, Python + faster-whisper and the model. */
export function SettingsDialog({ onClose }) {
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    try {
      setStatus(await api.toolStatus());
    } catch (err) {
      setStatus({ error: err.message });
    }
    setChecking(false);
  };

  useEffect(() => {
    api.getSettings().then(setSettings);
    check();
  }, []);

  if (!settings) return null;
  const set = (k) => (e) => setSettings({ ...settings, [k]: e.target.value });
  const save = async () => {
    setSettings(await api.setSettings(settings));
    await check();
  };

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>Settings</h2>
        <label className="field">
          <span>FFmpeg (empty = bundled, then PATH)</span>
          <input value={settings.ffmpeg} onChange={set('ffmpeg')} placeholder="C:\ffmpeg\bin\ffmpeg.exe" />
        </label>
        <label className="field">
          <span>Python command (empty = auto: py -3.11, py -3, python)</span>
          <input value={settings.python} onChange={set('python')} placeholder="py -3.11" />
        </label>
        <label className="field">
          <span>Whisper model: folder or name (empty = local Transcript QC model, else "small")</span>
          <input value={settings.model} onChange={set('model')} placeholder="E:\models\faster-whisper-small" />
        </label>
        <div className="row2">
          <label className="field">
            <span>Language (empty = detect)</span>
            <input value={settings.language} onChange={set('language')} placeholder="en" />
          </label>
          <label className="field">
            <span>Export encoder</span>
            <select value={settings.encoder} onChange={set('encoder')}>
              {ENCODERS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </label>
        </div>
        <h4>Tool check {checking && <em>checking…</em>}</h4>
        {status?.error && <p className="bad">{status.error}</p>}
        {status && !status.error && (
          <ul className="status">
            <li className={status.ffmpeg.version ? 'ok' : 'bad'}>FFmpeg: {status.ffmpeg.version ?? `not found (${status.ffmpeg.path})`}</li>
            <li className={status.ffprobe.version ? 'ok' : 'bad'}>FFprobe: {status.ffprobe.version ?? `not found (${status.ffprobe.path})`}</li>
            <li className={status.python.ok ? 'ok' : 'bad'}>
              Python ({status.python.command}): {status.python.ok ? `faster-whisper ${status.python.version}` : status.python.error}
            </li>
            <li className="ok">
              Encoder: {status.encoders.chosen}
              {status.encoders.hardware.length ? ` (working hardware: ${status.encoders.hardware.join(', ')})` : ' (no working hardware encoder)'}
            </li>
            <li className={status.model.local ? 'ok' : 'warn'}>
              Model: {status.model.value} {status.model.local ? '(local, offline)' : '(downloads on first use)'}
            </li>
          </ul>
        )}
        <div className="row-buttons end">
          <button onClick={onClose}>Close</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
