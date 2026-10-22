// Shared fixtures for the tests.
import { addMedia, appendClip, createProject } from '../../core/project.js';

/** Media entry with defaults a probe would give. */
export function media(id, duration, extra = {}) {
  return { id, path: `C:\\media\\${id}.mp4`, name: `${id}.mp4`, duration, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', words: null, ...extra };
}

/** Project with one clip per media entry, in order. */
export function projectWith(...entries) {
  let p = createProject();
  for (const m of entries) p = appendClip(addMedia(p, m), m.id);
  return p;
}

/** Evenly spaced words "w0 w1 ..." from `start`, `step` seconds apart, each `len` long. */
export function words(texts, start = 0, step = 0.5, len = 0.4) {
  return texts.map((text, i) => ({ text, start: start + i * step, end: start + i * step + len }));
}
