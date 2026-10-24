// End-to-end checks of speed, flip and reverse in the real Electron window, with real mouse input over the
// DevTools protocol: speed steps and the slider on several clips (one undo step, the preview plays at that
// rate), flipping layers and a main clip from the timeline toolbar (the picture mirrors in place), and
// reversing a main clip and an audio item (backwards copies made in the background, swapped in, and back).
// Usage: npm run e2e (needs `npm run samples` once). Screenshots go to dev/out/.
import { existsSync } from 'node:fs';
import { check, runE2E, sleep } from './cdp.mjs';
import { writeLayersProject } from './sampleProject.mjs';

await runE2E(await writeLayersProject('e2e-motion'), run, 9341);

async function run({ evaluate, waitFor, click, clickAt, rect, shot }) {
  await waitFor('window.__vce?.state.project.tracks?.length === 3', 15000);
  const S = () => evaluate(`JSON.parse(JSON.stringify({ p: __vce.state.project, past: __vce.state.past.length, sel: __vce.state.selectedClipId,
    ids: __vce.state.selectedIds, time: __vce.state.time, cues: __vce.cues.length, jobs: Object.values(__vce.state.jobs) }))`);
  const item = (s, id) => s.p.tracks.flatMap((t) => t.items).find((i) => i.id === id);
  const seek = async (t) => {
    await evaluate(`__vce.dispatch({ type: 'time', time: ${t} })`);
    await sleep(450);
  };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const pick = async (id, add = false) => {
    // Audio tracks sit at the bottom of the timeline, under its scroll bar until scrolled into view.
    await evaluate(`document.querySelector('[data-clip="${id}"]').scrollIntoView({ block: 'center', inline: 'nearest' })`);
    await sleep(100);
    const r = await rect(`[data-clip="${id}"] .clip-label`);
    await clickAt(r.x, r.y, add ? 2 : 0);
  };
  const setRange = (label, value) => evaluate(`(() => {
    const el = document.querySelector('.inspector input[aria-label=${JSON.stringify(label)}]');
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  // Length of the main track without its transition overlaps (they do not change with speed here).
  const tlEnd = () => evaluate(`(() => { const p = __vce.state.project; let e = 0;
    for (const c of p.clips) e += Math.max(1, Math.round((c.out - c.in) / c.speed * p.fps)) / p.fps; return e; })()`);
  await sleep(800);

  let s = await S();
  const talk = s.p.clips[0];
  const mainLen0 = await tlEnd();

  // 1. Speed: a step button on the main clip, then the slider on the main clip and the music together.
  await pick(talk.id);
  await click('2×');
  s = await S();
  const mainLen1 = await tlEnd();
  check('speed: the 2× step doubles the main clip speed', s.p.clips[0].speed === 2 && near(mainLen1, mainLen0 - (talk.out - talk.in) / 2, 0.05),
    `speed ${s.p.clips[0].speed}, main track ${mainLen0.toFixed(2)} -> ${mainLen1.toFixed(2)} s`);
  const badge = await evaluate(`document.querySelector('[data-clip="${talk.id}"] .badge')?.textContent`);
  check('speed: the timeline badge shows it', badge === '2×', String(badge));
  await pick('music1', true);
  const past0 = (await S()).past;
  for (const v of [0.4, 0.7, 1]) {
    await setRange('Speed', v);
    await sleep(60);
  }
  s = await S();
  check('speed: the slider reaches 10× and sets every selected clip', s.p.clips[0].speed === 10 && item(s, 'music1').speed === 10,
    `${s.p.clips[0].speed}, ${item(s, 'music1').speed}`);
  check('speed: one slider drag is one undo step', s.past === past0 + 1, `${past0} -> ${s.past}`);
  // The timeline runs in real time; the source runs 10 times faster (the 10 s clip lasts 1 s).
  // Its slot is read, not the visible one: the transition to the next clip starts at 0.5 s.
  const talkSlot = `(() => { const e = window.__vcePlayback; const v = e.slots.find((x) => x.item?.clip.mediaId === 'talk').video;
    return { rate: v.playbackRate, src: v.currentTime, t: __vce.state.time }; })()`;
  await seek(0.1);
  const v0 = (await evaluate(talkSlot)).src;
  await evaluate('__vce.commands.togglePlay()');
  await sleep(300);
  const fast = await evaluate(talkSlot);
  await evaluate('__vce.commands.togglePlay()');
  check('speed: the preview plays the clip at 10×', fast.rate === 10 && fast.src - v0 > 1.5 && fast.t > 0.2 && fast.t < 0.9,
    `rate ${fast.rate}, source ${v0.toFixed(2)} -> ${fast.src.toFixed(2)} s while the timeline went to ${fast.t.toFixed(2)} s`);
  // Playing on past the 1 s clip: the next clip takes over at its new place, not where it was at 1×.
  await seek(0.5);
  await evaluate('__vce.commands.togglePlay()');
  await sleep(1200);
  const after = await evaluate('__vce.state.time');
  await evaluate('__vce.commands.togglePlay()');
  check('speed: playback runs on into the next clip without jumping', after > 1.2 && after < 2.2, `t=${after.toFixed(2)} after 1.2 s from 0.5 s`);
  const slow = await setRange('Speed', -1);
  s = await S();
  check('speed: the slider goes down to 0.1×', slow && s.p.clips[0].speed === 0.1, String(s.p.clips[0].speed));
  await click('1×');
  s = await S();
  check('speed: the 1× step resets both', s.p.clips[0].speed === 1 && item(s, 'music1').speed === 1);

  // 2. Flip: the logo from the toolbar, then the logo and the GIF together, then the main clip.
  await seek(2);
  await pick('logo1');
  const box0 = await rect('.gizmo');
  await click('Flip ⇋');
  s = await S();
  const logoCss = await evaluate(`document.querySelector('[data-item="logo1"]').style.transform`);
  const box1 = await rect('.gizmo');
  check('flip: Flip ⇋ mirrors the selected layer', item(s, 'logo1').flip.h === true && logoCss === 'scale(-1, 1)', logoCss);
  check('flip: the picture stays where it was', near(box0.x, box1.x, 1) && near(box0.y, box1.y, 1) && near(box0.width, box1.width, 1));
  await pick('gif1', true);
  await click('Flip ⇵');
  s = await S();
  check('flip: Flip ⇵ turns both selected layers upside down', item(s, 'logo1').flip.v && item(s, 'gif1').flip.v && !item(s, 'gif1').flip.h);
  await click('Flip ⇋');
  s = await S();
  check('flip: with only some mirrored, Flip ⇋ mirrors them all', item(s, 'logo1').flip.h && item(s, 'gif1').flip.h);
  await click('Flip ⇋');
  s = await S();
  check('flip: again, it unmirrors them all', !item(s, 'logo1').flip.h && !item(s, 'gif1').flip.h);
  await shot('e2e-m1-flip');
  await pick(talk.id);
  await click('Flip ⇋');
  const mainCss = await evaluate(`(() => { const e = window.__vcePlayback; return e.slots[e.activeSlot].video.style.transform; })()`);
  check('flip: a main clip mirrors in the preview', (await S()).p.clips[0].flip.h && mainCss === 'scale(-1, 1)', mainCss);
  await click('Flip ⇋');

  // 3. Reverse the main clip: a backwards copy is made, swapped in, and its captions go (words run backwards).
  const cues0 = (await S()).cues;
  await click('Reverse');
  await waitFor(`Object.values(__vce.state.jobs).some((j) => j.kind === 'reverse' && j.status === 'done')`, 60000);
  await sleep(300);
  s = await S();
  const rev = s.p.media[s.p.clips[0].mediaId];
  check('reverse: the main clip plays a reversed copy of its range', Boolean(rev.reverseOf) && rev.reverseOf.mediaId === talk.mediaId
    && s.p.clips[0].in === 0 && near(s.p.clips[0].out, talk.out - talk.in, 0.001) && existsSync(rev.path), `${rev.name} ${rev.path}`);
  check('reverse: the timeline badge says so and its captions are gone', (await evaluate(`document.querySelector('[data-clip="${talk.id}"] .badge')?.textContent`)) === '◀◀' && s.cues < cues0,
    `${cues0} -> ${s.cues} captions`);
  await seek(1);
  const slot = await evaluate(`(() => { const e = window.__vcePlayback; const v = e.slots[e.activeSlot].video; return { src: decodeURIComponent(v.src), t: v.currentTime }; })()`);
  check('reverse: the preview plays the copy', slot.src.includes(rev.path.split(/[\\/]/).pop()) && near(slot.t, 1, 0.1), `${slot.src.split('/').pop()} at ${slot.t.toFixed(2)}`);
  await shot('e2e-m2-reverse');
  await click('◀◀ Reversed · play forwards');
  s = await S();
  check('reverse: again, the original comes back with the same range', s.p.clips[0].mediaId === talk.mediaId && s.p.clips[0].in === talk.in && s.p.clips[0].out === talk.out
    && s.cues === cues0, `${s.p.clips[0].in}–${s.p.clips[0].out}, ${s.cues} captions`);

  // 4. Reverse two at once: the main clip again (cached: instant) and the music on the audio track.
  await pick(talk.id);
  await pick('music1', true);
  s = await S();
  check('reverse: the main clip and the music are picked', s.ids.join() === `${talk.id},music1` && s.p.clips[0].id === talk.id, s.ids.join());
  const jobs0 = s.jobs.length;
  await click('Reverse');
  await waitFor(`Object.values(__vce.state.jobs).filter((j) => j.kind === 'reverse' && j.status === 'done').length >= ${jobs0 + 1}
    && __vce.state.project.media[__vce.state.project.tracks.flatMap((t) => t.items).find((i) => i.id === 'music1').mediaId].reverseOf`, 60000);
  await sleep(300);
  s = await S();
  const musicRev = s.p.media[item(s, 'music1').mediaId];
  check('reverse: several at once, audio too', Boolean(s.p.media[s.p.clips[0].mediaId].reverseOf) && Boolean(musicRev.reverseOf) && musicRev.path.endsWith('.m4a'),
    `${s.p.media[s.p.clips[0].mediaId].name}, ${musicRev.name}`);
  const reversedCopies = Object.values(s.p.media).filter((m) => m.reverseOf && m.reverseOf.mediaId === talk.mediaId).length;
  check('reverse: the same range is reused, not copied again', reversedCopies === 1, `${reversedCopies} copies of ${talk.mediaId}`);
  await evaluate("__vce.dispatch({ type: 'undo' })");
  s = await S();
  check('reverse: undo puts the music back (the cached main clip swapped first)', item(s, 'music1').mediaId === 'music' && Boolean(s.p.media[s.p.clips[0].mediaId].reverseOf),
    item(s, 'music1').mediaId);
}
