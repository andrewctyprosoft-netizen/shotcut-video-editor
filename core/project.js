// Project model and pure editing operations.
// Every operation returns a new project and never mutates its input, so the renderer can keep an undo history.

import { round3 } from './time.js';

export const PROJECT_VERSION = 1;

/** Aspect ratios as [width, height] units. */
export const ASPECTS = {
  '16:9': [16, 9],
  '9:16': [9, 16],
  '1:1': [1, 1],
};

/** Output resolutions, named by the short side of the frame. */
export const RESOLUTIONS = [720, 1080, 1440, 2160];
export const QUALITIES = ['high', 'standard', 'small'];

/** Shortest clip the editor keeps, in seconds. */
export const MIN_CLIP = 0.1;
const EPS = 1e-6;
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** FFmpeg `xfade` transitions offered in the UI: [value, label]. */
export const TRANSITIONS = [
  ['fade', 'Fade'],
  ['fadeblack', 'Dip to black'],
  ['fadewhite', 'Dip to white'],
  ['dissolve', 'Dissolve'],
  ['wipeleft', 'Wipe left'],
  ['wiperight', 'Wipe right'],
  ['slideleft', 'Slide left'],
  ['slideright', 'Slide right'],
  ['smoothleft', 'Smooth left'],
  ['circleopen', 'Circle open'],
  ['circleclose', 'Circle close'],
  ['radial', 'Radial'],
  ['pixelize', 'Pixelize'],
  ['zoomin', 'Zoom in'],
];

/** @returns {object} default caption settings */
export function defaultCaptions() {
  return {
    enabled: true,
    maxChars: 32,
    maxDuration: 3.5,
    style: {
      font: 'Arial',
      size: 0.06, // fraction of frame height
      bold: true,
      color: '#FFFFFF',
      highlight: '#FFD400',
      wordHighlight: true,
      outlineColor: '#000000',
      outline: 0.08, // fraction of font size
      box: false,
      boxColor: '#000000',
      position: 0.85, // bottom of the text, as a fraction of frame height
      uppercase: false,
      highlightMode: 'word', // 'word': only the spoken word; 'progressive': every word spoken so far (karaoke fill)
      pop: false, // enlarge the spoken word
    },
  };
}

/** @returns {{resolution: number, quality: string}} default export settings */
export function defaultExport() {
  return { resolution: 1080, quality: 'high' };
}

/**
 * New empty project.
 * @param {object} [overrides]
 * @returns {object}
 */
export function createProject(overrides = {}) {
  return {
    version: PROJECT_VERSION,
    aspect: '16:9',
    fit: 'fit',
    fps: 30,
    media: {},
    clips: [],
    captions: defaultCaptions(),
    glossary: [],
    export: defaultExport(),
    ...overrides,
  };
}

/**
 * Output frame size from the aspect ratio and the export resolution (short side), in even pixels.
 * @param {object} project
 * @returns {[number, number]}
 */
export function frameSize(project) {
  const [w, h] = ASPECTS[project.aspect] ?? ASPECTS['16:9'];
  const short = project.export?.resolution ?? 1080;
  const even = (x) => Math.round(x / 2) * 2;
  return w >= h ? [even((short * w) / h), short] : [short, even((short * h) / w)];
}

/** @returns {string} a random id with a readable prefix */
export function newId(prefix) {
  return `${prefix}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Add (or replace) a media entry. `info` comes from `parseProbe` plus `id` and `path`.
 * @param {object} project
 * @param {object} info
 * @returns {object}
 */
export function addMedia(project, info) {
  return { ...project, media: { ...project.media, [info.id]: { words: null, ...project.media[info.id], ...info } } };
}

/**
 * Shallow-merge fields into a media entry.
 * @param {object} project
 * @param {string} mediaId
 * @param {object} patch
 * @returns {object}
 */
export function updateMedia(project, mediaId, patch) {
  const m = project.media[mediaId];
  if (!m) return project;
  return { ...project, media: { ...project.media, [mediaId]: { ...m, ...patch } } };
}

/**
 * Remove a media entry and every clip that uses it.
 * @param {object} project
 * @param {string} mediaId
 * @returns {object}
 */
export function removeMedia(project, mediaId) {
  const { [mediaId]: _gone, ...media } = project.media;
  return normalizeTransitions({ ...project, media, clips: project.clips.filter((c) => c.mediaId !== mediaId) });
}

/**
 * Append a clip covering the whole media (or `range`) at the end of the timeline.
 * @param {object} project
 * @param {string} mediaId
 * @param {{in?: number, out?: number}} [range]
 * @returns {object}
 */
export function appendClip(project, mediaId, range = {}) {
  const m = project.media[mediaId];
  if (!m) throw new Error(`unknown media ${mediaId}`);
  const clip = {
    id: newId('clip'),
    mediaId,
    in: range.in ?? 0,
    out: range.out ?? m.duration,
    speed: 1,
    adjust: { brightness: 0, contrast: 1, saturation: 1 },
    transition: null,
  };
  return { ...project, clips: [...project.clips, clampClip(clip, m)] };
}

/**
 * Merge `patch` into a clip, then clamp it to valid values.
 * @param {object} project
 * @param {string} clipId
 * @param {object} patch
 * @returns {object}
 */
export function updateClip(project, clipId, patch) {
  const clips = project.clips.map((c) => (c.id === clipId ? clampClip({ ...c, ...patch }, project.media[c.mediaId]) : c));
  return normalizeTransitions({ ...project, clips });
}

/**
 * Split a clip at a source time into two clips. Out-of-range times leave the project unchanged.
 * @param {object} project
 * @param {string} clipId
 * @param {number} sourceTime seconds in the clip's media
 * @returns {object}
 */
export function splitClip(project, clipId, sourceTime) {
  const i = project.clips.findIndex((c) => c.id === clipId);
  if (i < 0) return project;
  const c = project.clips[i];
  if (sourceTime - c.in < MIN_CLIP - EPS || c.out - sourceTime < MIN_CLIP - EPS) return project;
  const left = { ...c, out: sourceTime };
  const right = { ...c, id: newId('clip'), in: sourceTime, transition: null };
  const clips = [...project.clips.slice(0, i), left, right, ...project.clips.slice(i + 1)];
  return { ...project, clips };
}

/**
 * Split the clip under timeline time `t`.
 * @param {object} project
 * @param {number} t
 * @returns {object}
 */
export function splitAt(project, t) {
  const hit = locate(project, t);
  return hit ? splitClip(project, hit.clip.id, hit.sourceTime) : project;
}

/**
 * Remove a clip from the timeline.
 * @param {object} project
 * @param {string} clipId
 * @returns {object}
 */
export function removeClip(project, clipId) {
  return normalizeTransitions({ ...project, clips: project.clips.filter((c) => c.id !== clipId) });
}

/**
 * Move a clip `delta` places left (negative) or right (positive).
 * @param {object} project
 * @param {string} clipId
 * @param {number} delta
 * @returns {object}
 */
export function moveClip(project, clipId, delta) {
  const i = project.clips.findIndex((c) => c.id === clipId);
  return i < 0 ? project : moveClipTo(project, clipId, i + delta);
}

/**
 * Move a clip to position `index` (0-based, in the order after removal).
 * @param {object} project
 * @param {string} clipId
 * @param {number} index
 * @returns {object}
 */
export function moveClipTo(project, clipId, index) {
  const i = project.clips.findIndex((c) => c.id === clipId);
  if (i < 0) return project;
  const j = Math.max(0, Math.min(project.clips.length - 1, index));
  if (i === j) return project;
  const clips = [...project.clips];
  const [c] = clips.splice(i, 1);
  clips.splice(j, 0, c);
  return normalizeTransitions({ ...project, clips });
}

/**
 * Trim one edge of a clip to a source time, never past the other edge (keeps MIN_CLIP).
 * @param {object} project
 * @param {string} clipId
 * @param {'in' | 'out'} edge
 * @param {number} sourceTime
 * @returns {object}
 */
export function trimClip(project, clipId, edge, sourceTime) {
  const c = project.clips.find((x) => x.id === clipId);
  if (!c) return project;
  const patch = edge === 'in'
    ? { in: Math.min(sourceTime, c.out - MIN_CLIP) }
    : { out: Math.max(sourceTime, c.in + MIN_CLIP) };
  return updateClip(project, clipId, patch);
}

/**
 * Cut source time ranges out of every clip that uses `mediaId` (text-based editing).
 * A clip that loses its middle becomes two clips; pieces shorter than MIN_CLIP are dropped.
 * @param {object} project
 * @param {string} mediaId
 * @param {Array<[number, number]>} ranges source-time [start, end) pairs
 * @returns {object}
 */
export function removeSourceRanges(project, mediaId, ranges) {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  if (!sorted.length) return project;
  const clips = [];
  for (const c of project.clips) {
    if (c.mediaId !== mediaId) {
      clips.push(c);
      continue;
    }
    let pieces = [[c.in, c.out]];
    for (const [s, e] of sorted) {
      pieces = pieces.flatMap(([a, b]) => (e <= a || s >= b ? [[a, b]] : [[a, Math.min(s, b)], [Math.max(e, a), b]]));
    }
    pieces = pieces.filter(([a, b]) => b - a >= MIN_CLIP - EPS);
    pieces.forEach(([a, b], k) => {
      clips.push({ ...c, id: k === 0 ? c.id : newId('clip'), in: a, out: b, transition: k === 0 ? c.transition : null });
    });
  }
  return normalizeTransitions({ ...project, clips });
}

/**
 * Timeline layout: where each clip sits. Durations are whole frames so preview, captions and the
 * FFmpeg export agree. A transition overlaps a clip with the one before it.
 * @param {object} project
 * @returns {Array<{clip: object, index: number, start: number, end: number, duration: number, overlap: number}>}
 */
export function layout(project) {
  const fps = project.fps || 30;
  const items = [];
  let end = 0;
  project.clips.forEach((clip, index) => {
    const duration = Math.max(1, Math.round(((clip.out - clip.in) / clip.speed) * fps)) / fps;
    const overlap = index > 0 && clip.transition ? transitionLength(clip.transition.duration, items[index - 1].duration, duration, fps) : 0;
    const start = end - overlap;
    end = start + duration;
    items.push({ clip, index, start, end, duration, overlap });
  });
  return items;
}

/**
 * Total timeline length in seconds.
 * @param {object} project
 * @returns {number}
 */
export function totalDuration(project) {
  const items = layout(project);
  return items.length ? items[items.length - 1].end : 0;
}

/**
 * Find the clip shown at timeline time `t`. During a transition the incoming clip wins.
 * @param {object} project
 * @param {number} t
 * @param {ReturnType<typeof layout>} [items] precomputed layout
 * @returns {{item: object, clip: object, sourceTime: number} | null}
 */
export function locate(project, t, items = layout(project)) {
  if (!items.length) return null;
  let item = items[0];
  for (const it of items) {
    if (it.start <= t + 1e-9) item = it;
    else break;
  }
  const local = Math.min(Math.max(t - item.start, 0), item.duration);
  const sourceTime = Math.min(item.clip.in + local * item.clip.speed, item.clip.out);
  return { item, clip: item.clip, sourceTime };
}

/**
 * Timeline time where a clip's source time appears.
 * @param {object} item a layout item
 * @param {number} sourceTime
 * @returns {number}
 */
export function toTimeline(item, sourceTime) {
  return item.start + (sourceTime - item.clip.in) / item.clip.speed;
}

// ---------- helpers ----------

/** Transition length that fits both neighbours, rounded to whole frames. */
function transitionLength(wanted, prevDuration, duration, fps) {
  const max = Math.min(prevDuration, duration) - 1 / fps;
  const d = Math.min(Math.max(wanted, 0), max);
  return d > 0 ? Math.round(d * fps) / fps : 0;
}

function clampClip(c, media) {
  const dur = media?.duration ?? c.out;
  const speed = Math.min(4, Math.max(0.25, Number(c.speed) || 1));
  let inT = Math.min(Math.max(Number(c.in) || 0, 0), Math.max(dur - MIN_CLIP, 0));
  let outT = Math.min(Math.max(Number(c.out) || 0, inT + MIN_CLIP), dur);
  if (outT - inT < MIN_CLIP) inT = Math.max(0, outT - MIN_CLIP);
  return { ...c, in: round3(inT), out: round3(outT), speed };
}

/** The first clip never has an incoming transition. */
function normalizeTransitions(project) {
  if (!project.clips.length || !project.clips[0].transition) return project;
  return { ...project, clips: [{ ...project.clips[0], transition: null }, ...project.clips.slice(1)] };
}
