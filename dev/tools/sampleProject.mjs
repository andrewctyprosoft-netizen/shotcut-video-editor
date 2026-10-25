// Build the sample projects used by the smoke and end-to-end checks: talk.mp4 (transcribed once,
// cached as talk.words.json) + bars.mp4 with a fade; the layers project adds a transparent PNG logo,
// a GIF, a green-screen image, music on an audio track and imported subtitles. Run `npm run samples` first.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSubtitles } from '../../core/captions.js';
import { addItem, addMedia, appendClip, createProject, setSubtitles, updateClip, updateElement } from '../../core/project.js';
import { transcribe } from '../../electron/asr.js';
import { probe } from '../../electron/media.js';
import { DEFAULT_SETTINGS, resolveFfmpeg, resolveModel, resolvePython } from '../../electron/tools.js';

export const root = fileURLToPath(new URL('../..', import.meta.url));
export const outDir = join(root, 'dev', 'out');
const samples = join(root, 'dev', 'samples');

/**
 * Write dev/out/<name>.shotcut (talk + bars) and return its path.
 * @param {string} [name]
 * @returns {Promise<string>}
 */
export async function writeSampleProject(name = 'sample') {
  return save(name, await baseProject());
}

/**
 * Write dev/out/<name>.shotcut with layers on top of the sample project and return its path.
 * Layer 1: logo.png 0.5–6.5 s (top right). Layer 2: spin.gif 1–5 s (top left), green.png 6–9 s (centre).
 * Audio: music.wav from 0 s at -12 dB. Subtitles: one imported line at 10.6–11.8 s. long.ogg (70 min) is in Media only.
 * @param {string} [name]
 * @returns {Promise<string>}
 */
export async function writeLayersProject(name = 'layers') {
  const { ffprobe } = resolveFfmpeg(DEFAULT_SETTINGS, root);
  const files = makeLayerSamples();
  let p = await baseProject();
  for (const [id, file] of Object.entries(files)) {
    if (id !== 'srt') p = addMedia(p, { ...(await probe(ffprobe, file)), id });
  }
  p = addItem(p, 'logo', 0.5, { id: 'logo1', out: 6 });
  p = updateElement(p, 'logo1', { transform: { x: 0.8, y: 0.25, scale: 0.3, opacity: 1 } });
  p = addItem(p, 'spin', 1, { id: 'gif1', out: 4 });
  p = updateElement(p, 'gif1', { transform: { x: 0.2, y: 0.3, scale: 0.35, opacity: 1 } });
  p = addItem(p, 'green', 6, { id: 'green1', out: 3 });
  p = addItem(p, 'music', 0, { id: 'music1' });
  p = updateElement(p, 'music1', { volume: -12 });
  p = setSubtitles(p, parseSubtitles(readFileSync(files.srt, 'utf8')));
  return save(name, p);
}

// ---------- helpers ----------

async function baseProject() {
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(join(samples, 'talk.mp4'))) throw new Error('Run `npm run samples` first.');
  const { ffprobe } = resolveFfmpeg(DEFAULT_SETTINGS, root);
  const talk = await probe(ffprobe, join(samples, 'talk.mp4'));
  const bars = await probe(ffprobe, join(samples, 'bars.mp4'));

  const wordsFile = join(samples, 'talk.words.json');
  if (!existsSync(wordsFile)) {
    const python = await resolvePython(DEFAULT_SETTINGS, root);
    if (!python.ok) throw new Error(python.error);
    console.log('transcribing talk.mp4 ...');
    const words = await transcribe({
      python: python.command, asrDir: join(root, 'asr'), workDir: join(outDir, 'asr'), media: talk.path,
      model: resolveModel(DEFAULT_SETTINGS, root), language: 'en',
    });
    writeFileSync(wordsFile, JSON.stringify(words, null, 1));
  }
  const words = JSON.parse(readFileSync(wordsFile, 'utf8'));

  let p = createProject();
  p = appendClip(addMedia(p, { ...talk, id: 'talk', words }), 'talk');
  p = appendClip(addMedia(p, { ...bars, id: 'bars' }), 'bars');
  p = updateClip(p, p.clips[1].id, { transition: { type: 'fade', duration: 0.5 } });
  return { ...p, glossary: [{ from: 'shotcut', to: 'ShotCut' }] };
}

/** Make the extra layer samples once (FFmpeg only). */
function makeLayerSamples() {
  const ffmpeg = resolveFfmpeg(DEFAULT_SETTINGS, root).ffmpeg;
  const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const files = {
    logo: join(samples, 'logo.png'),
    spin: join(samples, 'spin.gif'),
    green: join(samples, 'green.png'),
    music: join(samples, 'music.wav'),
    srt: join(samples, 'lines.srt'),
    long: join(samples, 'long.ogg'), // 70 minutes of silence, for zooming a long timeline
  };
  if (!existsSync(files.logo)) {
    ff(['-f', 'lavfi', '-i', 'color=c=black@0:s=300x300,format=rgba', '-frames:v', '1',
      '-vf', "geq=r='255':g='140':b='0':a='if(lt(hypot(X-150,Y-150),140),255,0)'", files.logo]);
  }
  if (!existsSync(files.spin)) {
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=200x200:r=10:d=1', '-vf', 'split[a][b];[a]palettegen[p];[b][p]paletteuse', files.spin]);
  }
  if (!existsSync(files.green)) {
    ff(['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=640x360,drawbox=x=220:y=80:w=200:h=200:color=0xe02020:t=fill', '-frames:v', '1', files.green]);
  }
  if (!existsSync(files.music)) ff(['-f', 'lavfi', '-i', 'sine=f=220:d=12', files.music]);
  if (!existsSync(files.long)) ff(['-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '4200', '-c:a', 'libopus', '-b:a', '6k', files.long]);
  if (!existsSync(files.srt)) writeFileSync(files.srt, '1\n00:00:10,600 --> 00:00:11,800\nImported subtitle line\n', 'utf8');
  return files;
}

function save(name, project) {
  const file = join(outDir, `${name}.shotcut`);
  writeFileSync(file, JSON.stringify(project, null, 1));
  return file;
}
