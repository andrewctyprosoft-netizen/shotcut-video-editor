// Integration: faster-whisper transcription and Transcript QC alignment on the generated speech sample.
// Needs `npm run samples` first, Python with faster-whisper, and a model; skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alignTranscript, transcribe } from '../../electron/asr.js';
import { DEFAULT_SETTINGS, resolveModel, resolvePython } from '../../electron/tools.js';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const sample = join(appRoot, 'dev', 'samples', 'speech.wav');
const python = await resolvePython(DEFAULT_SETTINGS);
const model = resolveModel(DEFAULT_SETTINGS, appRoot);
const skip = !existsSync(sample) ? 'run npm run samples first'
  : !python.ok ? python.error
    : !existsSync(join(model, 'model.bin')) ? 'no local Whisper model' : false;

test('transcribe the sample, then align the clean transcript', { skip, timeout: 300000 }, async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'shotcut-asr-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const progress = [];
  const words = await transcribe({
    python: python.command, asrDir: join(appRoot, 'asr'), workDir, media: sample, model, language: 'en',
    onProgress: (f) => progress.push(f),
  });
  const text = words.map((w) => w.text.toLowerCase()).join(' ');
  assert.ok(words.length >= 15, `only ${words.length} words`);
  for (const expected of ['welcome', 'captions', 'pauses']) assert.ok(text.includes(expected), `"${expected}" missing from: ${text}`);
  assert.ok(words.every((w, i) => w.end >= w.start && (i === 0 || w.start >= words[i - 1].start)));
  assert.ok(progress.length > 0);

  const clean = readFileSync(join(appRoot, 'dev', 'samples', 'clean.txt'), 'utf8');
  const aligned = await alignTranscript({ python: python.command, asrDir: join(appRoot, 'asr'), workDir, text: clean, words });
  const lines = clean.split('\n').filter(Boolean);
  assert.equal(aligned.length, lines.join(' ').split(/\s+/).length, 'one timed word per clean token');
  assert.equal(aligned.filter((w) => w.br).length, lines.length, 'a cue break at the end of every line');
  assert.equal(aligned[0].text, 'Hello');
  assert.ok(aligned.at(-1).end <= words.at(-1).end + 1);
});
