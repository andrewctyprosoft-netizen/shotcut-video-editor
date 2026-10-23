// Caption cues from timeline words and imported subtitles, per-caption overrides, and the SRT, WebVTT,
// text and ASS writers. The same cues drive the preview overlay and the burned-in export, so both show
// identical lines.
//
// Auto cues are rebuilt from words on every edit, so each one is identified by a key of one of its words
// (`w:<mediaId>:<wordIndex>`); an override stored under that key follows the word through cuts and regrouping.
// Imported subtitles are keyed `s:<id>`.

import { updateSubtitle } from './project.js';
import { applyGlossary } from './transcript.js';
import { assTime, srtTime } from './time.js';

const SENTENCE_END = /[.?!…]["')\]]?$/;
const CLAUSE_END = /[,;:]["')\]]?$/;
const END_PAD = 0.25;
const MIN_CUE = 0.5;
const CUE_GAP = 0.02;
/** Caption entrance/exit animation lengths in seconds. */
export const CAPTION_FADE = 0.2;
export const CAPTION_POP = 0.15;
/** Download formats: [extension, label]. */
export const CAPTION_FORMATS = [
  ['srt', 'SubRip (.srt)'],
  ['vtt', 'WebVTT (.vtt)'],
  ['ass', 'Styled ASS (.ass)'],
  ['txt', 'Plain text (.txt)'],
];

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
 * Every caption on the timeline: auto cues from timeline words (glossary, limits and per-caption timing
 * applied) plus imported subtitles, sorted by start. Each cue carries its effective `style`.
 * @param {Array<object>} words output of timelineWords()
 * @param {object} project
 * @returns {Array<{key: string, source: 'auto' | 'srt', start: number, end: number, text: string,
 *   words: Array<object>, style: object, baseStart?: number, baseEnd?: number, srtId?: string}>}
 */
export function projectCues(words, project) {
  const { maxChars, maxDuration, style } = project.captions;
  const ov = project.captions.overrides ?? {};
  const auto = buildCues(glossWords(words, project.glossary), { maxChars, maxDuration }).map((cue) => {
    const keys = cue.words.map(wordKey);
    const key = keys.find((k) => ov[k]) ?? keys[0];
    const o = ov[key];
    return { ...cue, key, source: 'auto', baseStart: cue.start, baseEnd: cue.end, start: cue.start + (o?.dStart ?? 0), end: cue.end + (o?.dEnd ?? 0) };
  });
  for (let i = 0; i < auto.length; i++) {
    const c = auto[i];
    c.start = Math.max(0, c.start, i ? auto[i - 1].start + 0.05 : 0);
    const next = auto[i + 1]?.start ?? Infinity;
    c.end = Math.max(Math.min(c.end, next - CUE_GAP), c.start + 0.1);
  }
  const srt = (project.subtitles ?? []).map((s) => {
    const ws = glossWords(spreadWords(s.text, s.start, s.end), project.glossary);
    return { key: `s:${s.id}`, srtId: s.id, source: 'srt', start: s.start, end: s.end, text: ws.map((w) => w.text).join(' '), words: ws };
  });
  const all = [...auto, ...srt].sort((a, b) => a.start - b.start);
  for (const c of all) c.style = ov[c.key]?.style ? { ...style, ...ov[c.key].style } : style;
  return all;
}

/**
 * Caption cues of one media file in its own (source) time, for downloading what a transcription produced.
 * @param {object} project
 * @param {string} mediaId
 * @returns {ReturnType<typeof buildCues>}
 */
export function mediaCues(project, mediaId) {
  const words = (project.media[mediaId]?.words ?? []).map((w, index) => ({ ...w, mediaId, index }));
  const { maxChars, maxDuration, style } = project.captions;
  return buildCues(glossWords(words, project.glossary), { maxChars, maxDuration }).map((c) => ({ ...c, style }));
}

/**
 * The cue on screen at time `t`, or null (first one when several overlap).
 * @param {Array<{start: number, end: number}>} cues
 * @param {number} t
 * @returns {object | null}
 */
export function cueAt(cues, t) {
  return cues.find((c) => c.start <= t && t < c.end) ?? null;
}

/**
 * Every cue on screen at time `t` (imported subtitles can overlap auto captions).
 * @param {Array<{start: number, end: number}>} cues
 * @param {number} t
 * @returns {Array<object>}
 */
export function cuesAt(cues, t) {
  return cues.filter((c) => c.start <= t && t < c.end);
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
 * Entrance/exit animation of a caption at time `t`: opacity and scale.
 * @param {{start: number, end: number}} cue
 * @param {{animIn?: string, animOut?: string}} style
 * @param {number} t
 * @returns {{opacity: number, scale: number}}
 */
export function captionAnim(cue, style, t) {
  let opacity = 1;
  let scale = 1;
  const since = t - cue.start;
  const left = cue.end - t;
  if (style.animIn === 'fade') opacity *= clamp01(since / CAPTION_FADE);
  if (style.animIn === 'pop') scale = 0.6 + 0.4 * clamp01(since / CAPTION_POP);
  if (style.animOut === 'fade') opacity *= clamp01(left / CAPTION_FADE);
  return { opacity, scale };
}

// ---------- editing ----------

/**
 * Change caption style for every caption (`keys` null) or only for the cues with these keys.
 * @param {object} project
 * @param {object} patch style fields
 * @param {string[] | null} [keys]
 * @returns {object}
 */
export function setCaptionStyle(project, patch, keys = null) {
  const c = project.captions;
  if (!keys) return { ...project, captions: { ...c, style: { ...c.style, ...patch } } };
  const overrides = { ...c.overrides };
  for (const k of keys) overrides[k] = { ...overrides[k], style: { ...overrides[k]?.style, ...patch } };
  return { ...project, captions: { ...c, overrides } };
}

/**
 * Drop the per-caption style of these cues (they follow the default style again). Timing changes stay.
 * @param {object} project
 * @param {string[]} keys
 * @returns {object}
 */
export function resetCaptionStyle(project, keys) {
  const overrides = { ...project.captions.overrides };
  for (const k of keys) {
    if (!overrides[k]) continue;
    const { style: _gone, ...rest } = overrides[k];
    if (Object.keys(rest).length) overrides[k] = rest;
    else delete overrides[k];
  }
  return { ...project, captions: { ...project.captions, overrides } };
}

/**
 * Move a caption's start and/or end on the timeline. Imported subtitles change directly; auto captions
 * store the shift from their word timing.
 * @param {object} project
 * @param {object} cue a cue from projectCues()
 * @param {{start?: number, end?: number}} to
 * @returns {object}
 */
export function setCueTiming(project, cue, to) {
  if (cue.source === 'srt') return updateSubtitle(project, cue.srtId, to);
  const c = project.captions;
  const o = c.overrides?.[cue.key] ?? {};
  const next = { ...o };
  if (to.start !== undefined) next.dStart = Math.min(to.start, cue.end - 0.1) - cue.baseStart;
  if (to.end !== undefined) next.dEnd = Math.max(to.end, cue.start + 0.1) - cue.baseEnd;
  return { ...project, captions: { ...c, overrides: { ...c.overrides, [cue.key]: next } } };
}

// ---------- reading subtitles ----------

/**
 * Parse SubRip or WebVTT text into cues. Formatting tags are dropped; line breaks become spaces.
 * @param {string} text
 * @returns {Array<{start: number, end: number, text: string}>}
 */
export function parseSubtitles(text) {
  const time = String.raw`(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})`;
  const re = new RegExp(`${time}\\s*-->\\s*${time}`);
  const blocks = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => re.test(l));
    if (at < 0) continue;
    const m = re.exec(lines[at]);
    const sec = (h, mm, s, ms) => Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
    const start = sec(m[1], m[2], m[3], m[4]);
    const end = sec(m[5], m[6], m[7], m[8]);
    const body = lines.slice(at + 1).join(' ').replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
    if (body && end > start) cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/**
 * Words for a subtitle line without word timing, spread over the cue by length (for highlighting).
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {Array<{text: string, start: number, end: number}>}
 */
export function spreadWords(text, start, end) {
  const tokens = String(text).split(/\s+/).filter(Boolean);
  const total = tokens.reduce((n, w) => n + w.length + 1, 0) || 1;
  let t = start;
  return tokens.map((w) => {
    const d = ((end - start) * (w.length + 1)) / total;
    const word = { text: w, start: t, end: t + d };
    t += d;
    return word;
  });
}

// ---------- writers ----------

/**
 * SubRip text.
 * @param {Array<{start: number, end: number, text: string, style?: object}>} cues
 * @param {{uppercase?: boolean}} [style]
 * @returns {string}
 */
export function toSrt(cues, style = {}) {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${caps(c, style)}\n`)
    .join('\n');
}

/**
 * WebVTT text.
 * @param {Array<{start: number, end: number, text: string, style?: object}>} cues
 * @param {{uppercase?: boolean}} [style]
 * @returns {string}
 */
export function toVtt(cues, style = {}) {
  const t = (s) => srtTime(s).replace(',', '.');
  return `WEBVTT\n\n${cues.map((c) => `${t(c.start)} --> ${t(c.end)}\n${caps(c, style)}\n`).join('\n')}`;
}

/**
 * One caption per line, no timing.
 * @param {Array<{text: string, style?: object}>} cues
 * @param {{uppercase?: boolean}} [style]
 * @returns {string}
 */
export function toTxt(cues, style = {}) {
  return `${cues.map((c) => caps(c, style)).join('\n')}\n`;
}

/**
 * Captions in a download format.
 * @param {'srt' | 'vtt' | 'ass' | 'txt'} format
 * @param {Array<object>} cues
 * @param {object} style default caption style
 * @param {[number, number]} frame
 * @returns {string}
 */
export function captionsAs(format, cues, style, frame) {
  if (format === 'vtt') return toVtt(cues, style);
  if (format === 'txt') return toTxt(cues, style);
  if (format === 'ass') return toAss(cues, style, frame);
  return toSrt(cues, style);
}

/**
 * Advanced SubStation Alpha script for burning captions in with FFmpeg (`ass=` filter, libass).
 * Each distinct caption style (default plus per-caption changes) becomes one ASS style; position and
 * box width are the style's margins. With `wordHighlight`, each word gets its own event so the spoken
 * word changes colour.
 * @param {Array<{start: number, end: number, words: Array<{text: string, start: number}>, style?: object}>} cues
 * @param {object} style project.captions.style (cues without their own style use it)
 * @param {[number, number]} frame output width and height
 * @returns {string}
 */
export function toAss(cues, style, [width, height]) {
  const names = new Map();
  const styleLines = [];
  const nameOf = (s) => {
    const fields = assStyleFields(s, [width, height]);
    const id = fields.join(',');
    if (!names.has(id)) {
      const name = names.size ? `Cue${names.size}` : 'Default';
      names.set(id, name);
      styleLines.push(`Style: ${name},${fields.join(',')}`);
    }
    return names.get(id);
  };
  nameOf(style);
  const lines = [];
  for (const cue of cues) {
    const s = cue.style ?? style;
    const name = nameOf(s);
    const up = (t) => (s.uppercase ? t.toUpperCase() : t);
    const event = (start, end, text) => `Dialogue: 0,${assTime(start)},${assTime(end)},${name},,0,0,0,,${text}`;
    const words = cue.words.map((w) => assEscape(up(w.text)));
    const events = [];
    if (!s.wordHighlight) {
      events.push([cue.start, cue.end, words.join(' ')]);
    } else {
      const hl = assRgb(s.highlight);
      const back = assRgb(s.color);
      cue.words.forEach((w, i) => {
        const start = i === 0 ? cue.start : w.start;
        const end = i + 1 < cue.words.length ? cue.words[i + 1].start : cue.end;
        if (end <= start) return;
        const text = words.map((t, j) => {
          if (!isHighlighted(s, j, i)) return t;
          const pop = s.pop && j === i;
          const scale = Math.round(POP * 100);
          return `{${pop ? `\\fscx${scale}\\fscy${scale}` : ''}\\c${hl}}${t}{${pop ? '\\fscx100\\fscy100' : ''}\\c${back}}`;
        }).join(' ');
        events.push([start, end, text]);
      });
    }
    events.forEach(([start, end, text], i) => {
      const fadeIn = i === 0 && s.animIn === 'fade' ? Math.round(CAPTION_FADE * 1000) : 0;
      const fadeOut = i === events.length - 1 && s.animOut === 'fade' ? Math.round(CAPTION_FADE * 1000) : 0;
      let tags = fadeIn || fadeOut ? `\\fad(${fadeIn},${fadeOut})` : '';
      if (i === 0 && s.animIn === 'pop') tags += `\\fscx60\\fscy60\\t(0,${Math.round(CAPTION_POP * 1000)},\\fscx100\\fscy100)`;
      lines.push(event(start, end, tags ? `{${tags}}${text}` : text));
    });
  }
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
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  return [...head, ...lines, ''].join('\n');
}

/**
 * Text box of a caption style in frame pixels: left, right and bottom margins (ASS) / CSS box.
 * @param {object} style
 * @param {[number, number]} frame
 * @returns {{marginL: number, marginR: number, marginV: number}}
 */
export function captionBox(style, [width, height]) {
  const x = style.x ?? 0.5;
  const w = style.width ?? 0.88;
  return {
    marginL: Math.max(0, Math.round((x - w / 2) * width)),
    marginR: Math.max(0, Math.round(width - (x + w / 2) * width)),
    marginV: Math.round((1 - style.position) * height),
  };
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

/** ASS Style fields after the name, in the Format order. */
function assStyleFields(style, frame) {
  const height = frame[1];
  const fontPx = Math.round(style.size * height);
  const box = Boolean(style.box);
  const outline = box ? Math.round(fontPx * 0.25) : Math.round(fontPx * style.outline * 10) / 10;
  const outlineColor = box ? assColor(style.boxColor, 0x40) : assColor(style.outlineColor);
  const { marginL, marginR, marginV } = captionBox(style, frame);
  const primary = assColor(style.color);
  return [
    style.font, fontPx, primary, primary, outlineColor, assColor('#000000', 0x80),
    style.bold ? -1 : 0, 0, 0, 0, 100, 100, 0, 0, box ? 3 : 1, outline, 0, 2, marginL, marginR, marginV, 1,
  ];
}

function wordKey(w) {
  return `w:${w.mediaId}:${w.index}`;
}

function caps(cue, style) {
  return (cue.style ?? style).uppercase ? cue.text.toUpperCase() : cue.text;
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

function assEscape(text) {
  return text.replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, ' ');
}

function bare(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function trailingPunct(text) {
  return /[^\p{L}\p{N}]*$/u.exec(text)?.[0] ?? '';
}
