import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STILL_LENGTH, addItem, addMedia, addTrack, appendClip, createProject, findElement, itemSpan, itemsAt, moveItem, moveTrack,
  normalizeProject, removeSourceRanges, setSubtitles, splitClip, splitItem, totalDuration, trimItem, updateElement,
} from '../../core/project.js';
import { timelineWords } from '../../core/transcript.js';
import { media, projectWith } from './helpers.mjs';

const image = (id) => media(id, 0, { kind: 'image', hasAudio: false, width: 800, height: 600, path: `C:\\media\\${id}.png` });
const gif = (id) => media(id, 1.2, { kind: 'gif', hasAudio: false, width: 200, height: 200, path: `C:\\media\\${id}.gif` });
const audio = (id, d) => media(id, d, { kind: 'audio', hasVideo: false, width: 0, height: 0, path: `C:\\media\\${id}.mp3` });

test('images and GIFs get a default length that can be stretched; no speed change', () => {
  let p = projectWith(image('logo'), gif('spin'));
  assert.deepEqual(p.clips.map((c) => [c.in, c.out]), [[0, STILL_LENGTH], [0, STILL_LENGTH]]);
  p = updateElement(p, p.clips[0].id, { out: 42, speed: 2 });
  assert.deepEqual([p.clips[0].out, p.clips[0].speed], [42, 1]);
  assert.equal(totalDuration(p), 47);
});

test('addItem picks a free track of the right kind, or adds one in front', () => {
  let p = projectWith(media('v', 10));
  p = addMedia(addMedia(addMedia(p, image('logo')), gif('spin')), audio('music', 30));
  p = addItem(p, 'logo', 1, { id: 'i1' });
  p = addItem(p, 'spin', 2, { id: 'i2' }); // overlaps i1: second layer
  p = addItem(p, 'logo', 7, { id: 'i3' }); // free on the first layer again
  p = addItem(p, 'music', 0, { id: 'i4' });
  assert.deepEqual(p.tracks.map((t) => [t.kind, t.items.map((i) => i.id)]), [['layer', ['i1', 'i3']], ['layer', ['i2']], ['audio', ['i4']]]);
  assert.equal(findElement(p, 'i2').el.transform.scale, 0.5, 'layers start at half size');
  assert.equal(totalDuration(p), 30);
  assert.deepEqual(itemsAt(p, 2.5).map((x) => x.item.id), ['i1', 'i2', 'i4']);
});

test('moveItem changes time and track; a collision moves it to the next free layer', () => {
  let p = addMedia(createProject(), image('logo'));
  p = addItem(p, 'logo', 0, { id: 'a' });
  p = addItem(p, 'logo', 0, { id: 'b' });
  const [l1, l2] = p.tracks;
  p = moveItem(p, 'b', { start: 2, trackId: l1.id });
  assert.equal(findElement(p, 'b').track.id, l2.id, 'collides with a: goes to the next free layer in front');
  p = moveItem(p, 'b', { start: 5.01, trackId: l1.id });
  assert.deepEqual(p.tracks.map((t) => t.items.map((i) => [i.id, i.start])), [[['a', 0], ['b', 5]]], 'fits after a; the emptied layer is removed');
  p = addTrack(p, 'audio');
  p = moveItem(p, 'b', { trackId: p.tracks[1].id });
  assert.equal(findElement(p, 'b').track.kind, 'layer', 'never onto an audio track');
});

test('splitItem and trimItem keep the picture in place', () => {
  let p = addMedia(createProject(), media('v', 10));
  p = addItem(p, 'v', 2, { id: 'x', in: 1, out: 9 });
  p = trimItem(p, 'x', 'in', 3); // start 2 -> 3: in 1 -> 2
  assert.deepEqual([findElement(p, 'x').el.start, findElement(p, 'x').el.in], [3, 2]);
  p = trimItem(p, 'x', 'in', -5); // can't go before the media start
  assert.deepEqual([findElement(p, 'x').el.start, findElement(p, 'x').el.in], [1, 0]);
  p = trimItem(p, 'x', 'out', 6);
  assert.equal(itemSpan(findElement(p, 'x').el, 30).end, 6);
  p = splitItem(p, 'x', 4);
  assert.deepEqual(p.tracks[0].items.map((i) => [i.start, i.in, i.out]), [[1, 0, 3], [4, 3, 5]]);
});

test('splitting keeps keyframes and effects with their half', () => {
  let p = projectWith(media('v', 10));
  const id = p.clips[0].id;
  p = updateElement(p, id, {
    keyframes: [{ t: 1, x: 0, y: 0.5, scale: 1, opacity: 1 }, { t: 6, x: 1, y: 0.5, scale: 1, opacity: 1 }],
    anim: { in: { type: 'fade', duration: 0.5 }, out: { type: 'fade', duration: 0.5 } },
  });
  p = splitClip(p, id, 4);
  assert.deepEqual(p.clips.map((c) => c.keyframes.map((k) => k.t)), [[1], [2]]);
  assert.deepEqual(p.clips.map((c) => [c.anim.in?.type ?? null, c.anim.out?.type ?? null]), [['fade', null], [null, 'fade']]);
});

test('text cuts also cut track items and close the gap inside the item', () => {
  let p = addMedia(createProject(), { ...audio('vo', 10), words: [{ text: 'a', start: 1, end: 1.5 }, { text: 'b', start: 6, end: 6.5 }] });
  p = addItem(p, 'vo', 2, { id: 'vo1' });
  assert.deepEqual(timelineWords(p).map((w) => [w.text, w.start]), [['a', 3], ['b', 8]]);
  p = removeSourceRanges(p, 'vo', [[3, 5]]);
  assert.deepEqual(p.tracks[0].items.map((i) => [i.start, i.in, i.out]), [[2, 0, 3], [5, 5, 10]]);
  assert.deepEqual(timelineWords(p).map((w) => [w.text, w.start]), [['a', 3], ['b', 6]]);
});

test('moveTrack reorders layers among themselves', () => {
  let p = addTrack(addTrack(addTrack(createProject(), 'layer', { id: 'A' }), 'audio', { id: 'M' }), 'layer', { id: 'B' });
  p = moveTrack(p, 'A', 1);
  assert.deepEqual(p.tracks.map((t) => t.id), ['M', 'B', 'A']);
  assert.equal(moveTrack(p, 'A', 1), p, 'already in front');
});

test('normalizeProject upgrades a 0.2 project', () => {
  const old = { version: 1, aspect: '16:9', fit: 'fit', fps: 30, media: { a: media('a', 3) }, clips: [{ id: 'c', mediaId: 'a', in: 0, out: 3, speed: 1, adjust: { brightness: 0, contrast: 1, saturation: 1 }, transition: null }], captions: { enabled: true, maxChars: 30, maxDuration: 3, style: { font: 'Impact', size: 0.07, position: 0.8 } }, glossary: [] };
  const p = normalizeProject(old);
  assert.equal(p.version, 2);
  assert.deepEqual([p.tracks, p.subtitles, p.captions.overrides], [[], [], {}]);
  assert.deepEqual([p.captions.style.font, p.captions.style.x, p.captions.style.width], ['Impact', 0.5, 0.88]);
  assert.deepEqual([p.clips[0].volume, p.clips[0].keyframes, p.media.a.kind], [0, [], 'video']);
});

test('subtitles count towards the timeline length', () => {
  const p = setSubtitles(appendClip(addMedia(createProject(), media('a', 3)), 'a'), [{ start: 1, end: 12.5, text: 'x' }]);
  assert.equal(totalDuration(p), 12.5);
});
