// Integration: real FFmpeg export of two clips with a transition and burned-in captions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addMedia, appendClip, createProject, removeSourceRanges, updateClip } from '../../core/project.js';
import { runExport } from '../../electron/export.js';
import { probe } from '../../electron/media.js';
import { run } from '../../electron/proc.js';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
const hasFfmpeg = await run(ffmpeg, ['-version']).then((r) => r.code === 0, () => false);

test('export: fade transition, captions burned in, exact duration', { skip: !hasFfmpeg && 'ffmpeg not found', timeout: 120000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shotcut-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const a = join(dir, 'a.mp4');
  const b = join(dir, 'b.mp4');
  ff(['-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:r=25:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', a]);
  ff(['-f', 'lavfi', '-i', 'color=c=0x402020:s=360x640:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', b]);

  const ia = await probe(ffprobe, a);
  const ib = await probe(ffprobe, b);
  assert.equal(ib.hasAudio, false);
  let p = createProject();
  p = appendClip(addMedia(p, { ...ia, id: 'a', words: [{ text: 'Hello', start: 0.2, end: 0.7 }, { text: 'captions.', start: 0.8, end: 1.6 }] }), 'a');
  p = appendClip(addMedia(p, { ...ib, id: 'b' }), 'b');
  p = updateClip(p, p.clips[1].id, { transition: { type: 'fade', duration: 0.5 } });

  const out = join(dir, 'out.mp4');
  const workDir = join(dir, 'job');
  const fractions = [];
  const res = await runExport({ ffmpeg, project: p, output: out, workDir, onProgress: (f) => fractions.push(f) });
  assert.equal(res.duration, 4.5);
  assert.ok(fractions.length > 0, 'progress reported');
  assert.match(readFileSync(join(workDir, 'captions.ass'), 'utf8'), /Dialogue: .*Hello/);

  const info = await probe(ffprobe, out);
  assert.ok(Math.abs(info.duration - 4.5) < 0.1, `duration ${info.duration}`);
  assert.deepEqual([info.width, info.height, info.hasAudio, info.videoCodec], [1920, 1080, true, 'h264']);

  // At 1.0 s the caption is on screen: the bottom band holds bright text pixels; the dark clip alone has none.
  const band = (time) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', out, '-frames:v', '1',
    '-vf', 'crop=iw:ih*0.3:0:ih*0.7,format=gray', '-f', 'rawvideo', '-']);
  const bright = (buf) => buf.reduce((n, v) => n + (v > 200 ? 1 : 0), 0);
  assert.ok(bright(band(1.0)) > 500, 'caption pixels at 1.0 s');
  assert.equal(bright(band(3.0)), 0, 'no caption after the words');
  assert.ok(existsSync(out));
});

test('export: a cut followed by a transition (concat then xfade)', { skip: !hasFfmpeg && 'ffmpeg not found', timeout: 120000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shotcut-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, 'src.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=4', '-f', 'lavfi', '-i', 'sine=d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  const info = await probe(ffprobe, src);
  let p = createProject();
  p = appendClip(addMedia(p, { ...info, id: 's' }), 's');
  p = appendClip(p, 's');
  p = removeSourceRanges(p, 's', [[1, 1.5]]); // first clip -> two pieces joined by a cut
  p = updateClip(p, p.clips[2].id, { transition: { type: 'wipeleft', duration: 0.5 } });
  assert.equal(p.clips.length, 4);
  const out = join(dir, 'out.mp4');
  const res = await runExport({ ffmpeg, project: p, output: out, workDir: join(dir, 'job') });
  const got = await probe(ffprobe, out);
  assert.ok(Math.abs(got.duration - res.duration) < 0.1, `${got.duration} vs ${res.duration}`);
});

test('export with a preset (9:16, 720p, small) on the auto-picked encoder', { skip: !hasFfmpeg && 'ffmpeg not found', timeout: 120000 }, async (t) => {
  const { applyExportPreset } = await import('../../core/presets.js');
  const { detectEncoders, resolveEncoder } = await import('../../electron/tools.js');
  const dir = mkdtempSync(join(tmpdir(), 'shotcut-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, 'src.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=2', '-f', 'lavfi', '-i', 'sine=d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  let p = createProject();
  p = appendClip(addMedia(p, { ...(await probe(ffprobe, src)), id: 's', words: [{ text: 'Hi', start: 0.2, end: 0.6 }] }), 's');
  p = applyExportPreset({ ...p, fit: 'fill' }, 'vertical');
  p = applyExportPreset(p, 'small');
  const encoder = await resolveEncoder({ encoder: 'auto' }, ffmpeg);
  const hardware = await detectEncoders(ffmpeg);
  assert.equal(encoder, hardware[0] ?? 'libx264');
  const out = join(dir, 'out.mp4');
  await runExport({ ffmpeg, project: p, output: out, workDir: join(dir, 'job'), encoder });
  const info = await probe(ffprobe, out);
  assert.deepEqual([info.width, info.height, info.videoCodec, info.hasAudio], [720, 1280, 'h264', true], `encoder ${encoder}`);
  assert.ok(Math.abs(info.duration - 2) < 0.1);
  t.diagnostic(`encoder: ${encoder}`);
});
