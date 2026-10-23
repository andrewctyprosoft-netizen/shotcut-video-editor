// End-to-end checks of layers, effects and caption editing in the real Electron window, with real mouse
// input over the DevTools protocol: layer placement and stacking, click-select, drag-move with centre snap,
// corner resize, crop in the preview, keyframes and their curve, a fade-in effect, moving an item in time
// and onto a new layer, a +6 dB boost through Web Audio, the transition preview, moving the caption box for
// all captions and for one selected caption, trimming a caption, moving an imported subtitle, and colour-key
// background removal. Usage: npm run e2e (needs `npm run samples` once). Screenshots go to dev/out/.
import { check, runE2E, sleep } from './cdp.mjs';
import { writeLayersProject } from './sampleProject.mjs';

await runE2E(await writeLayersProject('e2e-layers'), run, 9340);

async function run({ evaluate, waitFor, drag, click, clickAt, rect, shot, send }) {
  await waitFor('window.__vce?.state.project.tracks?.length === 3', 15000);
  const S = () => evaluate(`JSON.parse(JSON.stringify({ p: __vce.state.project, past: __vce.state.past.length, sel: __vce.state.selectedClipId,
    cues: __vce.state.selectedCues, all: __vce.state.captionScopeAll, time: __vce.state.time }))`);
  const item = (s, id) => s.p.tracks.flatMap((t) => t.items).find((i) => i.id === id);
  const seek = async (t) => {
    await evaluate(`__vce.dispatch({ type: 'time', time: ${t} })`);
    await sleep(450);
  };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const field = (label, tag, value, event) => evaluate(`(() => {
    const f = [...document.querySelectorAll('.inspector label.field')].find((l) => l.querySelector('span')?.childNodes[0]?.textContent.trim() === ${JSON.stringify(label)});
    const el = f?.querySelector(${JSON.stringify(tag)});
    if (!el) return false;
    const proto = ${tag === 'select' ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }));
    return true;
  })()`);
  const setSelect = (label, value) => field(label, 'select', value, 'change');
  const setRange = (label, value) => field(label, 'input', value, 'input');
  await sleep(800);
  const stage = await rect('.stage');
  const fx = (x) => stage.left + x * stage.width;
  const fy = (y) => stage.top + y * stage.height;

  // 1. Layers: the logo sits where its transform says; the GIF layer stacks above it.
  await seek(2);
  const logo = await rect('[data-item="logo1"]');
  const expectW = ((300 * Math.min(1920 / 300, 1080 / 300) * 0.3) / 1920) * stage.width;
  check('layer: logo drawn at its place and size', near(logo.x, fx(0.8), 2) && near(logo.y, fy(0.25), 2) && near(logo.width, expectW, 2),
    `centre ${logo.x.toFixed(0)},${logo.y.toFixed(0)} vs ${fx(0.8).toFixed(0)},${fy(0.25).toFixed(0)}; width ${logo.width.toFixed(1)} vs ${expectW.toFixed(1)}`);
  const z = await evaluate(`['logo1', 'gif1'].map((id) => Number(document.querySelector('[data-item="' + id + '"]').style.zIndex))`);
  check('layer: the second layer stacks in front of the first', z[1] > z[0], z.join(' < '));

  // 2. Click to select; drag to the centre (snaps); one undo step.
  await clickAt(logo.x, logo.y);
  let s = await S();
  check('select: clicking the logo in the preview selects it', s.sel === 'logo1', s.sel);
  const past0 = s.past;
  await drag(logo.x, logo.y, fx(0.506), fy(0.495));
  s = await S();
  const t1 = item(s, 'logo1').transform;
  check('move: dragged to the centre and snapped', t1.x === 0.5 && t1.y === 0.5, `${t1.x}, ${t1.y}`);
  check('move: one undo step', s.past === past0 + 1, `${past0} -> ${s.past}`);

  // 3. Resize from a corner.
  const corner = await rect('.gizmo .gz-h.se');
  await drag(corner.x, corner.y, corner.x + 60, corner.y + 60);
  s = await S();
  check('resize: dragging a corner outwards enlarges it', item(s, 'logo1').transform.scale > 0.4, String(item(s, 'logo1').transform.scale.toFixed(3)));
  await shot('e2e-l1-move-resize');

  // 4. Crop in the preview: drag the right edge in by 30% of the picture.
  await click('Crop in preview');
  await waitFor("!!document.querySelector('.crop-box')");
  const edge = await rect('.crop-box .cr-h.e');
  const full = await rect('.crop-full');
  await drag(edge.x, edge.y, edge.x - full.width * 0.3, edge.y);
  s = await S();
  const crop = item(s, 'logo1').crop;
  check('crop: the right edge drag keeps 70% of the width', crop && near(crop.w, 0.7, 0.02) && crop.x === 0, JSON.stringify(crop));
  await shot('e2e-l2-crop');
  await click('Done');
  const clipPath = await evaluate(`document.querySelector('[data-item="logo1"]').style.clipPath`);
  const right = Number(/^inset\(\S+ ([\d.]+)%/.exec(clipPath)?.[1]);
  check('crop: the preview clips the picture after Done', near(right, 30, 0.1), clipPath);

  // 5. Keyframes: one at 1.0 s, a drag at 5.0 s adds the second; halfway is in between; set the curve.
  await seek(1.0);
  await click('◇ Add keyframe');
  await seek(5.0);
  const at5 = await rect('[data-item="logo1"]');
  await drag(at5.x, at5.y, at5.x - stage.width * 0.3, at5.y);
  s = await S();
  const kfs = item(s, 'logo1').keyframes;
  check('keyframes: a drag at another time adds the second keyframe', kfs.length === 2, kfs.map((k) => `${k.t}s x=${k.x.toFixed(2)}`).join(', '));
  // The selection box is the visible (cropped) picture; its centre is the transform position.
  await seek(3.0);
  const mid = await rect('.gizmo');
  const want = kfs[0].x + ((kfs[1].x - kfs[0].x) * (2.5 - kfs[0].t)) / (kfs[1].t - kfs[0].t);
  check('keyframes: halfway in time is halfway in place (linear)', near((mid.x - stage.left) / stage.width, want, 0.01),
    `${((mid.x - stage.left) / stage.width).toFixed(3)} vs ${want.toFixed(3)}`);
  await seek(2.0);
  const quarter = await rect('.gizmo');
  await seek(1.0);
  await setSelect('Transition to the next keyframe', 'inOut');
  s = await S();
  check('keyframes: curve to the next keyframe set', item(s, 'logo1').keyframes[0].ease === 'inOut');
  await seek(2.0);
  const eased = await rect('.gizmo');
  const lin = (quarter.x - stage.left) / stage.width;
  const inOut = (eased.x - stage.left) / stage.width;
  const wantInOut = kfs[0].x + (kfs[1].x - kfs[0].x) * 4 * 0.25 ** 3;
  check('keyframes: ease in-out starts slower than linear', near(inOut, wantInOut, 0.01) && Math.abs(inOut - kfs[0].x) < Math.abs(lin - kfs[0].x),
    `linear ${lin.toFixed(3)}, ease ${inOut.toFixed(3)} (want ${wantInOut.toFixed(3)})`);

  // 6. Fade-in effect on the GIF (selected on the timeline).
  const gifClip = await rect('[data-clip="gif1"] .clip-label');
  await clickAt(gifClip.x, gifClip.y);
  await setSelect('In', 'fade');
  s = await S();
  check('animation: fade in set on the GIF', item(s, 'gif1').anim.in?.type === 'fade', JSON.stringify(item(s, 'gif1').anim));
  await seek(1.15);
  const op1 = Number(await evaluate(`document.querySelector('[data-item="gif1"]').style.opacity`));
  await seek(2.5);
  const op2 = Number(await evaluate(`document.querySelector('[data-item="gif1"]').style.opacity`));
  check('animation: the GIF fades in, then shows fully', op1 > 0.05 && op1 < 0.9 && op2 === 1, `${op1.toFixed(2)} then ${op2}`);

  // 7. Timeline: drag the GIF later on its layer, then above the top layer onto a new one; undo both.
  const pps = Number(await evaluate("document.querySelector('.zoom input').dataset.pps"));
  const g0 = await rect('[data-clip="gif1"] .clip-label');
  await drag(g0.x, g0.y, g0.x + 2 * pps, g0.y);
  s = await S();
  check('timeline: item moved 2 s later', near(item(s, 'gif1').start, 3, 0.07), String(item(s, 'gif1').start));
  const topLane = await rect('.lane.layer');
  const g1 = await rect('[data-clip="gif1"] .clip-label');
  await drag(g1.x, g1.y, g1.x, topLane.top - 10);
  s = await S();
  const lastLayer = s.p.tracks.filter((t) => t.kind === 'layer').at(-1);
  check('timeline: dropping above the top layer makes a new layer in front', s.p.tracks.length === 4 && lastLayer.items.some((i) => i.id === 'gif1'),
    s.p.tracks.map((t) => `${t.kind}[${t.items.map((i) => i.id)}]`).join(' '));
  await shot('e2e-l3-new-layer');
  await evaluate("__vce.dispatch({ type: 'undo' }); __vce.dispatch({ type: 'undo' })");
  s = await S();
  check('timeline: undo puts the GIF back', s.p.tracks.length === 3 && item(s, 'gif1').start === 1);

  // 8. +6 dB on the main clip plays through Web Audio without breaking playback.
  const talk = await rect('.video-track .clip .clip-label');
  await clickAt(talk.x, talk.y);
  await setRange('Volume', 6);
  s = await S();
  check('volume: +6 dB set on the main clip', s.p.clips[0].volume === 6, String(s.p.clips[0].volume));
  await seek(0.5);
  await evaluate("__vce.dispatch({ type: 'play', playing: true })");
  await sleep(1200);
  const audio = await evaluate(`(() => { __vce.dispatch({ type: 'play', playing: false });
    const v = __vcePlayback.slots[__vcePlayback.activeSlot].video;
    return { routed: window.__vceAudioRouted ?? 0, error: v.error?.message ?? null, t: __vce.state.time, volume: v.volume }; })()`);
  check('volume: the boost routes through Web Audio and the clip keeps playing', audio.routed >= 1 && !audio.error && audio.t > 1.3,
    JSON.stringify(audio));

  // 9. Transition preview: halfway through the fade both clips show, the incoming one at about half opacity.
  const tr = await evaluate('(() => { const i = __vcePlayback.items[1]; return { start: i.start, overlap: i.overlap }; })()');
  await seek(tr.start + tr.overlap / 2);
  await sleep(300);
  const slots = await evaluate(`[...document.querySelectorAll('.stage .main-slot')].slice(0, 2).map((w) => ({ vis: w.style.visibility, op: w.style.opacity }))`);
  const ops = slots.map((x) => (x.op === '' ? 1 : Number(x.op)));
  check('transition: both clips show, the incoming one fading in', slots.every((x) => x.vis === 'visible') && ops.some((o) => near(o, 0.5, 0.15)),
    JSON.stringify(slots));
  await shot('e2e-l4-transition');

  // 10. Caption box, all captions: drag it right and up.
  await seek(3.05);
  const cap = await rect('.stage .caption');
  await drag(cap.x, cap.y, cap.x + stage.width * 0.1, cap.y - stage.height * 0.1);
  s = await S();
  check('captions (all): dragging the caption moves every caption', near(s.p.captions.style.x, 0.6, 0.01) && near(s.p.captions.style.position, 0.75, 0.01)
    && !Object.keys(s.p.captions.overrides).length, `x ${s.p.captions.style.x} bottom ${s.p.captions.style.position}`);

  // 11. Untick "All captions", pick one caption on the caption track, drag it: only that one moves.
  await click('Captions');
  const allBox = await evaluate(`(() => { const i = [...document.querySelectorAll('.inspector label.check')].find((l) => l.textContent.trim() === 'All captions')?.querySelector('input');
    i.scrollIntoView({ block: 'center' });
    const r = i.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await clickAt(allBox.x, allBox.y);
  s = await S();
  check('captions: "All captions" unticked', s.all === false);
  const cues = await evaluate('__vce.cues.map((c) => ({ key: c.key, start: c.start, end: c.end, source: c.source }))');
  const target = cues.filter((c) => c.source === 'auto')[3];
  const cueEl = await rect(`[data-cue="${target.key}"]`);
  await clickAt(cueEl.x, cueEl.y);
  s = await S();
  check('captions: clicking a caption on the track selects it', s.cues.length === 1 && s.cues[0] === target.key, s.cues.join(','));
  await seek(target.start + 0.15);
  const one = await rect('.stage .caption.selected');
  await drag(one.x, one.y, one.x - stage.width * 0.2, one.y);
  s = await S();
  const ov = s.p.captions.overrides[target.key]?.style;
  const others = await evaluate(`__vce.cues.filter((c) => c.key !== ${JSON.stringify(target.key)}).map((c) => c.style.x)`);
  check('captions (selected): only the selected caption moves', ov && near(ov.x, 0.4, 0.01) && others.every((x) => near(x, 0.6, 0.01)) && near(s.p.captions.style.x, 0.6, 0.01),
    `selected x ${ov?.x}; others ${[...new Set(others)].join(',')}`);
  const side = await rect('.stage .caption.selected .cap-h.e');
  await drag(side.x, side.y, side.x - stage.width * 0.15, side.y);
  s = await S();
  check('captions (selected): the side handle narrows its box', s.p.captions.overrides[target.key].style.width < 0.8, String(s.p.captions.overrides[target.key].style.width));
  await shot('e2e-l5-caption-one');

  // 12. Trim the selected caption's end on the caption track.
  const handle = await rect(`[data-cue="${target.key}"] .handle.right`);
  await drag(handle.x, handle.y, handle.x - 0.5 * pps, handle.y);
  s = await S();
  const dEnd = s.p.captions.overrides[target.key]?.dEnd ?? 0;
  check('captions: dragging the end shortens the caption', dEnd < -0.3, `dEnd ${dEnd.toFixed(3)}`);

  // 13. Move the imported subtitle line 1 s later.
  const sub = await rect('.cue.srt');
  await drag(sub.x, sub.y, sub.x + pps, sub.y);
  s = await S();
  check('subtitles: an imported line moves as a whole', near(s.p.subtitles[0].start, 11.6, 0.1) && near(s.p.subtitles[0].end - s.p.subtitles[0].start, 1.2, 0.01),
    `${s.p.subtitles[0].start}–${s.p.subtitles[0].end}`);

  // 14. Remove the green background of the image layer with the colour key.
  await seek(7);
  const green = await rect('[data-clip="green1"] .clip-label');
  await clickAt(green.x, green.y);
  await click('Colour key');
  await click('Remove background');
  await waitFor("(() => { const it = __vce.state.project.tracks.flatMap((t) => t.items).find((i) => i.id === 'green1'); return __vce.state.project.media[it.mediaId].cutoutOf === 'green'; })()", 60000);
  await sleep(800);
  const px = await evaluate(`(async () => {
    const img = document.querySelector('[data-item="green1"]');
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return { corner: [...g.getImageData(5, 5, 1, 1).data], middle: [...g.getImageData(320, 180, 1, 1).data], src: img.src.slice(-12) };
  })()`);
  check('background: the green is transparent, the subject stays', px.corner[3] === 0 && px.middle[3] === 255 && px.middle[0] > 180, JSON.stringify(px));
  await shot('e2e-l6-background');

  // 15. Timeline zoom: Ctrl+wheel at the pointer keeps that time in place; plain wheel does not zoom;
  // buttons and keys step; Fit shows the whole timeline.
  const zoomState = (x) => evaluate(`(() => { const el = document.querySelector('.tl-scroll'); const pps = Number(document.querySelector('.zoom input').dataset.pps);
    return { pps, scroll: el.scrollLeft, t: ${x === undefined ? 'null' : `(el.scrollLeft + ${x} - el.getBoundingClientRect().left - 156) / pps`},
      view: el.clientWidth - 156, total: Math.max(...__vce.cues.map((c) => c.end), __vcePlayback.total) }; })()`);
  const lane = await rect('.lane.video-track');
  const wx = lane.left + 300;
  const wheel = (deltaY, modifiers) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wx, y: lane.y, deltaX: 0, deltaY, modifiers });
  const z0 = await zoomState(wx);
  for (let i = 0; i < 4; i++) await wheel(-120, 2);
  await sleep(300);
  const z1 = await zoomState(wx);
  check('zoom: Ctrl+wheel up zooms in at the pointer', z1.pps > z0.pps * 1.5 && near(z1.t, z0.t, 0.05), `${z0.pps.toFixed(1)} -> ${z1.pps.toFixed(1)} px/s; time under pointer ${z0.t.toFixed(2)} -> ${z1.t.toFixed(2)} s`);
  for (let i = 0; i < 4; i++) await wheel(120, 2);
  await sleep(300);
  const z2 = await zoomState(wx);
  check('zoom: Ctrl+wheel down zooms back out', near(z2.pps, z0.pps, 0.5) && near(z2.t, z0.t, 0.05), `${z2.pps.toFixed(1)} px/s, ${z2.t.toFixed(2)} s`);
  await wheel(120, 0);
  await sleep(200);
  check('zoom: a plain wheel scrolls, it does not zoom', (await zoomState()).pps === z2.pps);
  await click('+');
  const z3 = await zoomState();
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '-', code: 'Minus', text: '-' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '-', code: 'Minus' });
  await sleep(200);
  const z4 = await zoomState();
  check('zoom: + button and - key step by 1.5×', near(z3.pps, z2.pps * 1.5, 0.01) && near(z4.pps, z2.pps, 0.01), `${z2.pps.toFixed(1)} -> ${z3.pps.toFixed(1)} -> ${z4.pps.toFixed(1)}`);
  await click('Fit');
  const z5 = await zoomState();
  check('zoom: Fit shows the whole timeline', z5.scroll === 0 && z5.total * z5.pps <= z5.view && z5.total * z5.pps > z5.view * 0.8,
    `${z5.total.toFixed(1)} s × ${z5.pps.toFixed(1)} px/s in ${z5.view} px`);
  await shot('e2e-l7-zoom-fit');
}
