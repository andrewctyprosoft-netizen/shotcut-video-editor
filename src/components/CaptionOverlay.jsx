import { POP, cueAt, isHighlighted, wordIndexAt } from '../../core/captions.js';

/**
 * Caption preview drawn over the video. Sizes use container-query units of the stage (cqh = 1% of
 * frame height), matching the ASS style the export burns in.
 */
export function CaptionOverlay({ cues, time, style }) {
  const cue = cueAt(cues, time);
  if (!cue) return null;
  return <CaptionLine words={cue.words} active={wordIndexAt(cue, time)} style={style} />;
}

/**
 * One caption line in a style. Also used for the preset previews (with `unit` = 'px' and a fixed height).
 * @param {{words: Array<{text: string}>, active: number, style: object, frameHeight?: number}} props
 */
export function CaptionLine({ words, active, style, frameHeight }) {
  // Inside the stage, 1cqh = 1% of the frame height; previews pass a pixel height instead.
  const u = (pct) => (frameHeight ? `${(pct * frameHeight) / 100}px` : `${pct}cqh`);
  const size = style.size * 100;
  const css = {
    bottom: `${(1 - style.position) * 100}%`,
    fontFamily: `"${style.font}", sans-serif`,
    fontSize: u(size),
    fontWeight: style.bold ? 700 : 400,
    color: style.color,
    textTransform: style.uppercase ? 'uppercase' : 'none',
  };
  const inner = style.box
    ? { background: `${style.boxColor}bf`, padding: `0 ${u(size * 0.25)}`, boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone' }
    : { WebkitTextStroke: `${u(size * style.outline * 2)} ${style.outlineColor}`, paintOrder: 'stroke fill' };
  return (
    <div className="caption" style={css}>
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
    </div>
  );
}
