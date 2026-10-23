import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { projectCues, setCueTiming } from '../../core/captions.js';
import {
  addTrack, elementSpan, findElement, isStill, isVisual, itemSpan, layout, mediaKind, moveClipTo, moveItem, moveTrack, newId,
  removeTrack, trimClip, trimItem, updateTrack,
} from '../../core/project.js';
import { formatClock, snapTime } from '../../core/time.js';
import { timelineWords } from '../../core/transcript.js';
import { mediaUrl } from '../api.js';

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
/** Zoom range in pixels per second (log-scale slider) and the step of the buttons and keys. */
const MIN_PPS = 0.02; // 1 px = 50 s: a 10-hour timeline still fits a laptop screen
const MAX_PPS = 400;
const ZOOM_STEP = 1.5;
const sliderOf = (pps) => Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS);
const ppsOf = (f) => MIN_PPS * (MAX_PPS / MIN_PPS) ** f;
const SNAP_PX = 8;
const DRAG_PX = 3;
/** Drag type for media dragged from the Media panel onto a track. */
export const MEDIA_DRAG = 'application/x-shotcut-media';
const HEAD = 156; // track header column, px (matches .row .head in styles.css)
/** Blocks narrower than this drop their padding: CSS never draws a box narrower than its padding and border,
 * so zoomed out a 2-second caption was drawn 14 px (about 50 s at Fit on a 70-minute timeline). */
const NARROW = 16;
const narrow = (w) => (w < NARROW ? ' narrow' : '');

/**
 * Timeline: ruler, caption track, layer tracks (front-most on top), the main track and audio tracks.
 * Click or drag the ruler to seek. Main track: drag a clip's edge to trim it, drag its body to reorder.
 * Layer and audio items: drag to move in time or to another track (above the top layer = a new layer),
 * drag an edge to trim or lengthen (images and GIFs have no fixed length). Captions: click to select
 * (Ctrl/Shift+click adds), drag an edge to change when it shows; imported subtitles can be dragged whole.
 * A drag previews live and commits as one undo step. Dragging on empty space (or across auto captions)
 * draws a box that selects everything it touches, on every track.
 */
export function Timeline({ state, items, cues, total, dispatch, onSeek, commands }) {
  const { project, time, selectedClipId, selectedIds, selectedCues } = state;
  const [dropAt, setDropAt] = useState(null); // track id, 'main' or 'new' while media is dragged over it
  const [pps, setPps] = useState(40); // pixels per second
  const [scrollX, setScrollX] = useState(0);
  const [drag, setDrag] = useState(null);
  const [marquee, setMarquee] = useState(null); // box select rectangle in .tl-inner pixels
  const dragRef = useRef(null);
  const scrollRef = useRef(null);
  const innerRef = useRef(null);
  const fps = project.fps || 30;
  const tracks0 = project.tracks ?? [];

  const edgesExcept = (id) => {
    const out = [0, time];
    for (const i of items) if (i.clip.id !== id) out.push(i.start, i.end);
    for (const t of project.tracks ?? []) for (const it of t.items) if (it.id !== id) { const s = itemSpan(it, fps); out.push(s.start, s.end); }
    return out;
  };

  /** What a drag would do: the edited project, plus where to put the playhead or the drop marker. */
  const resultOf = (d) => {
    const dsec = d.dx / pps;
    const tol = SNAP_PX / pps;
    if (d.kind === 'cue' || d.kind === 'cue-trim') {
      const cue = cues.find((c) => c.key === d.cueKey);
      if (!cue) return { project };
      if (d.kind === 'cue') {
        const start = Math.max(0, snapTime(cue.start + dsec, edgesExcept(null), tol));
        return { project: setCueTiming(project, cue, { start, end: start + (cue.end - cue.start) }) };
      }
      const t = snapTime((d.edge === 'in' ? cue.start : cue.end) + dsec, edgesExcept(null), tol);
      return { project: setCueTiming(project, cue, d.edge === 'in' ? { start: Math.max(0, t) } : { end: t }) };
    }
    const found = findElement(project, d.clipId);
    if (!found) return { project };
    if (found.kind === 'item') {
      const it = found.el;
      const span = itemSpan(it, fps);
      if (d.kind === 'trim') {
        const edge = snapTime((d.edge === 'in' ? span.start : span.end) + dsec, edgesExcept(it.id), tol);
        const next = trimItem(project, it.id, d.edge, edge);
        return { project: next, time: d.edge === 'in' ? findElement(next, it.id).el.start : Math.max(span.start, edge - 1 / fps) };
      }
      let start = Math.max(0, it.start + dsec);
      const end = start + span.duration;
      const edges = edgesExcept(it.id);
      const s1 = snapTime(start, edges, tol);
      const s2 = snapTime(end, edges, tol);
      start = s1 !== start ? s1 : s2 !== end ? s2 - span.duration : start;
      let p = project;
      let trackId = d.overTrack ?? found.track.id;
      if (d.newTrack) {
        trackId = d.newTrackId;
        p = addTrack(p, found.track.kind, { id: trackId });
      }
      return { project: moveItem(p, it.id, { start, trackId }) };
    }
    const it = items.find((i) => i.clip.id === d.clipId);
    if (!it) return { project };
    const c = it.clip;
    if (d.kind === 'trim' && d.edge === 'out') {
      const edge = snapTime(it.end + dsec, [time, ...items.map((i) => i.start)], tol);
      const next = trimClip(project, c.id, 'out', c.in + (edge - it.start) * c.speed);
      const after = layout(next)[it.index];
      return { project: next, time: Math.max(after.start, after.end - 1 / fps) };
    }
    if (d.kind === 'trim') {
      return { project: trimClip(project, c.id, 'in', c.in + dsec * c.speed), time: it.start };
    }
    const others = items.filter((i) => i.clip.id !== c.id);
    const center = it.start + it.duration / 2 + dsec;
    const index = others.filter((o) => o.start + o.duration / 2 < center).length;
    const marker = index < others.length ? others[index].start : (others.at(-1)?.end ?? 0);
    return { project: moveClipTo(project, c.id, index), marker };
  };

  const beginDrag = (e, start) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const d0 = { ...start, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0, moved: false };
    dragRef.current = d0;
    setDrag(d0);
    // Lanes where they are now: the live preview may add a row (new layer) and shift them while dragging.
    const lanes = [...document.querySelectorAll('.lane[data-track]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.track, top: r.top - 3, bottom: r.bottom + 3 };
    });
    const layerTop = Math.min(...[...document.querySelectorAll('.lane.layer')].map((el) => el.getBoundingClientRect().top));
    const move = (ev) => {
      const dx = ev.clientX - d0.startX;
      const dy = ev.clientY - d0.startY;
      const cur = { ...dragRef.current, dx, dy, moved: dragRef.current.moved || Math.abs(dx) > DRAG_PX || Math.abs(dy) > DRAG_PX };
      if (d0.kind === 'move' && d0.trackKind) {
        // Which track is under the pointer: same kind only; above the top layer means a new layer.
        const lane = lanes.find((l) => ev.clientY >= l.top && ev.clientY < l.bottom);
        const over = lane && project.tracks.find((t) => t.id === lane.id);
        cur.overTrack = over && over.kind === d0.trackKind ? over.id : d0.trackId;
        cur.newTrack = d0.trackKind === 'layer' && Number.isFinite(layerTop) && ev.clientY < layerTop - 3;
        cur.newTrackId = d0.newTrackId;
      }
      dragRef.current = cur;
      setDrag(cur);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const fin = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!fin?.moved) return;
      const res = resultOf(fin);
      if (res.project !== project) dispatch({ type: 'edit', fn: () => res.project });
      if (res.time !== undefined) dispatch({ type: 'time', time: res.time });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const pickElement = (e, id, kind, edge) => {
    // Ctrl/Shift+click anywhere on it, its trim edges too (a short clip zoomed out is mostly edge), adds or removes it.
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      if (e.button !== 0) return;
      e.stopPropagation();
      dispatch({ type: 'select', clipId: id, add: true });
      return;
    }
    dispatch({ type: 'select', clipId: id });
    const found = findElement(project, id);
    beginDrag(e, { kind, edge, clipId: id, trackId: found?.track?.id, trackKind: found?.track?.kind, newTrackId: newId('track') });
  };
  const pickCue = (e, cue, kind, edge) => {
    if (e.button !== 0) return;
    const multi = e.ctrlKey || e.metaKey || e.shiftKey;
    if (multi) {
      e.stopPropagation();
      const keys = selectedCues.includes(cue.key) ? selectedCues.filter((k) => k !== cue.key) : [...selectedCues, cue.key];
      dispatch({ type: 'selectCues', keys, add: true });
      return;
    }
    if (!selectedCues.includes(cue.key) || kind !== 'cue') dispatch({ type: 'selectCues', keys: [cue.key] });
    if (kind === 'cue' && cue.source !== 'srt') {
      // Auto captions do not move, so dragging across them box-selects (they often leave no empty space).
      onSeek(cue.start);
      beginMarquee(e, () => {});
      return;
    }
    if (kind === 'cue') onSeek(cue.start);
    beginDrag(e, { kind, edge, cueKey: cue.key });
  };

  // While dragging, draw the edited timeline (a main-track move shows the committed one plus a ghost).
  const moving = drag?.moved && drag.kind === 'move';
  const mainMove = moving && project.clips.some((c) => c.id === drag.clipId);
  const preview = drag?.moved ? resultOf(drag) : null;
  const shownProject = preview && !mainMove ? preview.project : project;
  const shownItems = shownProject === project ? items : layout(shownProject);
  const shownCues = shownProject === project ? cues : projectCues(timelineWords(shownProject), shownProject);
  const shownTotal = Math.max(total, shownItems.at(-1)?.end ?? 0, ...shownCues.map((c) => c.end));
  // One screen of room after the end, so any time can be scrolled to the left edge (zoom keeps its anchor).
  const viewWidth = scrollRef.current ? scrollRef.current.clientWidth - HEAD : 1000;
  const width = Math.max(shownTotal * pps + viewWidth, 600);

  const timeAt = (clientX) => (clientX - innerRef.current.getBoundingClientRect().left - HEAD) / pps;
  const onScrub = (e) => {
    if (e.button !== 0) return;
    onSeek(timeAt(e.clientX));
    const move = (ev) => onSeek(timeAt(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const clearAndSeek = (clientX) => {
    dispatch({ type: 'selectBox', ids: [], keys: [] });
    onSeek(Math.max(0, timeAt(clientX)));
  };

  /**
   * Box select: press and drag draws a rectangle; every clip, layer item and caption it touches, on any
   * track, is selected live. Ctrl/Shift keeps the current selection. Near the edges the view scrolls.
   * A press that does not move calls `onClick` instead (by default: clear the selection and seek there).
   */
  const beginMarquee = (e, onClick = () => clearAndSeek(e.clientX)) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const inner = innerRef.current;
    const scroller = scrollRef.current;
    const add = e.ctrlKey || e.metaKey || e.shiftKey;
    const at = (cx, cy) => {
      const r = inner.getBoundingClientRect();
      return { x: Math.max(HEAD, cx - r.left), y: Math.max(0, cy - r.top) };
    };
    const a = at(e.clientX, e.clientY);
    let pointer = { x: e.clientX, y: e.clientY };
    let moved = false;
    let raf = 0;
    const update = () => {
      const b = at(pointer.x, pointer.y);
      const box = { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
      setMarquee(box);
      const r = inner.getBoundingClientRect();
      const hit = (el) => {
        const c = el.getBoundingClientRect();
        return c.right - r.left > box.left && c.left - r.left < box.right && c.bottom - r.top > box.top && c.top - r.top < box.bottom;
      };
      const ids = [...inner.querySelectorAll('[data-clip]')].filter(hit).map((el) => el.dataset.clip);
      const keys = [...inner.querySelectorAll('[data-cue]')].filter(hit).map((el) => el.dataset.cue);
      dispatch({ type: 'selectBox', ids, keys, add });
    };
    // Auto-scroll while the pointer is past an edge of the visible timeline, faster the further out it is.
    const tick = () => {
      const v = scroller.getBoundingClientRect();
      const over = (p, lo, hi) => (p < lo ? p - lo : p > hi ? p - hi : 0);
      const dx = over(pointer.x, v.left + HEAD + 20, v.right - 20);
      const dy = over(pointer.y, v.top + 30, v.bottom - 10);
      if (dx || dy) {
        scroller.scrollLeft += Math.sign(dx) * Math.min(40, Math.abs(dx) / 2 + 2);
        scroller.scrollTop += Math.sign(dy) * Math.min(30, Math.abs(dy) / 2 + 2);
        update();
      }
      raf = requestAnimationFrame(tick);
    };
    const move = (ev) => {
      pointer = { x: ev.clientX, y: ev.clientY };
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) <= DRAG_PX) return;
      if (!moved) raf = requestAnimationFrame(tick);
      moved = true;
      update();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      cancelAnimationFrame(raf);
      setMarquee(null);
      if (!moved) onClick();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const laneDown = (e) => {
    if (e.target === e.currentTarget) beginMarquee(e);
  };

  // ----- zoom: keep the time under the pointer (or the playhead, or the view centre) in place -----
  const zoomRef = useRef({});
  zoomRef.current = { pps, time, total: shownTotal };
  const pendingScroll = useRef(null);
  const zoomTo = (next, clientX) => {
    const el = scrollRef.current;
    const cur = zoomRef.current;
    const p = Math.min(MAX_PPS, Math.max(MIN_PPS, next));
    if (!el || Math.abs(p - cur.pps) < 1e-6) return;
    const view = el.clientWidth - HEAD;
    const head = cur.time * cur.pps - el.scrollLeft;
    const x = clientX !== undefined ? clientX - el.getBoundingClientRect().left - HEAD : head >= 0 && head <= view ? head : view / 2;
    pendingScroll.current = ((el.scrollLeft + x) / cur.pps) * p - x;
    setPps(p);
  };
  const zoomFit = () => {
    const el = scrollRef.current;
    if (!el || !(zoomRef.current.total > 0)) return;
    pendingScroll.current = 0;
    setPps(Math.min(MAX_PPS, Math.max(MIN_PPS, (el.clientWidth - HEAD - 30) / Math.max(zoomRef.current.total, 1))));
  };
  const zoomFns = useRef({});
  zoomFns.current = { zoomTo, zoomFit };

  // Fit the whole timeline into the window when added media makes it longer (import, + Main / + Layer,
  // a drop) and when a project is opened. Trims and splits keep the zoom.
  const elementCount = project.clips.length + tracks0.reduce((n, t) => n + t.items.length, 0);
  const seen = useRef({ n: elementCount, total });
  useEffect(() => {
    const prev = seen.current;
    if (elementCount > prev.n && total > prev.total + 1e-6) zoomFns.current.zoomFit();
    seen.current = { n: elementCount, total };
  }, [elementCount, total]);
  useEffect(() => {
    seen.current = { n: elementCount, total };
    zoomFns.current.zoomFit();
  }, [state.loadedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Drop target props for a lane: media dragged from the Media panel lands there at the pointer's time. */
  const dropProps = (target) => ({
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(MEDIA_DRAG)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (dropAt !== target) setDropAt(target);
    },
    onDragLeave: () => setDropAt(null),
    onDrop: (e) => {
      const id = e.dataTransfer.getData(MEDIA_DRAG);
      setDropAt(null);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      commands.placeMedia(id, target, Math.max(0, timeAt(e.clientX)));
    },
  });
  const dropClass = (target) => (dropAt === target ? ' drop-target' : '');

  useLayoutEffect(() => {
    if (pendingScroll.current === null || !scrollRef.current) return;
    scrollRef.current.scrollLeft = Math.max(0, pendingScroll.current);
    pendingScroll.current = null;
  }, [pps]);

  // Ctrl + wheel (and touchpad pinch, which Chromium sends as Ctrl + wheel) zooms at the pointer;
  // + / - zoom at the playhead, 0 fits the whole timeline.
  useEffect(() => {
    const el = scrollRef.current;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomFns.current.zoomTo(zoomRef.current.pps * Math.exp(-e.deltaY * 0.0015), e.clientX);
    };
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === '+' || e.key === '=') zoomFns.current.zoomTo(zoomRef.current.pps * ZOOM_STEP);
      else if (e.key === '-' || e.key === '_') zoomFns.current.zoomTo(zoomRef.current.pps / ZOOM_STEP);
      else if (e.key === '0') zoomFns.current.zoomFit();
      else return;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Keep the playhead in view while it moves (zooming keeps its own anchor).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || dragRef.current) return;
    const x = time * zoomRef.current.pps;
    const view = el.clientWidth - HEAD;
    if (x < el.scrollLeft || x > el.scrollLeft + view - 40) el.scrollLeft = Math.max(0, x - view * 0.3);
  }, [time]);

  // Ruler ticks only around the visible part: a zoomed-in hour would otherwise be tens of thousands of labels.
  const step = TICK_STEPS.find((s) => s * pps >= 70) ?? 14400;
  const ticks = [];
  const firstTick = Math.max(0, Math.floor((scrollX - viewWidth) / pps / step));
  const lastTick = Math.min(Math.floor(width / pps / step), Math.ceil((scrollX + 2 * viewWidth) / pps / step));
  for (let i = firstTick; i <= lastTick; i++) ticks.push(Math.round(i * step * 1000) / 1000);

  const tracks = shownProject.tracks ?? [];
  const layers = tracks.filter((t) => t.kind === 'layer').reverse();
  const audios = tracks.filter((t) => t.kind === 'audio');
  const setTrack = (id, patch) => dispatch({ type: 'edit', fn: (p) => updateTrack(p, id, patch) });
  const trackName = (t) => `${t.kind === 'layer' ? 'Layer' : 'Audio'} ${tracks.filter((x) => x.kind === t.kind).indexOf(t) + 1}`;

  const keyframeMarks = (el, span) => (el.id === selectedClipId && el.keyframes?.length ? el.keyframes.map((k) => (
    <span
      key={k.t}
      className={`kf${Math.abs(span.start + k.t - time) < 0.5 / fps ? ' on' : ''}`}
      style={{ left: k.t * pps }}
      title={`Keyframe at ${formatClock(span.start + k.t)}`}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSeek(span.start + k.t);
      }}
    />
  )) : null);

  const itemView = (track, it) => {
    const m = project.media[it.mediaId];
    const span = itemSpan(it, fps);
    const isDragged = drag?.clipId === it.id && drag.moved;
    const style = { left: span.start * pps, width: Math.max(span.duration * pps - 2, 4) };
    if (m && isStill(m)) Object.assign(style, { backgroundImage: `url("${mediaUrl(m.path)}")` });
    return (
      <div
        key={it.id}
        data-clip={it.id}
        className={`clip item k-${mediaKind(m)}${selectedIds.includes(it.id) ? ' selected' : ''}${isDragged ? ' dragged' : ''}${narrow(style.width)}`}
        style={style}
        onPointerDown={(e) => pickElement(e, it.id, 'move')}
        title={`${m?.name ?? 'missing'} · ${formatClock(span.start)}–${formatClock(span.end)}`}
      >
        <span className="clip-label">{m?.name ?? 'missing media'}</span>
        {(it.volume ?? 0) <= -40 && m?.hasAudio && <span className="badge">🔇</span>}
        {isDragged && drag.kind === 'trim' && <span className="badge dur">{formatClock(span.duration)}</span>}
        {keyframeMarks(it, span)}
        <span className="handle left" data-edge="in" onPointerDown={(e) => pickElement(e, it.id, 'trim', 'in')} />
        <span className="handle right" data-edge="out" onPointerDown={(e) => pickElement(e, it.id, 'trim', 'out')} />
      </div>
    );
  };

  const trackRow = (t) => (
    <div key={t.id} className={`row ${t.kind}${t.hidden ? ' hidden-track' : ''}`}>
      <div className="head">
        <span className="head-name">{trackName(t)}</span>
        {t.kind === 'layer' && (
          <button className={`icon${t.hidden ? ' off' : ''}`} title={t.hidden ? 'Show layer' : 'Hide layer'} onClick={() => setTrack(t.id, { hidden: !t.hidden })}>👁</button>
        )}
        <button className={`icon${t.muted ? ' off' : ''}`} title={t.muted ? 'Unmute track' : 'Mute track'} onClick={() => setTrack(t.id, { muted: !t.muted })}>{t.muted ? '🔇' : '🔊'}</button>
        {t.kind === 'layer' && (
          <>
            <button className="icon" title="Bring layer forward" onClick={() => dispatch({ type: 'edit', fn: (p) => moveTrack(p, t.id, 1) })}>▲</button>
            <button className="icon" title="Send layer backward" onClick={() => dispatch({ type: 'edit', fn: (p) => moveTrack(p, t.id, -1) })}>▼</button>
          </>
        )}
        <button
          className="icon danger"
          title="Delete track"
          onClick={() => (!t.items.length || confirm(`Delete ${trackName(t)} and its ${t.items.length} item(s)?`)) && dispatch({ type: 'edit', fn: (p) => removeTrack(p, t.id) })}
        >
          ✕
        </button>
      </div>
      <div className={`lane ${t.kind}${dropClass(t.id)}`} data-track={t.id} onPointerDown={laneDown} {...dropProps(t.id)}>
        {t.items.map((it) => itemView(t, it))}
      </div>
    </div>
  );

  const newLayerHint = moving && !mainMove && drag.newTrack;

  return (
    <section className="timeline">
      <div className="tl-toolbar">
        <button onClick={commands.splitAtPlayhead} disabled={!items.length && !tracks.some((t) => t.items.length)} title="Split at playhead (S)">Split</button>
        <button onClick={commands.openCrop} disabled={!(selectedIds.some((id) => { const f = findElement(project, id); return f && isVisual(project.media[f.el.mediaId]) && f.track?.kind !== 'audio'; }))} title="Crop the selected layers (Ctrl+click or drag a box on the timeline to pick several)">Crop</button>
        <button onClick={commands.deleteSelected} disabled={!selectedIds.length && !selectedCues.length} title="Delete selected (Del)">Delete</button>
        <button onClick={() => dispatch({ type: 'edit', fn: (p) => addTrack(p, 'layer') })} title="Add an empty layer in front">+ Layer</button>
        <button onClick={() => dispatch({ type: 'edit', fn: (p) => addTrack(p, 'audio') })} title="Add an empty audio track">+ Audio track</button>
        <span className="clock">{formatClock(time)}</span>
        <span className="hint">Drag edges to trim · drag clips to move or change layer · drag empty space to box-select · Ctrl+wheel to zoom</span>
        <span className="grow" />
        <div className="zoom" title="Zoom: Ctrl + mouse wheel or pinch on the timeline · + / - keys · 0 fits">
          <button onClick={() => zoomTo(pps / ZOOM_STEP)} title="Zoom out (-)">−</button>
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(sliderOf(pps) * 1000)}
            data-pps={pps}
            aria-label="Timeline zoom"
            onChange={(e) => zoomTo(ppsOf(Number(e.target.value) / 1000))}
          />
          <button onClick={() => zoomTo(pps * ZOOM_STEP)} title="Zoom in (+)">+</button>
          <button onClick={zoomFit} title="Show the whole timeline (0)">Fit</button>
        </div>
      </div>
      <div className="tl-scroll" ref={scrollRef} onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)}>
        <div
          className={`tl-inner${drag?.moved ? ' dragging' : ''}`}
          ref={innerRef}
          style={{ width: width + HEAD }}
          onPointerDown={(e) => e.target === e.currentTarget && e.clientX - e.currentTarget.getBoundingClientRect().left > HEAD && beginMarquee(e)}
        >
          <div className="row ruler-row">
            <div className="head" />
            <div className="ruler" onPointerDown={onScrub}>
              {ticks.map((t) => (
                <span key={t} className="tick" style={{ left: t * pps }}>
                  {formatClock(t).replace(/\.0$/, '')}
                </span>
              ))}
            </div>
          </div>
          <div className="row captions">
            <div className="head">
              <span className="head-name">Captions</span>
              <button
                className={`icon${project.captions.enabled ? '' : ' off'}`}
                title={project.captions.enabled ? 'Hide captions' : 'Show captions'}
                onClick={() => dispatch({ type: 'edit', fn: (p) => ({ ...p, captions: { ...p.captions, enabled: !p.captions.enabled } }) })}
              >
                👁
              </button>
            </div>
            <div className={`lane caption-track${dropClass('new')}`} onPointerDown={laneDown} {...dropProps('new')}>
              {shownCues.map((c) => (
                <div
                  key={c.key}
                  data-cue={c.key}
                  className={`cue${c.source === 'srt' ? ' srt' : ''}${selectedCues.includes(c.key) ? ' selected' : ''}${narrow((c.end - c.start) * pps)}`}
                  style={{ left: c.start * pps, width: Math.max((c.end - c.start) * pps - 1, 2) }}
                  title={c.text}
                  onPointerDown={(e) => pickCue(e, c, 'cue')}
                >
                  {c.text}
                  <span className="handle left" onPointerDown={(e) => pickCue(e, c, 'cue-trim', 'in')} />
                  <span className="handle right" onPointerDown={(e) => pickCue(e, c, 'cue-trim', 'out')} />
                </div>
              ))}
            </div>
          </div>
          {layers.map(trackRow)}
          <div className="row main">
            <div className="head">
              <span className="head-name">Main</span>
              <button
                className={`icon${project.main?.muted ? ' off' : ''}`}
                title={project.main?.muted ? 'Unmute main track' : 'Mute main track'}
                onClick={() => dispatch({ type: 'edit', fn: (p) => ({ ...p, main: { ...p.main, muted: !p.main?.muted } }) })}
              >
                {project.main?.muted ? '🔇' : '🔊'}
              </button>
            </div>
            <div className={`lane track video-track${dropClass('main')}`} onPointerDown={laneDown} {...dropProps('main')}>
              {shownItems.map((it) => {
                const m = project.media[it.clip.mediaId];
                const isDragged = drag?.clipId === it.clip.id;
                const style = { left: it.start * pps, width: Math.max(it.duration * pps - 2, 4) };
                if (mainMove && isDragged) Object.assign(style, { transform: `translateX(${drag.dx}px)` });
                if (m && isStill(m)) Object.assign(style, { backgroundImage: `url("${mediaUrl(m.path)}")` });
                const span = elementSpan(shownProject, it.clip.id, shownItems);
                return (
                  <div
                    key={it.clip.id}
                    data-clip={it.clip.id}
                    className={`clip k-${mediaKind(m)}${selectedIds.includes(it.clip.id) ? ' selected' : ''}${m?.hasVideo ? '' : ' audio'}${mainMove && isDragged ? ' ghost' : ''}${narrow(style.width)}`}
                    style={style}
                    onPointerDown={(e) => pickElement(e, it.clip.id, 'move')}
                    title={`${m?.name ?? 'missing'} · ${formatClock(it.clip.in)}–${formatClock(it.clip.out)}${it.clip.speed !== 1 ? ` · ${it.clip.speed}×` : ''}`}
                  >
                    {it.overlap > 0 && <span className="transition-mark" style={{ width: it.overlap * pps }} title={it.clip.transition.type} />}
                    <span className="clip-label">{m?.name ?? 'missing media'}</span>
                    {it.clip.speed !== 1 && <span className="badge">{it.clip.speed}×</span>}
                    {drag?.moved && drag.kind === 'trim' && isDragged && <span className="badge dur">{formatClock(it.duration)}</span>}
                    {span && keyframeMarks(it.clip, span)}
                    <span className="handle left" data-edge="in" onPointerDown={(e) => pickElement(e, it.clip.id, 'trim', 'in')} />
                    <span className="handle right" data-edge="out" onPointerDown={(e) => pickElement(e, it.clip.id, 'trim', 'out')} />
                  </div>
                );
              })}
              {mainMove && <div className="drop-marker" style={{ left: preview.marker * pps }} />}
            </div>
          </div>
          {audios.map(trackRow)}
          {newLayerHint && <div className="new-layer-hint">Drop for a new layer</div>}
          {marquee && (
            <div className="marquee" style={{ left: marquee.left, top: marquee.top, width: marquee.right - marquee.left, height: marquee.bottom - marquee.top }} />
          )}
          <div className="playhead" style={{ left: HEAD + time * pps }} />
        </div>
      </div>
    </section>
  );
}
