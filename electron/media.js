// Probe media and build preview proxies with FFmpeg. No Electron imports (tests use it directly).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { needsProxy, parseProbe, proxyArgs } from '../core/media.js';
import { parseProgressLine } from '../core/exportPlan.js';
import { runOk } from './proc.js';

/**
 * Probe a media file.
 * @param {string} ffprobe
 * @param {string} path
 * @returns {Promise<ReturnType<typeof parseProbe> & {needsProxy: boolean}>}
 */
export async function probe(ffprobe, path) {
  const res = await runOk(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], { capture: true });
  const info = parseProbe(JSON.parse(res.stdout), path);
  if (!info.hasVideo && !info.hasAudio) throw new Error(`${info.name} has no audio or video.`);
  return { ...info, needsProxy: needsProxy(info) };
}

/**
 * Make (or reuse) a 720p H.264 proxy for the preview. Cached by path, size and modified time.
 * @param {string} ffmpeg
 * @param {{path: string, duration: number}} info
 * @param {string} dir proxy cache folder
 * @param {{signal?: AbortSignal, onProgress?: (fraction: number) => void}} [opts]
 * @returns {Promise<string>} proxy path
 */
export async function makeProxy(ffmpeg, info, dir, opts = {}) {
  const st = statSync(info.path);
  const key = createHash('sha1').update(`${info.path}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
  const out = join(dir, `${key}.mp4`);
  if (existsSync(out)) return out;
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${key}.part.mp4`);
  await runOk(ffmpeg, proxyArgs(info.path, tmp), {
    signal: opts.signal,
    onStdout: (line) => {
      const p = parseProgressLine(line);
      if (p?.seconds !== undefined && info.duration) opts.onProgress?.(Math.min(1, p.seconds / info.duration));
    },
  });
  renameSync(tmp, out);
  return out;
}
