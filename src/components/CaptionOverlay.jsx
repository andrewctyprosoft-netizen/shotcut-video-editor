import { useRef } from 'react';
import { POP, captionAnim, cuesAt, isHighlighted, setCaptionStyle, wordIndexAt } from '../../core/captions.js';

const SNAP = 0.012;

/**
 * Captions drawn over the video: every cue on screen, each in its own style and text box. Sizes use
 * container-query units of the stage (cqh = 1% of frame height), matching the ASS style the export burns in.
 * Click a caption to select it (Ctrl/Shift+click adds); drag it to move, drag a side to change the box width,
 * drag a corner to resize the text. Edits go to every caption, or with "Apply to all" off, to the selected ones.
 */
export function CaptionOverlay({ cues, time, selectedKeys, scopeAll, dispatch, edit }) {
  const seq = useRef(0);
  const shown = cuesAt(cues, time);
  if (!shown.length) return null;

  const begin = (e, cue, mode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const multi = e.ctrlKey || e.metaKey || e.shiftKey;
    let keys = selectedKeys;
    if (multi) keys = selectedKeys.includes(cue.key) ? selectedKeys.filter((k) => k !== cue.key) : [...selectedKeys, cue.key];
    else if (!selectedKeys.includes(cue.key)) keys = [cue.key];
    if (keys !== selectedKeys) dispatch({ type: 'selectCues', keys });
    if (multi) return;
    const stage = e.currentTarget.closest('.stage').getBoundingClientRect();
    const s = cue.style;
    const start = { x: s.x ?? 0.5, width: s.width ?? 0.88, position: s.position, size: s.size };
    const target = scopeAll ? null : keys;
    const key = `drag:caption:${++seq.current}`;
    const move = (ev) => {
      const dx = (ev.clientX - e.clientX) / stage.width;
      const dy = (ev.clientY - e.clientY) / stage.height;
      let patch;
      if (mode === 'move') {
        let x = start.x + dx;
        if (Math.abs(x - 0.5) < SNAP) x = 0.5;
        patch = { x: round(x), position: round(clamp(start.position + dy, 0.05, 1)) };
      } else if (mode === 'e' || mode === 'w') {
        const d = mode === 'e' ? dx : -dx;
        const width = clamp(start.width + d, 0.1, 1.5);
        patch = { width: round(width), x: round(start.x + (mode === 'e' ? 1 : -1) * (width - start.width) / 2) };
      } else {
        const f = clamp(1 + ((mode.endsWith('e') ? dx : -dx) * 2) / start.width, 0.2, 5);
        patch = { size: round(clamp(start.size * f, 0.01, 0.3), 4), width: round(clamp(start.width * f, 0.1, 1.5)) };
      }
      edit((p) => setCaptionStyle(p, patch, target), key);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return shown.map((cue) => {
    const sel = selectedKeys.includes(cue.key);
    const anim = captionAnim(cue, cue.style, time);
    return (
      <CaptionLine
        key={cue.key}
        words={cue.words}
        active={wordIndexAt(cue, time)}
        style={cue.style}
        anim={anim}
        selected={sel}
        onDown={(e, mode) => begin(e, cue, mode)}
      />
    );
  });
}

/**
 * One caption line in a style. Also used for the preset previews (with a fixed `frameHeight` in pixels,
 * laid out inline).
 * @param {{words: Array<{text: string}>, active: number, style: object, frameHeight?: number, anim?: object,
 *   selected?: boolean, onDown?: (e: PointerEvent, mode: string) => void}} props
 */
export function CaptionLine({ words, active, style, frameHeight, anim, selected, onDown }) {
  // Inside the stage, 1cqh = 1% of the frame height; previews pass a pixel height instead.
  const u = (pct) => (frameHeight ? `${(pct * frameHeight) / 100}px` : `${pct}cqh`);
  const size = style.size * 100;
  const x = style.x ?? 0.5;
  const width = style.width ?? 0.88;
  const css = {
    fontFamily: `"${style.font}", sans-serif`,
    fontSize: u(size),
    fontWeight: style.bold ? 700 : 400,
    color: style.color,
    textTransform: style.uppercase ? 'uppercase' : 'none',
    ...(frameHeight ? {} : {
      left: `${(x - width / 2) * 100}%`,
      width: `${width * 100}%`,
      bottom: `${(1 - style.position) * 100}%`,
      opacity: anim?.opacity ?? 1,
      transform: anim && anim.scale !== 1 ? `scale(${anim.scale})` : undefined,
    }),
  };
  const inner = style.box
    ? { background: `${style.boxColor}bf`, padding: `0 ${u(size * 0.25)}`, boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone' }
    : { WebkitTextStroke: `${u(size * style.outline * 2)} ${style.outlineColor}`, paintOrder: 'stroke fill' };
  return (
    <div className={`caption${selected ? ' selected' : ''}${onDown ? ' live' : ''}`} style={css} onPointerDown={onDown && ((e) => onDown(e, 'move'))}>
      <span style={inner}>
        {words.map((w, i) => {
          const lit = style.wordHighlight && isHighlighted(style, i, active);
          const pop = lit && style.pop && i === active;
          return (
            <span key={i}>
              {i ? ' ' : ''}
              <span className={pop ? 'pop' : undefined} style={lit ? { color: style.highlight, '--pop': POP } : undefined}>{w.text}</span>
            </span>
          );
        })}
      </span>
      {selected && onDown && ['w', 'e', 'nw', 'ne', 'sw', 'se'].map((h) => (
        <span key={h} className={`cap-h ${h}`} onPointerDown={(e) => onDown(e, h)} />
      ))}
    </div>
  );
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function round(x, d = 3) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
