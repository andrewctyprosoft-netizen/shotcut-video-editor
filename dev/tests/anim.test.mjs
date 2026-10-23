import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addKeyframe, audioGain, dbToGain, ease, elementState, keyframeValues, normCrop, placement, removeKeyframe,
  setKeyframeEase, setTransformAt,
} from '../../core/anim.js';
import { elementDefaults } from '../../core/project.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('easing curves start at 0, end at 1; hold jumps at the end', () => {
  for (const name of ['linear', 'in', 'out', 'inOut']) {
    assert.equal(ease(name, 0), 0, name);
    assert.equal(ease(name, 1), 1, name);
  }
  assert.ok(ease('in', 0.5) < 0.5 && ease('out', 0.5) > 0.5);
  assert.equal(ease('hold', 0.99), 0);
  assert.ok(ease('back', 0.7) > 1, 'back overshoots');
});

test('keyframes interpolate with the curve of the earlier keyframe and hold outside', () => {
  const ks = [
    { t: 1, x: 0.2, y: 0.5, scale: 1, opacity: 1, ease: 'linear' },
    { t: 3, x: 0.8, y: 0.5, scale: 2, opacity: 0, ease: 'in' },
    { t: 4, x: 0.2, y: 0.5, scale: 1, opacity: 1 },
  ];
  assert.equal(keyframeValues(ks, 0).x, 0.2);
  assert.ok(near(keyframeValues(ks, 2).x, 0.5));
  assert.ok(near(keyframeValues(ks, 2).scale, 1.5));
  assert.ok(near(keyframeValues(ks, 3.5).x, 0.8 - 0.6 * 0.125), 'ease in: slow start');
  assert.equal(keyframeValues(ks, 9).x, 0.2);
});

test('editing the transform with keyframes sets the keyframe at the playhead (CapCut style)', () => {
  let el = { ...elementDefaults(), transform: { x: 0.3, y: 0.5, scale: 1, opacity: 1 } };
  el = setTransformAt(el, 1, { x: 0.4 }, 30);
  assert.equal(el.keyframes.length, 0);
  assert.equal(el.transform.x, 0.4);
  el = addKeyframe(el, 0, 30);
  el = setTransformAt(el, 2, { x: 0.9, scale: 1.5 }, 30);
  assert.deepEqual(el.keyframes.map((k) => [k.t, k.x, k.scale]), [[0, 0.4, 1], [2, 0.9, 1.5]]);
  el = setTransformAt(el, 2.01, { y: 0.1 }, 30); // within half a frame: same keyframe
  assert.equal(el.keyframes.length, 2);
  assert.equal(el.keyframes[1].y, 0.1);
  el = setKeyframeEase(el, 0, 'inOut', 30);
  assert.equal(el.keyframes[0].ease, 'inOut');
  el = removeKeyframe(removeKeyframe(el, 2, 30), 0, 30);
  assert.deepEqual([el.keyframes.length, el.transform.x], [0, 0.4], 'last keyframe becomes the static transform');
});

test('in/out effects: fade, slide and pop, shortened to fit the element', () => {
  const el = { ...elementDefaults(), anim: { in: { type: 'fade', duration: 1 }, out: { type: 'slideLeft', duration: 1 } } };
  assert.equal(elementState(el, 0, 5).opacity, 0);
  assert.ok(elementState(el, 0.5, 5).opacity > 0.5);
  assert.equal(elementState(el, 2, 5).opacity, 1);
  assert.equal(elementState(el, 2, 5).x, 0.5);
  assert.ok(elementState(el, 4.9, 5).x < 0, 'slides out to the left');
  const short = elementState(el, 0.5, 1); // 1 s element: 0.5 s in + 0.5 s out
  assert.ok(short.opacity > 0.99 && short.x <= 0.5);
  const pop = { ...elementDefaults(), anim: { in: { type: 'pop', duration: 0.5 }, out: null } };
  assert.ok(near(elementState(pop, 0, 3).scale, 0));
  assert.ok(Math.max(...[0.3, 0.35, 0.4].map((t) => elementState(pop, t, 3).scale)) > 1, 'pop overshoots');
});

test('placement: fit and fill, crop zooms the kept part, scale and position', () => {
  const m = { width: 1920, height: 1080 };
  const frame = [1080, 1920]; // vertical output
  const base = { x: 0.5, y: 0.5, scale: 1, opacity: 1 };
  const fit = placement(m, null, base, frame, 'fit');
  assert.ok(near(fit.box.width, 1080) && near(fit.box.height, 607.5) && near(fit.box.top, (1920 - 607.5) / 2));
  const fill = placement(m, null, base, frame, 'fill');
  assert.ok(near(fill.box.height, 1920) && near(fill.box.left, (1080 - 3413.333333) / 2, 1e-3));
  // Keep the middle third: it fills the width; the full picture extends beyond the box.
  const crop = placement(m, { x: 1 / 3, y: 0, w: 1 / 3, h: 1 }, { ...base, scale: 0.5, x: 0.25 }, frame, 'fit');
  assert.ok(near(crop.box.width, 1080 * 0.5, 1e-6), `box ${crop.box.width}`);
  assert.ok(near(crop.box.left + crop.box.width / 2, 270));
  assert.ok(near(crop.full.width, crop.box.width * 3) && near(crop.full.left, crop.box.left - crop.box.width));
  assert.equal(placement({ width: 0, height: 0 }, null, base, frame), null);
  assert.deepEqual(normCrop({ x: 0.9, y: -1, w: 0.5, h: 0 }), { x: 0.5, y: 0, w: 0.5, h: 0.02 });
});

test('volume in dB with mute, and audio fades', () => {
  assert.equal(dbToGain(0), 1);
  assert.equal(dbToGain(-40), 0);
  assert.ok(near(dbToGain(6), 1.995, 1e-3));
  assert.ok(near(dbToGain(99), 10, 1e-9), 'capped at +20 dB');
  const el = { ...elementDefaults(), volume: 0, audioFade: { in: 1, out: 2 } };
  assert.equal(audioGain(el, 0, 10), 0);
  assert.ok(near(audioGain(el, 0.5, 10), 0.5));
  assert.equal(audioGain(el, 5, 10), 1);
  assert.ok(near(audioGain(el, 9, 10), 0.5));
});
