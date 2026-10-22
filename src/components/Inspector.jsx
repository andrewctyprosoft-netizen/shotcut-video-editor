import { useState } from 'react';
import { ASPECTS, MIN_CLIP, SPEEDS, TRANSITIONS, frameSize, updateClip } from '../../core/project.js';
import { formatGlossary, parseGlossary } from '../../core/transcript.js';
import { formatClock } from '../../core/time.js';
import { CAPTION_PRESETS, applyCaptionPreset, captionPreset, matchingCaptionPreset } from '../../core/presets.js';
import { CaptionLine } from './CaptionOverlay.jsx';

const FONTS = ['Arial', 'Segoe UI', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Impact', 'Calibri'];
const SAMPLE = [{ text: 'Your' }, { text: 'words' }, { text: 'here' }];

/** Right panel: selected clip, caption style and project settings. */
export function Inspector({ project, clip, edit, commands }) {
  const [tab, setTab] = useState('clip');
  return (
    <>
      <div className="tabs">
        {[['clip', 'Clip'], ['captions', 'Captions'], ['project', 'Project']].map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      <div className="inspector">
        {tab === 'clip' && <ClipTab project={project} clip={clip} edit={edit} commands={commands} />}
        {tab === 'captions' && <CaptionsTab project={project} edit={edit} commands={commands} />}
        {tab === 'project' && <ProjectTab project={project} edit={edit} />}
      </div>
    </>
  );
}

function ClipTab({ project, clip, edit, commands }) {
  if (!clip) return <p className="hint">Select a clip on the timeline to trim it, change speed, colour or its transition.</p>;
  const m = project.media[clip.mediaId];
  const set = (patch, key) => edit((p) => updateClip(p, clip.id, patch), key && `${clip.id}:${key}`);
  const first = project.clips[0]?.id === clip.id;
  const adj = (k, v) => set({ adjust: { ...clip.adjust, [k]: v } }, k);
  return (
    <>
      <h3 title={m?.path}>{m?.name}</h3>
      <div className="row2">
        <Field label="In (s)">
          <input type="number" step={0.1} min={0} value={round(clip.in)} onChange={(e) => set({ in: Number(e.target.value) }, 'in')} />
        </Field>
        <Field label="Out (s)">
          <input type="number" step={0.1} min={clip.in + MIN_CLIP} value={round(clip.out)} onChange={(e) => set({ out: Number(e.target.value) }, 'out')} />
        </Field>
      </div>
      <p className="hint">Source {formatClock(clip.in)} – {formatClock(clip.out)} of {formatClock(m?.duration ?? 0)}</p>
      <Field label="Speed">
        <select value={clip.speed} onChange={(e) => set({ speed: Number(e.target.value) })}>
          {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>
      </Field>
      <h4>Colour</h4>
      <Slider label="Brightness" min={-0.3} max={0.3} step={0.01} value={clip.adjust.brightness} onChange={(v) => adj('brightness', v)} />
      <Slider label="Contrast" min={0.5} max={1.5} step={0.01} value={clip.adjust.contrast} onChange={(v) => adj('contrast', v)} />
      <Slider label="Saturation" min={0} max={2} step={0.01} value={clip.adjust.saturation} onChange={(v) => adj('saturation', v)} />
      <h4>Transition in</h4>
      {first ? (
        <p className="hint">The first clip has no incoming transition.</p>
      ) : (
        <>
          <Field label="Type">
            <select
              value={clip.transition?.type ?? ''}
              onChange={(e) => set({ transition: e.target.value ? { type: e.target.value, duration: clip.transition?.duration ?? 0.5 } : null })}
            >
              <option value="">None (cut)</option>
              {TRANSITIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </Field>
          {clip.transition && (
            <Slider
              label="Duration (s)"
              min={0.1}
              max={2}
              step={0.05}
              value={clip.transition.duration}
              onChange={(v) => set({ transition: { ...clip.transition, duration: v } }, 'tdur')}
            />
          )}
          <p className="hint">Transitions render in the export; the preview cuts.</p>
        </>
      )}
      <div className="row-buttons">
        <button onClick={commands.splitAtPlayhead}>Split at playhead</button>
        <button className="danger" onClick={commands.deleteSelected}>Delete clip</button>
      </div>
    </>
  );
}

function CaptionsTab({ project, edit, commands }) {
  const c = project.captions;
  const s = c.style;
  const setCaps = (patch, key) => edit((p) => ({ ...p, captions: { ...p.captions, ...patch } }), key && `cap:${key}`);
  const setStyle = (patch, key) => edit((p) => ({ ...p, captions: { ...p.captions, style: { ...p.captions.style, ...patch } } }), key && `style:${key}`);
  const [glossary, setGlossary] = useState(formatGlossary(project.glossary));
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={c.enabled} onChange={(e) => setCaps({ enabled: e.target.checked })} /> Show captions
      </label>
      <h4>Presets</h4>
      <div className="presets">
        {CAPTION_PRESETS.map((pr) => (
          <button
            key={pr.id}
            className={`preset${matchingCaptionPreset(c) === pr.id ? ' on' : ''}`}
            onClick={() => edit((p) => applyCaptionPreset(p, pr.id))}
            title={`${pr.name}: up to ${pr.maxChars} characters per caption`}
          >
            <span className="preset-sample">
              <CaptionLine words={SAMPLE} active={1} style={captionPreset(pr.id).style} frameHeight={150} />
            </span>
            <span className="preset-name">{pr.name}</span>
          </button>
        ))}
      </div>
      <Slider label="Max characters per caption" min={12} max={60} step={1} value={c.maxChars} onChange={(v) => setCaps({ maxChars: v }, 'maxChars')} />
      <h4>Style</h4>
      <Field label="Font">
        <select value={s.font} onChange={(e) => setStyle({ font: e.target.value })}>
          {FONTS.map((f) => <option key={f}>{f}</option>)}
        </select>
      </Field>
      <Slider label="Size" min={0.03} max={0.12} step={0.002} value={s.size} onChange={(v) => setStyle({ size: v }, 'size')} />
      <Slider label="Position" min={0.15} max={0.97} step={0.01} value={s.position} onChange={(v) => setStyle({ position: v }, 'position')} />
      <div className="row2">
        <Field label="Text"><input type="color" value={s.color} onChange={(e) => setStyle({ color: e.target.value }, 'color')} /></Field>
        <Field label="Spoken word"><input type="color" value={s.highlight} onChange={(e) => setStyle({ highlight: e.target.value }, 'highlight')} /></Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={s.wordHighlight} onChange={(e) => setStyle({ wordHighlight: e.target.checked })} /> Highlight the spoken word
      </label>
      {s.wordHighlight && (
        <>
          <div className="seg">
            <button className={s.highlightMode !== 'progressive' ? 'on' : ''} onClick={() => setStyle({ highlightMode: 'word' })}>Spoken word</button>
            <button className={s.highlightMode === 'progressive' ? 'on' : ''} onClick={() => setStyle({ highlightMode: 'progressive' })}>Karaoke fill</button>
          </div>
          <label className="check">
            <input type="checkbox" checked={Boolean(s.pop)} onChange={(e) => setStyle({ pop: e.target.checked })} /> Pop (enlarge the spoken word)
          </label>
        </>
      )}
      <label className="check">
        <input type="checkbox" checked={s.bold} onChange={(e) => setStyle({ bold: e.target.checked })} /> Bold
      </label>
      <label className="check">
        <input type="checkbox" checked={s.uppercase} onChange={(e) => setStyle({ uppercase: e.target.checked })} /> UPPERCASE
      </label>
      <label className="check">
        <input type="checkbox" checked={s.box} onChange={(e) => setStyle({ box: e.target.checked })} /> Background box
      </label>
      {s.box ? (
        <Field label="Box colour"><input type="color" value={s.boxColor} onChange={(e) => setStyle({ boxColor: e.target.value }, 'boxColor')} /></Field>
      ) : (
        <div className="row2">
          <Slider label="Outline" min={0} max={0.2} step={0.005} value={s.outline} onChange={(v) => setStyle({ outline: v }, 'outline')} />
          <Field label="Outline colour"><input type="color" value={s.outlineColor} onChange={(e) => setStyle({ outlineColor: e.target.value }, 'outlineColor')} /></Field>
        </div>
      )}
      <h4>Glossary</h4>
      <p className="hint">One fix per line, <code>wrong =&gt; right</code>. Whole words, any case. Applied to captions and exports.</p>
      <textarea
        rows={5}
        value={glossary}
        placeholder={'flora 2 => FLAURA2\nosimertinip => osimertinib'}
        onChange={(e) => setGlossary(e.target.value)}
        onBlur={() => edit((p) => ({ ...p, glossary: parseGlossary(glossary) }))}
      />
      <div className="row-buttons">
        <button onClick={commands.exportSrt}>Save captions as .srt</button>
      </div>
    </>
  );
}

function ProjectTab({ project, edit }) {
  const set = (patch) => edit((p) => ({ ...p, ...patch }));
  return (
    <>
      <Field label="Aspect ratio">
        <div className="seg">
          {Object.keys(ASPECTS).map((a) => (
            <button key={a} className={project.aspect === a ? 'on' : ''} onClick={() => set({ aspect: a })}>{a}</button>
          ))}
        </div>
      </Field>
      <p className="hint">Output {frameSize(project).join(' × ')}</p>
      <Field label="Framing">
        <div className="seg">
          <button className={project.fit !== 'fill' ? 'on' : ''} onClick={() => set({ fit: 'fit' })}>Fit (bars)</button>
          <button className={project.fit === 'fill' ? 'on' : ''} onClick={() => set({ fit: 'fill' })}>Fill (crop)</button>
        </div>
      </Field>
      <Field label="Frame rate">
        <select value={project.fps} onChange={(e) => set({ fps: Number(e.target.value) })}>
          {[24, 25, 30, 50, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}
        </select>
      </Field>
    </>
  );
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Slider({ label, min, max, step, value, onChange }) {
  return (
    <label className="field">
      <span>
        {label} <em>{round(value, 3)}</em>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function round(x, d = 2) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
