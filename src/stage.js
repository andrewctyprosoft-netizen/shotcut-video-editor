// Map core placement (frame pixels) onto the preview stage (percentages), and the CSS look of main-track
// transitions. Pure: no DOM access.

/**
 * CSS for a rectangle in frame pixels, as percentages of the stage.
 * @param {{left: number, top: number, width: number, height: number}} r
 * @param {[number, number]} frame
 * @returns {object}
 */
export function rectCss(r, [W, H]) {
  return { left: `${(r.left / W) * 100}%`, top: `${(r.top / H) * 100}%`, width: `${(r.width / W) * 100}%`, height: `${(r.height / H) * 100}%` };
}

/**
 * CSS for a picture element: the whole source at its placed size, clipped to the crop, faded.
 * @param {ReturnType<import('../core/anim.js').placement>} p
 * @param {[number, number]} frame
 * @returns {object}
 */
export function pictureCss(p, frame) {
  const c = p.crop;
  const pct = (x) => `${Math.max(0, x * 100)}%`;
  return {
    ...rectCss(p.full, frame),
    clipPath: `inset(${pct(c.y)} ${pct(1 - c.x - c.w)} ${pct(1 - c.y - c.h)} ${pct(c.x)})`,
    opacity: p.opacity,
  };
}

/**
 * How a main-track transition looks at progress `p` (0..1): styles for the incoming and outgoing
 * pictures, an optional colour dip over both, and which one is on top. CSS approximations of the
 * FFmpeg `xfade` transitions the export renders.
 * @param {string} type xfade transition name
 * @param {number} p
 * @returns {{incoming: object, outgoing: object, dip: {color: string, opacity: number} | null, outgoingOnTop: boolean}}
 */
export function transitionCss(type, p) {
  const q = Math.min(1, Math.max(0, p));
  const pct = (x) => `${x * 100}%`;
  switch (type) {
    case 'fadeblack':
    case 'fadewhite':
      return {
        incoming: { opacity: q < 0.5 ? 0 : 1 },
        outgoing: { opacity: q < 0.5 ? 1 : 0 },
        dip: { color: type === 'fadeblack' ? '#000' : '#fff', opacity: 1 - Math.abs(1 - 2 * q) },
        outgoingOnTop: false,
      };
    case 'wipeleft':
      return { incoming: { clipPath: `inset(0 0 0 ${pct(1 - q)})` }, outgoing: {}, dip: null, outgoingOnTop: false };
    case 'wiperight':
      return { incoming: { clipPath: `inset(0 ${pct(1 - q)} 0 0)` }, outgoing: {}, dip: null, outgoingOnTop: false };
    case 'slideleft':
    case 'smoothleft':
      return { incoming: { transform: `translateX(${pct(1 - q)})` }, outgoing: { transform: `translateX(${pct(-q)})` }, dip: null, outgoingOnTop: false };
    case 'slideright':
      return { incoming: { transform: `translateX(${pct(q - 1)})` }, outgoing: { transform: `translateX(${pct(q)})` }, dip: null, outgoingOnTop: false };
    case 'circleopen':
      return { incoming: { clipPath: `circle(${q * 71}% at 50% 50%)` }, outgoing: {}, dip: null, outgoingOnTop: false };
    case 'circleclose':
      return { incoming: {}, outgoing: { clipPath: `circle(${(1 - q) * 71}% at 50% 50%)` }, dip: null, outgoingOnTop: true };
    case 'zoomin':
      return { incoming: {}, outgoing: { transform: `scale(${1 + q})`, opacity: 1 - q }, dip: null, outgoingOnTop: true };
    default: // fade, dissolve, radial, pixelize: a cross-fade
      return { incoming: { opacity: q }, outgoing: {}, dip: null, outgoingOnTop: false };
  }
}
