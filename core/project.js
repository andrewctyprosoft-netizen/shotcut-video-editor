// Project model and pure editing operations.
// Every operation returns a new project and never mutates its input, so the renderer can keep an undo history.
//
// The main track (`clips`) is magnetic: clips sit back to back and may overlap by a transition.
// Layer and audio tracks (`tracks`) hold items placed at any time. Layer order is stacking order:
// tracks[0] is just above the main track, the last layer track is in front of everything but captions.

import { DEFAULT_TRANSFORM } from './anim.js';
import { round3 } from './time.js';

export const PROJECT_VERSION = 2;

/** Aspect ratios as [width, height] units. */
export const ASPECTS = {
  '16:9': [16, 9],
  '9:16': [9, 16],
  '1:1': [1, 1],
  '4:5': [4, 5],
  '4:3': [4, 3],
};

/** Output resolutions, named by the short side of the frame. */
export const RESOLUTIONS = [720, 1080, 1440, 2160];
export const QUALITIES = ['high', 'standard', 'small'];

/** Shortest clip the editor keeps, in seconds. */
export const MIN_CLIP = 0.1;
/** Default length of an image on the timeline. Stills and looping GIFs can be stretched to any length. */
export const STILL_LENGTH = 5;
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
      x: 0.5, // centre of the text box, as a fraction of frame width
      width: 0.88, // text box width (lines wrap inside it), as a fraction of frame width
      uppercase: false,
      highlightMode: 'word', // 'word': only the spoken word; 'progressive': every word spoken so far (karaoke fill)
      pop: false, // enlarge the spoken word
      animIn: 'none', // 'none' | 'fade' | 'pop'
      animOut: 'none', // 'none' | 'fade'
    },
    // Per-caption changes keyed by cue key (see core/captions.js): { style?: {...}, dStart?: s, dEnd?: s }
    overrides: {},
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
    main: { muted: false },
    tracks: [],
    subtitles: [],
    captions: defaultCaptions(),
    glossary: [],
    export: defaultExport(),
    ...overrides,
  };
}

/**
 * Bring a project from any earlier version (or a hand-edited file) up to the current shape.
 * @param {object} project
 * @returns {object}
 */
export function normalizeProject(project) {
  const base = createProject();
  const caps = project.captions ?? base.captions;
  const media = Object.fromEntries(Object.entries(project.media ?? {}).map(([id, m]) => [id, { ...m, kind: mediaKind(m) }]));
  return {
    ...base,
    ...project,
    version: PROJECT_VERSION,
    media,
    clips: (project.clips ?? []).map((c) => ({ ...elementDefaults(), ...c })),
    main: { ...base.main, ...project.main },
    tracks: (project.tracks ?? []).map((t) => ({ hidden: false, muted: false, ...t, items: (t.items ?? []).map((i) => ({ ...elementDefaults(), ...i })) })),
    subtitles: project.subtitles ?? [],
    captions: { ...base.captions, ...caps, style: { ...base.captions.style, ...caps.style }, overrides: caps.overrides ?? {} },
    export: { ...base.export, ...project.export },
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

// ---------- media ----------

/**
 * 'video', 'audio', 'image' (a still) or 'gif' (an animation that loops: GIF or APNG).
 * @param {object} m media entry
 * @returns {string}
 */
export function mediaKind(m) {
  return m?.kind ?? (m?.hasVideo ? 'video' : 'audio');
}

/** Whether the media has a picture (video, image or GIF). */
export function isVisual(m) {
  return mediaKind(m) !== 'audio' && Boolean(m?.hasVideo ?? true);
}

/** Images and GIFs: no fixed length on the timeline, no speed change. */
export function isStill(m) {
  const k = mediaKind(m);
  return k === 'image' || k === 'gif';
}

/**
 * Add (or replace) a media entry. `info` comes from `parseProbe` plus `id` and `path`.
 * @param {object} project
 * @param {object} info
 * @returns {object}
 */
export function addMedia(project, info) {
  return { ...project, media: { ...project.media, [info.id]: { words: null, ...project.media[info.id], ...info, kind: mediaKind(info) } } };
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
 * Remove a media entry and every clip and item that uses it.
 * @param {object} project
 * @param {string} mediaId
 * @returns {object}
 */
export function removeMedia(project, mediaId) {
  const { [mediaId]: _gone, ...media } = project.media;
  const tracks = (project.tracks ?? []).map((t) => ({ ...t, items: t.items.filter((i) => i.mediaId !== mediaId) }));
  return normalizeTransitions({ ...project, media, tracks, clips: project.clips.filter((c) => c.mediaId !== mediaId) });
}

// ---------- main track ----------

/** Fields every clip and item has, with their neutral values. */
export function elementDefaults() {
  return {
    speed: 1,
    adjust: { brightness: 0, contrast: 1, saturation: 1 },
    transform: { ...DEFAULT_TRANSFORM },
    crop: null,
    keyframes: [],
    anim: { in: null, out: null },
    volume: 0, // dB; MUTE_DB (-40) and below = mute
    audioFade: { in: 0, out: 0 },
  };
}

/**
 * Append a clip covering the whole media (or `range`) at the end of the main track.
 * Images get STILL_LENGTH seconds.
 * @param {object} project
 * @param {string} mediaId
 * @param {{in?: number, out?: number, id?: string}} [range]
 * @returns {object}
 */
export function appendClip(project, mediaId, range = {}) {
  const m = project.media[mediaId];
  if (!m) throw new Error(`unknown media ${mediaId}`);
  const clip = {
    id: range.id ?? newId('clip'),
    mediaId,
    ...elementDefaults(),
    in: range.in ?? 0,
    out: range.out ?? naturalLength(m),
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
 * Keyframes and effects stay with the half they belong to.
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
  const [left, right] = splitElement(c, sourceTime);
  const clips = [...project.clips.slice(0, i), left, { ...right, transition: null }, ...project.clips.slice(i + 1)];
  return { ...project, clips };
}

/**
 * Split the main clip under timeline time `t`.
 * @param {object} project
 * @param {number} t
 * @returns {object}
 */
export function splitAt(project, t) {
  const hit = locate(project, t);
  return hit ? splitClip(project, hit.clip.id, hit.sourceTime) : project;
}

/**
 * Remove a clip from the main track.
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
 * Cut source time ranges out of every clip and item that uses `mediaId` (text-based editing).
 * A main clip that loses its middle becomes two clips; a track item becomes two items, the second moved
 * left to close the gap. Pieces shorter than MIN_CLIP are dropped.
 * @param {object} project
 * @param {string} mediaId
 * @param {Array<[number, number]>} ranges source-time [start, end) pairs
 * @returns {object}
 */
export function removeSourceRanges(project, mediaId, ranges) {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  if (!sorted.length) return project;
  const piecesOf = (c) => {
    let pieces = [[c.in, c.out]];
    for (const [s, e] of sorted) {
      pieces = pieces.flatMap(([a, b]) => (e <= a || s >= b ? [[a, b]] : [[a, Math.min(s, b)], [Math.max(e, a), b]]));
    }
    return pieces.filter(([a, b]) => b - a >= MIN_CLIP - EPS);
  };
  const clips = [];
  for (const c of project.clips) {
    if (c.mediaId !== mediaId) {
      clips.push(c);
      continue;
    }
    piecesOf(c).forEach(([a, b], k) => {
      clips.push({ ...c, id: k === 0 ? c.id : newId('clip'), in: a, out: b, transition: k === 0 ? c.transition : null });
    });
  }
  const fps = project.fps || 30;
  const tracks = (project.tracks ?? []).map((t) => {
    const items = t.items.flatMap((it) => {
      if (it.mediaId !== mediaId) return [it];
      let start = it.start;
      return piecesOf(it).map(([a, b], k) => {
        const piece = { ...it, id: k === 0 ? it.id : newId('item'), in: a, out: b, start: roundFrame(start, fps) };
        start += (b - a) / it.speed;
        return piece;
      });
    });
    return { ...t, items };
  });
  return normalizeTransitions({ ...project, clips, tracks });
}

/**
 * Main-track layout: where each clip sits. Durations are whole frames so preview, captions and the
 * FFmpeg export agree. A transition overlaps a clip with the one before it.
 * @param {object} project
 * @returns {Array<{clip: object, index: number, start: number, end: number, duration: number, overlap: number}>}
 */
export function layout(project) {
  const fps = project.fps || 30;
  const items = [];
  let end = 0;
  project.clips.forEach((clip, index) => {
    const duration = frames((clip.out - clip.in) / clip.speed, fps);
    const overlap = index > 0 && clip.transition ? transitionLength(clip.transition.duration, items[index - 1].duration, duration, fps) : 0;
    const start = end - overlap;
    end = start + duration;
    items.push({ clip, index, start, end, duration, overlap });
  });
  return items;
}

/**
 * Length of the main track in seconds.
 * @param {object} project
 * @returns {number}
 */
export function mainDuration(project) {
  const items = layout(project);
  return items.length ? items[items.length - 1].end : 0;
}

/**
 * Total timeline length: the main track, every track item and every imported subtitle.
 * @param {object} project
 * @returns {number}
 */
export function totalDuration(project) {
  let end = mainDuration(project);
  const fps = project.fps || 30;
  for (const t of project.tracks ?? []) for (const it of t.items) end = Math.max(end, itemSpan(it, fps).end);
  for (const s of project.subtitles ?? []) end = Math.max(end, s.end);
  return end;
}

/**
 * Find the main clip shown at timeline time `t`. During a transition the incoming clip wins.
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

// ---------- layer and audio tracks ----------

/**
 * Add an empty track. Layer tracks are added in front of the others unless `index` is given.
 * @param {object} project
 * @param {'layer' | 'audio'} kind
 * @param {{id?: string, index?: number}} [opts]
 * @returns {object}
 */
export function addTrack(project, kind, opts = {}) {
  const track = { id: opts.id ?? newId('track'), kind, hidden: false, muted: false, items: [] };
  const tracks = [...(project.tracks ?? [])];
  tracks.splice(opts.index ?? tracks.length, 0, track);
  return { ...project, tracks };
}

/**
 * Merge fields (hidden, muted, name) into a track.
 * @param {object} project
 * @param {string} trackId
 * @param {object} patch
 * @returns {object}
 */
export function updateTrack(project, trackId, patch) {
  return { ...project, tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) };
}

/**
 * Remove a track and its items.
 * @param {object} project
 * @param {string} trackId
 * @returns {object}
 */
export function removeTrack(project, trackId) {
  return { ...project, tracks: project.tracks.filter((t) => t.id !== trackId) };
}

/**
 * Move a track past `delta` tracks of the same kind (+1 = towards the front for layers).
 * @param {object} project
 * @param {string} trackId
 * @param {number} delta
 * @returns {object}
 */
export function moveTrack(project, trackId, delta) {
  const tracks = [...project.tracks];
  const i = tracks.findIndex((t) => t.id === trackId);
  if (i < 0) return project;
  const same = tracks.map((t, k) => (t.kind === tracks[i].kind ? k : -1)).filter((k) => k >= 0);
  const pos = same.indexOf(i) + delta;
  if (pos < 0 || pos >= same.length) return project;
  const [t] = tracks.splice(i, 1);
  tracks.splice(same[pos], 0, t);
  return { ...project, tracks };
}

/**
 * Put media on a track at timeline time `start`. With no track given, uses the lowest track of the
 * right kind ('audio' for audio files, else 'layer') that is free there, or adds a new one.
 * @param {object} project
 * @param {string} mediaId
 * @param {number} start
 * @param {{trackId?: string, id?: string, in?: number, out?: number}} [opts]
 * @returns {object}
 */
export function addItem(project, mediaId, start, opts = {}) {
  const m = project.media[mediaId];
  if (!m) throw new Error(`unknown media ${mediaId}`);
  const fps = project.fps || 30;
  const item = clampClip({
    id: opts.id ?? newId('item'),
    mediaId,
    ...elementDefaults(),
    transform: { ...DEFAULT_TRANSFORM, scale: isVisual(m) ? 0.5 : 1 },
    start: roundFrame(Math.max(0, start), fps),
    in: opts.in ?? 0,
    out: opts.out ?? naturalLength(m),
  }, m);
  return insertItem(project, item, opts.trackId, isVisual(m) ? 'layer' : 'audio');
}

/**
 * Merge `patch` into a track item, then clamp it to valid values.
 * @param {object} project
 * @param {string} itemId
 * @param {object} patch
 * @returns {object}
 */
export function updateItem(project, itemId, patch) {
  const fps = project.fps || 30;
  return mapItems(project, (it) => {
    if (it.id !== itemId) return it;
    const next = clampClip({ ...it, ...patch }, project.media[it.mediaId]);
    return { ...next, start: roundFrame(Math.max(0, next.start), fps) };
  });
}

/**
 * Remove a track item.
 * @param {object} project
 * @param {string} itemId
 * @returns {object}
 */
export function removeItem(project, itemId) {
  return { ...project, tracks: project.tracks.map((t) => ({ ...t, items: t.items.filter((i) => i.id !== itemId) })) };
}

/**
 * Move a track item in time and/or to another track of the same kind. When it would overlap an item
 * there, it goes to the next free track in front (a new one if needed). A track the move leaves empty
 * is removed, like CapCut.
 * @param {object} project
 * @param {string} itemId
 * @param {{start?: number, trackId?: string}} to
 * @returns {object}
 */
export function moveItem(project, itemId, to) {
  const found = findElement(project, itemId);
  if (found?.kind !== 'item') return project;
  const fps = project.fps || 30;
  const item = { ...found.el, start: roundFrame(Math.max(0, to.start ?? found.el.start), fps) };
  const target = project.tracks.find((t) => t.id === (to.trackId ?? found.track.id));
  const trackId = target && target.kind === found.track.kind ? target.id : found.track.id;
  const next = insertItem(removeItem(project, itemId), item, trackId, found.track.kind);
  const left = next.tracks.find((t) => t.id === found.track.id);
  return left && !left.items.length ? removeTrack(next, left.id) : next;
}

/**
 * Split a track item at timeline time `t`.
 * @param {object} project
 * @param {string} itemId
 * @param {number} t
 * @returns {object}
 */
export function splitItem(project, itemId, t) {
  const found = findElement(project, itemId);
  if (found?.kind !== 'item') return project;
  const it = found.el;
  const fps = project.fps || 30;
  const span = itemSpan(it, fps);
  if (t - span.start < MIN_CLIP - EPS || span.end - t < MIN_CLIP - EPS) return project;
  const [left, right] = splitElement(it, it.in + (t - it.start) * it.speed);
  const rightItem = { ...right, start: roundFrame(t, fps) };
  return {
    ...project,
    tracks: project.tracks.map((tr) => (tr.id !== found.track.id ? tr : {
      ...tr,
      items: tr.items.flatMap((x) => (x.id === itemId ? [left, rightItem] : [x])),
    })),
  };
}

/**
 * Trim a track item's edge to timeline time `t`. Trimming the start keeps the picture in place
 * (the in-point moves with the start), like CapCut.
 * @param {object} project
 * @param {string} itemId
 * @param {'in' | 'out'} edge
 * @param {number} t
 * @returns {object}
 */
export function trimItem(project, itemId, edge, t) {
  const found = findElement(project, itemId);
  if (found?.kind !== 'item') return project;
  const it = found.el;
  const fps = project.fps || 30;
  const span = itemSpan(it, fps);
  if (edge === 'out') {
    const end = Math.max(t, span.start + MIN_CLIP);
    return updateItem(project, itemId, { out: it.in + (end - it.start) * it.speed });
  }
  const start = Math.min(Math.max(t, it.start - it.in / it.speed), span.end - MIN_CLIP);
  const inT = it.in + (start - it.start) * it.speed;
  return updateItem(project, itemId, { start, in: Math.max(0, inT) });
}

/**
 * Where a track item sits on the timeline, in whole frames.
 * @param {object} item
 * @param {number} fps
 * @returns {{start: number, end: number, duration: number}}
 */
export function itemSpan(item, fps) {
  const duration = frames((item.out - item.in) / item.speed, fps);
  return { start: item.start, end: item.start + duration, duration };
}

/**
 * Track items on screen (or heard) at timeline time `t`, bottom track first.
 * @param {object} project
 * @param {number} t
 * @returns {Array<{item: object, track: object, start: number, end: number, duration: number, sourceTime: number}>}
 */
export function itemsAt(project, t) {
  const fps = project.fps || 30;
  const out = [];
  for (const track of project.tracks ?? []) {
    for (const item of track.items) {
      const span = itemSpan(item, fps);
      if (t >= span.start - 1e-9 && t < span.end - 1e-9) out.push({ item, track, ...span, sourceTime: item.in + (t - span.start) * item.speed });
    }
  }
  return out;
}

// ---------- any element (main clip or track item) ----------

/**
 * Find a main clip or track item by id.
 * @param {object} project
 * @param {string} id
 * @returns {{el: object, kind: 'clip' | 'item', track?: object} | null}
 */
export function findElement(project, id) {
  if (!id) return null;
  const clip = project.clips.find((c) => c.id === id);
  if (clip) return { el: clip, kind: 'clip' };
  for (const track of project.tracks ?? []) {
    const item = track.items.find((i) => i.id === id);
    if (item) return { el: item, kind: 'item', track };
  }
  return null;
}

/**
 * Merge `patch` into a main clip or track item.
 * @param {object} project
 * @param {string} id
 * @param {object} patch
 * @returns {object}
 */
export function updateElement(project, id, patch) {
  const found = findElement(project, id);
  if (!found) return project;
  return found.kind === 'clip' ? updateClip(project, id, patch) : updateItem(project, id, patch);
}

/**
 * Replace an element with `fn(element)` (for keyframe edits and other derived changes).
 * @param {object} project
 * @param {string} id
 * @param {(el: object) => object} fn
 * @returns {object}
 */
export function mapElement(project, id, fn) {
  const found = findElement(project, id);
  if (!found) return project;
  const next = fn(found.el);
  return next === found.el ? project : updateElement(project, id, next);
}

/**
 * Remove a main clip or a track item.
 * @param {object} project
 * @param {string} id
 * @returns {object}
 */
export function removeElement(project, id) {
  const found = findElement(project, id);
  if (!found) return project;
  return found.kind === 'clip' ? removeClip(project, id) : removeItem(project, id);
}

/**
 * Where an element sits on the timeline.
 * @param {object} project
 * @param {string} id
 * @param {ReturnType<typeof layout>} [items] precomputed main layout
 * @returns {{start: number, end: number, duration: number} | null}
 */
export function elementSpan(project, id, items = layout(project)) {
  const found = findElement(project, id);
  if (!found) return null;
  if (found.kind === 'item') return itemSpan(found.el, project.fps || 30);
  const it = items.find((i) => i.clip.id === id);
  return it ? { start: it.start, end: it.end, duration: it.duration } : null;
}

// ---------- imported subtitles ----------

/**
 * Replace the imported subtitles with `cues` ({start, end, text}, timeline seconds).
 * @param {object} project
 * @param {Array<{start: number, end: number, text: string}>} cues
 * @returns {object}
 */
export function setSubtitles(project, cues) {
  return { ...project, subtitles: cues.map((c) => ({ id: c.id ?? newId('sub'), start: round3(c.start), end: round3(c.end), text: c.text })) };
}

/**
 * Change one imported subtitle (text or timing); keeps at least MIN_CLIP of length.
 * @param {object} project
 * @param {string} id
 * @param {{start?: number, end?: number, text?: string}} patch
 * @returns {object}
 */
export function updateSubtitle(project, id, patch) {
  const subtitles = (project.subtitles ?? []).map((s) => {
    if (s.id !== id) return s;
    const next = { ...s, ...patch };
    next.start = round3(Math.max(0, next.start));
    next.end = round3(Math.max(next.end, next.start + MIN_CLIP));
    return next;
  });
  return { ...project, subtitles };
}

/**
 * Remove imported subtitles by id.
 * @param {object} project
 * @param {string[]} ids
 * @returns {object}
 */
export function removeSubtitles(project, ids) {
  const gone = new Set(ids);
  return { ...project, subtitles: (project.subtitles ?? []).filter((s) => !gone.has(s.id)) };
}

// ---------- helpers ----------

/** Transition length that fits both neighbours, rounded to whole frames. */
function transitionLength(wanted, prevDuration, duration, fps) {
  const max = Math.min(prevDuration, duration) - 1 / fps;
  const d = Math.min(Math.max(wanted, 0), max);
  return d > 0 ? Math.round(d * fps) / fps : 0;
}

function frames(seconds, fps) {
  return Math.max(1, Math.round(seconds * fps)) / fps;
}

function roundFrame(t, fps) {
  return Math.round(t * fps) / fps;
}

function naturalLength(m) {
  if (mediaKind(m) === 'image') return STILL_LENGTH;
  if (mediaKind(m) === 'gif') return Math.max(m.duration || 0, STILL_LENGTH);
  return m.duration;
}

function clampClip(c, media) {
  const still = isStill(media);
  const dur = still ? Infinity : media?.duration ?? c.out;
  const speed = still ? 1 : Math.min(4, Math.max(0.25, Number(c.speed) || 1));
  let inT = Math.min(Math.max(Number(c.in) || 0, 0), Math.max(dur - MIN_CLIP, 0));
  let outT = Math.min(Math.max(Number(c.out) || 0, inT + MIN_CLIP), dur);
  if (outT - inT < MIN_CLIP) inT = Math.max(0, outT - MIN_CLIP);
  return { ...c, in: round3(inT), out: round3(outT), speed };
}

/**
 * Two halves of an element split at a source time. Keyframes and the in/out effects go with their half.
 * @param {object} el
 * @param {number} sourceTime
 * @returns {[object, object]}
 */
function splitElement(el, sourceTime) {
  const cut = (sourceTime - el.in) / el.speed; // local timeline seconds
  const kfs = el.keyframes ?? [];
  const left = { ...el, out: sourceTime, keyframes: kfs.filter((k) => k.t <= cut + EPS), anim: { ...el.anim, out: null } };
  const right = {
    ...el,
    id: newId(el.id?.startsWith('item') ? 'item' : 'clip'),
    in: sourceTime,
    keyframes: kfs.filter((k) => k.t >= cut - EPS).map((k) => ({ ...k, t: Math.max(0, k.t - cut) })),
    anim: { ...el.anim, in: null },
  };
  return [left, right];
}

function mapItems(project, fn) {
  return { ...project, tracks: project.tracks.map((t) => ({ ...t, items: t.items.map(fn) })) };
}

/** Put `item` on `trackId` if it fits there, else on the next free track of `kind` in front (or a new one). */
function insertItem(project, item, trackId, kind) {
  const fps = project.fps || 30;
  const span = itemSpan(item, fps);
  const fits = (t) => t.kind === kind && t.items.every((o) => {
    const s = itemSpan(o, fps);
    return s.end <= span.start + EPS || s.start >= span.end - EPS;
  });
  let tracks = [...(project.tracks ?? [])];
  let i = trackId ? tracks.findIndex((t) => t.id === trackId) : tracks.findIndex((t) => t.kind === kind);
  if (i >= 0 && !fits(tracks[i])) {
    const j = tracks.findIndex((t, k) => k > i && fits(t));
    i = j;
  }
  if (i < 0) {
    const next = addTrack({ ...project, tracks }, kind);
    tracks = next.tracks;
    i = tracks.length - 1;
  }
  tracks[i] = { ...tracks[i], items: [...tracks[i].items, item].sort((a, b) => a.start - b.start) };
  return { ...project, tracks };
}

/** The first clip never has an incoming transition. */
function normalizeTransitions(project) {
  if (!project.clips.length || !project.clips[0].transition) return project;
  return { ...project, clips: [{ ...project.clips[0], transition: null }, ...project.clips.slice(1)] };
}
