import { useEffect, useState } from 'react';
import { dragCrop, isFullCrop, normCrop, ratioCrop } from '../../core/anim.js';
import { elementSpan, findElement, isVisual, mediaKind, updateElement } from '../../core/project.js';
import { mediaUrl } from '../api.js';

const RATIOS = [['free', 'Free'], ['original', 'Original'], [16 / 9, '16:9'], [9 / 16, '9:16'], [1, '1:1'], [4 / 3, '4:3'], [3 / 4, '3:4']];
const HANDLES = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];

/**
 * Crop window for the selected layers (opened from the timeline toolbar). Shows the first selected
 * picture at the playhead with a crop box; Apply gives the same crop (as a share of each picture) to every
 * selected layer, in one undo step. Other layers are not touched.
 */
export function CropDialog({ project, ids, items, time, edit, onClose }) {
  const targets = ids.map((id) => findElement(project, id)).filter((f) => f && isVisual(project.media[f.el.mediaId])
    && !(f.kind === 'item' && f.track.kind === 'audio'));
  const first = targets[0];
  const m = first && project.media[first.el.mediaId];
  const [crop, setCrop] = useState(() => normCrop(first?.el.crop));
  const [ratio, setRatio] = useState('free');

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'Enter' && !e.target.closest('input')) apply();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (!first) return null;
  // The picture fits the window: room is left for the title, ratio buttons, fields and buttons.
  const k = Math.min(Math.min(760, window.innerWidth - 120) / m.width, Math.max(160, Math.min(420, window.innerHeight - 330)) / m.height);
  const dw = m.width * k;
  const dh = m.height * k;
  const span = elementSpan(project, first.el.id, items);
  const local = Math.min(Math.max(time - span.start, 0), span.duration);
  const sourceTime = first.el.in + local * first.el.speed;
  const lock = typeof ratio === 'number' ? ratio : ratio === 'original' ? m.width / m.height : null;

  const pick = (r) => {
    setRatio(r);
    if (r === 'original') setCrop(normCrop(null));
    else if (typeof r === 'number') setCrop(ratioCrop(m, r));
  };
  const begin = (e, handle) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const c0 = crop;
    const move = (ev) => setCrop(dragCrop(c0, handle, (ev.clientX - e.clientX) / dw, (ev.clientY - e.clientY) / dh, m, lock));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  function apply() {
    const next = isFullCrop(crop) ? null : normCrop(crop);
    edit((p) => targets.reduce((q, f) => updateElement(q, f.el.id, { crop: next }), p));
    onClose();
  }
  const edge = (v, set) => {
    const n = Math.min(98, Math.max(0, Number(v) || 0)) / 100;
    setRatio('free');
    setCrop(normCrop({ ...crop, ...set(n) }));
  };
  const box = { left: crop.x * dw, top: crop.y * dh, width: crop.w * dw, height: crop.h * dh };
  const names = targets.map((f) => project.media[f.el.mediaId]?.name ?? '?');

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal crop-dialog">
        <h2>Crop {targets.length > 1 ? `${targets.length} layers` : names[0]}</h2>
        <div className="crop-frame">
          <div className="crop-stage" style={{ width: dw, height: dh }}>
            {mediaKind(m) === 'video' ? (
              <video
                src={mediaUrl(m.proxyPath || m.path)}
                muted
                preload="auto"
                crossOrigin="anonymous"
                onLoadedMetadata={(e) => { e.currentTarget.currentTime = sourceTime; }}
              />
            ) : (
              <img src={mediaUrl(m.path)} alt="" draggable={false} crossOrigin="anonymous" />
            )}
            <div className="crop-box" style={box} onPointerDown={(e) => begin(e, 'box')}>
              {HANDLES.map((h) => <span key={h} className={`cr-h ${h}`} onPointerDown={(e) => begin(e, h)} />)}
            </div>
          </div>
        </div>
        <div className="seg crop-ratios">
          {RATIOS.map(([r, label]) => (
            <button key={label} className={ratio === r ? 'on' : ''} onClick={() => pick(r)}>{label}</button>
          ))}
        </div>
        <div className="row4">
          {[['Left', crop.x, (v) => ({ x: v, w: crop.w + crop.x - v })], ['Top', crop.y, (v) => ({ y: v, h: crop.h + crop.y - v })],
            ['Right', 1 - crop.x - crop.w, (v) => ({ w: 1 - crop.x - v })], ['Bottom', 1 - crop.y - crop.h, (v) => ({ h: 1 - crop.y - v })]].map(([label, v, set]) => (
              <label key={label} className="field">
                <span>{label} %</span>
                <input type="number" min={0} max={98} step={1} value={Math.round(v * 100)} onChange={(e) => edge(e.target.value, set)} />
              </label>
          ))}
        </div>
        <p className="hint">
          Applies to {names.join(', ')}.
          {targets.length > 1 ? ' Each gets the same crop, as a share of its own picture.' : ' Ctrl+click more layers on the timeline to crop them together.'}
          {' '}Drag the box or its handles; a ratio keeps its shape while you drag.
        </p>
        <div className="row-buttons end">
          <button onClick={() => { setRatio('free'); setCrop(normCrop(null)); }}>Reset</button>
          <span className="grow" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={apply}>{targets.length > 1 ? `Apply to ${targets.length} layers` : 'Apply'}</button>
        </div>
      </div>
    </div>
  );
}
