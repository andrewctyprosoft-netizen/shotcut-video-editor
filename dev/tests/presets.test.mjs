import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCues, isHighlighted, toAss } from '../../core/captions.js';
import { createProject, defaultCaptions, frameSize } from '../../core/project.js';
import {
  CAPTION_PRESETS, EXPORT_PRESETS, applyCaptionPreset, applyExportPreset, captionPreset, matchingCaptionPreset, matchingExportPreset,
} from '../../core/presets.js';
import { words } from './helpers.mjs';

test('every caption preset is a complete style and is recognised after applying it', () => {
  for (const pr of CAPTION_PRESETS) {
    const p = applyCaptionPreset(createProject(), pr.id);
    assert.deepEqual(Object.keys(p.captions.style).sort(), Object.keys(defaultCaptions().style).sort(), pr.id);
    assert.equal(matchingCaptionPreset(p.captions), pr.id);
  }
  assert.equal(matchingCaptionPreset(createProject().captions), 'classic');
  const custom = applyCaptionPreset(createProject(), 'karaoke');
  custom.captions.style.size = 0.1;
  assert.equal(matchingCaptionPreset(custom.captions), null);
});

test('karaoke fill keeps spoken words highlighted; pop scales only the current word', () => {
  assert.deepEqual([0, 1, 2].map((j) => isHighlighted({ highlightMode: 'progressive' }, j, 1)), [true, true, false]);
  assert.deepEqual([0, 1, 2].map((j) => isHighlighted({ highlightMode: 'word' }, j, 1)), [false, true, false]);
  const cues = buildCues(words(['one', 'two', 'three.']));
  const karaoke = toAss(cues, captionPreset('karaoke').style, [1920, 1080]).split('\n').filter((l) => l.startsWith('Dialogue'));
  assert.match(karaoke[2], /\{\\c&HD84FFF&\}one\{\\c&HFFFFFF&\} \{\\c&HD84FFF&\}two\{\\c&HFFFFFF&\} \{\\c&HD84FFF&\}three\./);
  const pop = toAss(cues, captionPreset('bold-pop').style, [1080, 1920]).split('\n').filter((l) => l.startsWith('Dialogue'));
  assert.match(pop[1], /,,ONE \{\\fscx115\\fscy115\\c&H4FFF7C&\}TWO\{\\fscx100\\fscy100\\c&HFFFFFF&\} THREE\.$/);
  assert.match(toAss(cues, captionPreset('bold-pop').style, [1080, 1920]), /Style: Default,Impact,163,/);
});

test('export presets set frame, rate, resolution and quality', () => {
  let p = applyExportPreset(createProject(), 'vertical');
  assert.deepEqual([p.aspect, p.fps, frameSize(p)], ['9:16', 30, [1080, 1920]]);
  assert.equal(matchingExportPreset(p), 'vertical');
  p = applyExportPreset(p, 'small');
  assert.deepEqual([p.aspect, frameSize(p), p.export.quality], ['9:16', [720, 1280], 'small']);
  assert.equal(matchingExportPreset(p), 'small');
  p = applyExportPreset(createProject(), 'youtube-4k');
  assert.deepEqual(frameSize(p), [3840, 2160]);
  assert.equal(matchingExportPreset(createProject()), 'youtube-1080');
  assert.equal(EXPORT_PRESETS.length, new Set(EXPORT_PRESETS.map((x) => x.id)).size);
});
