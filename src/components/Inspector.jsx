import { useEffect, useState } from 'react';
import {
  EASINGS, IN_EFFECTS, MAX_DB, MUTE_DB, OUT_EFFECTS, addKeyframe, baseState, keyframeAt, normCrop, removeKeyframe,
  setKeyframeEase, setTransformAt,
} from '../../core/anim.js';
import { CAPTION_FORMATS, resetCaptionStyle, setCaptionStyle } from '../../core/captions.js';
import {
  ASPECTS, MIN_CLIP, SPEEDS, TRANSITIONS, elementSpan, findElement, frameSize, isStill, isVisual, mapElement, mediaKind,
  removeSubtitles, updateElement, updateSubtitle,
} from '../../core/project.js';
import { formatGlossary, parseGlossary } from '../../core/transcript.js';
import { formatClock } from '../../core/time.js';
import { CAPTION_PRESETS, applyCaptionPreset, captionPreset, matchingCaptionPreset } from '../../core/presets.js';
import { CaptionLine } from './CaptionOverlay.jsx';

const FONTS = ['Arial', 'Segoe UI', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Impact', 'Calibri'];
const SAMPLE = [{ text: 'Your' }, { text: 'words' }, { text: 'here' }];

/** Right panel: the selected clip or item, caption style and project settings. */
export function Inspector({ state, items, cues, edit, dispatch, commands, onSeek }) {
  const [tab, setTab] = useState('clip');
  const { selectedClipId, selectedCues } = state;
  // Follow the selection: an element opens Clip, captions open Captions.
  useEffect(() => {
    if (selectedClipId) setTab('clip');
  }, [selectedClipId]);
  useEffect(() => {
    if (selectedCues.length) setTab('captions');
  }, [selectedCues]);
  return (
    <>
      <div className="tabs">
        {[['clip', 'Clip'], ['captions', 'Captions'], ['project', 'Project']].map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      <div className="inspector">
        {tab === 'clip' && <ClipTab state={state} items={items} edit={edit} dispatch={dispatch} commands={commands} onSeek={onSeek} />}
        {tab === 'captions' && <CaptionsTab state={state} cues={cues} edit={edit} dispatch={dispatch} commands={commands} />}
        {tab === 'project' && <ProjectTab project={state.project} edit={edit} />}
      </div>
    </>
  );
}

function ClipTab({ state, items, edit, dispatch, commands, onSeek }) {
  const { project, time, selectedClipId, selectedIds, jobs } = state;
  const found = findElement(project, selectedClipId);
  if (!found) {
    return <p className="hint">Select a clip on the timeline or in the preview to trim it, move or resize it, animate it, crop it or change its volume.</p>;
  }
  const el = found.el;
  const m = project.media[el.mediaId];
  const kind = mediaKind(m);
  const visual = isVisual(m) && !(found.kind === 'item' && found.track.kind === 'audio');
  const span = elementSpan(project, el.id, items);
  const fps = project.fps || 30;
  const local = Math.min(Math.max(time - span.start, 0), span.duration);
  const inside = time >= span.start - 1e-6 && time <= span.end + 1e-6;
  const set = (patch, key) => edit((p) => updateElement(p, el.id, patch), key && `${el.id}:${key}`);
  const mapEl = (fn, key) => edit((p) => mapElement(p, el.id, fn), key && `${el.id}:${key}`);
  const tf = baseState(el, local);
  const setTf = (patch, key) => mapEl((x) => setTransformAt(x, local, patch, fps), key);
  const kfs = el.keyframes ?? [];
  const kfHere = keyframeAt(el, local, fps);
  const prevKf = [...kfs].reverse().find((k) => k.t < local - 0.5 / fps);
  const nextKf = kfs.find((k) => k.t > local + 0.5 / fps);
  const crop = normCrop(el.crop);
  const job = Object.values(jobs).find((j) => j.kind === 'cutout' && j.elementId === el.id && j.status === 'running');
  const adj = (k, v) => set({ adjust: { ...el.adjust, [k]: v } }, k);
  const first = project.clips[0]?.id === el.id;
  const db = el.volume ?? 0;

  return (
    <>
      <h3 title={m?.path}>{m?.name}</h3>
      {selectedIds.length > 1 && <p className="hint">{selectedIds.length} selected (Ctrl+click or drag a box to change) · showing the last one picked. Crop and Delete apply to all.</p>}
      <p className="hint">
        {found.kind === 'clip' ? 'Main track' : `${found.track.kind === 'layer' ? 'Layer' : 'Audio'} track`} · {kind}
        {' · '}{formatClock(span.start)}–{formatClock(span.end)}
      </p>

      <h4>Timing</h4>
      {found.kind === 'item' && (
        <Field label="Start on the timeline (s)">
          <input type="number" step={0.1} min={0} value={round(el.start)} onChange={(e) => set({ start: Number(e.target.value) }, 'start')} />
        </Field>
      )}
      {isStill(m) ? (
        <Field label="Length (s)">
          <input type="number" step={0.5} min={MIN_CLIP} value={round(el.out - el.in)} onChange={(e) => set({ out: el.in + Math.max(MIN_CLIP, Number(e.target.value)) }, 'len')} />
        </Field>
      ) : (
        <>
          <div className="row2">
            <Field label="In (s)">
              <input type="number" step={0.1} min={0} value={round(el.in)} onChange={(e) => set({ in: Number(e.target.value) }, 'in')} />
            </Field>
            <Field label="Out (s)">
              <input type="number" step={0.1} min={el.in + MIN_CLIP} value={round(el.out)} onChange={(e) => set({ out: Number(e.target.value) }, 'out')} />
            </Field>
          </div>
          <p className="hint">Source {formatClock(el.in)} – {formatClock(el.out)} of {formatClock(m?.duration ?? 0)}</p>
          <Field label="Speed">
            <select value={el.speed} onChange={(e) => set({ speed: Number(e.target.value) })}>
              {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
            </select>
          </Field>
        </>
      )}

      {visual && (
        <>
          <h4>Position and size</h4>
          {!inside && <p className="hint warn">Move the playhead over this clip to see it while you edit.</p>}
          <div className="row2">
            <Slider label="X" min={-0.5} max={1.5} step={0.005} value={tf.x} onChange={(v) => setTf({ x: v }, 'x')} />
            <Slider label="Y" min={-0.5} max={1.5} step={0.005} value={tf.y} onChange={(v) => setTf({ y: v }, 'y')} />
          </div>
          <div className="row2">
            <Slider label="Scale" min={0.05} max={3} step={0.01} value={tf.scale} onChange={(v) => setTf({ scale: v }, 'scale')} />
            <Slider label="Opacity" min={0} max={1} step={0.01} value={tf.opacity} onChange={(v) => setTf({ opacity: v }, 'opacity')} />
          </div>
          <div className="row-buttons">
            <button onClick={() => setTf({ x: 0.5, y: 0.5, scale: 1, opacity: 1 })}>Reset (fit frame)</button>
            <button onClick={() => setTf({ x: 0.5, y: 0.5 })} title="Centre without changing the size">Centre</button>
          </div>

          <h4>Keyframes</h4>
          <div className="row-buttons">
            <button className={kfHere ? 'on' : ''} onClick={() => mapEl((x) => (kfHere ? removeKeyframe(x, local, fps) : addKeyframe(x, local, fps)))} disabled={!inside}>
              {kfHere ? '◆ Remove keyframe' : '◇ Add keyframe'}
            </button>
            <button disabled={!prevKf} onClick={() => onSeek(span.start + prevKf.t)} title="Previous keyframe">◀</button>
            <button disabled={!nextKf} onClick={() => onSeek(span.start + nextKf.t)} title="Next keyframe">▶</button>
            {kfs.length > 0 && <button onClick={() => set({ keyframes: [], transform: tf })}>Clear all</button>}
          </div>
          {kfHere && nextKf && (
            <Field label="Transition to the next keyframe">
              <select value={kfHere.ease ?? 'linear'} onChange={(e) => mapEl((x) => setKeyframeEase(x, local, e.target.value, fps))}>
                {EASINGS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </Field>
          )}
          <p className="hint">
            {kfs.length ? `${kfs.length} keyframe${kfs.length === 1 ? '' : 's'}. Changing position, size or opacity sets the keyframe at the playhead.` : 'Add keyframes at two times, change the picture at each, and it moves between them.'}
          </p>

          <h4>Crop</h4>
          <div className="row-buttons">
            <button onClick={commands.openCrop} title="Crop the selected layers (also in the timeline toolbar)">Crop…</button>
            <button onClick={() => set({ crop: null })} disabled={!el.crop}>Reset crop</button>
            {el.crop && (
              <span className="hint">
                Keeps {Math.round(crop.w * 100)}% × {Math.round(crop.h * 100)}% of the picture
              </span>
            )}
          </div>
        </>
      )}

      <h4>Animation in and out</h4>
      {[['in', 'In', IN_EFFECTS], ['out', 'Out', OUT_EFFECTS]].map(([side, label, list]) => (
        <div className="row2" key={side}>
          <Field label={label}>
            <select
              value={el.anim?.[side]?.type ?? ''}
              onChange={(e) => set({ anim: { ...el.anim, [side]: e.target.value ? { type: e.target.value, duration: el.anim?.[side]?.duration ?? 0.5 } : null } })}
            >
              <option value="">None</option>
              {list.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          {el.anim?.[side] && (
            <Slider label="Length (s)" min={0.1} max={3} step={0.05} value={el.anim[side].duration} onChange={(v) => set({ anim: { ...el.anim, [side]: { ...el.anim[side], duration: v } } }, `anim${side}`)} />
          )}
        </div>
      ))}
      {!visual && <p className="hint">Audio clips use the fades below.</p>}

      {m?.hasAudio && (
        <>
          <h4>Audio</h4>
          <Slider
            label="Volume"
            min={MUTE_DB}
            max={MAX_DB}
            step={0.5}
            value={Math.max(MUTE_DB, db)}
            display={db <= MUTE_DB ? 'Mute' : `${db > 0 ? '+' : ''}${round(db, 1)} dB`}
            onChange={(v) => set({ volume: v }, 'volume')}
          />
          <div className="row-buttons">
            <button onClick={() => set({ volume: db <= MUTE_DB ? 0 : MUTE_DB })}>{db <= MUTE_DB ? '🔊 Unmute' : '🔇 Mute'}</button>
            <button onClick={() => set({ volume: 0 })} disabled={db === 0}>0 dB</button>
          </div>
          <div className="row2">
            <Slider label="Fade in (s)" min={0} max={5} step={0.1} value={el.audioFade?.in ?? 0} onChange={(v) => set({ audioFade: { ...el.audioFade, in: v } }, 'fadein')} />
            <Slider label="Fade out (s)" min={0} max={5} step={0.1} value={el.audioFade?.out ?? 0} onChange={(v) => set({ audioFade: { ...el.audioFade, out: v } }, 'fadeout')} />
          </div>
        </>
      )}

      {visual && (
        <>
          <h4>Colour</h4>
          <Slider label="Brightness" min={-0.3} max={0.3} step={0.01} value={el.adjust.brightness} onChange={(v) => adj('brightness', v)} />
          <Slider label="Contrast" min={0.5} max={1.5} step={0.01} value={el.adjust.contrast} onChange={(v) => adj('contrast', v)} />
          <Slider label="Saturation" min={0} max={2} step={0.01} value={el.adjust.saturation} onChange={(v) => adj('saturation', v)} />
          <Background el={el} m={m} job={job} commands={commands} />
        </>
      )}

      {found.kind === 'clip' && (
        <>
          <h4>Transition in</h4>
          {first ? (
            <p className="hint">The first clip has no incoming transition.</p>
          ) : (
            <>
              <Field label="Type">
                <select
                  value={el.transition?.type ?? ''}
                  onChange={(e) => set({ transition: e.target.value ? { type: e.target.value, duration: el.transition?.duration ?? 0.5 } : null })}
                >
                  <option value="">None (cut)</option>
                  {TRANSITIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
              </Field>
              {el.transition && (
                <Slider label="Duration (s)" min={0.1} max={2} step={0.05} value={el.transition.duration} onChange={(v) => set({ transition: { ...el.transition, duration: v } }, 'tdur')} />
              )}
            </>
          )}
        </>
      )}

      <h4>Arrange</h4>
      <div className="row-buttons">
        {found.kind === 'item' && found.track.kind === 'layer' && (
          <>
            <button onClick={() => commands.shiftLayer(el.id, 1)} title="Move to the layer in front">Bring forward</button>
            <button onClick={() => commands.shiftLayer(el.id, -1)} title="Move to the layer behind">Send backward</button>
            <button onClick={() => commands.toMainTrack(el.id)} title="Move onto the main track at this time">To main track</button>
          </>
        )}
        {found.kind === 'clip' && visual && <button onClick={() => commands.toLayer(el.id)} title="Lift onto a layer, keeping its time (picture-in-picture)">Lift to a layer</button>}
      </div>
      <div className="row-buttons">
        <button onClick={commands.splitAtPlayhead}>Split at playhead</button>
        <button className="danger" onClick={commands.deleteSelected}>Delete</button>
      </div>
    </>
  );
}

/** Background removal for the selected element: AI matte or colour key, baked into a transparent copy. */
function Background({ el, m, job, commands }) {
  const [method, setMethod] = useState('ai');
  const [key, setKey] = useState({ color: '#00ff00', similarity: 0.3, blend: 0.1 });
  return (
    <>
      <h4>Background</h4>
      {m.cutoutOf ? (
        <div className="row-buttons">
          <span className="ok">Background removed</span>
          <button onClick={() => commands.restoreBackground(el.id)}>Restore original</button>
        </div>
      ) : (
        <>
          <div className="seg">
            <button className={method === 'ai' ? 'on' : ''} onClick={() => setMethod('ai')}>AI (any subject)</button>
            <button className={method === 'key' ? 'on' : ''} onClick={() => setMethod('key')}>Colour key</button>
          </div>
          {method === 'key' && (
            <div className="row2">
              <Field label="Key colour"><input type="color" value={key.color} onChange={(e) => setKey({ ...key, color: e.target.value })} /></Field>
              <Slider label="Similarity" min={0.05} max={0.8} step={0.01} value={key.similarity} onChange={(v) => setKey({ ...key, similarity: v })} />
            </div>
          )}
          <button className="primary" disabled={Boolean(job)} onClick={() => commands.removeBackground(el.id, method, key)}>
            {job ? `Removing… ${Math.round((job.progress ?? 0) * 100)}%` : 'Remove background'}
          </button>
          <p className="hint">
            {method === 'ai'
              ? 'Runs offline. The first time it downloads the model (43 MB, choose another in Settings). Videos take a while: every frame is processed.'
              : 'For green or blue screens and plain backgrounds. Pick the background colour; raise Similarity if edges remain.'}
          </p>
        </>
      )}
    </>
  );
}

function CaptionsTab({ state, cues, edit, dispatch, commands }) {
  const { project, selectedCues, captionScopeAll } = state;
  const c = project.captions;
  const picked = cues.filter((q) => selectedCues.includes(q.key));
  const target = captionScopeAll ? null : selectedCues;
  const s = !captionScopeAll && picked.length ? picked[0].style : c.style;
  const setCaps = (patch, key) => edit((p) => ({ ...p, captions: { ...p.captions, ...patch } }), key && `cap:${key}`);
  const setStyle = (patch, key) => {
    if (target && !target.length) return;
    edit((p) => setCaptionStyle(p, patch, target), key && `style:${key}:${captionScopeAll ? 'all' : selectedCues.join(',')}`);
  };
  const [glossary, setGlossary] = useState(formatGlossary(project.glossary));
  const [format, setFormat] = useState('srt');
  const oneSrt = picked.length === 1 && picked[0].source === 'srt' ? project.subtitles.find((x) => x.id === picked[0].srtId) : null;
  const disabled = !captionScopeAll && !picked.length;
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
            title={`${pr.name}: up to ${pr.maxChars} characters per caption (all captions)`}
          >
            <span className="preset-sample">
              <CaptionLine words={SAMPLE} active={1} style={captionPreset(pr.id).style} frameHeight={150} />
            </span>
            <span className="preset-name">{pr.name}</span>
          </button>
        ))}
      </div>
      <Slider label="Max characters per caption" min={12} max={60} step={1} value={c.maxChars} onChange={(v) => setCaps({ maxChars: v }, 'maxChars')} />

      <h4>Apply changes to</h4>
      <label className="check">
        <input type="checkbox" checked={captionScopeAll} onChange={(e) => dispatch({ type: 'captionScope', all: e.target.checked })} /> All captions
      </label>
      {!captionScopeAll && (picked.length ? (
        <div className="row-buttons">
          <span className="hint">{picked.length} selected caption{picked.length === 1 ? '' : 's'}</span>
          <button onClick={() => edit((p) => resetCaptionStyle(p, selectedCues))}>Reset to default style</button>
        </div>
      ) : (
        <p className="hint warn">Select captions on the caption track or in the preview (Ctrl+click for several).</p>
      ))}

      <fieldset className="plain" disabled={disabled}>
        <h4>Text box</h4>
        <p className="hint">Or drag the caption in the preview: the middle moves it, the sides set the width, the corners resize the text.</p>
        <div className="row2">
          <Slider label="Size" min={0.02} max={0.15} step={0.002} value={s.size} onChange={(v) => setStyle({ size: v }, 'size')} />
          <Slider label="Width" min={0.1} max={1} step={0.01} value={s.width ?? 0.88} onChange={(v) => setStyle({ width: v }, 'width')} />
        </div>
        <div className="row2">
          <Slider label="Horizontal" min={0} max={1} step={0.005} value={s.x ?? 0.5} onChange={(v) => setStyle({ x: v }, 'x')} />
          <Slider label="Vertical (bottom)" min={0.08} max={1} step={0.005} value={s.position} onChange={(v) => setStyle({ position: v }, 'position')} />
        </div>

        <h4>Style</h4>
        <Field label="Font">
          <select value={s.font} onChange={(e) => setStyle({ font: e.target.value })}>
            {FONTS.map((f) => <option key={f}>{f}</option>)}
          </select>
        </Field>
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
        <div className="row2">
          <Field label="Animation in">
            <select value={s.animIn ?? 'none'} onChange={(e) => setStyle({ animIn: e.target.value })}>
              <option value="none">None</option>
              <option value="fade">Fade in</option>
              <option value="pop">Pop</option>
            </select>
          </Field>
          <Field label="Animation out">
            <select value={s.animOut ?? 'none'} onChange={(e) => setStyle({ animOut: e.target.value })}>
              <option value="none">None</option>
              <option value="fade">Fade out</option>
            </select>
          </Field>
        </div>
      </fieldset>

      {oneSrt && (
        <>
          <h4>Selected subtitle</h4>
          <textarea rows={2} defaultValue={oneSrt.text} key={oneSrt.id} onBlur={(e) => edit((p) => updateSubtitle(p, oneSrt.id, { text: e.target.value.trim() || oneSrt.text }))} />
          <div className="row2">
            <Field label="Start (s)"><input type="number" step={0.05} value={round(oneSrt.start)} onChange={(e) => edit((p) => updateSubtitle(p, oneSrt.id, { start: Number(e.target.value) }), `sub:${oneSrt.id}:s`)} /></Field>
            <Field label="End (s)"><input type="number" step={0.05} value={round(oneSrt.end)} onChange={(e) => edit((p) => updateSubtitle(p, oneSrt.id, { end: Number(e.target.value) }), `sub:${oneSrt.id}:e`)} /></Field>
          </div>
        </>
      )}

      <h4>Glossary</h4>
      <p className="hint">One fix per line, <code>wrong =&gt; right</code>. Whole words, any case. Applied to captions and exports.</p>
      <textarea
        rows={4}
        value={glossary}
        placeholder={'flora 2 => FLAURA2\nosimertinip => osimertinib'}
        onChange={(e) => setGlossary(e.target.value)}
        onBlur={() => edit((p) => ({ ...p, glossary: parseGlossary(glossary) }))}
      />

      <h4>Download captions</h4>
      <div className="row-buttons">
        <select value={format} onChange={(e) => setFormat(e.target.value)}>
          {CAPTION_FORMATS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <button className="primary" onClick={() => commands.exportCaptions(format)} disabled={!cues.length}>Download…</button>
      </div>
      <p className="hint">Timeline captions after your cuts, with the glossary. Each file in Media also has its own ⤓ Captions.</p>
      {project.subtitles?.length > 0 && (
        <div className="row-buttons">
          <span className="hint">{project.subtitles.length} imported subtitle lines</span>
          <button className="danger" onClick={() => confirm('Remove all imported subtitles?') && edit((p) => removeSubtitles(p, p.subtitles.map((x) => x.id)))}>Remove</button>
        </div>
      )}
    </>
  );
}

function ProjectTab({ project, edit }) {
  const set = (patch) => edit((p) => ({ ...p, ...patch }));
  return (
    <>
      <Field label="Canvas">
        <div className="seg">
          {Object.keys(ASPECTS).map((a) => (
            <button key={a} className={project.aspect === a ? 'on' : ''} onClick={() => set({ aspect: a })}>{a}</button>
          ))}
        </div>
      </Field>
      <p className="hint">Output {frameSize(project).join(' × ')}</p>
      <Field label="Main track framing">
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

function Slider({ label, min, max, step, value, onChange, display }) {
  return (
    <label className="field">
      <span>
        {label} <em>{display ?? round(value, 3)}</em>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function round(x, d = 2) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
