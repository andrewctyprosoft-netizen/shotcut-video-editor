// Build the sample project used by the smoke and end-to-end checks: talk.mp4 (transcribed once,
// cached as talk.words.json) + bars.mp4 with a fade. Run `npm run samples` first.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addMedia, appendClip, createProject, updateClip } from '../../core/project.js';
import { transcribe } from '../../electron/asr.js';
import { probe } from '../../electron/media.js';
import { DEFAULT_SETTINGS, resolveFfmpeg, resolveModel, resolvePython } from '../../electron/tools.js';

export const root = fileURLToPath(new URL('../..', import.meta.url));
export const outDir = join(root, 'dev', 'out');

/**
 * Write dev/out/<name>.shotcut and return its path.
 * @param {string} [name]
 * @returns {Promise<string>}
 */
export async function writeSampleProject(name = 'sample') {
  const samples = join(root, 'dev', 'samples');
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(join(samples, 'talk.mp4'))) throw new Error('Run `npm run samples` first.');
  const { ffprobe } = resolveFfmpeg(DEFAULT_SETTINGS, root);
  const talk = await probe(ffprobe, join(samples, 'talk.mp4'));
  const bars = await probe(ffprobe, join(samples, 'bars.mp4'));

  const wordsFile = join(samples, 'talk.words.json');
  if (!existsSync(wordsFile)) {
    const python = await resolvePython(DEFAULT_SETTINGS);
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
  p = { ...p, glossary: [{ from: 'shotcut', to: 'ShotCut' }] };
  const file = join(outDir, `${name}.shotcut`);
  writeFileSync(file, JSON.stringify(p, null, 1));
  return file;
}
