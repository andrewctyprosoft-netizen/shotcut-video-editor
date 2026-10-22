// Transcript operations: map ASR words onto the timeline and turn word selections into cuts.
// Words use the Transcript QC `words.json` shape: { text, start, end } in media (source) seconds,
// with an optional `br: true` that forces a caption break after the word.

import { layout, toTimeline, updateMedia } from './project.js';

export const DEFAULT_FILLERS = ['um', 'uh', 'uhm', 'umm', 'erm', 'er', 'ah', 'hmm', 'mm'];

/**
 * Words that survive the current cuts, in timeline seconds.
 * A word belongs to a clip when its midpoint is inside the clip; during a transition the incoming clip wins.
 * @param {object} project
 * @returns {Array<{text: string, start: number, end: number, mediaId: string, index: number, clipId: string, br?: boolean}>}
 */
export function timelineWords(project) {
  const items = layout(project);
  const out = [];
  items.forEach((item, k) => {
    const { clip } = item;
    const words = project.media[clip.mediaId]?.words;
    if (!words) return;
    const limit = k + 1 < items.length ? items[k + 1].start : item.end;
    words.forEach((w, index) => {
      const mid = (w.start + w.end) / 2;
      if (mid < clip.in || mid >= clip.out) return;
      const start = toTimeline(item, Math.max(w.start, clip.in));
      if (start >= limit) return;
      const end = Math.min(toTimeline(item, Math.min(w.end, clip.out)), limit);
      out.push({ text: w.text, start, end, mediaId: clip.mediaId, index, clipId: clip.id, br: w.br });
    });
  });
  return out;
}

/**
 * Source ranges covering the given words, with neighbouring words merged into one range.
 * @param {Array<{start: number, end: number, index: number}>} words words of one media
 * @returns {Array<[number, number]>}
 */
export function rangesForWords(words) {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const ranges = [];
  for (const w of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && w.start - last[1] < 0.05) last[1] = Math.max(last[1], w.end);
    else ranges.push([w.start, w.end]);
  }
  return ranges;
}

/**
 * Source ranges of filler words ("um", "uh", ...).
 * @param {Array<{text: string, start: number, end: number}>} words
 * @param {string[]} [fillers]
 * @returns {Array<[number, number]>}
 */
export function fillerRanges(words, fillers = DEFAULT_FILLERS) {
  const set = new Set(fillers.map(normWord));
  return rangesForWords((words ?? []).filter((w) => set.has(normWord(w.text))));
}

/**
 * Source ranges of pauses longer than `minGap`, keeping `keep` seconds of air on each side.
 * Leading and trailing silence of the media counts too.
 * @param {Array<{start: number, end: number}>} words
 * @param {number} mediaDuration
 * @param {number} [minGap]
 * @param {number} [keep]
 * @returns {Array<[number, number]>}
 */
export function pauseRanges(words, mediaDuration, minGap = 0.8, keep = 0.2) {
  if (!words?.length) return [];
  const ranges = [];
  const push = (a, b) => {
    if (b - a > 0.05) ranges.push([a, b]);
  };
  if (words[0].start > minGap) push(0, words[0].start - keep);
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > minGap) push(words[i - 1].end + keep, words[i].start - keep);
  }
  const last = words[words.length - 1];
  if (mediaDuration - last.end > minGap) push(last.end + keep, mediaDuration);
  return ranges;
}

/**
 * Replace one word's text (an empty string is kept as-is; cut the word to remove it).
 * @param {object} project
 * @param {string} mediaId
 * @param {number} index
 * @param {string} text
 * @returns {object}
 */
export function setWordText(project, mediaId, index, text) {
  const words = project.media[mediaId]?.words;
  if (!words?.[index]) return project;
  const next = words.map((w, i) => (i === index ? { ...w, text: text.trim() } : w));
  return updateMedia(project, mediaId, { words: next });
}

/**
 * Apply whole-word glossary fixes (case-insensitive) to caption text.
 * @param {string} text
 * @param {Array<{from: string, to: string}>} glossary
 * @returns {string}
 */
export function applyGlossary(text, glossary) {
  let out = text;
  for (const { from, to } of glossary ?? []) {
    if (!from) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(from)}(?=[^\\p{L}\\p{N}]|$)`, 'giu');
    out = out.replace(re, (_m, pre) => pre + to);
  }
  return out;
}

/**
 * Parse glossary lines of the form `wrong => right`.
 * @param {string} text
 * @returns {Array<{from: string, to: string}>}
 */
export function parseGlossary(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.split('=>'))
    .filter((parts) => parts.length === 2 && parts[0].trim())
    .map(([from, to]) => ({ from: from.trim(), to: to.trim() }));
}

/**
 * Inverse of parseGlossary.
 * @param {Array<{from: string, to: string}>} glossary
 * @returns {string}
 */
export function formatGlossary(glossary) {
  return (glossary ?? []).map((g) => `${g.from} => ${g.to}`).join('\n');
}

/**
 * Convert Transcript QC / faster-whisper `words.json` entries (`word` key) to editor words (`text` key).
 * @param {Array<{word?: string, text?: string, start: number, end: number, br?: boolean}>} raw
 * @returns {Array<{text: string, start: number, end: number, br?: boolean}>}
 */
export function fromWordsJson(raw) {
  return raw
    .map((w) => ({ text: String(w.text ?? w.word ?? '').trim(), start: Number(w.start), end: Number(w.end), ...(w.br ? { br: true } : {}) }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end))
    .sort((a, b) => a.start - b.start);
}

// ---------- helpers ----------

function normWord(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
