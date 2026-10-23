import { useEffect, useRef, useState } from 'react';
import { projectCues, setCueTiming } from '../../core/captions.js';
import {
  addTrack, elementSpan, findElement, isStill, itemSpan, layout, mediaKind, moveClipTo, moveItem, moveTrack, newId,
  removeTrack, trimClip, trimItem, updateTrack,
} from '../../core/project.js';
import { formatClock, snapTime } from '../../core/time.js';
import { timelineWords } from '../../core/transcript.js';
import { mediaUrl } from '../api.js';

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const SNAP_PX = 8;
const DRAG_PX = 3;
const HEAD = 156; // track header column, px (matches .row .head in styles.css)

/**
 * Timeline: ruler, caption track, layer tracks (front-most on top), the main track and audio tracks.
 * Click or drag the ruler to seek. Main track: drag a clip's edge to trim it, drag its body to reorder.
 * Layer and audio items: drag to move in time or to another track (above the top layer = a new layer),
 * drag an edge to trim or lengthen (images and GIFs have no fixed length). Captions: click to select
 * (Ctrl/Shift+click adds), drag an edge to change when it shows; imported subtitles can be dragged whole.
 * A drag previews live and commits as one undo step.
 */
export function Timeline({ state, items, cues, total, dispatch, onSeek, commands }) {
  const { project, time, selectedClipId, selectedCues } = state;
  const [pps, setPps] = useState(40); // pixels per second
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const scrollRef = useRef(null);
  const innerRef = useRef(null);
  const fps = project.fps || 30;

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
      dispatch({ type: 'selectCues', keys });
      return;
    }
    if (!selectedCues.includes(cue.key) || kind !== 'cue') dispatch({ type: 'selectCues', keys: [cue.key] });
    if (kind === 'cue' && cue.source !== 'srt') {
      e.stopPropagation();
      onSeek(cue.start);
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
  const width = Math.max((shownTotal + 10) * pps, 600);

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
  const laneDown = (e) => {
    if (e.target !== e.currentTarget) return;
    dispatch({ type: 'select', clipId: null });
    dispatch({ type: 'selectCues', keys: [] });
    onScrub(e);
  };

  // Keep the playhead in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || dragRef.current) return;
    const x = time * pps;
    const view = el.clientWidth - HEAD;
    if (x < el.scrollLeft || x > el.scrollLeft + view - 40) el.scrollLeft = Math.max(0, x - view * 0.3);
  }, [time, pps]);

  const step = TICK_STEPS.find((s) => s * pps >= 70) ?? 600;
  const ticks = [];
  for (let t = 0; t <= shownTotal + 10; t += step) ticks.push(t);

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
        className={`clip item k-${mediaKind(m)}${it.id === selectedClipId ? ' selected' : ''}${isDragged ? ' dragged' : ''}`}
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
      <div className={`lane ${t.kind}`} data-track={t.id} onPointerDown={laneDown}>
        {t.items.map((it) => itemView(t, it))}
      </div>
    </div>
  );

  const newLayerHint = moving && !mainMove && drag.newTrack;

  return (
    <section className="timeline">
      <div className="tl-toolbar">
        <button onClick={commands.splitAtPlayhead} disabled={!items.length && !tracks.some((t) => t.items.length)} title="Split at playhead (S)">Split</button>
        <button onClick={commands.deleteSelected} disabled={!selectedClipId && !selectedCues.length} title="Delete selected (Del)">Delete</button>
        <button onClick={() => dispatch({ type: 'edit', fn: (p) => addTrack(p, 'layer') })} title="Add an empty layer in front">+ Layer</button>
        <button onClick={() => dispatch({ type: 'edit', fn: (p) => addTrack(p, 'audio') })} title="Add an empty audio track">+ Audio track</button>
        <span className="clock">{formatClock(time)}</span>
        <span className="hint">Drag edges to trim · drag clips to move or change layer · Ctrl+click captions to pick several</span>
        <span className="grow" />
        <label className="zoom">
          Zoom
          <input type="range" min={5} max={300} value={pps} onChange={(e) => setPps(Number(e.target.value))} />
        </label>
      </div>
      <div className="tl-scroll" ref={scrollRef}>
        <div className={`tl-inner${drag?.moved ? ' dragging' : ''}`} ref={innerRef} style={{ width: width + HEAD }}>
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
            <div className="lane caption-track" onPointerDown={laneDown}>
              {shownCues.map((c) => (
                <div
                  key={c.key}
                  data-cue={c.key}
                  className={`cue${c.source === 'srt' ? ' srt' : ''}${selectedCues.includes(c.key) ? ' selected' : ''}`}
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
            <div className="lane track video-track" onPointerDown={laneDown}>
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
                    className={`clip k-${mediaKind(m)}${it.clip.id === selectedClipId ? ' selected' : ''}${m?.hasVideo ? '' : ' audio'}${mainMove && isDragged ? ' ghost' : ''}`}
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
          <div className="playhead" style={{ left: HEAD + time * pps }} />
        </div>
      </div>
    </section>
  );
}
