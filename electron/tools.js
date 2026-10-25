// Settings and external tools: where FFmpeg, Python and the Whisper model are, and whether they work.
// No Electron imports, so tests can use it directly.

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { HARDWARE_ENCODERS, encoderArgs } from '../core/exportPlan.js';
import { run, splitCommand } from './proc.js';

export const DEFAULT_SETTINGS = {
  ffmpeg: '', // empty = FFMPEG_PATH, then the launcher's runtime/ffmpeg or tools/ffmpeg.exe, then PATH
  python: '', // empty = the launcher's runtime/python, then the first of PYTHON_CANDIDATES that can import faster_whisper
  model: '', // empty = VCE_WHISPER_MODEL, then the launcher's runtime/models copy, then a workspace hf_cache copy, then "small" (downloads)
  language: 'en',
  encoder: 'auto', // 'auto' = first working hardware encoder, else libx264
  cutoutModel: 'silueta', // background removal model (electron/cutout.js CUTOUT_MODELS), downloaded on first use
};

const PYTHON_CANDIDATES = process.platform === 'win32' ? ['py -3.11', 'py -3', 'python'] : ['python3', 'python'];
const MODEL_DIR = join('hf_cache', 'faster-whisper-small');

/**
 * Read settings.json merged over the defaults.
 * @param {string} file
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function loadSettings(file) {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Write settings.json (only known keys).
 * @param {string} file
 * @param {object} settings
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function saveSettings(file, settings) {
  const clean = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, settings[k] ?? DEFAULT_SETTINGS[k]]));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(clean, null, 2));
  return clean;
}

/**
 * FFmpeg and FFprobe paths.
 * @param {typeof DEFAULT_SETTINGS} settings
 * @param {string} appRoot
 * @returns {{ffmpeg: string, ffprobe: string}}
 */
export function resolveFfmpeg(settings, appRoot) {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const bundled = [join(appRoot, 'runtime', 'ffmpeg', `ffmpeg${exe}`), join(appRoot, 'tools', `ffmpeg${exe}`)].find((p) => existsSync(p));
  const ffmpeg = settings.ffmpeg || process.env.FFMPEG_PATH || bundled || 'ffmpeg';
  const sibling = ffmpeg.replace(/ffmpeg(\.exe)?$/i, `ffprobe${exe}`);
  const ffprobe = ffmpeg !== 'ffmpeg' && existsSync(sibling) ? sibling : 'ffprobe';
  return { ffmpeg, ffprobe };
}

/**
 * Whisper model path or name. Looks for the workspace's offline copy (Transcript QC) above the app folder.
 * @param {typeof DEFAULT_SETTINGS} settings
 * @param {string} appRoot
 * @returns {string}
 */
export function resolveModel(settings, appRoot) {
  if (settings.model) return settings.model;
  if (process.env.VCE_WHISPER_MODEL) return process.env.VCE_WHISPER_MODEL;
  const bundled = join(appRoot, 'runtime', 'models', 'faster-whisper-small');
  if (existsSync(join(bundled, 'model.bin'))) return bundled;
  let dir = resolve(appRoot);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, MODEL_DIR);
    if (existsSync(join(candidate, 'model.bin'))) return candidate;
    dir = dirname(dir);
  }
  return 'small';
}

/**
 * The Python the launcher installed (runtime/python/cpython-3.x-…), or null.
 * @param {string} [appRoot]
 * @returns {string|null}
 */
export function bundledPython(appRoot) {
  if (!appRoot) return null;
  const base = join(appRoot, 'runtime', 'python');
  let dirs = [];
  try {
    dirs = readdirSync(base).filter((d) => d.startsWith('cpython-')).sort().reverse();
  } catch {
    return null;
  }
  for (const d of dirs) {
    const exe = process.platform === 'win32' ? join(base, d, 'python.exe') : join(base, d, 'bin', 'python3');
    if (existsSync(exe)) return exe;
  }
  return null;
}

let pythonCache = null;

/**
 * Find a Python that can import faster_whisper: the setting, else the launcher's bundled Python, else the usual commands.
 * @param {typeof DEFAULT_SETTINGS} settings
 * @param {string} [appRoot]
 * @returns {Promise<{command: string, ok: boolean, version: string|null, error: string|null}>}
 */
export async function resolvePython(settings, appRoot) {
  const bundled = bundledPython(appRoot);
  const candidates = settings.python ? [settings.python] : bundled ? [`"${bundled}"`, ...PYTHON_CANDIDATES] : PYTHON_CANDIDATES;
  if (pythonCache && candidates.includes(pythonCache.command)) return pythonCache;
  let last = null;
  for (const command of candidates) {
    const [cmd, ...pre] = splitCommand(command);
    try {
      const res = await run(cmd, [...pre, '-c', 'import faster_whisper; print(faster_whisper.__version__)']);
      if (res.code === 0) {
        pythonCache = { command, ok: true, version: res.stdout.trim(), error: null };
        return pythonCache;
      }
      last = { command, ok: false, version: null, error: 'faster-whisper is not installed: start the app with its launcher (it sets Python up), or run  pip install -r asr/requirements.txt' };
    } catch (err) {
      last ??= { command, ok: false, version: null, error: err.message };
    }
  }
  return last ?? { command: candidates[0], ok: false, version: null, error: 'No Python found' };
}

/** Forget the cached Python lookup (after settings change). */
export function resetPythonCache() {
  pythonCache = null;
}

const encoderCache = new Map();

/**
 * Hardware H.264 encoders that actually work on this PC (FFmpeg lists them even without the GPU),
 * found by encoding a few frames with the same arguments the export uses. Cached per FFmpeg path.
 * @param {string} ffmpeg
 * @returns {Promise<string[]>}
 */
export function detectEncoders(ffmpeg) {
  if (!encoderCache.has(ffmpeg)) {
    encoderCache.set(ffmpeg, (async () => {
      const ok = [];
      for (const enc of HARDWARE_ENCODERS) {
        try {
          const res = await run(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=0.3',
            ...encoderArgs(enc), '-f', 'null', '-']);
          if (res.code === 0) ok.push(enc);
        } catch {
          // FFmpeg missing: no hardware encoders
        }
      }
      return ok;
    })());
  }
  return encoderCache.get(ffmpeg);
}

/**
 * The encoder to export with: the setting, or for 'auto' the first working hardware encoder, else libx264.
 * @param {typeof DEFAULT_SETTINGS} settings
 * @param {string} ffmpeg
 * @returns {Promise<string>}
 */
export async function resolveEncoder(settings, ffmpeg) {
  if (settings.encoder && settings.encoder !== 'auto') return settings.encoder;
  return (await detectEncoders(ffmpeg))[0] ?? 'libx264';
}

/**
 * Check every external tool, for the Settings dialog.
 * @param {typeof DEFAULT_SETTINGS} settings
 * @param {string} appRoot
 * @returns {Promise<object>}
 */
export async function toolStatus(settings, appRoot) {
  const { ffmpeg, ffprobe } = resolveFfmpeg(settings, appRoot);
  const version = async (cmd) => {
    try {
      const res = await run(cmd, ['-hide_banner', '-version']);
      return res.code === 0 ? res.stdout.split('\n')[0].replace(/ Copyright.*/, '') : null;
    } catch {
      return null;
    }
  };
  const model = resolveModel(settings, appRoot);
  return {
    ffmpeg: { path: ffmpeg, version: await version(ffmpeg) },
    ffprobe: { path: ffprobe, version: await version(ffprobe) },
    python: await resolvePython(settings, appRoot),
    model: { value: model, local: existsSync(join(model, 'model.bin')) },
    encoders: { hardware: await detectEncoders(ffmpeg), chosen: await resolveEncoder(settings, ffmpeg) },
  };
}
