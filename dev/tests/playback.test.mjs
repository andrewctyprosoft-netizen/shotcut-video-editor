import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, removeSourceRanges, updateClip } from '../../core/project.js';
import {
  HARD_DRIFT, MAX_WAIT, PlaybackEngine, SEEK_HOLD, followTimeline, mediaWaiting,
} from '../../src/playback.js';
import { media, projectWith } from './helpers.mjs';

/** Minimal HTMLVideoElement stand-in: loads on demand, seeks instantly, advances when told. */
class FakeVideo {
  constructor() {
    this._src = '';
    this.currentTime = 0;
    this.readyState = 0;
    this.seeking = false;
    this.paused = true;
    this.ended = false;
    this.playbackRate = 1;
    this.defaultPlaybackRate = 1;
    this.style = {};
    this.muted = false;
    this.listeners = {};
    this.loads = 0;
  }
  get src() { return this._src; }
  set src(url) {
    this._src = url;
    this.readyState = 0;
    this.playbackRate = this.defaultPlaybackRate; // the media load algorithm resets the rate
    this.loads++;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  finishLoad() {
    if (this.readyState) return;
    this.readyState = 4;
    const fns = this.listeners.loadedmetadata ?? [];
    this.listeners.loadedmetadata = [];
    fns.forEach((f) => f());
  }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  advance(dt) { if (!this.paused && this.readyState >= 2) this.currentTime += dt * this.playbackRate; }
}

function setup(project) {
  const videos = [new FakeVideo(), new FakeVideo()];
  const times = [];
  let ended = 0;
  const engine = new PlaybackEngine({
    videos,
    urlFor: (clip) => `media://${clip.mediaId}`,
    onTime: (t) => times.push(t),
    onEnd: () => ended++,
  });
  const load = () => videos.forEach((v) => v.finishLoad());
  return { engine, videos, times, ended: () => ended, load, items: layout(project) };
}

test('preloads the next clip and swaps at the boundary without reloading', () => {
  // a[0-2] , a[5-7] (same file, after a text cut), b[0-3]
  const p = removeSourceRanges(projectWith(media('a', 7), media('b', 3)), 'a', [[2, 5]]);
  const { engine, videos, times, ended, load, items } = setup(p);
  engine.sync(items, 0);
  load();
  assert.deepEqual(videos.map((v) => v.currentTime), [0, 5], 'slot 1 waits on the next clip');
  assert.deepEqual(videos.map((v) => v.style.visibility), ['visible', 'hidden']);

  engine.play();
  videos[0].advance(1.5);
  engine.tick();
  assert.equal(videos[1].paused, true, 'no pre-roll yet');
  videos[0].advance(0.3);
  engine.tick();
  assert.ok(Math.abs(times.at(-1) - 1.8) < 1e-9);
  assert.deepEqual([videos[1].paused, videos[1].muted], [false, true], 'hidden slot pre-rolls muted');
  assert.ok(Math.abs(videos[1].currentTime - 4.8) < 1e-9, 'timed to reach the in-point at the boundary');
  videos.forEach((v) => v.advance(0.21));
  engine.tick();
  assert.equal(engine.activeSlot, 1);
  assert.equal(times.at(-1), 2);
  assert.deepEqual([videos[0].paused, videos[1].paused, videos[1].muted], [true, false, false]);
  assert.ok(Math.abs(videos[1].currentTime - 5.01) < 1e-9);
  engine.tick();
  assert.ok(Math.abs(times.at(-1) - 2.01) < 1e-9);
  assert.deepEqual(videos.map((v) => v.style.visibility), ['hidden', 'visible']);
  assert.equal(videos[0].src, 'media://b', 'old slot now preloads the third clip');

  videos[1].advance(2.0);
  engine.tick();
  assert.equal(engine.activeSlot, 0);
  assert.equal(times.at(-1), 4);
  engine.tick(); // still loading: no time reported, no crash
  load();
  videos[0].advance(1);
  engine.tick();
  assert.ok(Math.abs(times.at(-1) - 5) < 1e-9);
  videos[0].advance(5);
  engine.tick();
  assert.equal(ended(), 1);
  assert.equal(times.at(-1), 7);
  assert.equal(engine.playing, false);
  assert.equal(videos[1].loads, 1, 'slot 1 never reloaded its file');
});

test('seek while paused loads the clip under the playhead and the one after it', () => {
  const p = projectWith(media('a', 4), media('b', 4), media('c', 4));
  const { engine, videos, load, items } = setup(p);
  engine.sync(items, 0);
  load();
  engine.seek(5.5);
  load();
  assert.deepEqual([videos[0].src, videos[0].currentTime], ['media://b', 1.5]);
  assert.deepEqual([videos[1].src, videos[1].currentTime], ['media://c', 0]);
});

test('an edit elsewhere keeps the playing clip; an edit to it reseeks', () => {
  let p = projectWith(media('a', 4), media('b', 4), media('c', 4));
  const { engine, videos, load } = setup(p);
  engine.sync(layout(p), 1);
  load();
  engine.play();
  videos[0].advance(0.5);
  const before = videos[0].currentTime;
  p = updateClip(p, p.clips[2].id, { speed: 2 });
  engine.sync(layout(p), 1.5);
  assert.equal(videos[0].currentTime, before, 'no reseek');
  p = updateClip(p, p.clips[0].id, { speed: 2 });
  engine.sync(layout(p), 1.5);
  assert.equal(videos[0].currentTime, 3, 'reseeked to source 3 s at 2x');
  assert.equal(videos[0].playbackRate, 2);
});

test('speeding up the playing clip moves the preloaded next clip earlier too', () => {
  let p = projectWith(media('a', 10), media('b', 4));
  const { engine, videos, times, load } = setup(p);
  engine.sync(layout(p), 0.2);
  load();
  p = updateClip(p, p.clips[0].id, { speed: 4 }); // a now lasts 2.5 s; b starts at 2.5 instead of 10
  engine.sync(layout(p), 0.2);
  load();
  assert.equal(engine.slots[1].item.start, 2.5, 'the hidden slot has the new place of b');
  engine.play();
  const active = engine.activeSlot;
  videos[active].advance(0.5); // 2 source seconds at 4x: timeline 0.7
  engine.tick();
  videos[active].currentTime = 10;
  videos[active].ended = true;
  engine.tick();
  assert.notEqual(engine.activeSlot, active, 'swapped to b');
  videos[engine.activeSlot].advance(0.5);
  engine.tick();
  assert.ok(Math.abs(times.at(-1) - 3) < 1e-6, `timeline at ${times.at(-1)}, not past b's old start`);
});

test('falls back to one slot when the next clip was not preloaded', () => {
  const p = projectWith(media('a', 2), media('b', 2));
  const { engine, videos, times, load, items } = setup(p);
  engine.sync(items, 0);
  load();
  engine.slots[1].item = null; // simulate a preload that never happened
  engine.slots[1].url = null;
  engine.play();
  videos[0].advance(2.1);
  engine.tick();
  assert.equal(engine.activeSlot, 0);
  assert.equal(videos[0].src, 'media://b');
  assert.equal(times.at(-1), 2);
});

test('pausing during a pre-roll puts the hidden slot back on its in-point', () => {
  const p = projectWith(media('a', 2), media('b', 2));
  const { engine, videos, load, items } = setup(p);
  engine.sync(items, 0);
  load();
  engine.play();
  videos[0].advance(1.9);
  engine.tick();
  assert.equal(videos[1].paused, false);
  engine.pause();
  assert.deepEqual([videos[1].paused, videos[1].muted, videos[1].currentTime], [true, false, 0]);
});

test('a transition keeps the outgoing clip playing until its end, both visible', () => {
  let p = projectWith(media('a', 4), media('b', 4));
  p = updateClip(p, p.clips[1].id, { transition: { type: 'fade', duration: 1 } }); // b starts at 3
  const { engine, videos, times, load, items } = setup(p);
  engine.sync(items, 2.5);
  load();
  engine.play();
  videos.forEach((v) => v.advance(0.55));
  engine.tick();
  assert.equal(engine.activeSlot, 1, 'swapped at the start of the transition');
  assert.equal(times.at(-1), 3);
  assert.deepEqual(videos.map((v) => [v.paused, v.style.visibility]), [[false, 'visible'], [false, 'visible']]);
  videos.forEach((v) => v.advance(1));
  engine.tick();
  assert.deepEqual([videos[0].paused, videos[0].style.visibility], [true, 'hidden'], 'outgoing stops at its end');
});

test('seeking into a transition shows both clips at their own times', () => {
  let p = projectWith(media('a', 4), media('b', 4));
  p = updateClip(p, p.clips[1].id, { transition: { type: 'wipeleft', duration: 1 } });
  const { engine, videos, load, items } = setup(p);
  engine.sync(items, 0);
  load();
  engine.seek(3.5);
  load();
  const byUrl = Object.fromEntries(videos.map((v) => [v.src, v]));
  assert.equal(byUrl['media://b'].currentTime, 0.5);
  assert.equal(byUrl['media://a'].currentTime, 3.5);
  assert.ok(videos.every((v) => v.style.visibility === 'visible'));
});

test('stills on the main track and the timeline after it run on the wall clock', () => {
  const p = projectWith(media('img', 0, { kind: 'image' }), media('v', 2));
  const items = layout(p); // img 0-5, v 5-7
  const videos = [new FakeVideo(), new FakeVideo()];
  const times = [];
  let now = 1000;
  let ended = 0;
  const engine = new PlaybackEngine({
    videos,
    urlFor: (clip) => `media://${clip.mediaId}`,
    isStill: (clip) => clip.mediaId === 'img',
    now: () => now,
    onTime: (t) => times.push(t),
    onEnd: () => ended++,
  });
  engine.sync(items, 0, 9); // layers run to 9 s
  videos.forEach((v) => v.finishLoad());
  assert.ok(videos.every((v) => v.style.visibility === 'hidden'), 'the page draws the image');
  engine.play();
  now += 4800;
  engine.tick();
  assert.equal(times.at(-1), 4.8);
  const pre = videos.find((v) => v.src === 'media://v');
  assert.ok(pre && !pre.paused && pre.muted, 'the video after the image pre-rolls');
  pre.advance(0.2);
  now += 200;
  engine.tick();
  assert.equal(times.at(-1), 5);
  assert.deepEqual([pre.muted, pre.style.visibility], [false, 'visible']);
  pre.advance(2);
  engine.tick();
  assert.equal(times.at(-1), 7, 'main track over');
  assert.equal(ended, 0, 'but the timeline goes on');
  now += 1500;
  engine.tick();
  assert.equal(times.at(-1), 8.5);
  now += 600;
  engine.tick();
  assert.equal(ended, 1);
});

test('layer media follows the timeline: small drift changes the rate, large drift seeks once per hold', () => {
  assert.deepEqual(followTimeline({ drift: 0.01, speed: 1, sinceSeek: 9 }), { seek: false, rate: 1 });
  // Behind by 0.1 s: play 4% faster; ahead: slower; never beyond 6%.
  assert.deepEqual(followTimeline({ drift: -0.1, speed: 1, sinceSeek: 9 }), { seek: false, rate: 1.04 });
  assert.deepEqual(followTimeline({ drift: 0.1, speed: 1, sinceSeek: 9 }), { seek: false, rate: 0.96 });
  assert.deepEqual(followTimeline({ drift: -0.5, speed: 1, sinceSeek: 9 }), { seek: false, rate: 1.06 });
  // At 2x the drift in source seconds counts half in timeline seconds; the rate scales with the speed.
  assert.deepEqual(followTimeline({ drift: -0.2, speed: 2, sinceSeek: 9 }), { seek: false, rate: 2 * 1.04 });
  // Far off: seek, but not again while the last seek settles (that loop was the stutter) ...
  assert.equal(followTimeline({ drift: -(HARD_DRIFT + 0.1), speed: 1, sinceSeek: SEEK_HOLD }).seek, true);
  const held = followTimeline({ drift: -(HARD_DRIFT + 0.1), speed: 1, sinceSeek: SEEK_HOLD / 2 });
  assert.deepEqual(held, { seek: false, rate: 1.06 });
  // ... unless the playhead was moved by seconds.
  assert.equal(followTimeline({ drift: 30, speed: 1, sinceSeek: 0.1 }).seek, true);
});

test('the wall clock waits while layer audio buffers, but not for ever', () => {
  const p = projectWith(media('img', 0, { kind: 'image' }));
  const items = layout(p); // img 0-5
  let now = 1000;
  let waiting = true;
  const times = [];
  const engine = new PlaybackEngine({
    videos: [new FakeVideo(), new FakeVideo()],
    urlFor: (clip) => `media://${clip.mediaId}`,
    isStill: () => true,
    isWaiting: () => waiting,
    now: () => now,
    onTime: (t) => times.push(t),
    onEnd: () => {},
  });
  engine.sync(items, 1, 60);
  engine.play();
  now += 1500; // the audio takes 1.5 s to start
  engine.tick();
  assert.equal(times.length, 0, 'held at 1 s while the audio buffers');
  waiting = false;
  now += 500;
  engine.tick();
  assert.equal(times.at(-1), 1.5, 'then runs from where it held');
  waiting = true; // a file that never loads
  now += 100;
  engine.tick();
  now += MAX_WAIT * 1000 + 100;
  engine.tick();
  assert.ok(times.at(-1) > 1.5, 'gives up waiting after MAX_WAIT');
});

test('layer media counts as waiting until its time moves, even when it reports ready', () => {
  const el = { readyState: 4, seeking: false, currentTime: 2100, error: null, ended: false };
  const live = new Map([[el, 2100]]);
  assert.equal(mediaWaiting(live), true, 'ready but not moving yet');
  el.currentTime = 2100.1;
  assert.equal(mediaWaiting(live), false, 'moving');
  assert.equal(live.get(el), null, 'remembered as started');
  el.currentTime = 2100.1; // a later stall with data is drift, not start-up
  assert.equal(mediaWaiting(live), false);
  el.readyState = 2;
  assert.equal(mediaWaiting(live), true, 'buffering');
  el.error = { code: 4 };
  assert.equal(mediaWaiting(live), false, 'a broken file never holds the clock');
});

test('wall clock: play starts where the timeline stands, however long it sat paused', () => {
  const p = projectWith(media('img', 0, { kind: 'image' }));
  let now = 1000;
  const times = [];
  const engine = new PlaybackEngine({
    videos: [new FakeVideo(), new FakeVideo()],
    urlFor: (clip) => `media://${clip.mediaId}`,
    isStill: () => true,
    now: () => now,
    onTime: (t) => times.push(t),
    onEnd: () => {},
  });
  engine.sync(layout(p), 0, 4000); // e.g. a 70-minute audio track under a still
  engine.seek(2100);
  now += 1500; // paused for 1.5 s after the seek (this used to jump play ahead by 1.5 s)
  engine.play();
  now += 100;
  engine.tick();
  assert.equal(times.at(-1), 2100.1);
  engine.pause();
  now += 10000; // paused for 10 s
  engine.play();
  now += 500;
  engine.tick();
  assert.equal(times.at(-1), 2100.6);
});
