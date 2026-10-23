import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captionAnim, captionBox, captionsAs, cuesAt, parseSubtitles, projectCues, resetCaptionStyle, setCaptionStyle, setCueTiming,
  spreadWords, toAss, toVtt,
} from '../../core/captions.js';
import { removeSourceRanges, setSubtitles, updateMedia } from '../../core/project.js';
import { timelineWords } from '../../core/transcript.js';
import { media, projectWith, words } from './helpers.mjs';

function sample() {
  let p = projectWith(media('a', 10));
  p = updateMedia(p, 'a', { words: words(['One', 'two.', 'Three', 'four.', 'Five', 'six.'], 0, 0.6, 0.4) });
  return p;
}
const cuesOf = (p) => projectCues(timelineWords(p), p);

test('apply to all changes the default style; per-caption changes touch only those captions', () => {
  let p = sample();
  const [c1, c2] = cuesOf(p);
  assert.deepEqual(cuesOf(p).map((c) => c.key), ['w:a:0', 'w:a:2', 'w:a:4']);
  p = setCaptionStyle(p, { x: 0.3, width: 0.4 });
  assert.ok(cuesOf(p).every((c) => c.style.x === 0.3));
  p = setCaptionStyle(p, { size: 0.1, position: 0.2 }, [c2.key]);
  const cs = cuesOf(p);
  assert.deepEqual(cs.map((c) => c.style.size), [0.06, 0.1, 0.06]);
  assert.equal(cs[1].style.x, 0.3, 'still follows the default for fields it did not change');
  p = resetCaptionStyle(p, [c2.key]);
  assert.ok(cuesOf(p).every((c) => c.style.size === 0.06));
  assert.equal(c1.style.x, 0.5);
});

test('a per-caption override follows its words through a cut', () => {
  let p = sample();
  p = setCaptionStyle(p, { color: '#FF0000' }, ['w:a:2']);
  p = removeSourceRanges(p, 'a', [[0, 1.1]]); // cut "One two."
  const cs = cuesOf(p);
  assert.equal(cs[0].text, 'Three four.');
  assert.equal(cs[0].style.color, '#FF0000');
});

test('caption timing: auto captions store a shift, never overlap the next one', () => {
  let p = sample();
  const [c1, c2] = cuesOf(p);
  p = setCueTiming(p, c1, { end: c1.end + 5 });
  const [d1, d2] = cuesOf(p);
  assert.ok(Math.abs(d1.end - (d2.start - 0.02)) < 1e-9, 'stops before the next caption');
  p = setCueTiming(p, c2, { start: c2.start + 0.3 });
  assert.ok(Math.abs(cuesOf(p)[1].start - (c2.start + 0.3)) < 1e-9);
  assert.ok(cuesOf(p)[0].end > d1.end, 'the earlier caption can now run longer');
});

test('imported SRT: parsed, timed words spread by length, editable timing, overlapping auto captions', () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:03,000\r\n<i>Hello</i> big\r\nworld\r\n\r\n2\r\n00:00:04,500 --> 00:00:05,000\r\nBye\r\n';
  const cues = parseSubtitles(srt);
  assert.deepEqual(cues, [{ start: 1, end: 3, text: 'Hello big world' }, { start: 4.5, end: 5, text: 'Bye' }]);
  assert.deepEqual(parseSubtitles('WEBVTT\n\n00:01.000 --> 00:02.500 align:start\n- Hi\n'), [{ start: 1, end: 2.5, text: '- Hi' }]);
  const ws = spreadWords('aa b', 0, 1);
  assert.deepEqual(ws.map((w) => [w.text, Math.round(w.end * 1000) / 1000]), [['aa', 0.6], ['b', 1]]);
  let p = setSubtitles(sample(), cues);
  const all = cuesOf(p);
  const sub = all.find((c) => c.source === 'srt' && c.text === 'Hello big world');
  assert.ok(sub);
  assert.equal(cuesAt(all, 1.3).length, 2, 'an SRT line and an auto caption on screen together');
  p = setCueTiming(p, sub, { end: 3.5 });
  assert.equal(p.subtitles[0].end, 3.5);
});

test('ASS: one style per distinct look, position and width as margins, fade and pop', () => {
  let p = sample();
  p = setCaptionStyle(p, { animIn: 'fade', animOut: 'fade' });
  p = setCaptionStyle(p, { x: 0.25, width: 0.4, position: 0.3, box: true }, ['w:a:2']);
  const cs = cuesOf(p);
  const ass = toAss(cs, p.captions.style, [1920, 1080]);
  const styles = ass.split('\n').filter((l) => l.startsWith('Style:'));
  assert.equal(styles.length, 2);
  assert.match(styles[0], /^Style: Default,.*,2,115,115,162,1$/);
  assert.match(styles[1], /^Style: Cue1,.*,3,.*,2,96,1056,756,1$/); // x 0.25 w 0.4 -> margins 96 / 1056, bottom at 0.3
  const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.match(events[0], /,Default,,0,0,0,,\{\\fad\(200,0\)\}/);
  assert.match(events[1], /\{\\fad\(0,200\)\}/);
  assert.ok(events.some((e) => e.includes(',Cue1,')));
  assert.deepEqual(captionBox({ x: 0.5, width: 0.88, position: 0.85 }, [1000, 1000]), { marginL: 60, marginR: 60, marginV: 150 });
  const pop = toAss(cs.slice(0, 1).map((c) => ({ ...c, style: { ...c.style, animIn: 'pop', animOut: 'none' } })), p.captions.style, [1920, 1080]);
  assert.match(pop, /\\fscx60\\fscy60\\t\(0,150,\\fscx100\\fscy100\)/);
});

test('caption animation in the preview and download formats', () => {
  const cue = { start: 1, end: 3 };
  assert.equal(captionAnim(cue, { animIn: 'fade' }, 1).opacity, 0);
  assert.equal(captionAnim(cue, { animIn: 'fade', animOut: 'fade' }, 2).opacity, 1);
  assert.ok(captionAnim(cue, { animIn: 'pop' }, 1.05).scale < 1);
  const cues = cuesOf(sample());
  assert.match(toVtt(cues, {}), /^WEBVTT\n\n00:00:00\.000 --> /);
  assert.equal(captionsAs('txt', cues, {}, [1920, 1080]), 'One two.\nThree four.\nFive six.\n');
  assert.match(captionsAs('srt', cues, {}, [1920, 1080]), /^1\n00:00:00,000 --> /);
});
