// Run the Python ASR sidecar (asr/transcribe.py, asr/align.py). No Electron imports.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromWordsJson } from '../core/transcript.js';
import { runOk, splitCommand } from './proc.js';

/**
 * Transcribe a media file to editor words.
 * @param {{python: string, asrDir: string, workDir: string, media: string, model: string, language: string,
 *   signal?: AbortSignal, onProgress?: (fraction: number, text?: string) => void}} opts
 * @returns {Promise<Array<{text: string, start: number, end: number}>>}
 */
export async function transcribe(opts) {
  mkdirSync(opts.workDir, { recursive: true });
  const out = join(opts.workDir, 'words.json');
  const [cmd, ...pre] = splitCommand(opts.python);
  const args = [...pre, join(opts.asrDir, 'transcribe.py'), opts.media, out, '--model', opts.model, '--language', opts.language || ''];
  await runOk(cmd, args, {
    signal: opts.signal,
    env: { ...process.env, PYTHONUTF8: '1' },
    onStdout: (line) => {
      const msg = parseJsonLine(line);
      if (msg?.type === 'progress' && msg.duration) opts.onProgress?.(Math.min(1, msg.seconds / msg.duration), msg.text);
    },
  });
  return fromWordsJson(JSON.parse(readFileSync(out, 'utf8')));
}

/**
 * Align a clean transcript (one caption per line) to existing word timings with the Transcript QC aligner.
 * @param {{python: string, asrDir: string, workDir: string, text: string,
 *   words: Array<{text: string, start: number, end: number}>, signal?: AbortSignal}} opts
 * @returns {Promise<Array<{text: string, start: number, end: number, br?: boolean}>>}
 */
export async function alignTranscript(opts) {
  mkdirSync(opts.workDir, { recursive: true });
  const clean = join(opts.workDir, 'clean.txt');
  const words = join(opts.workDir, 'asr_words.json');
  const out = join(opts.workDir, 'aligned.json');
  writeFileSync(clean, opts.text, 'utf8');
  writeFileSync(words, JSON.stringify(opts.words.map((w) => ({ word: w.text, start: w.start, end: w.end }))), 'utf8');
  const [cmd, ...pre] = splitCommand(opts.python);
  await runOk(cmd, [...pre, join(opts.asrDir, 'align.py'), clean, words, out], {
    signal: opts.signal,
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  return fromWordsJson(JSON.parse(readFileSync(out, 'utf8')));
}

function parseJsonLine(line) {
  if (!line.startsWith('{')) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
