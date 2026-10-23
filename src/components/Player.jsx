import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  audioGain, baseState, elementState, normCrop, placement, setTransformAt,
} from '../../core/anim.js';
import {
  ASPECTS, elementSpan, findElement, frameSize, isStill, isVisual, itemSpan, locate, mapElement, mediaKind, updateElement,
} from '../../core/project.js';
import { formatClock } from '../../core/time.js';
import { mediaUrl } from '../api.js';
import { setGain } from '../audio.js';
import { PlaybackEngine } from '../playback.js';
import { pictureCss, rectCss, transitionCss } from '../stage.js';
import { CaptionOverlay } from './CaptionOverlay.jsx';

const SNAP = 0.012; // fraction of the frame
const LOOKAHEAD = 4; // seconds of upcoming layer items kept mounted (preloaded)

/**
 * Preview stage. The main track plays through two stacked <video> elements driven by PlaybackEngine
 * (gap-free clip changes, transitions shown with CSS); layer items are <video>/<img>/<audio> elements
 * kept in sync with the timeline clock; captions are drawn on top. Click an element to select it, drag
 * it to move, drag a corner to resize; in crop mode, drag the crop box. While playing, the engine's clock
 * drives timeline time; otherwise time drives the engine.
 */
export function Player({ state, items, cues, total, dispatch, edit, onTogglePlay }) {
  const { project, time, playing, selectedClipId, selectedCues, captionScopeAll, cropId } = state;
  const v0 = useRef(null);
  const v1 = useRef(null);
  const wraps = [useRef(null), useRef(null)];
  const stageRef = useRef(null);
  const engine = useRef(null);
  const reported = useRef(-1); // last time the engine reported, so its own updates don't trigger a seek
  const latest = useRef({ project, time });
  latest.current = { project, time };
  const [guides, setGuides] = useState(null);
  const frame = frameSize(project);
  const fps = project.fps || 30;

  useEffect(() => {
    const filterOf = (clip) => {
      const a = clip.adjust;
      return a ? `brightness(${1 + a.brightness}) contrast(${a.contrast}) saturate(${a.saturation})` : 'none';
    };
    engine.current = new PlaybackEngine({
      videos: [v0.current, v1.current],
      urlFor: (clip) => {
        const m = latest.current.project.media[clip.mediaId];
        return m ? mediaUrl(m.proxyPath || m.path) : '';
      },
      isStill: (clip) => isStill(latest.current.project.media[clip.mediaId]),
      styleFor: filterOf,
      onTime: (t) => {
        reported.current = t;
        dispatch({ type: 'time', time: t });
      },
      onEnd: () => dispatch({ type: 'play', playing: false }),
      onShow: (t) => applyRef.current?.(t),
    });
    window.__vcePlayback = engine.current; // debugging and end-to-end checks
    return () => engine.current.pause();
  }, [dispatch]);

  // The project changed (edit, proxy ready, load): give the engine the new layout.
  useEffect(() => {
    engine.current.sync(items, latest.current.time, total);
  }, [items, project.media, total]);

  // Time moved for a reason other than playback (seek, scrub, keyboard, load).
  useEffect(() => {
    if (time !== reported.current) engine.current.seek(time);
  }, [time]);

  useEffect(() => {
    if (playing) engine.current.play();
    else engine.current.pause();
  }, [playing]);

  useEffect(() => {
    if (!playing) return undefined;
    let raf = 0;
    const tick = () => {
      engine.current.tick();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // ----- main track: which clips show now, and how (transition) -----
  const roles = mainRoles(items, time);
  const fx = roles.incoming ? transitionCss(roles.type, roles.progress) : null;
  const cropping = (el) => cropId && el.id === cropId;
  const placeOf = (el, m, local, duration, fit) => placement(m, cropping(el) ? null : el.crop, elementState(el, local, duration), frame, fit);

  // Geometry, transition look and volume of the engine's video slots at timeline time t. Runs on every
  // render, and from the engine itself when it swaps slots, so the incoming clip is styled in that frame.
  const applyRef = useRef(null);
  applyRef.current = (t) => {
    const eng = engine.current;
    if (!eng) return;
    const r = mainRoles(items, t);
    eng.slots.forEach((s, i) => {
      const it = s.item;
      const m = it && project.media[it.clip.mediaId];
      const look = slotLook(r, it && m && !isStill(m) ? it.clip : null);
      Object.assign(wraps[i].current.style, look.style);
      if (!look.role) return;
      const local = clamp(t - it.start, 0, it.duration);
      const p = placeOf(it.clip, m, local, it.duration, project.fit);
      if (p) Object.assign(s.video.style, pictureCss(p, frame));
      if (!s.preroll) setGain(s.video, project.main?.muted ? 0 : audioGain(it.clip, local, it.duration) * look.fade);
    });
  };
  useLayoutEffect(() => applyRef.current(time));

  const stillRoles = ['current', 'incoming', 'outgoing']
    .map((k) => roles[k])
    .filter((it) => it && isStill(project.media[it.clip.mediaId]));

  // ----- selection and direct manipulation on the stage -----
  const dragSeq = useRef(0);
  const selected = findElement(project, selectedClipId);
  const selectedSpan = selected ? elementSpan(project, selectedClipId, items) : null;
  const selectedMedia = selected && project.media[selected.el.mediaId];
  const selectedVisible = selected && selectedSpan && isVisual(selectedMedia)
    && time >= selectedSpan.start - 1e-6 && time < selectedSpan.end && !(selected.kind === 'item' && selected.track.hidden);
  const selectedPlace = selectedVisible
    ? placeOf(selected.el, selectedMedia, clamp(time - selectedSpan.start, 0, selectedSpan.duration), selectedSpan.duration, selected.kind === 'clip' ? project.fit : 'fit')
    : null;

  /** Drag on the stage: 'move' / 'scale' an element, or a crop edge ('n', 'se', 'crop' = whole box, ...). */
  const beginDrag = (e, id, mode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (id !== selectedClipId) dispatch({ type: 'select', clipId: id });
    const found = findElement(project, id);
    const span = elementSpan(project, id, items);
    const m = found && project.media[found.el.mediaId];
    if (!found || !span || !isVisual(m)) return;
    const local = clamp(time - span.start, 0, span.duration);
    const start = baseState(found.el, local);
    const crop0 = normCrop(found.el.crop);
    const rect = stageRef.current.getBoundingClientRect();
    const p0 = placement(m, mode === 'move' || mode === 'scale' ? found.el.crop : null, elementState(found.el, local, span.duration), frame,
      found.kind === 'clip' ? project.fit : 'fit');
    const key = `drag:stage:${id}:${++dragSeq.current}`;
    const cx = rect.left + ((p0?.box.left ?? 0) + (p0?.box.width ?? 0) / 2) * (rect.width / frame[0]);
    const cy = rect.top + ((p0?.box.top ?? 0) + (p0?.box.height ?? 0) / 2) * (rect.height / frame[1]);
    const d0 = Math.hypot(e.clientX - cx, e.clientY - cy) || 1;
    const move = (ev) => {
      const dx = (ev.clientX - e.clientX) / rect.width;
      const dy = (ev.clientY - e.clientY) / rect.height;
      if (mode === 'move') {
        let x = start.x + dx;
        let y = start.y + dy;
        const sx = Math.abs(x - 0.5) < SNAP;
        const sy = Math.abs(y - 0.5) < SNAP;
        if (sx) x = 0.5;
        if (sy) y = 0.5;
        setGuides({ x: sx, y: sy });
        edit((p) => mapElement(p, id, (el) => setTransformAt(el, local, { x, y }, fps)), key);
      } else if (mode === 'scale') {
        const scale = Math.max(0.02, (start.scale * Math.hypot(ev.clientX - cx, ev.clientY - cy)) / d0);
        edit((p) => mapElement(p, id, (el) => setTransformAt(el, local, { scale }, fps)), key);
      } else {
        // Crop handles move in fractions of the whole (uncropped) picture.
        const fx0 = (ev.clientX - e.clientX) / ((p0.full.width / frame[0]) * rect.width);
        const fy0 = (ev.clientY - e.clientY) / ((p0.full.height / frame[1]) * rect.height);
        const c = { ...crop0 };
        if (mode === 'crop') {
          c.x = clamp(crop0.x + fx0, 0, 1 - crop0.w);
          c.y = clamp(crop0.y + fy0, 0, 1 - crop0.h);
        }
        if (mode.includes('w')) {
          c.x = clamp(crop0.x + fx0, 0, crop0.x + crop0.w - 0.02);
          c.w = crop0.w - (c.x - crop0.x);
        }
        if (mode.includes('e')) c.w = clamp(crop0.w + fx0, 0.02, 1 - crop0.x);
        if (mode.includes('n')) {
          c.y = clamp(crop0.y + fy0, 0, crop0.y + crop0.h - 0.02);
          c.h = crop0.h - (c.y - crop0.y);
        }
        if (mode.includes('s')) c.h = clamp(crop0.h + fy0, 0.02, 1 - crop0.y);
        edit((p) => updateElement(p, id, { crop: normCrop(c) }), key);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGuides(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onStageDown = (e) => {
    if (e.target !== e.currentTarget && !e.target.classList.contains('main-slot')) return;
    if (cropId) dispatch({ type: 'crop', id: null });
    dispatch({ type: 'select', clipId: null });
    dispatch({ type: 'selectCues', keys: [] });
  };
  const pickMain = (e, slot) => {
    const it = engine.current?.slots[slot].item;
    if (it) beginDrag(e, it.clip.id, 'move');
  };

  const [W, H] = frame;
  const empty = !items.length && !(project.tracks ?? []).some((t) => t.items.length);
  return (
    <section className="player">
      <div className="stage-wrap">
        <div
          className="stage"
          ref={stageRef}
          style={{ '--ar': W / H, aspectRatio: `${W} / ${H}` }}
          onPointerDown={onStageDown}
          onDoubleClick={(e) => e.target === e.currentTarget && onTogglePlay()}
        >
          <div className="main-slot" ref={wraps[0]}>
            <video ref={v0} className="el" preload="auto" crossOrigin="anonymous" onPointerDown={(e) => pickMain(e, 0)} />
          </div>
          <div className="main-slot" ref={wraps[1]}>
            <video ref={v1} className="el" preload="auto" crossOrigin="anonymous" onPointerDown={(e) => pickMain(e, 1)} />
          </div>
          {stillRoles.map((it) => {
            const m = project.media[it.clip.mediaId];
            const p = placeOf(it.clip, m, clamp(time - it.start, 0, it.duration), it.duration, project.fit);
            return (
              <div key={it.clip.id} className="main-slot" style={slotLook(roles, it.clip).style}>
                {p && <img className="el" src={mediaUrl(m.path)} alt="" crossOrigin="anonymous" draggable={false} style={{ ...pictureCss(p, frame), filter: cssFilter(it.clip) }} onPointerDown={(e) => beginDrag(e, it.clip.id, 'move')} />}
              </div>
            );
          })}
          {fx?.dip && <div className="dip" style={{ background: fx.dip.color, opacity: fx.dip.opacity }} />}
          <Layers project={project} time={time} playing={playing} frame={frame} cropId={cropId} onDown={(e, id) => beginDrag(e, id, 'move')} />
          {empty && <div className="stage-empty">Import media to start</div>}
          {project.captions.enabled && (
            <CaptionOverlay
              cues={cues}
              time={time}
              selectedKeys={selectedCues}
              scopeAll={captionScopeAll}
              dispatch={dispatch}
              edit={edit}
            />
          )}
          {selectedPlace && !cropping(selected.el) && (
            <div className="gizmo" style={rectCss(selectedPlace.box, frame)}>
              {['nw', 'ne', 'sw', 'se'].map((h) => <span key={h} className={`gz-h ${h}`} onPointerDown={(e) => beginDrag(e, selected.el.id, 'scale')} />)}
            </div>
          )}
          {selectedPlace && cropping(selected.el) && (
            <CropBox place={selectedPlace} crop={normCrop(selected.el.crop)} frame={frame} onDown={(e, mode) => beginDrag(e, selected.el.id, mode)} onDone={() => dispatch({ type: 'crop', id: null })} />
          )}
          {guides?.x && <div className="guide v" />}
          {guides?.y && <div className="guide h" />}
        </div>
      </div>
      <div className="transport">
        <button className="play" onClick={onTogglePlay} disabled={empty} title="Play / pause (Space)">
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="clock">
          {formatClock(time)} / {formatClock(total)}
        </span>
        <label className="ratio" title="Canvas (output frame)">
          <select value={project.aspect} onChange={(e) => edit((p) => ({ ...p, aspect: e.target.value }))}>
            {Object.keys(ASPECTS).map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <span className="hint">Click to select · drag to move · corners resize · double-click to play</span>
      </div>
    </section>
  );
}

/** Layer and audio track items near the playhead, each kept in sync with the timeline. */
function Layers({ project, time, playing, frame, cropId, onDown }) {
  const fps = project.fps || 30;
  const out = [];
  (project.tracks ?? []).forEach((track, ti) => {
    for (const item of track.items) {
      const span = itemSpan(item, fps);
      if (span.end < time - 1 || span.start > time + LOOKAHEAD) continue;
      const m = project.media[item.mediaId];
      if (!m) continue;
      out.push(
        <LayerItem key={item.id} item={item} track={track} z={10 + ti} media={m} span={span} time={time} playing={playing}
          frame={frame} cropping={cropId === item.id} onDown={onDown} />,
      );
    }
  });
  return out;
}

function LayerItem({ item, track, z, media, span, time, playing, frame, cropping, onDown }) {
  const ref = useRef(null);
  const kind = mediaKind(media);
  const active = time >= span.start - 1e-6 && time < span.end;
  const local = clamp(time - span.start, 0, span.duration);
  const timed = kind === 'video' || kind === 'audio';

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !timed) return;
    const src = item.in + local * item.speed;
    if (Math.abs(el.playbackRate - item.speed) > 1e-3) el.playbackRate = item.speed;
    if (!active) {
      if (!el.paused) el.pause();
      if (time < span.start && Math.abs(el.currentTime - item.in) > 0.05 && !el.seeking) el.currentTime = item.in;
      return;
    }
    setGain(el, track.muted ? 0 : audioGain(item, local, span.duration));
    if (playing) {
      if (el.paused) el.play()?.catch?.(() => {});
      if (Math.abs(el.currentTime - src) > 0.25 && !el.seeking) el.currentTime = src;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - src) > 0.02 && !el.seeking) el.currentTime = src;
    }
  });
  useEffect(() => () => ref.current?.pause?.(), []);

  const url = mediaUrl(media.proxyPath || media.path);
  if (kind === 'audio' || track.kind === 'audio') return <audio ref={ref} src={url} preload="auto" crossOrigin="anonymous" />;
  const p = placement(media, cropping ? null : item.crop, elementState(item, local, span.duration), frame, 'fit');
  const style = p ? { ...pictureCss(p, frame), zIndex: z, visibility: active && !track.hidden ? 'visible' : 'hidden', filter: cssFilter(item) } : { display: 'none' };
  const props = { className: 'el layer-el', style, 'data-item': item.id, onPointerDown: (e) => onDown(e, item.id), draggable: false };
  if (kind === 'video') return <video ref={ref} src={url} preload="auto" crossOrigin="anonymous" {...props} />;
  return <img src={url} alt="" crossOrigin="anonymous" {...props} />;
}

/** Crop mode: the whole picture faded, the kept part bright, eight handles and a Done button. */
function CropBox({ place, crop, frame, onDown, onDone }) {
  const full = place.full;
  const box = { left: full.left + crop.x * full.width, top: full.top + crop.y * full.height, width: crop.w * full.width, height: crop.h * full.height };
  return (
    <>
      <div className="crop-full" style={rectCss(full, frame)} />
      <div className="crop-box" style={rectCss(box, frame)} onPointerDown={(e) => onDown(e, 'crop')}>
        {['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].map((h) => <span key={h} className={`cr-h ${h}`} onPointerDown={(e) => onDown(e, h)} />)}
        <button className="crop-done" onPointerDown={(e) => e.stopPropagation()} onClick={onDone}>Done</button>
      </div>
    </>
  );
}

/**
 * Which main clips are on screen at `t`: one clip, or the incoming and outgoing clips of a transition.
 * @param {Array<object>} items main layout
 * @param {number} t
 * @returns {{current?: object, incoming?: object, outgoing?: object, progress?: number, type?: string}}
 */
export function mainRoles(items, t) {
  const hit = locate(null, t, items);
  if (!hit || t >= hit.item.end - 1e-6) return {};
  const it = hit.item;
  const prev = items[it.index - 1];
  if (prev && it.overlap > 0 && t < it.start + it.overlap) {
    return { incoming: it, outgoing: prev, progress: (t - it.start) / it.overlap, type: it.clip.transition.type };
  }
  return { current: it };
}

/**
 * How one main clip shows under `roles`: its wrapper style (visibility, transition look, stacking) and
 * the audio fade factor (a cross-fade during a transition).
 * @param {ReturnType<typeof mainRoles>} roles
 * @param {object | null} clip
 * @returns {{role: string | null, style: object, fade: number}}
 */
function slotLook(roles, clip) {
  let role = null;
  if (clip && roles.current?.clip === clip) role = 'only';
  else if (clip && roles.incoming?.clip === clip) role = 'in';
  else if (clip && roles.outgoing?.clip === clip) role = 'out';
  const style = { visibility: role ? 'visible' : 'hidden', zIndex: 1, opacity: '', transform: '', clipPath: '' };
  if (role === 'in' || role === 'out') {
    const fx = transitionCss(roles.type, roles.progress);
    const top = (role === 'out') === fx.outgoingOnTop;
    Object.assign(style, role === 'in' ? fx.incoming : fx.outgoing, { zIndex: top ? 2 : 1 });
  }
  const fade = role === 'in' ? roles.progress : role === 'out' ? 1 - roles.progress : 1;
  return { role, style, fade };
}

function cssFilter(el) {
  const a = el.adjust;
  return a ? `brightness(${1 + a.brightness}) contrast(${a.contrast}) saturate(${a.saturation})` : 'none';
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
