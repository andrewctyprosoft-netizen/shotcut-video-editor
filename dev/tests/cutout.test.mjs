// Background removal: colour key (FFmpeg only), the AI path with a stand-in ONNX model (no download),
// and the model downloader against a local HTTP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUTOUT_MODELS, ensureModel, keyFilter, makeCutout } from '../../electron/cutout.js';
import { probe } from '../../electron/media.js';
import { run, splitCommand } from '../../electron/proc.js';
import { bundledPython } from '../../electron/tools.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
const hasFfmpeg = await run(ffmpeg, ['-version']).then((r) => r.code === 0, () => false);
const bundled = bundledPython(root); // the launcher's Python, else the system one
const python = bundled ? `"${bundled}"` : process.platform === 'win32' ? 'py -3.11' : 'python3';
const hasOnnx = await (async () => {
  const [cmd, ...pre] = splitCommand(python);
  return run(cmd, [...pre, '-c', 'import onnxruntime, numpy, PIL']).then((r) => r.code === 0, () => false);
})();

/** RGBA of one pixel of the first frame (libvpx decodes the alpha of VP9 WebM). */
function rgba(file, x, y) {
  const pre = file.endsWith('.webm') ? ['-c:v', 'libvpx-vp9'] : [];
  return [...execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...pre, '-i', file, '-frames:v', '1', '-vf', `format=rgba,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-'])];
}

function samples(dir) {
  const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const green = join(dir, 'green.mp4');
  ff(['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x240:r=15:d=1,drawbox=x=100:y=60:w=120:h=120:color=0xff3030:t=fill', '-f', 'lavfi', '-i', 'sine=d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', green]);
  const square = join(dir, 'square.mp4');
  ff(['-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=15:d=1,drawbox=x=100:y=60:w=120:h=120:color=white:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', square]);
  const still = join(dir, 'square.png');
  ff(['-i', square, '-frames:v', '1', still]);
  return { green, square, still };
}

test('keyFilter adds despill for green and blue screens', () => {
  assert.equal(keyFilter({ color: '#00FF00' }), 'colorkey=0x00FF00:0.3:0.1,despill=type=green');
  assert.equal(keyFilter({ color: '#0000ff', similarity: 0.2, blend: 0 }), 'colorkey=0x0000ff:0.2:0,despill=type=blue');
  assert.equal(keyFilter({ color: '#ffffff' }), 'colorkey=0xffffff:0.3:0.1');
});

test('colour key: green screen video becomes VP9 with alpha, audio kept; cached on repeat', { skip: !hasFfmpeg && 'ffmpeg not found', timeout: 120000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shotcut-cut-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { green } = samples(dir);
  const info = await probe(ffprobe, green);
  const opts = { ffmpeg, visionDir: join(root, 'vision'), modelsDir: dir, outDir: join(dir, 'out'), info, method: 'key', key: { color: '#00ff00' } };
  const out = await makeCutout(opts);
  const got = await probe(ffprobe, out);
  assert.deepEqual([got.videoCodec, got.alpha, got.hasAudio], ['vp9', true, true]);
  assert.equal(rgba(out, 10, 10)[3], 0, 'green background is transparent');
  assert.equal(rgba(out, 160, 120)[3], 255, 'the red square stays');
  assert.equal(await makeCutout(opts), out, 'second run reuses the file');
});

test('AI method with a stand-in model: PNG for an image, VP9 alpha for a video', { skip: (!hasFfmpeg || !hasOnnx) && 'needs ffmpeg and Python with onnxruntime', timeout: 180000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shotcut-ai-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { square, still } = samples(dir);
  const [cmd, ...pre] = splitCommand(python);
  const models = join(dir, 'models');
  execFileSync(cmd, [...pre, join(root, 'dev', 'tools', 'fake_matte_model.py'), join(dir, 'fake.onnx')]);
  // Stand in for the default model so ensureModel finds it and does not download.
  execFileSync(cmd, [...pre, '-c', 'import os,shutil,sys; os.makedirs(sys.argv[2], exist_ok=True); shutil.copy(sys.argv[1], os.path.join(sys.argv[2], sys.argv[3]))',
    join(dir, 'fake.onnx'), models, CUTOUT_MODELS.silueta.file]);
  const base = { ffmpeg, python, visionDir: join(root, 'vision'), modelsDir: models, outDir: join(dir, 'out'), method: 'ai', model: 'silueta' };
  const progress = [];
  const png = await makeCutout({ ...base, info: await probe(ffprobe, still), onProgress: (f) => progress.push(f) });
  assert.match(png, /\.png$/);
  assert.deepEqual([rgba(png, 10, 10)[3], rgba(png, 160, 120)[3]], [0, 255]);
  const webm = await makeCutout({ ...base, info: await probe(ffprobe, square) });
  const got = await probe(ffprobe, webm);
  assert.deepEqual([got.alpha, Math.round(got.duration)], [true, 1]);
  assert.deepEqual([rgba(webm, 10, 10)[3], rgba(webm, 160, 120)[3]], [0, 255]);
  assert.ok(progress.at(-1) === 1);
});

test('ensureModel downloads once, with progress, from the releases URL', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shotcut-models-'));
  const body = Buffer.alloc(300000, 7);
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url !== `/${CUTOUT_MODELS.silueta.file}`) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const fractions = [];
  const file = await ensureModel('silueta', dir, { baseUrl, onProgress: (f) => fractions.push(f) });
  assert.equal(readFileSync(file).length, body.length);
  assert.equal(fractions.at(-1), 1);
  await ensureModel('silueta', dir, { baseUrl });
  assert.equal(hits, 1, 'cached after the first download');
  await assert.rejects(ensureModel('u2net_human_seg', dir, { baseUrl }), /HTTP 404/);
});
