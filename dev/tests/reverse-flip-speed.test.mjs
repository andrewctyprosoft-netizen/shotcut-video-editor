// Reverse (backwards copies made in chunks), flip (preview CSS and export filters) and the 0.1x-10x speed
// range: pure parts, then real FFmpeg runs (reversed picture and sound, flipped and sped-up export).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placement } from '../../core/anim.js';
import { buildExportPlan } from '../../core/exportPlan.js';
import {
  addItem, addMedia, addReversedCopy, appendClip, createProject, isReversedCopy, layout, offReversedCopy, onReversedCopy, splitClip,
  totalDuration, updateClip, updateElement, withSpeed,
} from '../../core/project.js';
import { runExport } from '../../electron/export.js';
import { probe } from '../../electron/media.js';
import { run } from '../../electron/proc.js';
import { makeReversed, reverseChunks } from '../../electron/reverse.js';
import { pictureCss } from '../../src/stage.js';
import { media, projectWith } from './helpers.mjs';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
const hasFfmpeg = await run(ffmpeg, ['-version']).then((r) => r.code === 0, () => false);

test('speed goes from 0.1x to 10x; keyframes move with the picture', () => {
  let p = projectWith(media('a', 10));
  const id = p.clips[0].id;
  p = updateClip(p, id, { speed: 99 });
  assert.equal(p.clips[0].speed, 10);
  assert.equal(totalDuration(p), 1);
  p = updateClip(p, id, { speed: 0.01 });
  assert.equal(p.clips[0].speed, 0.1);
  assert.equal(totalDuration(p), 100);
  const el = { speed: 1, keyframes: [{ t: 0 }, { t: 4 }] };
  assert.deepEqual(withSpeed(el, 2).keyframes.map((k) => k.t), [0, 2]);
  assert.deepEqual(withSpeed(el, 0.5).keyframes.map((k) => k.t), [0, 8]);
  assert.equal(withSpeed(el, 1), el, 'same speed: unchanged');
});

test('the export plan chains atempo for 0.1x and runs 10x in one step', () => {
  for (const [speed, tempo] of [[10, /atempo=10[,\]]/], [0.1, /atempo=0\.5,atempo=0\.5,atempo=0\.5,atempo=0\.8/]]) {
    let p = projectWith(media('a', 10));
    p = updateClip(p, p.clips[0].id, { speed });
    const plan = buildExportPlan(p);
    assert.match(plan.graph, tempo);
    assert.match(plan.graph, new RegExp(`setpts=\\(PTS-STARTPTS\\)/${speed}`));
    assert.equal(plan.duration, 10 / speed);
  }
});

test('flip: export filters run after the crop; plain clips keep the fast chain', () => {
  let p = projectWith(media('a', 4));
  p = updateClip(p, p.clips[0].id, { flip: { h: true, v: false } });
  assert.match(buildExportPlan(p).graph, /fps=30,hflip,scale=1920:1080:force_original/);
  p = updateClip(p, p.clips[0].id, { flip: { h: true, v: true }, crop: { x: 0, y: 0, w: 0.5, h: 1 } });
  assert.match(buildExportPlan(p).graph, /crop=960:1080:0:0,hflip,vflip,/);
});

test('flip in the preview keeps the cropped part where the export draws it', () => {
  const m = { width: 200, height: 100 };
  const crop = { x: 0, y: 0, w: 0.25, h: 1 }; // the left quarter
  const p = placement(m, crop, { x: 0.5, y: 0.5, scale: 1, opacity: 1 }, [200, 100]);
  const plain = pictureCss(p, [200, 100]);
  const flipped = pictureCss(p, [200, 100], { h: true });
  assert.equal(plain.transform, '');
  assert.equal(flipped.transform, 'scale(-1, 1)');
  assert.equal(flipped.clipPath, plain.clipPath, 'the clip-path flips with the element');
  // Element box after a CSS flip about its centre: visible part = mirror of the inset region.
  const px = (css) => Number(css.left.replace('%', '')) * 2; // % of 200 px
  const w = Number(flipped.width.replace('%', '')) * 2;
  const visibleLeft = px(flipped) + (1 - crop.x - crop.w) * w;
  assert.ok(Math.abs(visibleLeft - p.box.left) < 1e-6, `flipped crop at ${visibleLeft}, box at ${p.box.left}`);
});

test('reverse chunks: whole frames, bounded memory, audio in minutes', () => {
  const hd = reverseChunks({ hasVideo: true, width: 1920, height: 1080, fps: 30 }, { in: 2, out: 12 });
  assert.equal(hd[0].start, 2);
  assert.ok(hd.length > 1 && hd.length < 10, `${hd.length} chunks`);
  assert.ok(Math.abs(hd.reduce((n, c) => n + c.duration, 0) - 10) < 1e-6, 'chunks cover the range');
  assert.ok(Math.abs(hd[0].duration * 30 - Math.round(hd[0].duration * 30)) < 1e-6, 'whole frames');
  assert.ok(1920 * 1080 * 1.5 * hd[0].duration * 30 <= 300e6);
  assert.equal(reverseChunks({ hasVideo: false }, { in: 0, out: 150 }).length, 3);
});

test('reverse model: a copy of the range swaps in, trims map back, the copy is added once', () => {
  let p = projectWith(media('a', 20));
  p = splitClip(p, p.clips[0].id, 10);
  const [c1, c2] = p.clips;
  p = updateClip(p, c1.id, { in: 4 }); // c1 shows 4..10
  const res = { mediaId: 'a', elementIds: [c1.id, c2.id], range: { in: 4, out: 10 }, path: 'C:\\rev\\x.rev.mp4' };
  p = addReversedCopy(p, res);
  const rev = Object.values(p.media).find((m) => m.reverseOf);
  assert.deepEqual([rev.duration, rev.reverseOf, rev.words], [6, { mediaId: 'a', in: 4, out: 10 }, null]);
  assert.ok(isReversedCopy(p, rev));
  assert.deepEqual([p.clips[0].mediaId, p.clips[0].in, p.clips[0].out], [rev.id, 0, 6]);
  assert.equal(p.clips[1].mediaId, 'a', 'the other half has another range: untouched');
  assert.equal(addReversedCopy(p, res), p, 'the same file again: nothing to do');
  // Trim the reversed clip to copy time 1..4: it showed source 9..6 backwards, so forwards it is 6..9.
  p = updateClip(p, p.clips[0].id, { in: 1, out: 4 });
  p = updateElement(p, p.clips[0].id, offReversedCopy(p.clips[0], rev.reverseOf));
  assert.deepEqual([p.clips[0].mediaId, p.clips[0].in, p.clips[0].out], ['a', 6, 9], 'clamped to the original, not the 6 s copy');
  assert.deepEqual(onReversedCopy({ in: 2, out: 5 }, 'r'), { in: 0, out: 3, mediaId: 'r' });
});

test('reverse: picture and sound play backwards, joined from several chunks; cached', { skip: !hasFfmpeg && 'ffmpeg not found', timeout: 180000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shotcut-rev-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const src = join(dir, 'src.mp4');
  // 0-1 s red and silent, 1-2 s blue with a tone.
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=25:d=1[a];color=c=blue:s=160x90:r=25:d=1[b];[a][b]concat=n=2:v=1:a=0',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=1[s];sine=f=440:d=1:r=48000,aformat=channel_layouts=stereo[t];[s][t]concat=n=2:v=0:a=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  const info = await probe(ffprobe, src);
  const opts = { ffmpeg, info, range: { in: 0.5, out: 2 }, outDir: join(dir, 'out'), workDir: join(dir, 'work'), chunkSeconds: 0.4 };
  const progress = [];
  const out = await makeReversed({ ...opts, onProgress: (f) => progress.push(f) });
  assert.equal(progress.length, 5, '4 chunks (0.4 + 0.4 + 0.4 + 0.3 s) and the join');
  const got = await probe(ffprobe, out);
  assert.ok(Math.abs(got.duration - 1.5) < 0.08, `duration ${got.duration}`);
  assert.deepEqual([got.videoCodec, got.audioCodec, got.width], ['h264', 'aac', 160]);
  const rgb = (time) => [...execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', out, '-frames:v', '1',
    '-vf', 'crop=1:1:80:45,format=rgb24', '-f', 'rawvideo', '-'])];
  const [r0, , b0] = rgb(0.1);
  const [r1, , b1] = rgb(1.2);
  assert.ok(b0 > 200 && r0 < 60, `starts blue (the source end): ${rgb(0.1)}`);
  assert.ok(r1 > 200 && b1 < 60, `ends red: ${rgb(1.2)}`);
  const mean = async (start, d) => {
    const r = await run(ffmpeg, ['-hide_banner', '-ss', String(start), '-t', String(d), '-i', out, '-af', 'volumedetect', '-vn', '-f', 'null', '-']);
    return Number(/mean_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr)?.[1] ?? -Infinity);
  };
  assert.ok(await mean(0.05, 0.8) > -35, 'the tone (about -24 dB) comes first');
  assert.ok(await mean(1.1, 0.3) < -60, 'the silence comes last');
  assert.equal(await makeReversed(opts), out, 'second run reuses the file');

  // Audio only: an .m4a copy.
  const wav = join(dir, 'tone.wav');
  ff(['-f', 'lavfi', '-i', 'sine=f=220:d=3', wav]);
  const audio = await makeReversed({ ...opts, info: await probe(ffprobe, wav), range: { in: 0, out: 3 } });
  const ai = await probe(ffprobe, audio);
  assert.ok(audio.endsWith('.m4a') && !ai.hasVideo && Math.abs(ai.duration - 3) < 0.08, `${audio} ${ai.duration}`);
});

test('export: a flipped main clip and a 10x layer item', { skip: !hasFfmpeg && 'ffmpeg not found', timeout: 120000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shotcut-flip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const lr = join(dir, 'lr.mp4');
  // Left half red, right half blue.
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=2,drawbox=x=160:y=0:w=160:h=180:color=blue:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', lr]);
  const fast = join(dir, 'fast.mp4');
  ff(['-f', 'lavfi', '-i', 'color=c=white:s=160x90:r=30:d=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fast]);
  let p = createProject({ export: { resolution: 720, quality: 'small' } });
  p = appendClip(addMedia(p, { ...(await probe(ffprobe, lr)), id: 'lr' }), 'lr', { id: 'm' });
  p = updateElement(p, 'm', { flip: { h: true, v: false } });
  p = addItem(addMedia(p, { ...(await probe(ffprobe, fast)), id: 'fast' }), 'fast', 0, { id: 'f' });
  p = updateElement(p, 'f', { speed: 10, flip: { h: false, v: true }, crop: { x: 0, y: 0, w: 1, h: 0.5 } });
  assert.equal(layout(p)[0].duration, 2);
  assert.equal(totalDuration(p), 2, '10 s at 10x is 1 s');
  const out = join(dir, 'out.mp4');
  const workDir = join(dir, 'job');
  await runExport({ ffmpeg, project: p, output: out, workDir });
  assert.match(readFileSync(join(workDir, 'graph.txt'), 'utf8'), /setpts=\(PTS-STARTPTS\)\/10,fps=30,.*crop=160:45:0:0,vflip/);
  const rgb = (time, x, y) => [...execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', out, '-frames:v', '1',
    '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'])];
  const [rl, , bl] = rgb(1.5, 100, 360);
  const [rr, , br] = rgb(1.5, 1180, 360);
  assert.ok(bl > 200 && rl < 60, `left is blue after the flip: ${rgb(1.5, 100, 360)}`);
  assert.ok(rr > 200 && br < 60, `right is red: ${rgb(1.5, 1180, 360)}`);
  // The layer item (cropped to 160x45, fitted and halved) covers x 320-960, y 270-450.
  assert.ok(rgb(0.5, 400, 360).every((v) => v > 200), `the white layer item shows at 0.5 s: ${rgb(0.5, 400, 360)}`);
  assert.ok(rgb(1.5, 400, 360)[2] > 200, 'and is gone after 1 s (10 s at 10x)');
});
