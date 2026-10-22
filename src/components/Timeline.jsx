import { useEffect, useRef, useState } from 'react';
import { projectCues } from '../../core/captions.js';
import { layout, moveClipTo, trimClip } from '../../core/project.js';
import { formatClock, snapTime } from '../../core/time.js';
import { timelineWords } from '../../core/transcript.js';

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const SNAP_PX = 8;
const DRAG_PX = 3;

/**
 * Timeline: ruler, video track, caption track and playhead.
 * Click or drag the ruler to seek. Drag a clip's edge to trim it (snaps to the playhead), drag its body to reorder.
 * A drag previews live and commits as one undo step.
 */
export function Timeline({ project, items, cues, total, time, selectedClipId, dispatch, onSeek, commands }) {
  const [pps, setPps] = useState(40); // pixels per second
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const scrollRef = useRef(null);
  const innerRef = useRef(null);

  /** What a drag would do: the edited project, plus where to put the playhead or the drop marker. */
  const resultOf = (d) => {
    const it = items.find((i) => i.clip.id === d.clipId);
    if (!it) return { project };
    const c = it.clip;
    const dsec = d.dx / pps;
    if (d.kind === 'trim' && d.edge === 'out') {
      const edge = snapTime(it.end + dsec, [time, ...items.map((i) => i.start)], SNAP_PX / pps);
      const next = trimClip(project, c.id, 'out', c.in + (edge - it.start) * c.speed);
      const after = layout(next)[it.index];
      return { project: next, time: Math.max(after.start, after.end - 1 / (project.fps || 30)) };
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

  const beginDrag = (e, it, kind, edge) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    dispatch({ type: 'select', clipId: it.clip.id });
    const start = { kind, edge, clipId: it.clip.id, startX: e.clientX, dx: 0, moved: false };
    dragRef.current = start;
    setDrag(start);
    const move = (ev) => {
      const dx = ev.clientX - start.startX;
      const cur = { ...dragRef.current, dx, moved: dragRef.current.moved || Math.abs(dx) > DRAG_PX };
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

  // While trimming, draw the edited timeline; while moving, draw the committed one plus a ghost.
  const trimming = drag?.moved && drag.kind === 'trim';
  const moving = drag?.moved && drag.kind === 'move';
  const preview = drag?.moved ? resultOf(drag) : null;
  const shownProject = trimming ? preview.project : project;
  const shownItems = trimming ? layout(shownProject) : items;
  const shownCues = trimming ? projectCues(timelineWords(shownProject), shownProject) : cues;
  const shownTotal = shownItems.length ? shownItems[shownItems.length - 1].end : 0;
  const width = Math.max((Math.max(total, shownTotal) + 10) * pps, 600);

  const timeAt = (clientX) => (clientX - innerRef.current.getBoundingClientRect().left) / pps;
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

  // Keep the playhead in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || dragRef.current) return;
    const x = time * pps;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - el.clientWidth * 0.3);
  }, [time, pps]);

  const step = TICK_STEPS.find((s) => s * pps >= 70) ?? 600;
  const ticks = [];
  for (let t = 0; t <= Math.max(total, shownTotal) + 10; t += step) ticks.push(t);

  return (
    <section className="timeline">
      <div className="tl-toolbar">
        <button onClick={commands.splitAtPlayhead} disabled={!items.length} title="Split at playhead (S)">Split</button>
        <button onClick={commands.deleteSelected} disabled={!selectedClipId} title="Delete selected clip (Del)">Delete</button>
        <span className="clock">{formatClock(time)}</span>
        <span className="hint">Drag a clip's edge to trim · drag the clip to reorder</span>
        <span className="grow" />
        <label className="zoom">
          Zoom
          <input type="range" min={5} max={300} value={pps} onChange={(e) => setPps(Number(e.target.value))} />
        </label>
      </div>
      <div className="tl-scroll" ref={scrollRef}>
        <div className={`tl-inner${drag?.moved ? ' dragging' : ''}`} ref={innerRef} style={{ width }}>
          <div className="ruler" onPointerDown={onScrub}>
            {ticks.map((t) => (
              <span key={t} className="tick" style={{ left: t * pps }}>
                {formatClock(t).replace(/\.0$/, '')}
              </span>
            ))}
          </div>
          <div className="track video-track" onPointerDown={(e) => e.target === e.currentTarget && onScrub(e)}>
            {shownItems.map((it) => {
              const m = project.media[it.clip.mediaId];
              const isDragged = drag?.clipId === it.clip.id;
              const style = { left: it.start * pps, width: Math.max(it.duration * pps - 2, 4) };
              if (moving && isDragged) Object.assign(style, { transform: `translateX(${drag.dx}px)` });
              return (
                <div
                  key={it.clip.id}
                  data-clip={it.clip.id}
                  className={`clip${it.clip.id === selectedClipId ? ' selected' : ''}${m?.hasVideo ? '' : ' audio'}${moving && isDragged ? ' ghost' : ''}`}
                  style={style}
                  onPointerDown={(e) => beginDrag(e, it, 'move')}
                  title={`${m?.name ?? 'missing'} · ${formatClock(it.clip.in)}–${formatClock(it.clip.out)}${it.clip.speed !== 1 ? ` · ${it.clip.speed}×` : ''}`}
                >
                  {it.overlap > 0 && <span className="transition-mark" style={{ width: it.overlap * pps }} title={it.clip.transition.type} />}
                  <span className="clip-label">{m?.name ?? 'missing media'}</span>
                  {it.clip.speed !== 1 && <span className="badge">{it.clip.speed}×</span>}
                  {trimming && isDragged && <span className="badge dur">{formatClock(it.duration)}</span>}
                  <span className="handle left" data-edge="in" onPointerDown={(e) => beginDrag(e, it, 'trim', 'in')} />
                  <span className="handle right" data-edge="out" onPointerDown={(e) => beginDrag(e, it, 'trim', 'out')} />
                </div>
              );
            })}
            {moving && <div className="drop-marker" style={{ left: preview.marker * pps }} />}
          </div>
          <div className="track caption-track" onPointerDown={(e) => e.target === e.currentTarget && onScrub(e)}>
            {shownCues.map((c, i) => (
              <div
                key={i}
                className="cue"
                style={{ left: c.start * pps, width: Math.max((c.end - c.start) * pps - 1, 2) }}
                title={c.text}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onSeek(c.start);
                }}
              >
                {c.text}
              </div>
            ))}
          </div>
          <div className="playhead" style={{ left: time * pps }} />
        </div>
      </div>
    </section>
  );
}
