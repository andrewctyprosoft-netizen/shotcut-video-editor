import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atempoChain, buildExportPlan, exportArgs, parseProgressLine } from '../../core/exportPlan.js';
import { needsProxy, parseProbe } from '../../core/media.js';
import { updateClip } from '../../core/project.js';
import { media, projectWith } from './helpers.mjs';

test('two clips with a fade: xfade offset equals the incoming clip start', () => {
  let p = projectWith(media('a', 4), media('b', 3, { hasAudio: false }));
  p = updateClip(p, p.clips[1].id, { transition: { type: 'fade', duration: 0.5 }, adjust: { brightness: 0.1, contrast: 1, saturation: 1 } });
  const plan = buildExportPlan(p, { captionsFile: 'captions.ass' });
  assert.equal(plan.duration, 6.5);
  assert.deepEqual(plan.inputArgs, ['-ss', '0', '-t', '4.25', '-i', 'C:\\media\\a.mp4', '-ss', '0', '-t', '3.25', '-i', 'C:\\media\\b.mp4']);
  assert.match(plan.graph, /\[v0\]\[v1\]xfade=transition=fade:duration=0\.5:offset=3\.5\[vx1\]/);
  assert.match(plan.graph, /\[a0\]\[a1\]acrossfade=d=0\.5/);
  assert.match(plan.graph, /anullsrc=r=48000:cl=stereo.*atrim=duration=3\[a1\]/);
  assert.match(plan.graph, /eq=brightness=0\.1:contrast=1:saturation=1/);
  assert.match(plan.graph, /\[vx1\]ass=captions\.ass\[vout\]/);
  assert.ok(!plan.graph.includes('C:\\'), 'no Windows paths inside the graph');
});

test('cuts use concat; audio-only media gets a black frame; fill crops', () => {
  const p = { ...projectWith(media('a', 2), media('s', 2, { hasVideo: false })), fit: 'fill', aspect: '9:16' };
  const plan = buildExportPlan(p);
  assert.match(plan.graph, /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920/);
  assert.match(plan.graph, /color=c=black:s=1080x1920:r=30:d=2/);
  assert.match(plan.graph, /\[v0\]\[v1\]concat=n=2:v=1:a=0,settb=1\/30\[vx1\]/);
  assert.match(plan.graph, /\[vx1\]null\[vout\]/);
});

test('empty timeline is an error', () => {
  assert.throws(() => buildExportPlan(projectWith()), /empty/);
});

test('exportArgs reads the graph from a file', () => {
  const args = exportArgs({ inputArgs: ['-i', 'x'], outputArgs: ['-c:v', 'libx264'] }, 'graph.txt', 'out.mp4');
  assert.deepEqual(args.slice(-6), ['-c:v', 'libx264', '-progress', 'pipe:1', '-nostats', 'out.mp4']);
  assert.ok(args.includes('-/filter_complex'));
});

test('atempo chains below 0.5', () => {
  assert.deepEqual(atempoChain(1), []);
  assert.deepEqual(atempoChain(2), ['atempo=2']);
  assert.deepEqual(atempoChain(0.25), ['atempo=0.5', 'atempo=0.5']);
});

test('progress lines', () => {
  assert.deepEqual(parseProgressLine('out_time_us=1500000'), { seconds: 1.5 });
  assert.deepEqual(parseProgressLine('progress=end'), { done: true });
  assert.equal(parseProgressLine('fps=30'), null);
});

test('parseProbe swaps rotated phone video and needsProxy flags HEVC and MKV', () => {
  const probe = {
    format: { duration: '12.5' },
    streams: [
      { codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, avg_frame_rate: '30000/1001', side_data_list: [{ rotation: -90 }] },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
  };
  const info = parseProbe(probe, 'D:\\phone\\clip.MOV');
  assert.deepEqual([info.width, info.height, info.fps, info.duration, info.name], [1080, 1920, 29.97, 12.5, 'clip.MOV']);
  assert.equal(needsProxy(info), true);
  assert.equal(needsProxy({ ...info, videoCodec: 'h264' }), false);
  assert.equal(needsProxy({ ...info, videoCodec: 'h264', path: 'a.mkv' }), true);
});
