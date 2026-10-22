// Caption style presets and export presets. Presets only set fields; everything else keeps its default.

import { defaultCaptions } from './project.js';

/** Caption looks. `style` fields not listed fall back to defaultCaptions().style. */
export const CAPTION_PRESETS = [
  {
    id: 'classic',
    name: 'Classic',
    maxChars: 32,
    style: {},
  },
  {
    id: 'bold-pop',
    name: 'Bold pop',
    maxChars: 16,
    style: { font: 'Impact', size: 0.085, bold: false, highlight: '#7CFF4F', pop: true, outline: 0.1, position: 0.72, uppercase: true },
  },
  {
    id: 'karaoke',
    name: 'Karaoke',
    maxChars: 28,
    style: { font: 'Segoe UI', size: 0.065, highlight: '#FF4FD8', highlightMode: 'progressive', outline: 0.07 },
  },
  {
    id: 'boxed',
    name: 'Boxed',
    maxChars: 36,
    style: { font: 'Segoe UI', size: 0.05, wordHighlight: false, box: true, position: 0.88 },
  },
  {
    id: 'subtitle',
    name: 'Subtitle',
    maxChars: 42,
    style: { size: 0.045, bold: false, wordHighlight: false, outline: 0.06, position: 0.93 },
  },
  {
    id: 'neon',
    name: 'Neon',
    maxChars: 20,
    style: {
      font: 'Trebuchet MS', size: 0.07, color: '#E8FFFF', highlight: '#00E5FF', pop: true, outline: 0.12,
      outlineColor: '#0A2A6B', uppercase: true, position: 0.8,
    },
  },
];

/** Export targets. `aspect: null` keeps the project's frame. */
export const EXPORT_PRESETS = [
  { id: 'youtube-1080', name: 'YouTube 1080p', hint: '16:9 · 1920×1080', aspect: '16:9', resolution: 1080, fps: 30, quality: 'high' },
  { id: 'youtube-4k', name: 'YouTube 4K', hint: '16:9 · 3840×2160', aspect: '16:9', resolution: 2160, fps: 30, quality: 'high' },
  { id: 'vertical', name: 'Shorts · Reels · TikTok', hint: '9:16 · 1080×1920', aspect: '9:16', resolution: 1080, fps: 30, quality: 'high' },
  { id: 'square', name: 'Instagram square', hint: '1:1 · 1080×1080', aspect: '1:1', resolution: 1080, fps: 30, quality: 'high' },
  { id: 'small', name: 'Small file', hint: 'Same frame · 720p · for chat and email', aspect: null, resolution: 720, fps: 30, quality: 'small' },
];

/**
 * Full caption style for a preset.
 * @param {string} id
 * @returns {{maxChars: number, style: object} | null}
 */
export function captionPreset(id) {
  const p = CAPTION_PRESETS.find((x) => x.id === id);
  return p ? { maxChars: p.maxChars, style: { ...defaultCaptions().style, ...p.style } } : null;
}

/**
 * Apply a caption preset (style and characters per caption). Keeps captions on/off as they were.
 * @param {object} project
 * @param {string} id
 * @returns {object}
 */
export function applyCaptionPreset(project, id) {
  const p = captionPreset(id);
  return p ? { ...project, captions: { ...project.captions, maxChars: p.maxChars, style: p.style } } : project;
}

/**
 * The caption preset the project's captions currently match exactly, or null when customised.
 * @param {object} captions project.captions
 * @returns {string | null}
 */
export function matchingCaptionPreset(captions) {
  const hit = CAPTION_PRESETS.find((x) => {
    const p = captionPreset(x.id);
    return p.maxChars === captions.maxChars && Object.entries(p.style).every(([k, v]) => captions.style[k] === v);
  });
  return hit?.id ?? null;
}

/**
 * Apply an export preset: frame (aspect), frame rate, resolution and quality.
 * @param {object} project
 * @param {string} id
 * @returns {object}
 */
export function applyExportPreset(project, id) {
  const p = EXPORT_PRESETS.find((x) => x.id === id);
  if (!p) return project;
  return { ...project, aspect: p.aspect ?? project.aspect, fps: p.fps, export: { ...project.export, resolution: p.resolution, quality: p.quality } };
}

/**
 * The export preset the project matches, or null.
 * @param {object} project
 * @returns {string | null}
 */
export function matchingExportPreset(project) {
  const ex = project.export ?? {};
  const hit = EXPORT_PRESETS.find((p) => (p.aspect ?? project.aspect) === project.aspect && p.fps === project.fps
    && p.resolution === (ex.resolution ?? 1080) && p.quality === (ex.quality ?? 'high'));
  return hit?.id ?? null;
}
