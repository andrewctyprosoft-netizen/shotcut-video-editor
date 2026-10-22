// Build the FFmpeg command for exporting a project: one input per clip, one filter graph that
// normalises every clip to the output frame, joins them with `xfade`/`acrossfade` or `concat`,
// and burns captions in with libass. Pure: the runner writes the graph to a file and spawns FFmpeg.

import { frameSize, layout } from './project.js';

/** H.264 encoders: software x264 plus the hardware encoders common on Windows PCs (auto-pick order). */
export const ENCODER_NAMES = {
  libx264: 'H.264 software (x264)',
  h264_nvenc: 'NVIDIA NVENC',
  h264_qsv: 'Intel Quick Sync',
  h264_amf: 'AMD AMF',
};
export const HARDWARE_ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_amf'];

/** Quality levels: constant-quality targets per encoder and the audio bitrate. */
const QUALITY = {
  high: { crf: 18, cq: 19, qp: 18, audio: '192k' },
  standard: { crf: 21, cq: 23, qp: 22, audio: '160k' },
  small: { crf: 26, cq: 28, qp: 27, audio: '128k' },
};

/**
 * Video encoder arguments (codec, quality, pixel format) for an encoder and quality level.
 * Quick Sync and AMF take NV12 input.
 * @param {string} encoder
 * @param {string} [quality]
 * @returns {string[]}
 */
export function encoderArgs(encoder, quality = 'high') {
  const q = QUALITY[quality] ?? QUALITY.high;
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(q.cq), '-b:v', '0', '-pix_fmt', 'yuv420p'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', String(q.cq), '-pix_fmt', 'nv12'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(q.qp), '-qp_p', String(q.qp + 2), '-pix_fmt', 'nv12'];
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(q.crf), '-pix_fmt', 'yuv420p'];
  }
}

/**
 * @param {object} project
 * @param {{captionsFile?: string|null, encoder?: string, quality?: string}} [opts]
 *   quality defaults to project.export.quality
 *   captionsFile: ASS file name relative to the FFmpeg working directory (keeps Windows paths out of the graph)
 * @returns {{inputArgs: string[], graph: string, outputArgs: string[], duration: number}}
 */
export function buildExportPlan(project, opts = {}) {
  const items = layout(project);
  if (!items.length) throw new Error('The timeline is empty.');
  const [W, H] = frameSize(project);
  const fps = project.fps || 30;
  const inputArgs = [];
  const graph = [];
  let inputs = 0;

  items.forEach((item, i) => {
    const { clip, duration } = item;
    const m = project.media[clip.mediaId];
    if (!m) throw new Error(`Clip ${i + 1} points at missing media.`);
    const D = num(duration);
    let n = -1;
    if (m.hasVideo || m.hasAudio) {
      inputArgs.push('-ss', num(clip.in), '-t', num(clip.out - clip.in + 0.25), '-i', m.path);
      n = inputs++;
    }
    if (m.hasVideo) {
      const fit = project.fit === 'fill'
        ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
        : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
      const chain = [
        `setpts=(PTS-STARTPTS)/${num(clip.speed)}`,
        `fps=${fps}`,
        fit,
        'setsar=1',
        eqFilter(clip.adjust),
        'format=yuv420p',
        'tpad=stop_mode=clone:stop_duration=1',
        `trim=duration=${D}`,
        'setpts=PTS-STARTPTS',
      ].filter(Boolean);
      graph.push(`[${n}:v:0]${chain.join(',')}[v${i}]`);
    } else {
      graph.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${D},format=yuv420p,setsar=1[v${i}]`);
    }
    const aformat = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
    if (m.hasAudio) {
      const chain = ['asetpts=PTS-STARTPTS', ...atempoChain(clip.speed), aformat, 'apad', `atrim=duration=${D}`, 'asetpts=PTS-STARTPTS'];
      graph.push(`[${n}:a:0]${chain.join(',')}[a${i}]`);
    } else {
      graph.push(`anullsrc=r=48000:cl=stereo,${aformat},atrim=duration=${D}[a${i}]`);
    }
  });

  let v = 'v0';
  let a = 'a0';
  for (let i = 1; i < items.length; i++) {
    const { overlap, start, clip } = items[i];
    if (overlap > 0) {
      graph.push(`[${v}][v${i}]xfade=transition=${clip.transition.type}:duration=${num(overlap)}:offset=${num(start)}[vx${i}]`);
      graph.push(`[${a}][a${i}]acrossfade=d=${num(overlap)}:c1=tri:c2=tri[ax${i}]`);
    } else {
      // concat outputs a 1/1000000 timebase; a later xfade needs the clips' 1/fps (FFmpeg 8 refuses mismatches).
      graph.push(`[${v}][v${i}]concat=n=2:v=1:a=0,settb=1/${fps}[vx${i}]`);
      graph.push(`[${a}][a${i}]concat=n=2:v=0:a=1,asettb=1/48000[ax${i}]`);
    }
    v = `vx${i}`;
    a = `ax${i}`;
  }
  graph.push(opts.captionsFile ? `[${v}]ass=${opts.captionsFile}[vout]` : `[${v}]null[vout]`);
  graph.push(`[${a}]anull[aout]`);

  const quality = opts.quality ?? project.export?.quality ?? 'high';
  const outputArgs = [
    '-map', '[vout]', '-map', '[aout]',
    ...encoderArgs(opts.encoder ?? 'libx264', quality),
    '-r', String(fps),
    '-c:a', 'aac', '-b:a', (QUALITY[quality] ?? QUALITY.high).audio, '-movflags', '+faststart',
  ];
  return { inputArgs, graph: graph.join(';\n'), outputArgs, duration: items[items.length - 1].end };
}

/**
 * Full FFmpeg argument list. The graph is read from `graphFile` (`-/filter_complex`, FFmpeg 7.1+).
 * @param {ReturnType<typeof buildExportPlan>} plan
 * @param {string} graphFile
 * @param {string} output
 * @returns {string[]}
 */
export function exportArgs(plan, graphFile, output) {
  return ['-hide_banner', '-y', ...plan.inputArgs, '-/filter_complex', graphFile, ...plan.outputArgs, '-progress', 'pipe:1', '-nostats', output];
}

/**
 * Read one line of FFmpeg `-progress` output.
 * @param {string} line
 * @returns {{seconds?: number, done?: boolean} | null}
 */
export function parseProgressLine(line) {
  const [key, value] = line.trim().split('=');
  if (key === 'out_time_us' || key === 'out_time_ms') {
    const us = Number(value);
    return Number.isFinite(us) ? { seconds: us / 1e6 } : null;
  }
  if (key === 'progress') return { done: value === 'end' };
  return null;
}

/**
 * `atempo` filters for a speed factor (each instance accepts 0.5–100).
 * @param {number} speed
 * @returns {string[]}
 */
export function atempoChain(speed) {
  if (Math.abs(speed - 1) < 1e-6) return [];
  const out = [];
  let s = speed;
  while (s < 0.5) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  out.push(`atempo=${num(s)}`);
  return out;
}

// ---------- helpers ----------

function eqFilter(adjust) {
  const b = adjust?.brightness ?? 0;
  const c = adjust?.contrast ?? 1;
  const s = adjust?.saturation ?? 1;
  if (b === 0 && c === 1 && s === 1) return null;
  return `eq=brightness=${num(b)}:contrast=${num(c)}:saturation=${num(s)}`;
}

function num(x) {
  return String(Math.round(x * 1000) / 1000);
}
