import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  layout, locate, moveClip, removeClip, removeSourceRanges, splitAt, splitClip, totalDuration, updateClip,
} from '../../core/project.js';
import { media, projectWith } from './helpers.mjs';

test('layout places clips back to back in whole frames', () => {
  const p = projectWith(media('a', 2.01), media('b', 3));
  const items = layout(p);
  assert.equal(items[0].start, 0);
  assert.equal(items[0].duration, 60 / 30); // 2.01 s rounds to 60 frames
  assert.equal(items[1].start, 2);
  assert.equal(totalDuration(p), 5);
});

test('a transition overlaps the clips and the incoming clip wins in locate', () => {
  let p = projectWith(media('a', 4), media('b', 4));
  p = updateClip(p, p.clips[1].id, { transition: { type: 'fade', duration: 1 } });
  const items = layout(p);
  assert.equal(items[1].overlap, 1);
  assert.equal(items[1].start, 3);
  assert.equal(totalDuration(p), 7);
  const hit = locate(p, 3.5);
  assert.equal(hit.clip.mediaId, 'b');
  assert.equal(hit.sourceTime, 0.5);
});

test('transition length is limited by the shorter neighbour', () => {
  let p = projectWith(media('a', 0.5), media('b', 4));
  p = updateClip(p, p.clips[1].id, { transition: { type: 'fade', duration: 2 } });
  const { overlap } = layout(p)[1];
  assert.ok(overlap < 0.5 && overlap > 0.4, `overlap ${overlap}`);
});

test('speed shortens the clip on the timeline and maps source time', () => {
  let p = projectWith(media('a', 4));
  p = updateClip(p, p.clips[0].id, { speed: 2 });
  assert.equal(totalDuration(p), 2);
  assert.equal(locate(p, 1).sourceTime, 2);
});

test('updateClip clamps in/out/speed to the media', () => {
  let p = projectWith(media('a', 10));
  const id = p.clips[0].id;
  p = updateClip(p, id, { in: -3, out: 99, speed: 9 });
  assert.deepEqual([p.clips[0].in, p.clips[0].out, p.clips[0].speed], [0, 10, 4]);
  p = updateClip(p, id, { in: 6, out: 5 });
  assert.ok(p.clips[0].out - p.clips[0].in >= 0.1 - 1e-9);
});

test('split creates two clips, refuses tiny pieces, and splitAt uses timeline time', () => {
  const p = projectWith(media('a', 10));
  const id = p.clips[0].id;
  const s = splitClip(p, id, 4);
  assert.deepEqual(s.clips.map((c) => [c.in, c.out]), [[0, 4], [4, 10]]);
  assert.equal(splitClip(p, id, 0.05), p);
  const t = splitAt(projectWith(media('a', 2), media('b', 6)), 5);
  assert.deepEqual(t.clips.map((c) => [c.mediaId, c.in, c.out]), [['a', 0, 2], ['b', 0, 3], ['b', 3, 6]]);
});

test('removeSourceRanges cuts the middle out of every clip of that media', () => {
  let p = projectWith(media('a', 10), media('b', 5), media('a', 10));
  p = removeSourceRanges(p, 'a', [[2, 3], [9.95, 10]]);
  assert.deepEqual(p.clips.map((c) => [c.mediaId, c.in, c.out]), [
    ['a', 0, 2], ['a', 3, 9.95], ['b', 0, 5], ['a', 0, 2], ['a', 3, 9.95],
  ]);
  assert.equal(new Set(p.clips.map((c) => c.id)).size, 5);
});

test('moving or removing clips never leaves a transition on the first clip', () => {
  let p = projectWith(media('a', 4), media('b', 4));
  p = updateClip(p, p.clips[1].id, { transition: { type: 'fade', duration: 0.5 } });
  assert.equal(moveClip(p, p.clips[1].id, -1).clips[0].transition, null);
  assert.equal(removeClip(p, p.clips[0].id).clips[0].transition, null);
});

test('frameSize follows aspect and export resolution', async () => {
  const { createProject, frameSize } = await import('../../core/project.js');
  assert.deepEqual(frameSize(createProject()), [1920, 1080]);
  assert.deepEqual(frameSize(createProject({ aspect: '9:16', export: { resolution: 720 } })), [720, 1280]);
  assert.deepEqual(frameSize(createProject({ aspect: '1:1', export: { resolution: 2160 } })), [2160, 2160]);
  assert.deepEqual(frameSize({ aspect: '16:9' }), [1920, 1080]); // projects saved before 0.2
});

test('trimClip stops at the other edge; moveClipTo reorders', async () => {
  const { trimClip, moveClipTo } = await import('../../core/project.js');
  const p = projectWith(media('a', 10), media('b', 4), media('c', 4));
  const id = p.clips[0].id;
  assert.deepEqual([trimClip(p, id, 'in', 9.99).clips[0].in, trimClip(p, id, 'in', 9.99).clips[0].out], [9.9, 10]);
  assert.equal(trimClip(p, id, 'out', -5).clips[0].out, 0.1);
  assert.equal(trimClip(p, id, 'out', 4).clips[0].out, 4);
  assert.deepEqual(moveClipTo(p, id, 2).clips.map((c) => c.mediaId), ['b', 'c', 'a']);
  assert.deepEqual(moveClipTo(p, p.clips[2].id, 0).clips.map((c) => c.mediaId), ['c', 'a', 'b']);
  assert.equal(moveClipTo(p, id, 0), p);
});

test('snapTime picks the nearest target in tolerance', async () => {
  const { snapTime } = await import('../../core/time.js');
  assert.equal(snapTime(2.07, [1, 2, 2.1], 0.2), 2.1);
  assert.equal(snapTime(3, [1, 2], 0.2), 3);
});
