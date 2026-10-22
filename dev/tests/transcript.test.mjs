import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeSourceRanges, updateClip } from '../../core/project.js';
import {
  applyGlossary, fillerRanges, fromWordsJson, parseGlossary, pauseRanges, rangesForWords, setWordText, timelineWords,
} from '../../core/transcript.js';
import { media, projectWith, words } from './helpers.mjs';

const W = words(['one', 'two', 'um', 'three', 'four', 'five']); // 0.0, 0.5, 1.0, 1.5, 2.0, 2.5

test('timelineWords follows trims, cuts and speed', () => {
  let p = projectWith(media('a', 4, { words: W }));
  assert.equal(timelineWords(p).length, 6);
  p = removeSourceRanges(p, 'a', fillerRanges(W));
  const tw = timelineWords(p);
  assert.deepEqual(tw.map((w) => w.text), ['one', 'two', 'three', 'four', 'five']);
  assert.equal(tw[2].start, 1.5 - 0.4); // "three" moved left by the 0.4 s cut
  p = updateClip(p, p.clips[1].id, { speed: 2 });
  const fast = timelineWords(p);
  assert.ok(Math.abs(fast[3].start - (1.0 + (2.0 - 1.4) / 2)) < 1e-9);
});

test('rangesForWords merges neighbours', () => {
  assert.deepEqual(rangesForWords([{ start: 1, end: 1.4 }, { start: 1.42, end: 2 }, { start: 3, end: 3.5 }]), [[1, 2], [3, 3.5]]);
});

test('fillerRanges ignores case and punctuation', () => {
  assert.deepEqual(fillerRanges(words(['So,', 'Um,', 'yes', 'uh.'])), [[0.5, 0.9], [1.5, 1.9]]);
});

test('pauseRanges keeps air around words, including leading and trailing silence', () => {
  const ws = [{ text: 'a', start: 2, end: 2.5 }, { text: 'b', start: 4, end: 4.5 }, { text: 'c', start: 4.6, end: 5 }];
  assert.deepEqual(pauseRanges(ws, 8, 0.8, 0.2), [[0, 1.8], [2.7, 3.8], [5.2, 8]]);
});

test('setWordText edits one word', () => {
  const p = setWordText(projectWith(media('a', 4, { words: W })), 'a', 0, ' One ');
  assert.equal(p.media.a.words[0].text, 'One');
});

test('glossary: whole words, any case, unicode-safe', () => {
  const g = parseGlossary('flora => FLAURA\n  osimertinip=>osimertinib \nbad line\nđau => Đau');
  assert.equal(g.length, 3);
  assert.equal(applyGlossary('Flora and floral, OSIMERTINIP.', g), 'FLAURA and floral, osimertinib.');
  assert.equal(applyGlossary('cơn đau', g), 'cơn Đau');
});

test('fromWordsJson reads Transcript QC words.json', () => {
  const ws = fromWordsJson([{ word: ' hi', start: 1, end: 1.2 }, { word: '', start: 2, end: 2.1 }, { word: 'a', start: 0, end: 0.3, br: true }]);
  assert.deepEqual(ws, [{ text: 'a', start: 0, end: 0.3, br: true }, { text: 'hi', start: 1, end: 1.2 }]);
});
