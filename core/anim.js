// Element animation and placement: transform (position, scale, opacity), keyframes with easing between
// them, in/out effects, audio gain envelopes, and where an element sits in the output frame (crop + fit +
// transform). Pure: the preview and the FFmpeg export use the same numbers.

/** Position is the centre of the element as a fraction of the frame; scale 1 = fitted to the frame. */
export const DEFAULT_TRANSFORM = { x: 0.5, y: 0.5, scale: 1, opacity: 1 };
export const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };
export const TRANSFORM_PROPS = ['x', 'y', 'scale', 'opacity'];
const MIN_CROP = 0.02;

/** Curves between one keyframe and the next: [value, label]. */
export const EASINGS = [
  ['linear', 'Linear'],
  ['in', 'Ease in'],
  ['out', 'Ease out'],
  ['inOut', 'Ease in-out'],
  ['hold', 'Hold (jump)'],
];

/** Entrance effects: [value, label]. */
export const IN_EFFECTS = [
  ['fade', 'Fade in'],
  ['slideLeft', 'Slide in from left'],
  ['slideRight', 'Slide in from right'],
  ['slideUp', 'Slide up from below'],
  ['slideDown', 'Slide down from above'],
  ['zoomIn', 'Zoom in'],
  ['zoomOut', 'Zoom out'],
  ['pop', 'Pop'],
];

/** Exit effects: [value, label]. */
export const OUT_EFFECTS = [
  ['fade', 'Fade out'],
  ['slideLeft', 'Slide out to left'],
  ['slideRight', 'Slide out to right'],
  ['slideUp', 'Slide out upwards'],
  ['slideDown', 'Slide out downwards'],
  ['zoomIn', 'Zoom in and fade'],
  ['zoomOut', 'Zoom out and fade'],
  ['pop', 'Shrink'],
];

/** Volume range in dB; MUTE_DB and below is silence. */
export const MUTE_DB = -40;
export const MAX_DB = 20;

/**
 * Easing curve value for linear progress `p` (0..1).
 * @param {string} name one of EASINGS, or 'back' (overshoot, for pop)
 * @param {number} p
 * @returns {number}
 */
export function ease(name, p) {
  const x = Math.min(1, Math.max(0, p));
  switch (name) {
    case 'in':
      return x * x * x;
    case 'out':
      return 1 - (1 - x) ** 3;
    case 'inOut':
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
    case 'hold':
      return x >= 1 ? 1 : 0;
    case 'back': {
      const c1 = 1.70158;
      return 1 + (c1 + 1) * (x - 1) ** 3 + c1 * (x - 1) ** 2;
    }
    default:
      return x;
  }
}

/**
 * Transform values at local time `t` from keyframes sorted by `t`. Each keyframe's `ease` shapes the
 * move to the next one; before the first and after the last keyframe the values hold.
 * @param {Array<{t: number, x: number, y: number, scale: number, opacity: number, ease?: string}>} keyframes
 * @param {number} t
 * @returns {{x: number, y: number, scale: number, opacity: number}}
 */
export function keyframeValues(keyframes, t) {
  const ks = keyframes;
  if (t <= ks[0].t) return pick(ks[0]);
  for (let i = 0; i + 1 < ks.length; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    if (t < b.t) {
      const e = ease(a.ease ?? 'linear', (t - a.t) / Math.max(b.t - a.t, 1e-9));
      return Object.fromEntries(TRANSFORM_PROPS.map((k) => [k, val(a, k) + (val(b, k) - val(a, k)) * e]));
    }
  }
  return pick(ks[ks.length - 1]);
}

/**
 * Transform at local time `t` before in/out effects: keyframes when there are any, else the static transform.
 * @param {object} el clip or track item
 * @param {number} t seconds from the element's start on the timeline
 * @returns {{x: number, y: number, scale: number, opacity: number}}
 */
export function baseState(el, t) {
  return el.keyframes?.length ? keyframeValues(el.keyframes, t) : { ...DEFAULT_TRANSFORM, ...el.transform };
}

/**
 * Effective in/out effect lengths: both fit inside the element.
 * @param {object} el
 * @param {number} duration element length on the timeline
 * @returns {{din: number, dout: number}}
 */
export function effectLengths(el, duration) {
  let din = el.anim?.in?.type ? Math.max(0, el.anim.in.duration ?? 0.5) : 0;
  let dout = el.anim?.out?.type ? Math.max(0, el.anim.out.duration ?? 0.5) : 0;
  if (din + dout > duration && din + dout > 0) {
    const k = duration / (din + dout);
    din *= k;
    dout *= k;
  }
  return { din, dout };
}

/**
 * Full visual state of an element at local time `t`: keyframes or transform, then in/out effects.
 * @param {object} el
 * @param {number} t seconds from the element's start
 * @param {number} duration element length on the timeline
 * @returns {{x: number, y: number, scale: number, opacity: number}}
 */
export function elementState(el, t, duration) {
  const s = baseState(el, t);
  const { din, dout } = effectLengths(el, duration);
  if (din > 0 && t < din) applyEffect(s, el.anim.in.type, t / din, 'in');
  if (dout > 0 && t > duration - dout) applyEffect(s, el.anim.out.type, (duration - t) / dout, 'out');
  return s;
}

/**
 * Whether the element moves, scales or fades over time (keyframes or effects).
 * @param {object} el
 * @returns {boolean}
 */
export function isAnimated(el) {
  return Boolean(el.keyframes?.length > 1 || el.anim?.in?.type || el.anim?.out?.type);
}

/**
 * Where a visual element sits in the frame. The cropped picture is fitted into the frame (contain, or
 * cover for 'fill'), multiplied by `scale` and centred at (x, y).
 * @param {{width: number, height: number}} media source size in pixels
 * @param {{x: number, y: number, w: number, h: number} | null} crop fractions of the source
 * @param {{x: number, y: number, scale: number, opacity: number}} state
 * @param {[number, number]} frame output width and height
 * @param {'fit' | 'fill'} [fit]
 * @returns {{box: Rect, full: Rect, crop: object, opacity: number} | null} box = the visible (cropped) picture,
 *   full = the whole uncropped source at the same scale; null for media without a picture
 * @typedef {{left: number, top: number, width: number, height: number}} Rect
 */
export function placement(media, crop, state, [W, H], fit = 'fit') {
  const sw = media?.width;
  const sh = media?.height;
  if (!sw || !sh) return null;
  const c = normCrop(crop);
  const cw = sw * c.w;
  const ch = sh * c.h;
  const base = fit === 'fill' ? Math.max(W / cw, H / ch) : Math.min(W / cw, H / ch);
  const k = base * Math.max(0, state.scale);
  const box = { left: state.x * W - (cw * k) / 2, top: state.y * H - (ch * k) / 2, width: cw * k, height: ch * k };
  const full = { left: box.left - c.x * sw * k, top: box.top - c.y * sh * k, width: sw * k, height: sh * k };
  return { box, full, crop: c, opacity: Math.min(1, Math.max(0, state.opacity)) };
}

/**
 * Clamp a crop rectangle to the source and a minimum size. Null means no crop.
 * @param {{x: number, y: number, w: number, h: number} | null} crop
 * @returns {{x: number, y: number, w: number, h: number}}
 */
export function normCrop(crop) {
  if (!crop) return { ...FULL_CROP };
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const w = Math.min(1, Math.max(MIN_CROP, n(crop.w, 1)));
  const h = Math.min(1, Math.max(MIN_CROP, n(crop.h, 1)));
  const x = Math.min(1 - w, Math.max(0, n(crop.x, 0)));
  const y = Math.min(1 - h, Math.max(0, n(crop.y, 0)));
  return { x, y, w, h };
}

/**
 * Whether a crop leaves the whole picture.
 * @param {object | null} crop
 * @returns {boolean}
 */
export function isFullCrop(crop) {
  const c = normCrop(crop);
  return c.x < 1e-4 && c.y < 1e-4 && c.w > 1 - 1e-4 && c.h > 1 - 1e-4;
}

// ---------- keyframe editing (pure: each returns a new element) ----------

/**
 * Keyframe at local time `t` (within half a frame), or null.
 * @param {object} el
 * @param {number} t
 * @param {number} fps
 * @returns {object | null}
 */
export function keyframeAt(el, t, fps) {
  return el.keyframes?.find((k) => Math.abs(k.t - t) <= 0.5 / fps + 1e-9) ?? null;
}

/**
 * Change transform values at local time `t`. With keyframes, this sets (or adds) the keyframe at `t`,
 * like CapCut; without, it changes the static transform.
 * @param {object} el
 * @param {number} t
 * @param {object} patch some of x, y, scale, opacity
 * @param {number} fps
 * @returns {object}
 */
export function setTransformAt(el, t, patch, fps) {
  if (!el.keyframes?.length) return { ...el, transform: { ...DEFAULT_TRANSFORM, ...el.transform, ...patch } };
  return upsertKeyframe(el, t, { ...baseState(el, t), ...patch }, fps);
}

/**
 * Add a keyframe at `t` holding the current values (or update the one already there).
 * The first keyframe starts from the static transform.
 * @param {object} el
 * @param {number} t
 * @param {number} fps
 * @returns {object}
 */
export function addKeyframe(el, t, fps) {
  return upsertKeyframe(el, t, baseState(el, t), fps);
}

/**
 * Remove the keyframe at `t`. Removing the last one keeps its values as the static transform.
 * @param {object} el
 * @param {number} t
 * @param {number} fps
 * @returns {object}
 */
export function removeKeyframe(el, t, fps) {
  const k = keyframeAt(el, t, fps);
  if (!k) return el;
  const keyframes = el.keyframes.filter((x) => x !== k);
  return keyframes.length ? { ...el, keyframes } : { ...el, keyframes, transform: pick(k) };
}

/**
 * Set the curve from the keyframe at `t` to the next one.
 * @param {object} el
 * @param {number} t
 * @param {string} easeName
 * @param {number} fps
 * @returns {object}
 */
export function setKeyframeEase(el, t, easeName, fps) {
  const k = keyframeAt(el, t, fps);
  if (!k) return el;
  return { ...el, keyframes: el.keyframes.map((x) => (x === k ? { ...x, ease: easeName } : x)) };
}

// ---------- audio ----------

/**
 * Linear gain for a volume in dB (MUTE_DB or below = 0).
 * @param {number} db
 * @returns {number}
 */
export function dbToGain(db) {
  const d = Number(db ?? 0);
  return d <= MUTE_DB ? 0 : 10 ** (Math.min(d, MAX_DB) / 20);
}

/**
 * Audio gain at local time `t`: volume times the fade-in/fade-out envelope.
 * @param {object} el
 * @param {number} t
 * @param {number} duration
 * @returns {number}
 */
export function audioGain(el, t, duration) {
  let g = dbToGain(el.volume);
  const fin = Math.min(el.audioFade?.in ?? 0, duration / 2);
  const fout = Math.min(el.audioFade?.out ?? 0, duration / 2);
  if (fin > 0 && t < fin) g *= Math.max(0, t / fin);
  if (fout > 0 && t > duration - fout) g *= Math.max(0, (duration - t) / fout);
  return g;
}

// ---------- helpers ----------

function upsertKeyframe(el, t, values, fps) {
  const existing = keyframeAt(el, t, fps);
  const kf = { ease: existing?.ease ?? 'linear', ...pick(values), t: existing?.t ?? Math.max(0, Math.round(t * fps) / fps) };
  const keyframes = [...(el.keyframes ?? []).filter((k) => k !== existing), kf].sort((a, b) => a.t - b.t);
  return { ...el, keyframes };
}

function pick(o) {
  return Object.fromEntries(TRANSFORM_PROPS.map((k) => [k, val(o, k)]));
}

function val(o, k) {
  return Number.isFinite(o?.[k]) ? o[k] : DEFAULT_TRANSFORM[k];
}

/** `p` is linear progress, 1 = the element's normal state, 0 = fully in/out. Mutates `s`. */
function applyEffect(s, type, p, mode) {
  const q = ease('out', p);
  const away = 1 - q;
  switch (type) {
    case 'fade':
      s.opacity *= q;
      break;
    case 'slideLeft':
      s.x -= away;
      break;
    case 'slideRight':
      s.x += away;
      break;
    case 'slideUp':
      s.y += mode === 'in' ? away : -away;
      break;
    case 'slideDown':
      s.y += mode === 'in' ? -away : away;
      break;
    case 'zoomIn':
      s.scale *= mode === 'in' ? 0.5 + 0.5 * q : 1 + 0.5 * away;
      s.opacity *= q;
      break;
    case 'zoomOut':
      s.scale *= mode === 'in' ? 1 + 0.5 * away : 0.5 + 0.5 * q;
      s.opacity *= q;
      break;
    case 'pop':
      s.scale *= mode === 'in' ? Math.max(0, ease('back', p)) : q;
      s.opacity *= Math.min(1, p * 3);
      break;
    default:
      break;
  }
}
