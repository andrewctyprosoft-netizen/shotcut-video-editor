// Caption cues from timeline words, plus SRT and ASS writers.
// The same cues drive the preview overlay and the burned-in export, so both show identical lines.

import { applyGlossary } from './transcript.js';
import { assTime, srtTime } from './time.js';

const SENTENCE_END = /[.?!…]["')\]]?$/;
const CLAUSE_END = /[,;:]["')\]]?$/;
const END_PAD = 0.25;
const MIN_CUE = 0.5;
const CUE_GAP = 0.02;

/**
 * Apply the glossary to words. Multi-word entries ("flora 2 => FLAURA2") merge the matching words into one.
 * @param {Array<{text: string, start: number, end: number}>} words
 * @param {Array<{from: string, to: string}>} glossary
 * @returns {Array<object>}
 */
export function glossWords(words, glossary) {
  let out = words;
  for (const { from, to } of glossary ?? []) {
    const tokens = from.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) continue;
    const merged = [];
    for (let i = 0; i < out.length; i++) {
      const run = out.slice(i, i + tokens.length);
      const hit = run.length === tokens.length && run.every((w, k) => bare(w.text) === bare(tokens[k]));
      if (!hit) {
        merged.push(out[i]);
        continue;
      }
      const last = run[run.length - 1];
      merged.push({ ...run[0], text: to + trailingPunct(last.text), end: last.end, br: last.br });
      i += tokens.length - 1;
    }
    out = merged;
  }
  const single = (glossary ?? []).filter((g) => g.from.trim() && !/\s/.test(g.from.trim()));
  return single.length ? out.map((w) => ({ ...w, text: applyGlossary(w.text, single) })) : out;
}

/**
 * Group timeline words into caption cues.
 * Breaks on: a forced `br`, sentence end, a clause end once the line is half full, a long pause,
 * `maxChars` or `maxDuration`.
 * @param {Array<{text: string, start: number, end: number, br?: boolean}>} words timeline words, sorted
 * @param {{maxChars?: number, maxDuration?: number, maxGap?: number}} [opts]
 * @returns {Array<{start: number, end: number, text: string, words: Array<object>}>}
 */
export function buildCues(words, opts = {}) {
  const maxChars = opts.maxChars ?? 32;
  const maxDuration = opts.maxDuration ?? 3.5;
  const maxGap = opts.maxGap ?? 0.8;
  const groups = [];
  let cur = [];
  let len = 0;
  for (const w of words) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const breakHere =
        prev.br ||
        SENTENCE_END.test(prev.text) ||
        (CLAUSE_END.test(prev.text) && len >= maxChars / 2) ||
        w.start - prev.end > maxGap ||
        len + 1 + w.text.length > maxChars ||
        w.end - cur[0].start > maxDuration;
      if (breakHere) {
        groups.push(cur);
        cur = [];
        len = 0;
      }
    }
    cur.push(w);
    len += (len ? 1 : 0) + w.text.length;
  }
  if (cur.length) groups.push(cur);

  const cues = groups.map((g) => ({
    start: g[0].start,
    end: g[g.length - 1].end + END_PAD,
    text: g.map((w) => w.text).join(' '),
    words: g,
  }));
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1]?.start ?? Infinity;
    const c = cues[i];
    c.end = Math.min(Math.max(c.end, c.start + MIN_CUE), next - CUE_GAP);
    if (c.end <= c.start) c.end = c.start + 0.05;
  }
  return cues;
}

/**
 * Caption cues for a project's timeline words, with its glossary and limits applied.
 * @param {Array<object>} words output of timelineWords()
 * @param {object} project
 * @returns {ReturnType<typeof buildCues>}
 */
export function projectCues(words, project) {
  const { maxChars, maxDuration } = project.captions;
  return buildCues(glossWords(words, project.glossary), { maxChars, maxDuration });
}

/**
 * The cue on screen at time `t`, or null.
 * @param {Array<{start: number, end: number}>} cues
 * @param {number} t
 * @returns {object | null}
 */
export function cueAt(cues, t) {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].end <= t) lo = mid + 1;
    else if (cues[mid].start > t) hi = mid - 1;
    else return cues[mid];
  }
  return null;
}

/**
 * Index of the word being spoken at `t` inside a cue (the last word that has started).
 * @param {{words: Array<{start: number}>}} cue
 * @param {number} t
 * @returns {number}
 */
export function wordIndexAt(cue, t) {
  let idx = 0;
  cue.words.forEach((w, i) => {
    if (w.start <= t) idx = i;
  });
  return idx;
}

/**
 * SubRip text.
 * @param {Array<{start: number, end: number, text: string}>} cues
 * @param {{uppercase?: boolean}} [style]
 * @returns {string}
 */
export function toSrt(cues, style = {}) {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${style.uppercase ? c.text.toUpperCase() : c.text}\n`)
    .join('\n');
}

/**
 * Advanced SubStation Alpha script for burning captions in with FFmpeg (`ass=` filter, libass).
 * With `wordHighlight`, each word gets its own event so the spoken word changes colour.
 * @param {Array<{start: number, end: number, words: Array<{text: string, start: number}>}>} cues
 * @param {object} style project.captions.style
 * @param {[number, number]} frame output width and height
 * @returns {string}
 */
export function toAss(cues, style, [width, height]) {
  const fontPx = Math.round(style.size * height);
  const box = Boolean(style.box);
  const outline = box ? Math.round(fontPx * 0.25) : Math.round(fontPx * style.outline * 10) / 10;
  const outlineColor = box ? assColor(style.boxColor, 0x40) : assColor(style.outlineColor);
  const marginLR = Math.round(width * 0.06);
  const marginV = Math.round((1 - style.position) * height);
  const primary = assColor(style.color);
  const fields = [
    'Default', style.font, fontPx, primary, primary, outlineColor, assColor('#000000', 0x80),
    style.bold ? -1 : 0, 0, 0, 0, 100, 100, 0, 0, box ? 3 : 1, outline, 0, 2, marginLR, marginLR, marginV, 1,
  ];
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${fields.join(',')}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const caps = (s) => (style.uppercase ? s.toUpperCase() : s);
  const event = (start, end, text) => `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`;
  const lines = [];
  for (const cue of cues) {
    const words = cue.words.map((w) => assEscape(caps(w.text)));
    if (!style.wordHighlight) {
      lines.push(event(cue.start, cue.end, words.join(' ')));
      continue;
    }
    const hl = assRgb(style.highlight);
    const back = assRgb(style.color);
    cue.words.forEach((w, i) => {
      const start = i === 0 ? cue.start : w.start;
      const end = i + 1 < cue.words.length ? cue.words[i + 1].start : cue.end;
      if (end <= start) return;
      const text = words.map((t, j) => {
        if (!isHighlighted(style, j, i)) return t;
        const pop = style.pop && j === i;
        const scale = Math.round(POP * 100);
        return `{${pop ? `\\fscx${scale}\\fscy${scale}` : ''}\\c${hl}}${t}{${pop ? '\\fscx100\\fscy100' : ''}\\c${back}}`;
      }).join(' ');
      lines.push(event(start, end, text));
    });
  }
  return [...head, ...lines, ''].join('\n');
}

/** Scale of the spoken word with `pop`. */
export const POP = 1.15;

/**
 * Whether word `j` shows the highlight colour while word `active` is spoken.
 * 'progressive' (karaoke fill) keeps every word spoken so far highlighted.
 * @param {{highlightMode?: string}} style
 * @param {number} j
 * @param {number} active
 * @returns {boolean}
 */
export function isHighlighted(style, j, active) {
  return style.highlightMode === 'progressive' ? j <= active : j === active;
}

/**
 * `#RRGGBB` to ASS `&HAABBGGRR` (alpha 0 = opaque).
 * @param {string} hex
 * @param {number} [alpha]
 * @returns {string}
 */
export function assColor(hex, alpha = 0) {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex ?? '')?.[1] ?? 'FFFFFF';
  const [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
  return `&H${alpha.toString(16).padStart(2, '0')}${b}${g}${r}`.toUpperCase();
}

/**
 * `#RRGGBB` to the ASS inline colour override value `&HBBGGRR&`.
 * @param {string} hex
 * @returns {string}
 */
export function assRgb(hex) {
  return `&H${assColor(hex).slice(4)}&`;
}

// ---------- helpers ----------

function assEscape(text) {
  return text.replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, ' ');
}

function bare(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function trailingPunct(text) {
  return /[^\p{L}\p{N}]*$/u.exec(text)?.[0] ?? '';
}
