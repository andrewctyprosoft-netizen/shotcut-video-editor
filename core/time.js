// Time formatting helpers. Pure: safe in the renderer, the main process and tests.

/**
 * Round seconds to millisecond precision.
 * @param {number} sec
 * @returns {number}
 */
export function round3(sec) {
  return Math.round(sec * 1000) / 1000;
}

/**
 * Clock label for the UI: `m:ss.t`, or `h:mm:ss.t` from one hour.
 * @param {number} sec
 * @returns {string}
 */
export function formatClock(sec) {
  const tenths = Math.max(0, Math.round(sec * 10));
  const t = tenths % 10;
  const s = Math.floor(tenths / 10) % 60;
  const m = Math.floor(tenths / 600) % 60;
  const h = Math.floor(tenths / 36000);
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}.${t}` : `${m}:${ss}.${t}`;
}

/**
 * SRT timestamp `HH:MM:SS,mmm`.
 * @param {number} sec
 * @returns {string}
 */
export function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/**
 * ASS timestamp `H:MM:SS.cc` (centiseconds).
 * @param {number} sec
 * @returns {string}
 */
export function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const p = (n) => String(n).padStart(2, '0');
  return `${Math.floor(cs / 360000)}:${p(Math.floor(cs / 6000) % 60)}:${p(Math.floor(cs / 100) % 60)}.${p(cs % 100)}`;
}

/**
 * Snap `t` to the nearest target within `tolerance` seconds.
 * @param {number} t
 * @param {number[]} targets
 * @param {number} tolerance
 * @returns {number}
 */
export function snapTime(t, targets, tolerance) {
  let best = t;
  let dist = tolerance;
  for (const x of targets) {
    const d = Math.abs(x - t);
    if (d <= dist) {
      dist = d;
      best = x;
    }
  }
  return best;
}
