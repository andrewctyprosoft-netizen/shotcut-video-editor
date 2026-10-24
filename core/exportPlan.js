// Build the FFmpeg command for exporting a project. One input per clip or item, and one filter graph:
//   1. main track: every clip normalised to the output frame (or drawn on a black canvas when it is
//      cropped, moved, scaled, animated, transparent or a still), joined with `xfade`/`acrossfade` or `concat`;
//   2. layer tracks, bottom first: each item cropped, flipped, scaled and `overlay`ed at its time; keyframes and
//      in/out effects become expressions in `t`, piecewise linear through the per-frame values that
//      core/anim.js gives the preview (exact at every frame, and deterministic, unlike `sendcmd`);
//   3. audio: main track plus every item, with volume and fades, mixed with `amix`;
//   4. captions burned in with libass.
// Pure: the runner writes the graph to a file and spawns FFmpeg.
//
// Filter order matters for animated sizes: everything that changes the pixel format (eq, alpha) runs
// before the `scale` with `eval=frame`, and overlays blend in RGB, so FFmpeg never inserts a converter
// after that scale (a converter is configured for the first frame's size and would squash the rest).

import { MAX_DB, MUTE_DB, elementState, isAnimated, isFullCrop, placement } from './anim.js';
import { frameSize, isVisual, itemSpan, layout, mediaKind, totalDuration } from './project.js';

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
const AFORMAT = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
/** Peak limiter for boosted exports: -1 dBFS ceiling, 5 ms look-ahead, no make-up gain. */
export const LIMITER = 'alimiter=limit=0.891:attack=5:release=50:level=false:latency=true';
const MAX_PX = 8192;

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
  const total = totalDuration(project);
  if (!total) throw new Error('The timeline is empty.');
  const frame = frameSize(project);
  const [W, H] = frame;
  const fps = project.fps || 30;
  const inputArgs = [];
  const graph = [];
  let inputs = 0;
  const addInput = (m, el, D) => {
    inputArgs.push(...inputFor(m, el, D, fps));
    return inputs++;
  };

  // ----- 1. main track -----
  items.forEach((item, i) => {
    const { clip, duration } = item;
    const m = project.media[clip.mediaId];
    if (!m) throw new Error(`Clip ${i + 1} points at missing media.`);
    const D = num(duration);
    const silent = project.main?.muted || !m.hasAudio || (clip.volume ?? 0) <= MUTE_DB;
    const n = isVisual(m) || !silent ? addInput(m, clip, duration) : -1;
    if (!isVisual(m)) {
      graph.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${D},format=yuv420p,setsar=1[v${i}]`);
    } else if (mediaKind(m) === 'video' && !m.alpha && isPlain(clip)) {
      const fit = project.fit === 'fill'
        ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
        : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
      const chain = [
        ...headChain(m, clip, fps),
        ...flipFilters(clip.flip),
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
      // Cropped, moved, scaled, animated, transparent or a still: draw it on a black canvas.
      const fg = placed(m, clip, duration, { n, frame, fit: project.fit, fps, offset: 0 });
      graph.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${D},format=yuv420p,setsar=1[b${i}]`);
      graph.push(`${fg.chain}[f${i}]`);
      graph.push(`[b${i}][f${i}]overlay=x=${fg.x}:y=${fg.y}:eof_action=pass:format=rgb,format=yuv420p,setsar=1[v${i}]`);
    }
    if (!silent) {
      const chain = ['asetpts=PTS-STARTPTS', ...atempoChain(clip.speed), AFORMAT, 'apad', `atrim=duration=${D}`, 'asetpts=PTS-STARTPTS', ...gainFilters(clip, duration)];
      graph.push(`[${n}:a:0]${chain.join(',')}[a${i}]`);
    } else {
      graph.push(`anullsrc=r=48000:cl=stereo,${AFORMAT},atrim=duration=${D}[a${i}]`);
    }
  });

  let v = items.length ? 'v0' : null;
  let a = items.length ? 'a0' : null;
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

  // The canvas runs for the whole timeline: black where the main track is empty or over.
  const mainEnd = items.length ? items[items.length - 1].end : 0;
  const padded = total - mainEnd > 1e-6;
  if (!items.length) {
    graph.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${num(total)},format=yuv420p,setsar=1[vbase]`);
    graph.push(`anullsrc=r=48000:cl=stereo,${AFORMAT},atrim=duration=${num(total)}[abase]`);
    v = 'vbase';
    a = 'abase';
  } else if (padded) {
    graph.push(`[${v}]tpad=stop_mode=add:stop_duration=${num(total - mainEnd)}:color=black[vbase]`);
    v = 'vbase';
  }

  // ----- 2. layer tracks (bottom first) and item audio -----
  const extraAudio = [];
  let k = 0;
  for (const track of project.tracks ?? []) {
    for (const it of track.items) {
      const m = project.media[it.mediaId];
      if (!m) continue;
      const span = itemSpan(it, fps);
      const wantVideo = track.kind === 'layer' && !track.hidden && isVisual(m);
      const wantAudio = !track.muted && m.hasAudio && (it.volume ?? 0) > MUTE_DB;
      if (!wantVideo && !wantAudio) continue;
      const n = addInput(m, it, span.duration);
      const name = `o${k}`;
      if (wantVideo) {
        const fg = placed(m, it, span.duration, { n, frame, fit: 'fit', fps, offset: span.start });
        graph.push(`${fg.chain}[${name}]`);
        graph.push(`[${v}][${name}]overlay=x=${fg.x}:y=${fg.y}:eof_action=pass:format=rgb[L${k}]`);
        v = `L${k}`;
      }
      if (wantAudio) {
        const D = num(span.duration);
        const chain = [
          'asetpts=PTS-STARTPTS', ...atempoChain(it.speed), AFORMAT, 'apad', `atrim=duration=${D}`, 'asetpts=PTS-STARTPTS',
          ...gainFilters(it, span.duration), `adelay=delays=${Math.round(span.start * 1000)}:all=1`,
        ];
        graph.push(`[${n}:a:0]${chain.join(',')}[ia${k}]`);
        extraAudio.push(`ia${k}`);
      }
      k++;
    }
  }
  if (extraAudio.length) {
    graph.push(`[${a}]${extraAudio.map((l) => `[${l}]`).join('')}amix=inputs=${extraAudio.length + 1}:duration=longest:dropout_transition=0:normalize=0[amix]`);
    a = 'amix';
  }

  // ----- 3. captions and outputs -----
  graph.push(opts.captionsFile ? `[${v}]ass=${opts.captionsFile}[vout]` : `[${v}]null[vout]`);
  // Gain above 0 dB can push peaks past full scale: a look-ahead limiter (latency-compensated, so sync holds) caps them at -1 dBFS.
  const boosted = [...project.clips, ...(project.tracks ?? []).flatMap((t) => t.items)].some((el) => (el.volume ?? 0) > 0);
  const limiter = boosted ? `,${LIMITER}` : '';
  graph.push(extraAudio.length || padded
    ? `[${a}]apad=whole_dur=${num(total)},atrim=duration=${num(total)}${limiter}[aout]`
    : `[${a}]anull${limiter}[aout]`);

  const quality = opts.quality ?? project.export?.quality ?? 'high';
  const outputArgs = [
    '-map', '[vout]', '-map', '[aout]',
    ...encoderArgs(opts.encoder ?? 'libx264', quality),
    '-r', String(fps),
    '-c:a', 'aac', '-b:a', (QUALITY[quality] ?? QUALITY.high).audio, '-movflags', '+faststart',
  ];
  return { inputArgs, graph: graph.join(';\n'), outputArgs, duration: total };
}

/**
 * FFmpeg expression in `v` passing through (time, value) samples, linear between them and holding
 * outside. Runs that are already linear (within `tol`) merge, so a keyframed move is a few segments;
 * the segments form a balanced `if` tree.
 * @param {Array<[number, number]>} samples sorted by time
 * @param {string} [v] variable: 't' (most filters) or 'T' (geq)
 * @param {number} [tol]
 * @returns {string} a plain number when the value never changes
 */
export function pwlExpr(samples, v = 't', tol = 0.25) {
  const f = (x) => String(Math.round(x * 1e4) / 1e4);
  if (samples.every(([, x]) => Math.abs(x - samples[0][1]) <= tol)) return f(samples[0][1]);
  const pts = [samples[0]];
  let a = 0;
  for (let b = 2; b < samples.length; b++) {
    const [t0, v0] = samples[a];
    const [t1, v1] = samples[b];
    const off = samples.slice(a + 1, b).some(([t, x]) => Math.abs(v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) - x) > tol);
    if (off) {
      pts.push(samples[b - 1]);
      a = b - 1;
    }
  }
  pts.push(samples[samples.length - 1]);
  const seg = (i, j) => {
    if (j - i === 1) {
      const [t0, v0] = pts[i];
      const [t1, v1] = pts[j];
      const slope = (v1 - v0) / (t1 - t0);
      return Math.abs(slope) < 1e-9 ? f(v0) : `${f(v0)}+(${v}-${f(t0)})*${f(slope)}`;
    }
    const m = (i + j) >> 1;
    return `if(lt(${v},${f(pts[m][0])}),${seg(i, m)},${seg(m, j)})`;
  };
  const last = pts[pts.length - 1];
  return `if(lt(${v},${f(pts[0][0])}),${f(pts[0][1])},if(gte(${v},${f(last[0])}),${f(last[1])},${seg(0, pts.length - 1)}))`;
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

/** Input options for one element: stills loop, GIFs loop and are trimmed in the graph, transparent WebM uses libvpx. */
function inputFor(m, el, D, fps) {
  const kind = mediaKind(m);
  if (kind === 'image') return ['-loop', '1', '-framerate', String(fps), '-t', num(D + 0.25), '-i', m.path];
  if (kind === 'gif') return ['-ignore_loop', '0', '-t', num(el.in + D + 0.25), '-i', m.path];
  return [...(m.alpha ? ['-c:v', 'libvpx-vp9'] : []), '-ss', num(el.in), '-t', num(el.out - el.in + 0.25), '-i', m.path];
}

/** First filters of a picture: timestamps from zero at the element's speed, constant frame rate. */
function headChain(m, el, fps) {
  const kind = mediaKind(m);
  if (kind === 'image') return ['setpts=PTS-STARTPTS', `fps=${fps}`];
  if (kind === 'gif') return ['setpts=PTS-STARTPTS', `fps=${fps}`, ...(el.in > 0 ? [`trim=start=${num(el.in)}`, 'setpts=PTS-STARTPTS'] : [])];
  return [`setpts=(PTS-STARTPTS)/${num(el.speed)}`, `fps=${fps}`];
}

/**
 * Filter chain that crops, fades and scales one element for `overlay`, plus where to put it (numbers,
 * or expressions in `t` when it moves). Timestamps are local for main clips and global for items.
 */
function placed(m, el, duration, o) {
  const count = isAnimated(el) ? Math.max(1, Math.round(duration * o.fps)) : 1;
  const samples = [];
  for (let f = 0; f < count; f++) {
    const t = f / o.fps;
    samples.push([o.offset + t, geom(placement(m, el.crop, elementState(el, t, duration), o.frame, o.fit))]);
  }
  const isNum = (e) => /^-?[\d.]+$/.test(e);
  // Sizes and positions are sampled exactly and rounded by FFmpeg, so a linear move stays one segment.
  const track = (k, v = 't') => {
    const e = pwlExpr(samples.map(([t, g]) => [t, g[k]]), v, k === 'aa' ? 0.002 : 0.25);
    return isNum(e) && k !== 'aa' ? String(k === 'w' || k === 'h' ? Math.max(1, Math.round(Number(e))) : Math.round(Number(e))) : e;
  };
  const q = (e) => (isNum(e) ? e : `'round(${e})'`);
  const w = track('w');
  const h = track('h');
  // Opacity: constant -> colorchannelmixer; changing -> geq, only on the frames where it is below 1.
  const op = samples.map(([t, g]) => [t, g.aa]);
  let alpha = ['format=rgba'];
  if (op.every(([, a]) => Math.abs(a - op[0][1]) < 0.002)) {
    if (op[0][1] < 0.999) alpha = ['format=rgba', `colorchannelmixer=aa=${op[0][1]}`];
  } else {
    const spans = [];
    op.forEach(([t, a], i) => {
      if (a >= 0.999) return;
      if (i > 0 && op[i - 1][1] < 0.999) spans[spans.length - 1][1] = t;
      else spans.push([t, t]);
    });
    const half = 0.5 / o.fps;
    const enable = spans.map(([a, b]) => `between(t,${num(a - half)},${num(b + half)})`).join('+');
    alpha = ['format=gbrap', `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(${track('aa', 'T')},0,1)':enable='${enable}'`];
  }
  const c = isFullCrop(el.crop) ? null : el.crop;
  const chain = [
    ...headChain(m, el, o.fps),
    'tpad=stop_mode=clone:stop_duration=1',
    `trim=duration=${num(duration)}`,
    o.offset ? `setpts=PTS-STARTPTS+${num(o.offset)}/TB` : 'setpts=PTS-STARTPTS',
    c ? `crop=${Math.max(1, Math.round(m.width * c.w))}:${Math.max(1, Math.round(m.height * c.h))}:${Math.round(m.width * c.x)}:${Math.round(m.height * c.y)}` : null,
    ...flipFilters(el.flip),
    eqFilter(el.adjust),
    ...alpha,
    isNum(w) && isNum(h) ? `scale=w=${w}:h=${h}` : `scale=w=${q(w)}:h=${q(h)}:eval=frame`,
    'setsar=1',
  ].filter(Boolean);
  return { chain: `[${o.n}:v:0]${chain.join(',')}`, x: q(track('x')), y: q(track('y')) };
}

/** Size (at least 1 px, at most MAX_PX), position and opacity for FFmpeg, unrounded. */
function geom(p) {
  return {
    w: Math.min(MAX_PX, Math.max(1, p.box.width)),
    h: Math.min(MAX_PX, Math.max(1, p.box.height)),
    x: p.box.left,
    y: p.box.top,
    aa: Math.round(p.opacity * 1000) / 1000,
  };
}

/** Plain main clip: no crop, transform or animation, so the fast scale-and-pad chain is exact. */
function isPlain(el) {
  const t = el.transform ?? {};
  return isFullCrop(el.crop) && !isAnimated(el) && (t.x ?? 0.5) === 0.5 && (t.y ?? 0.5) === 0.5 && (t.scale ?? 1) === 1 && (t.opacity ?? 1) === 1;
}

/** Mirror filters; they run after the crop, so the cropped picture flips in place. */
function flipFilters(flip) {
  return [flip?.h ? 'hflip' : null, flip?.v ? 'vflip' : null].filter(Boolean);
}

/** Volume (dB) and fade-in/out filters for an element's audio. */
function gainFilters(el, duration) {
  const out = [];
  const db = Math.min(el.volume ?? 0, MAX_DB);
  if (db !== 0) out.push(`volume=${num(db)}dB`);
  const fin = Math.min(el.audioFade?.in ?? 0, duration / 2);
  const fout = Math.min(el.audioFade?.out ?? 0, duration / 2);
  if (fin > 0) out.push(`afade=t=in:st=0:d=${num(fin)}`);
  if (fout > 0) out.push(`afade=t=out:st=${num(duration - fout)}:d=${num(fout)}`);
  return out;
}

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
