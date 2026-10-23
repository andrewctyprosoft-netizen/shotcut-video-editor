// Background removal: bake a transparent copy of an image, GIF or video, so the preview (<img>/<video>)
// and the export (libvpx / APNG decoders) both just show the alpha channel. Two methods:
//   key: FFmpeg `colorkey` (green or blue screen, any solid colour), no model needed;
//   ai:  vision/remove_bg.py with a U2-Net family ONNX model, downloaded once into the models folder.
// No Electron imports, so tests use it directly.

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseProgressLine } from '../core/exportPlan.js';
import { CUTOUT_MODELS, DEFAULT_CUTOUT_MODEL } from '../core/media.js';
import { moveFile, runOk, splitCommand } from './proc.js';

const RELEASES = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0';

export { CUTOUT_MODELS, DEFAULT_CUTOUT_MODEL };

/**
 * Output path for a cutout, cached by source file, its size and date, and the settings.
 * @param {{path: string, kind: string}} info
 * @param {object} settings method + key colour / model
 * @param {string} dir
 * @returns {string}
 */
export function cutoutPath(info, settings, dir) {
  const st = statSync(info.path);
  const key = createHash('sha1').update(`${info.path}|${st.size}|${st.mtimeMs}|${JSON.stringify(settings)}`).digest('hex').slice(0, 16);
  const ext = info.kind === 'image' ? 'png' : info.kind === 'gif' ? 'apng' : 'webm';
  return join(dir, `${key}.${ext}`);
}

/**
 * FFmpeg filter for the colour-key method. `similarity` and `blend` are 0..1.
 * Green or blue keys also remove the colour spill on edges (`despill`).
 * @param {{color: string, similarity?: number, blend?: number}} key
 * @returns {string}
 */
export function keyFilter(key) {
  const hex = /^#?([0-9a-f]{6})$/i.exec(key.color ?? '')?.[1] ?? '00ff00';
  const sim = Math.min(1, Math.max(0.01, key.similarity ?? 0.3));
  const blend = Math.min(1, Math.max(0, key.blend ?? 0.1));
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const spill = g > r * 1.5 && g > b * 1.5 ? ',despill=type=green' : b > r * 1.5 && b > g * 1.5 ? ',despill=type=blue' : '';
  return `colorkey=0x${hex}:${sim}:${blend}${spill}`;
}

/**
 * Make (or reuse) a transparent copy of a media file.
 * @param {{ffmpeg: string, python?: string, visionDir: string, modelsDir: string, outDir: string,
 *   info: {path: string, kind: string, width: number, height: number, fps: number, duration: number},
 *   method: 'ai' | 'key', key?: object, model?: string, signal?: AbortSignal, onProgress?: (f: number, detail?: string) => void}} o
 * @returns {Promise<string>} the cutout file
 */
export async function makeCutout(o) {
  const settings = o.method === 'key' ? { method: 'key', key: o.key } : { method: 'ai', model: o.model ?? DEFAULT_CUTOUT_MODEL };
  mkdirSync(o.outDir, { recursive: true });
  const out = cutoutPath(o.info, settings, o.outDir);
  if (existsSync(out)) return out;
  const tmp = out.replace(/(\.\w+)$/, '.part$1');
  rmSync(tmp, { force: true });
  if (o.method === 'key') await keyOut(o, tmp);
  else await aiOut(o, settings.model, tmp);
  moveFile(tmp, out);
  return out;
}

/**
 * Path of a cutout model, downloading it first if needed (with progress).
 * @param {string} name a CUTOUT_MODELS key
 * @param {string} dir models folder
 * @param {{signal?: AbortSignal, onProgress?: (f: number, detail?: string) => void, baseUrl?: string}} [opts]
 * @returns {Promise<string>}
 */
export async function ensureModel(name, dir, opts = {}) {
  const spec = CUTOUT_MODELS[name];
  if (!spec) throw new Error(`Unknown background model ${name}`);
  const file = join(dir, spec.file);
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });
  const url = `${opts.baseUrl ?? RELEASES}/${spec.file}`;
  const res = await fetch(url, { signal: opts.signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Downloading ${spec.file} failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || spec.size * 1e6;
  let got = 0;
  const part = `${file}.part`;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    got += chunk.length;
    opts.onProgress?.(Math.min(1, got / total), `Downloading ${spec.file}: ${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB`);
  });
  await pipeline(body, createWriteStream(part), { signal: opts.signal });
  moveFile(part, file);
  return file;
}

// ---------- helpers ----------

async function keyOut(o, tmp) {
  const { info } = o;
  const vf = `${keyFilter(o.key ?? {})},format=${info.kind === 'video' ? 'yuva420p' : 'rgba'}`;
  let args;
  if (info.kind === 'image') args = ['-hide_banner', '-y', '-i', info.path, '-vf', vf, '-frames:v', '1', tmp];
  else if (info.kind === 'gif') args = ['-hide_banner', '-y', '-i', info.path, '-vf', vf, '-plays', '0', '-f', 'apng', tmp];
  else {
    args = ['-hide_banner', '-y', '-i', info.path, '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf,
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '30', '-row-mt', '1',
      '-deadline', 'good', '-cpu-used', '5', '-c:a', 'libopus', '-b:a', '128k', '-progress', 'pipe:1', '-nostats', tmp];
  }
  await runOk(o.ffmpeg, args, {
    signal: o.signal,
    onStdout: (line) => {
      const p = parseProgressLine(line);
      if (p?.seconds !== undefined && info.duration) o.onProgress?.(Math.min(1, p.seconds / info.duration));
    },
  });
}

async function aiOut(o, modelName, tmp) {
  if (!o.python) throw new Error('Background removal needs Python with onnxruntime (installed with faster-whisper).');
  const spec = CUTOUT_MODELS[modelName];
  const model = await ensureModel(modelName, o.modelsDir, { signal: o.signal, onProgress: (f, d) => o.onProgress?.(f * 0.1, d) });
  const { info } = o;
  const [cmd, ...pre] = splitCommand(o.python);
  const args = [
    ...pre, join(o.visionDir, 'remove_bg.py'), info.path, tmp,
    '--kind', info.kind === 'image' || info.kind === 'gif' ? info.kind : 'video',
    '--model', model, '--size', String(spec.input),
    ...(spec.mean ? ['--mean', ...spec.mean.map(String)] : []),
    ...(spec.std ? ['--std', ...spec.std.map(String)] : []),
    '--width', String(info.width), '--height', String(info.height),
    '--fps', String(info.fps || 30), '--duration', String(info.duration || 0), '--ffmpeg', o.ffmpeg,
  ];
  await runOk(cmd, args, {
    signal: o.signal,
    env: { ...process.env, PYTHONUTF8: '1' },
    onStdout: (line) => {
      if (!line.startsWith('{')) return;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'progress') o.onProgress?.(0.1 + 0.9 * msg.fraction, 'Removing the background');
      } catch {
        // not a progress line
      }
    },
  });
}
