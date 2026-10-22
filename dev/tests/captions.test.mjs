import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assColor, assRgb, buildCues, cueAt, glossWords, toAss, toSrt, wordIndexAt } from '../../core/captions.js';
import { defaultCaptions } from '../../core/project.js';
import { words } from './helpers.mjs';

test('cues break after sentences, forced breaks, pauses and the character limit', () => {
  const ws = words(['Hello', 'there.', 'This', 'is', 'a', 'longer', 'line', 'of', 'text']);
  ws[4].br = true;
  const cues = buildCues(ws, { maxChars: 12 });
  assert.deepEqual(cues.map((c) => c.text), ['Hello there.', 'This is a', 'longer line', 'of text']);
  const gap = buildCues([{ text: 'a', start: 0, end: 0.3 }, { text: 'b', start: 2, end: 2.3 }]);
  assert.equal(gap.length, 2);
});

test('cue timing: padded end, minimum length, never overlapping the next cue', () => {
  const cues = buildCues([{ text: 'Hi.', start: 0, end: 0.1 }, { text: 'Next', start: 0.3, end: 0.6 }]);
  assert.equal(cues[0].end, 0.3 - 0.02);
  assert.equal(cues[1].end, 0.6 + 0.25);
});

test('cueAt and wordIndexAt find what is on screen', () => {
  const cues = buildCues(words(['a.', 'b', 'c.', 'd']));
  assert.equal(cueAt(cues, 0.6).text, 'b c.');
  assert.equal(cueAt(cues, 99), null);
  assert.equal(wordIndexAt(cueAt(cues, 1.1), 1.1), 1);
});

test('glossWords merges multi-word fixes and keeps punctuation and timing', () => {
  const ws = glossWords(words(['the', 'flora', '2,', 'trial', 'flora']), [{ from: 'Flora 2', to: 'FLAURA2' }, { from: 'flora', to: 'FLAURA' }]);
  assert.deepEqual(ws.map((w) => w.text), ['the', 'FLAURA2,', 'trial', 'FLAURA']);
  assert.equal(ws[1].start, 0.5);
  assert.equal(ws[1].end, 1.4);
});

test('SRT output', () => {
  const srt = toSrt(buildCues(words(['Hi', 'there.'])), { uppercase: true });
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,150\nHI THERE.\n');
});

test('ASS colours are BGR with alpha first', () => {
  assert.equal(assColor('#FF8800'), '&H000088FF');
  assert.equal(assColor('#000000', 0x80), '&H80000000');
  assert.equal(assRgb('#FFD400'), '&H00D4FF&');
});

test('ASS script: style from the caption settings, one event per word when highlighting', () => {
  const { style } = defaultCaptions();
  const cues = buildCues(words(['Hello', 'world.']));
  const ass = toAss(cues, style, [1080, 1920]);
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
  assert.match(ass, /Style: Default,Arial,115,&H00FFFFFF,/);
  const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(events.length, 2);
  assert.match(events[0], /^Dialogue: 0,0:00:00\.00,0:00:00\.50,Default,,0,0,0,,\{\\c&H00D4FF&\}Hello\{\\c&HFFFFFF&\} world\.$/);
  const plain = toAss(cues, { ...style, wordHighlight: false, uppercase: true, box: true }, [1920, 1080]);
  assert.match(plain, /,,HELLO WORLD\.$/m);
  assert.match(plain, /,3,16,0,2,/); // BorderStyle 3 (box), padding from font size
});

test('ASS text cannot inject override tags', () => {
  const ass = toAss(buildCues([{ text: '{\\b1}x', start: 0, end: 1 }]), { ...defaultCaptions().style, wordHighlight: false }, [1920, 1080]);
  assert.match(ass, /,,\(\/b1\)x$/m);
});
