// Media probing helpers: read ffprobe JSON, tell videos, audio, images and GIFs apart, and decide
// whether the preview needs a proxy file.

const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const PLAYABLE_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav']);
const IMAGE_CODECS = new Set(['png', 'mjpeg', 'jpegls', 'webp', 'bmp', 'tiff']);

/** File extensions offered in the import dialog, by kind. */
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'ts', 'mts'];
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac'];
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'apng'];
export const SUBTITLE_EXTENSIONS = ['srt', 'vtt'];
export const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS];

/** Background removal models (rembg's U2-Net family, Apache-2.0), downloaded on first use. Sizes in MB. */
export const CUTOUT_MODELS = {
  silueta: { label: 'General (Silueta, 43 MB, fast)', file: 'silueta.onnx', size: 43, input: 320 },
  u2net_human_seg: { label: 'People (U²-Net human, 168 MB)', file: 'u2net_human_seg.onnx', size: 168, input: 320 },
  'isnet-general-use': {
    label: 'Sharp edges (IS-Net, 170 MB, slow; best for images)', file: 'isnet-general-use.onnx', size: 170, input: 1024,
    mean: [0.5, 0.5, 0.5], std: [1, 1, 1],
  },
};
export const DEFAULT_CUTOUT_MODEL = 'silueta';

/**
 * Summarise `ffprobe -show_format -show_streams -of json` output.
 * @param {object} probe parsed ffprobe JSON
 * @param {string} path media file path
 * @returns {{path: string, name: string, kind: string, duration: number, width: number, height: number, fps: number,
 *   hasVideo: boolean, hasAudio: boolean, videoCodec: string|null, audioCodec: string|null, alpha: boolean}}
 *   kind: 'video' | 'audio' | 'image' (a still) | 'gif' (an animation that loops: GIF, APNG)
 */
export function parseProbe(probe, path) {
  const streams = probe.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(probe.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0;
  let width = v?.width ?? 0;
  let height = v?.height ?? 0;
  const rotation = Math.abs(Number(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0));
  if (rotation % 180 === 90) [width, height] = [height, width];
  const format = probe.format?.format_name ?? '';
  let kind = v ? 'video' : 'audio';
  if (v?.codec_name === 'gif' || v?.codec_name === 'apng' || /^(gif|apng)$/.test(format)) kind = 'gif';
  else if (v && IMAGE_CODECS.has(v.codec_name) && (/_pipe$|^image2$/.test(format) || Number(v.nb_frames) <= 1)) kind = 'image';
  return {
    path,
    name: path.split(/[\\/]/).pop(),
    kind,
    duration: kind === 'image' ? 0 : duration,
    width,
    height,
    fps: v ? frameRate(v.avg_frame_rate || v.r_frame_rate) : 0,
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    // VP9/VP8 WebM with transparency (FFmpeg must decode it with libvpx to keep the alpha).
    alpha: Boolean(v && /^vp[89]$/.test(v.codec_name) && String(v.tags?.alpha_mode ?? v.tags?.ALPHA_MODE) === '1'),
  };
}

/**
 * Whether Chromium's `<video>` is unlikely to play the file, so the preview should use a proxy.
 * @param {ReturnType<typeof parseProbe>} info
 * @returns {boolean}
 */
export function needsProxy(info) {
  if (info.kind === 'image' || info.kind === 'gif') return false;
  const ext = info.path.split('.').pop().toLowerCase();
  if (!PLAYABLE_EXT.has(ext)) return true;
  if (info.hasVideo && !PLAYABLE_VIDEO.has(info.videoCodec)) return true;
  if (info.hasAudio && !PLAYABLE_AUDIO.has(info.audioCodec) && ext !== 'wav') return true;
  return false;
}

/**
 * FFmpeg arguments for a 720p H.264 preview proxy.
 * @param {string} input
 * @param {string} output
 * @returns {string[]}
 */
export function proxyArgs(input, output) {
  return [
    '-hide_banner', '-y', '-i', input,
    '-map', '0:v:0?', '-map', '0:a:0?',
    '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', output,
  ];
}

/**
 * Parse a "30000/1001" style rate.
 * @param {string} rate
 * @returns {number}
 */
export function frameRate(rate) {
  const [n, d] = String(rate ?? '0').split('/').map(Number);
  const r = d ? n / d : n;
  return Number.isFinite(r) ? Math.round(r * 1000) / 1000 : 0;
}
