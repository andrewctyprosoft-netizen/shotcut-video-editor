// The 0.1x-10x speed range: clamping, keyframes moving with the picture, and the export filters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExportPlan } from '../../core/exportPlan.js';
import { totalDuration, updateClip, withSpeed } from '../../core/project.js';
import { media, projectWith } from './helpers.mjs';

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
