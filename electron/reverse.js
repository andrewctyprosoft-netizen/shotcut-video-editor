// Reverse: bake a backwards copy (picture and sound) of one source range, so the preview and the export
// just play it forwards. FFmpeg's `reverse` / `areverse` keep every frame of their input in memory, so
// the range is reversed in chunks small enough to fit (about FRAME_BUDGET of decoded frames each), which
// are then joined last chunk first: video chunks are copied, the sound is joined as PCM and encoded once,
// so there is no gap or click at the joins. No Electron imports, so tests use it directly.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { moveFile, runOk } from './proc.js';

/** Decoded frames one chunk may hold (bytes). 1080p is about 80 frames, 4K about 20. */
const FRAME_BUDGET = 300e6;
const AUDIO_CHUNK = 60;

/**
 * Output path for the reversed copy of a range, cached by source file, its size and date, and the range.
 * @param {{path: string, hasVideo: boolean, alpha?: boolean}} info
 * @param {{in: number, out: number}} range source seconds
 * @param {string} dir
 * @returns {string}
 */
export function reversedPath(info, range, dir) {
  const st = statSync(info.path);
  const key = createHash('sha1').update(`${info.path}|${st.size}|${st.mtimeMs}|${range.in}|${range.out}`).digest('hex').slice(0, 16);
  const ext = !info.hasVideo ? 'm4a' : info.alpha ? 'webm' : 'mp4';
  return join(dir, `${key}.rev.${ext}`);
}

/**
 * Chunks of a range in source order, each short enough for the reverse filters; video chunks are whole frames.
 * @param {{hasVideo: boolean, width?: number, height?: number, fps?: number, alpha?: boolean}} info
 * @param {{in: number, out: number}} range
 * @param {number} [seconds] chunk length instead of the memory-based one (tests)
 * @returns {Array<{start: number, duration: number}>}
 */
export function reverseChunks(info, range, seconds) {
  const length = Math.max(0, range.out - range.in);
  let step = seconds ?? AUDIO_CHUNK;
  if (info.hasVideo && !seconds) {
    const fps = info.fps || 30;
    const bytes = Math.max(1, (info.width || 1920) * (info.height || 1080) * (info.alpha ? 2.5 : 1.5));
    const frames = Math.max(15, Math.min(Math.floor(FRAME_BUDGET / bytes), Math.round(30 * fps)));
    step = frames / fps;
  }
  const out = [];
  for (let s = 0; s < length - 1e-6; s += step) out.push({ start: round6(range.in + s), duration: round6(Math.min(step, length - s)) });
  return out;
}

/**
 * Make (or reuse) the reversed copy of a range of a video or audio file.
 * @param {{ffmpeg: string, info: {path: string, hasVideo: boolean, hasAudio: boolean, width?: number, height?: number,
 *   fps?: number, alpha?: boolean}, range: {in: number, out: number}, outDir: string, workDir?: string,
 *   chunkSeconds?: number, signal?: AbortSignal, onProgress?: (f: number, detail?: string) => void}} o
 * @returns {Promise<string>} the reversed file
 */
export async function makeReversed(o) {
  const { info } = o;
  mkdirSync(o.outDir, { recursive: true });
  const out = reversedPath(info, o.range, o.outDir);
  if (existsSync(out)) return out;
  const chunks = reverseChunks(info, o.range, o.chunkSeconds);
  if (!chunks.length) throw new Error('Nothing to reverse: the clip is empty.');
  const work = join(o.workDir ?? join(o.outDir, `${out.split(/[\\/]/).pop()}.chunks`), 'reverse');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const vext = info.alpha ? 'webm' : 'mp4';
  try {
    for (const [k, c] of chunks.entries()) {
      o.onProgress?.(k / (chunks.length + 1), `Reversing part ${k + 1} of ${chunks.length}`);
      await runOk(o.ffmpeg, chunkArgs(info, c, `v${k}.${vext}`, `a${k}.wav`), { cwd: work, signal: o.signal });
    }
    o.onProgress?.(chunks.length / (chunks.length + 1), 'Joining');
    // Last chunk first. Names are relative: FFmpeg runs in the work folder, so paths never need escaping.
    const order = chunks.map((_, k) => chunks.length - 1 - k);
    const list = (name) => `${order.map((k) => `file '${name(k)}'`).join('\n')}\n`;
    const inputs = [];
    const maps = [];
    if (info.hasVideo) {
      writeFileSync(join(work, 'v.txt'), list((k) => `v${k}.${vext}`));
      inputs.push('-f', 'concat', '-safe', '0', '-i', 'v.txt');
      maps.push('-map', `${maps.length / 2}:v:0`);
    }
    if (info.hasAudio) {
      writeFileSync(join(work, 'a.txt'), list((k) => `a${k}.wav`));
      inputs.push('-f', 'concat', '-safe', '0', '-i', 'a.txt');
      maps.push('-map', `${maps.length / 2}:a:0`);
    }
    const tmp = join(work, `out.part.${out.split('.').pop()}`);
    const audio = info.alpha ? ['-c:a', 'libopus', '-b:a', '160k'] : ['-c:a', 'aac', '-b:a', '192k'];
    await runOk(o.ffmpeg, [
      '-hide_banner', '-y', ...inputs, ...maps, '-c:v', 'copy', ...(info.hasAudio ? audio : []),
      ...(info.alpha ? [] : ['-movflags', '+faststart']), tmp,
    ], { cwd: work, signal: o.signal });
    moveFile(tmp, out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return out;
}

// ---------- helpers ----------

/** One chunk: its picture reversed into a video file and its sound reversed into a WAV file. */
function chunkArgs(info, c, vout, aout) {
  const args = ['-hide_banner', '-y', ...(info.alpha ? ['-c:v', 'libvpx-vp9'] : []), '-ss', String(c.start), '-t', String(c.duration), '-i', info.path];
  if (info.hasVideo) {
    const codec = info.alpha
      ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '24', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '5']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p'];
    args.push('-map', '0:v:0', '-vf', `fps=${info.fps || 30},reverse`, ...codec, '-an', vout);
  }
  if (info.hasAudio) args.push('-map', '0:a:0', '-af', 'areverse', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-vn', aout);
  return args;
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}
