// Integration: real FFmpeg export of layers (keyframed image, looping GIF, transparent WebM), a cropped
// and faded main clip, an audio track mixed in, and a timeline that runs past the main track.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setCaptionStyle } from '../../core/captions.js';
import { addItem, addMedia, appendClip, createProject, setSubtitles, updateElement, updateMedia } from '../../core/project.js';
import { runExport } from '../../electron/export.js';
import { probe } from '../../electron/media.js';
import { run } from '../../electron/proc.js';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
const hasFfmpeg = await run(ffmpeg, ['-version']).then((r) => r.code === 0, () => false);

test('export: layers, keyframes, effects, GIF, alpha and audio mix', { skip: !hasFfmpeg && 'ffmpeg not found', timeout: 180000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shotcut-layers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const f = (name) => join(dir, name);
  ff(['-f', 'lavfi', '-i', 'color=c=0x2040ff:s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f('main.mp4')]);
  ff(['-f', 'lavfi', '-i', 'color=c=white:s=100x100', '-frames:v', '1', f('logo.png')]);
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=100x100:r=10:d=1', '-vf', 'split[a][b];[a]palettegen[p];[b][p]paletteuse', f('spin.gif')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=880:d=2.5', f('music.wav')]);
  // Green square on a keyed-out background: only the square is opaque.
  ff(['-f', 'lavfi', '-i', 'color=c=black:s=200x200:r=30:d=3,drawbox=x=50:y=50:w=100:h=100:color=0x00ff00:t=fill', '-vf', 'colorkey=black:0.1:0,format=yuva420p',
    '-c:v', 'libvpx-vp9', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '30', f('cut.webm')]);

  const info = {};
  for (const n of ['main.mp4', 'logo.png', 'spin.gif', 'music.wav', 'cut.webm']) info[n] = await probe(ffprobe, f(n));
  assert.deepEqual([info['logo.png'].kind, info['spin.gif'].kind, info['cut.webm'].alpha], ['image', 'gif', true]);

  let p = createProject();
  for (const [id, n] of [['main', 'main.mp4'], ['logo', 'logo.png'], ['spin', 'spin.gif'], ['music', 'music.wav'], ['cut', 'cut.webm']]) {
    p = addMedia(p, { ...info[n], id });
  }
  p = appendClip(p, 'main', { id: 'm' });
  // Main clip: keep the left half (it is fitted again, so it fills the frame height) and fade in.
  p = updateElement(p, 'm', { crop: { x: 0, y: 0, w: 0.5, h: 1 }, anim: { in: { type: 'fade', duration: 0.5 }, out: null } });
  // Logo: 1.0–2.5 s, moves left to right (linear keyframes), 108 px square.
  p = addItem(p, 'logo', 1, { id: 'logo1', out: 1.5 });
  p = updateElement(p, 'logo1', {
    keyframes: [{ t: 0, x: 0.1, y: 0.5, scale: 0.1, opacity: 1 }, { t: 1.5, x: 0.9, y: 0.5, scale: 0.1, opacity: 1 }],
  });
  // GIF in the top-right corner for the whole 3.5 s (loops past its 1 s length).
  p = addItem(p, 'spin', 0, { id: 'gif1', out: 3.5 });
  p = updateElement(p, 'gif1', { transform: { x: 0.85, y: 0.2, scale: 0.2, opacity: 1 } });
  // Transparent WebM bottom-centre (432 px box): only its green square shows.
  p = addItem(p, 'cut', 0, { id: 'cut1' });
  p = updateElement(p, 'cut1', { transform: { x: 0.5, y: 0.75, scale: 0.4, opacity: 1 } });
  // Music on an audio track from 1.0 s, 6 dB down, running past the main track (timeline = 3.5 s).
  p = addItem(p, 'music', 1, { id: 'mus' });
  p = updateElement(p, 'mus', { volume: -6 });
  assert.deepEqual(p.tracks.map((tr) => tr.kind), ['layer', 'layer', 'layer', 'audio']);
  // Captions: the second caption has its own place and size; an imported subtitle line at 3.0 s.
  p = updateMedia(p, 'main', { words: [
    { text: 'Hello', start: 0.2, end: 0.6 }, { text: 'world.', start: 0.7, end: 1.2 },
    { text: 'Second', start: 1.6, end: 2.0 }, { text: 'line.', start: 2.1, end: 2.6 },
  ] });
  p = setCaptionStyle(p, { x: 0.3, position: 0.4, size: 0.05 }, ['w:main:2']);
  p = setSubtitles(p, [{ start: 3.0, end: 3.4, text: 'Imported' }]);

  const out = f('out.mp4');
  const workDir = f('job');
  const res = await runExport({ ffmpeg, project: p, output: out, workDir });
  assert.equal(res.duration, 3.5);
  const graph = readFileSync(join(workDir, 'graph.txt'), 'utf8');
  assert.match(graph, /scale=w=108:h=108,setsar=1\[o0\]/, 'a move without resizing keeps a fixed size');
  assert.match(graph, /\]overlay=x='round\(if\(lt\(t,1\),138,/, 'position is an expression in t starting at 138 px');
  assert.match(graph, /geq=.*enable='between\(t,-0\.017,0\.45\)'.*\[f0\]/, 'the main clip fades in with geq for its first 0.5 s only');
  assert.match(graph, /overlay=x='round\(if\(lt\(t,1\),138,if\(gte\(t,2\.4667\),[\d.]+,[\d.]+\+\(t-1\)\*[\d.]+\)\)\)'/, 'a linear move is one segment');
  const got = await probe(ffprobe, out);
  assert.ok(Math.abs(got.duration - 3.5) < 0.1, `duration ${got.duration}`);
  assert.deepEqual([got.width, got.height, got.hasAudio], [1920, 1080, true]);

  const pixel = (time, x, y) => [...execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', out, '-frames:v', '1',
    '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'])];
  const isWhite = (c) => c.every((v) => v > 200);
  const isBlue = (c) => c[2] > 180 && c[0] < 100;
  const isBlack = (c) => c.every((v) => v < 40);

  assert.ok(pixel(0.05, 960, 300)[2] < 120, 'main clip fades in from black');
  assert.ok(isBlue(pixel(1.0, 960, 300)), 'main clip after the fade');
  assert.ok(isBlack(pixel(1.0, 200, 300)), 'cropped to its left half: bars at the sides');
  assert.ok(isWhite(pixel(1.75, 960, 540)), 'logo in the middle halfway through its move');
  assert.ok(!isWhite(pixel(1.1, 960, 540)), 'logo not in the middle at the start of its move');
  const gif = pixel(2.8, 1632, 216);
  assert.ok(gif[0] > 180 && gif[1] < 90, `looping GIF still on screen at 2.8 s: ${gif}`);
  assert.ok(pixel(2.0, 960, 810)[1] > 180, 'green square of the transparent WebM');
  assert.ok(isBlue(pixel(2.0, 960 - 180, 810 - 180)), 'its keyed-out corner shows the main clip');
  assert.ok(isBlack(pixel(3.3, 960, 300)), 'black after the main track ends');

  const ass = readFileSync(join(workDir, 'captions.ass'), 'utf8');
  assert.match(ass, /^Style: Cue1,Arial,54,/m, 'the changed caption has its own style');
  assert.match(ass, /Dialogue: 0,0:00:03\.00,0:00:03\.40,Default,,0,0,0,,.*Imported/, 'the imported subtitle is burned in');
  const bright = (time, x, y, w, h) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', out, '-frames:v', '1',
    '-vf', `crop=${w}:${h}:${x}:${y},format=gray`, '-f', 'rawvideo', '-']).reduce((n, v) => n + (v > 220 ? 1 : 0), 0);
  assert.ok(bright(2.0, 300, 340, 560, 100) > 300, 'the second caption is drawn where it was moved (left, 40% down)');
  assert.equal(bright(2.0, 300, 840, 1300, 100), 0, 'and not at the default place');
  assert.ok(bright(1.0, 400, 840, 1120, 100) > 300, 'the first caption is at the default place');

  const vol = async (from, len) => {
    const r = await run(ffmpeg, ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(len), '-i', out, '-af', 'volumedetect', '-vn', '-f', 'null', '-']);
    return Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1]);
  };
  const before = await vol(0.2, 0.6);
  const mixed = await vol(1.5, 1);
  const tail = await vol(3.1, 0.3);
  // Music 6 dB under a tone of the same level adds a quarter of its power: +0.97 dB (FFmpeg 8.1 and 9.0 differ by 0.1 dB).
  assert.ok(mixed > before + 0.5, `music adds level: ${before} -> ${mixed} dB`);
  assert.ok(tail > -40, `music continues after the main track: ${tail} dB`);
});
