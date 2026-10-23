import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reducer } from '../../src/state.js';

test('undo steps: a drag is one step however slow; slider moves a second apart are separate', (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const edit = (s, x, key) => reducer(s, { type: 'edit', fn: (p) => ({ ...p, fps: x }), coalesce: key });
  let s = initialState;
  s = edit(s, 24, 'drag:stage:a:1');
  now += 5000; // the drag stalls
  s = edit(s, 25, 'drag:stage:a:1');
  assert.equal(s.past.length, 1);
  s = edit(s, 30, 'clip:x');
  now += 2000;
  s = edit(s, 50, 'clip:x');
  assert.equal(s.past.length, 3);
  s = reducer(s, { type: 'undo' });
  assert.equal(s.project.fps, 30);
});

test('a job that already ended keeps its end state when its start arrives late', () => {
  let s = reducer(initialState, { type: 'job', job: { id: 'j', status: 'done', result: { ok: 1 } } });
  s = reducer(s, { type: 'job', job: { id: 'j', status: 'running', progress: 0, elementId: 'e' } });
  assert.deepEqual([s.jobs.j.status, s.jobs.j.elementId, s.jobs.j.result.ok], ['done', 'e', 1]);
});
