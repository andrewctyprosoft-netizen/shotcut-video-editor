// Flip (preview CSS and export filters) and the 0.1x-10x speed range: pure parts, then a real FFmpeg
// export of a flipped and sped-up timeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placement } from '../../core/anim.js';
import { buildExportPlan } from '../../core/exportPlan.js';
import {
  addItem, addMedia, appendClip, createProject, layout, totalDuration, updateClip, updateElement, withSpeed,
} from '../../core/project.js';
import { runExport } from '../../electron/export.js';
import { probe } from '../../electron/media.js';
import { run } from '../../electron/proc.js';
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
