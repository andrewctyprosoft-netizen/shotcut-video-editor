// Media probing helpers: read ffprobe JSON and decide whether the preview needs a proxy file.

const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const PLAYABLE_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav']);

/** File extensions offered in the import dialog. */
export const MEDIA_EXTENSIONS = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'ts', 'mts', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac'];

/**
 * Summarise `ffprobe -show_format -show_streams -of json` output.
 * @param {object} probe parsed ffprobe JSON
 * @param {string} path media file path
 * @returns {{path: string, name: string, duration: number, width: number, height: number, fps: number,
 *   hasVideo: boolean, hasAudio: boolean, videoCodec: string|null, audioCodec: string|null}}
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
  return {
    path,
    name: path.split(/[\\/]/).pop(),
    duration,
    width,
    height,
    fps: v ? frameRate(v.avg_frame_rate || v.r_frame_rate) : 0,
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
  };
}

/**
 * Whether Chromium's `<video>` is unlikely to play the file, so the preview should use a proxy.
 * @param {ReturnType<typeof parseProbe>} info
 * @returns {boolean}
 */
export function needsProxy(info) {
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
