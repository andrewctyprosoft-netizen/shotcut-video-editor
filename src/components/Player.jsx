import { useEffect, useRef } from 'react';
import { frameSize } from '../../core/project.js';
import { formatClock } from '../../core/time.js';
import { mediaUrl } from '../api.js';
import { PlaybackEngine } from '../playback.js';
import { CaptionOverlay } from './CaptionOverlay.jsx';

/**
 * Preview: two stacked <video> elements driven by PlaybackEngine (gap-free clip changes), with the
 * caption overlay on top. While playing, the engine's clock drives timeline time; otherwise time drives the engine.
 */
export function Player({ project, items, cues, time, total, playing, dispatch, onTogglePlay }) {
  const v0 = useRef(null);
  const v1 = useRef(null);
  const engine = useRef(null);
  const reported = useRef(-1); // last time the engine reported, so its own updates don't trigger a seek
  const latest = useRef({ project, time });
  latest.current = { project, time };

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
      styleFor: filterOf,
      onTime: (t) => {
        reported.current = t;
        dispatch({ type: 'time', time: t });
      },
      onEnd: () => dispatch({ type: 'play', playing: false }),
    });
    window.__vcePlayback = engine.current; // debugging and end-to-end checks
    return () => engine.current.pause();
  }, [dispatch]);

  // The project changed (edit, proxy ready, load): give the engine the new layout.
  useEffect(() => {
    engine.current.sync(items, latest.current.time);
  }, [items, project.media]);

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

  const [W, H] = frameSize(project);
  const fit = project.fit === 'fill' ? 'fill' : 'fit';
  return (
    <section className="player">
      <div className="stage-wrap">
        <div className="stage" style={{ '--ar': W / H, aspectRatio: `${W} / ${H}` }} onClick={onTogglePlay}>
          <video ref={v0} className={fit} preload="auto" />
          <video ref={v1} className={fit} preload="auto" />
          {!items.length && <div className="stage-empty">Import media to start</div>}
          {project.captions.enabled && <CaptionOverlay cues={cues} time={time} style={project.captions.style} />}
        </div>
      </div>
      <div className="transport">
        <button className="play" onClick={onTogglePlay} disabled={!items.length} title="Play / pause (Space)">
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="clock">
          {formatClock(time)} / {formatClock(total)}
        </span>
        <span className="hint">S split · Del delete · ←/→ frame · Shift+←/→ second</span>
      </div>
    </section>
  );
}
