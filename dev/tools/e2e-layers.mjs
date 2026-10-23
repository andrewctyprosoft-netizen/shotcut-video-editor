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
    ids: __vce.state.selectedIds, cues: __vce.state.selectedCues, all: __vce.state.captionScopeAll, time: __vce.state.time }))`);
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

  // 4. Crop two layers together: Ctrl+click the GIF on the timeline (the logo is selected), Crop in the
  // toolbar, drag the right edge in by 30%, Apply. The green image on another layer is not touched.
  const gifPick = await rect('[data-clip="gif1"] .clip-label');
  await clickAt(gifPick.x, gifPick.y, 2);
  s = await S();
  check('select: Ctrl+click on the timeline adds a second layer', s.ids.length === 2 && s.ids.includes('logo1') && s.ids.includes('gif1'), s.ids.join(','));
  const outlines = await evaluate("document.querySelectorAll('.stage .gizmo').length");
  check('select: both selected layers are outlined in the preview', outlines === 2, String(outlines));
  const pastCrop = s.past;
  await click('Crop');
  await waitFor("!!document.querySelector('.crop-dialog')");
  const title = await evaluate("document.querySelector('.crop-dialog h2').textContent");
  const edge = await rect('.crop-dialog .cr-h.e');
  const stageBox = await rect('.crop-dialog .crop-stage');
  await drag(edge.x, edge.y, edge.x - stageBox.width * 0.3, edge.y);
  await shot('e2e-l2-crop');
  await click('Apply to 2 layers');
  s = await S();
  const crops = ['logo1', 'gif1', 'green1'].map((id) => item(s, id).crop);
  check('crop: the window crops both selected layers by the right edge', title === 'Crop 2 layers' && crops.slice(0, 2).every((c) => c && near(c.w, 0.7, 0.02) && c.x === 0),
    `${title}: ${JSON.stringify(crops.slice(0, 2))}`);
  check('crop: layers that were not selected keep their picture', crops[2] === null, JSON.stringify(crops[2]));
  check('crop: one undo step, window closed', s.past === pastCrop + 1 && !(await evaluate("!!document.querySelector('.crop-dialog')")), `${pastCrop} -> ${s.past}`);
  // Back to the logo alone for the keyframe steps.
  const logoAgain = await rect('[data-item="logo1"]');
  await clickAt(logoAgain.x, logoAgain.y);
  const clipPath = await evaluate(`document.querySelector('[data-item="logo1"]').style.clipPath`);
  const right = Number(/^inset\(\S+ ([\d.]+)%/.exec(clipPath)?.[1]);
  check('crop: the preview clips the picture', near(right, 30, 0.1) && (await S()).ids.join() === 'logo1', clipPath);

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

  // 15b. Box select: drag from the empty end of the top layer down-left into the main track picks every
  // layer item and main clip it touches; Ctrl + a box over the caption track adds the captions; a plain
  // click on empty space clears the selection and seeks there.
  await evaluate("document.querySelector('.tl-scroll').scrollTop = 0"); // earlier steps leave the caption lane under the ruler
  const lanes = await evaluate(`(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, y: b.top + b.height / 2 }; };
    const layers = [...document.querySelectorAll('.lane.layer')];
    return {
      top: r(layers[0]), main: r(document.querySelector('.lane.video-track')), caps: r(document.querySelector('.lane.caption-track')),
      viewRight: (() => { const el = document.querySelector('.tl-scroll'); return el.getBoundingClientRect().left + el.clientWidth; })(), // without the scrollbar
      expect: [...document.querySelectorAll('.lane.layer [data-clip], .lane.video-track [data-clip]')].map((el) => el.dataset.clip).sort(),
      cues: document.querySelectorAll('.lane.caption-track [data-cue]').length,
    };
  })()`);
  const endX = Math.min(lanes.viewRight, lanes.top.right) - 12;
  await drag(endX, lanes.top.y, lanes.top.left + 4, lanes.main.y, 16);
  s = await S();
  check('box select: a box across layers and the main track picks everything it touches', JSON.stringify([...s.ids].sort()) === JSON.stringify(lanes.expect) && !s.cues.length,
    `${s.ids.length} picked of ${lanes.expect.length}`);
  check('box select: the box disappears on release', !(await evaluate("document.querySelector('.marquee')")));
  await drag(endX, lanes.caps.y, lanes.caps.left + 4, lanes.caps.y + 2, 12, 2);
  s = await S();
  check('box select: Ctrl + a box over the captions adds them to the picked clips', s.ids.length === lanes.expect.length && s.cues.length === lanes.cues && lanes.cues > 0,
    `${s.ids.length} clips + ${s.cues.length}/${lanes.cues} captions`);
  await shot('e2e-l7b-box-select');
  // Ctrl+click adds an audio clip and takes an image out (on its trim edge) without dropping the captions;
  // Ctrl+click on a caption keeps the clips.
  const music = await rect('[data-clip="music1"]');
  await clickAt(music.x, Math.min(music.y, lanes.main.bottom + 12), 2);
  const greenEdge = await rect('[data-clip="green1"] .handle.right');
  await clickAt(greenEdge.x, greenEdge.y, 2);
  s = await S();
  check('Ctrl+click: adds audio and removes an image (even on its edge), captions stay', s.ids.includes('music1') && !s.ids.includes('green1') && s.ids.length === lanes.expect.length && s.cues.length === lanes.cues,
    `${s.ids.join(',')} + ${s.cues.length} captions`);
  const cue0 = await rect('.lane.caption-track [data-cue]');
  await clickAt(cue0.x, cue0.y, 2);
  s = await S();
  check('Ctrl+click: taking a caption out keeps the clips', s.cues.length === lanes.cues - 1 && s.ids.length === lanes.expect.length, `${s.ids.length} clips + ${s.cues.length} captions`);
  await clickAt(endX, lanes.top.y);
  s = await S();
  check('box select: a click on empty space clears the selection and seeks', !s.ids.length && !s.cues.length && s.time > 0, `t=${s.time.toFixed(2)}`);

  // 16. Importing more files into a project that has a timeline: they wait in Media (the Import button stays),
  // a file dropped from Explorer is imported, and dragging a file onto a track places it there.
  check('import: the Media panel keeps its Import button', (await evaluate("document.querySelector('.media-head button')?.textContent")) === '+ Import');
  const before = await S();
  const mediaBefore = Object.keys(before.p.media).length;
  const elementsOf = (x) => x.p.clips.length + x.p.tracks.reduce((n, t) => n + t.items.length, 0);
  await evaluate(`(() => { const { id, words, ...info } = __vce.state.project.media.long; __vce.commands.addImports([{ ...info, needsProxy: false }]); })()`);
  await sleep(400);
  s = await S();
  const longId = Object.keys(s.p.media).find((k) => !before.p.media[k]);
  check('import: a later import lands in Media, not on the timeline', Object.keys(s.p.media).length === mediaBefore + 1 && elementsOf(s) === elementsOf(before)
    && (await evaluate(`!!document.querySelector('[data-media="${longId}"]')`)), longId);
  const logoPath = before.p.media.logo.path;
  const dropAt = await rect('.stage');
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await send('Input.dispatchDragEvent', { type, x: dropAt.x, y: dropAt.y, data: { items: [], files: [logoPath], dragOperationsMask: 1 } });
  }
  await waitFor(`Object.keys(__vce.state.project.media).length === ${mediaBefore + 2}`, 10000).catch(() => {});
  s = await S();
  const dropped = Object.values(s.p.media).filter((m) => m.path === logoPath);
  check('import: a file dropped on the window is imported', dropped.length === 2 && elementsOf(s) === elementsOf(before), `${dropped.length} copies of logo.png in Media`);

  // 17. A 70-minute audio file dragged from Media onto the audio track: placed at the drop time, and the
  // whole timeline fits the window; you can zoom out further and back in; the ruler stays a handful of labels.
  const placed = await evaluate(`(() => {
    const dt = new DataTransfer();
    document.querySelector('[data-media="${longId}"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const lane = document.querySelector('.lane.audio');
    const r = lane.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 2, clientY: r.top + r.height / 2 };
    lane.dispatchEvent(new DragEvent('dragover', at));
    lane.dispatchEvent(new DragEvent('drop', at));
    return true;
  })()`);
  await sleep(600);
  s = await S();
  const longItems = s.p.tracks.flatMap((t) => t.items).filter((i) => i.mediaId === longId);
  check('drag to timeline: the file is placed on a track at the drop time', placed && longItems.length === 1 && longItems[0].start < 1, JSON.stringify(longItems.map((i) => i.start)));
  const zl = await zoomState();
  const longItem = await rect('.lane.audio .clip:last-child');
  check('long media: placing 70 minutes fits the timeline to the window', zl.total > 4200 && zl.total * zl.pps <= zl.view && zl.total * zl.pps > zl.view * 0.9 && zl.scroll === 0,
    `${(zl.total / 60).toFixed(1)} min × ${zl.pps.toFixed(3)} px/s in ${zl.view} px; item ${Math.round(longItem.width)} px`);
  const tickCount = await evaluate("document.querySelectorAll('.ruler .tick').length");
  check('long media: the ruler shows a few labels', tickCount > 3 && tickCount < 60, `${tickCount} labels`);
  await click('−');
  const zOut = await zoomState();
  check('long media: can zoom out beyond the fit', zOut.pps < zl.pps * 0.7, `${zl.pps.toFixed(3)} -> ${zOut.pps.toFixed(3)} px/s`);
  for (let i = 0; i < 12; i++) await click('+');
  const zIn = await zoomState();
  const zoomTicks = await evaluate("document.querySelectorAll('.ruler .tick').length");
  check('long media: zoomed in, only the visible ruler labels exist', zIn.pps > 20 && zoomTicks < 120, `${zIn.pps.toFixed(1)} px/s, ${zoomTicks} labels`);
  await click('Fit');
  await shot('e2e-l8-long-fit');

  // 18. An image stretched past an hour (to the end of the 70-minute file) by dragging its right edge.
  await evaluate("document.querySelector('.tl-scroll').scrollTop = 0");
  const logoEdge = await rect('[data-clip="logo1"]'); // 4 px wide at this zoom: press its last pixel (the right handle)
  const audioEnd = { right: await evaluate("Math.max(...[...document.querySelectorAll('.lane.audio .clip')].map((el) => el.getBoundingClientRect().right))") };
  await drag(logoEdge.right - 1, logoEdge.y, audioEnd.right - 1, logoEdge.y, 20);
  s = await S();
  const logoEnd = item(s, 'logo1').start + item(s, 'logo1').out - item(s, 'logo1').in;
  check('stretch: an image drags past one hour', logoEnd > 4000, `${(logoEnd / 60).toFixed(1)} min`);

  // 18b. Zoomed out to 70 minutes, captions and clips are drawn as wide as their time: padding used to
  // make every short block at least 14 px (about 50 s here), so captions ran past the end of the audio.
  const inflated = await evaluate(`[...document.querySelectorAll('.lane .cue, .lane .clip')]
    .filter((el) => Math.abs(el.getBoundingClientRect().width - parseFloat(el.style.width)) > 0.5).length`);
  check('zoomed out: captions and clips are drawn at their time width', inflated === 0, `${inflated} drawn wider than set`);

  // 19. Playback on the wall clock (no main clip under the playhead) starts where the playhead stands,
  // even after sitting paused; it used to jump ahead by the time spent paused.
  await evaluate('__vce.dispatch({ type: "time", time: 2100 })');
  await sleep(1500);
  await evaluate('__vce.dispatch({ type: "play", playing: true })');
  await sleep(500);
  await evaluate('__vce.dispatch({ type: "play", playing: false })');
  const t19 = (await S()).time;
  check('playback: play after a pause starts at the playhead, no jump', t19 > 2100.2 && t19 < 2100.9, `t=${t19.toFixed(2)} after 0.5 s`);
}
