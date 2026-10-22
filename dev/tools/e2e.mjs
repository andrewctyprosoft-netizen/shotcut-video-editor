// End-to-end checks in the real Electron window, driven over the Chrome DevTools Protocol with real
// mouse input: drag-trim, drag-reorder, undo, text cut, gap-free playback across a cut, captions presets
// and export presets. Usage: npm run e2e   (needs `npm run samples` once). Screenshots go to dev/out/.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import electronPath from 'electron';
import { outDir, root, writeSampleProject } from './sampleProject.mjs';

const PORT = 9339;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

const projectFile = await writeSampleProject('e2e');
const child = spawn(electronPath, ['.', projectFile, `--remote-debugging-port=${PORT}`], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
let exitCode = 1;
try {
  const cdp = await connect();
  exitCode = await run(cdp);
} catch (err) {
  console.error(err);
} finally {
  child.kill();
}
process.exit(exitCode);

// ---------- scenarios ----------

async function run({ evaluate, waitFor, drag, click, shot }) {
  await waitFor('window.__vce?.state.project.clips.length === 2', 15000);
  const st = () => evaluate(`(() => { const s = __vce.state; return JSON.parse(JSON.stringify({
    clips: s.project.clips, past: s.past.length, time: s.time, playing: s.playing, project: s.project })); })()`);
  const rect = (sel) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, right: r.right }; })()`);
  const pps = Number(await evaluate("document.querySelector('.zoom input').value"));
  await sleep(800);

  // 1. Drag-trim the end of the first clip 80 px to the left.
  let s0 = await st();
  const talk = s0.clips[0];
  const h = await rect(`[data-clip="${talk.id}"] .handle.right`);
  await drag(h.x, h.y, h.x - 80, h.y);
  let s1 = await st();
  const expectedOut = talk.out - 80 / pps;
  check('trim: end edge moved by the drag', Math.abs(s1.clips[0].out - expectedOut) < 0.06, `${s1.clips[0].out.toFixed(3)} vs ${expectedOut.toFixed(3)}`);
  check('trim: one undo step', s1.past === s0.past + 1, `${s0.past} -> ${s1.past}`);
  check('trim: playhead jumps to the new end', Math.abs(s1.time - (s1.clips[0].out - 1 / 30)) < 0.05, s1.time.toFixed(3));
  await shot('e2e-1-trim');

  // 2. Drag the second clip (bars) to the front.
  const bars = await rect(`[data-clip="${s1.clips[1].id}"] .clip-label`);
  const first = await rect(`[data-clip="${talk.id}"]`);
  await drag(bars.x, bars.y, first.left + 5, bars.y);
  const s2 = await st();
  check('reorder: bars moved to the front', s2.clips[0].mediaId === 'bars' && s2.clips[1].mediaId === 'talk', s2.clips.map((c) => c.mediaId).join(','));
  check('reorder: first clip has no incoming transition', s2.clips[0].transition === null);
  check('reorder: one undo step', s2.past === s1.past + 1);
  await shot('e2e-2-reorder');

  // 3. Undo both.
  await evaluate("__vce.dispatch({ type: 'undo' }); __vce.dispatch({ type: 'undo' })");
  const s3 = await st();
  check('undo: back to the original timeline', JSON.stringify(s3.clips) === JSON.stringify(s0.clips));

  // 4. Text cut: remove the filler word, which splits talk.mp4 into two clips of the same file.
  await click('Transcript');
  await click(/^Remove fillers \(1\)$/);
  const s4 = await st();
  check('text cut: filler removed, talk split in two', s4.clips.length === 3 && s4.clips[0].mediaId === 'talk' && s4.clips[1].mediaId === 'talk',
    s4.clips.map((c) => `${c.mediaId}[${c.in}-${c.out}]`).join(' '));

  // 5. Gap-free playback across that cut: measure presented video frames around the boundary.
  const boundary = Math.round((s4.clips[0].out - s4.clips[0].in) * 30) / 30;
  const measure = async (preload, at) => {
    await evaluate(`__vce.dispatch({ type: 'time', time: ${at - 0.8} })`);
    await sleep(700);
    await evaluate(`(() => {
      const eng = window.__vcePlayback;
      eng.__preloadNext ??= eng.preloadNext;
      eng.preloadNext = ${preload} ? eng.__preloadNext : () => {}; // baseline: the old one-video behaviour
      if (!${preload}) { const o = eng.slots[1 - eng.active]; o.item = null; o.url = null; }
      window.__frames = [];
      window.__stop = false;
      [...document.querySelectorAll('.stage video')].forEach((v, slot) => {
        const loop = (now, meta) => { if (window.__stop) return; window.__frames.push({ now, slot, mt: meta.mediaTime }); v.requestVideoFrameCallback(loop); };
        v.requestVideoFrameCallback(loop);
      });
      window.__slotBefore = eng.activeSlot;
      __vce.dispatch({ type: 'play', playing: true });
    })()`);
    await sleep(1800);
    const play = await evaluate(`(() => { __vce.dispatch({ type: 'play', playing: false }); window.__stop = true;
      window.__vcePlayback.preloadNext = window.__vcePlayback.__preloadNext;
      return { frames: window.__frames, before: window.__slotBefore, after: window.__vcePlayback.activeSlot, time: __vce.state.time }; })()`);
    const frames = play.frames.sort((a, b) => a.now - b.now);
    const gaps = frames.slice(1).map((f, i) => f.now - frames[i].now);
    // The frame where the source jumps over the cut (media time leaps forward).
    const cut = frames.findIndex((f, i) => i > 0 && (f.mt - frames[i - 1].mt > 0.3 || f.mt < frames[i - 1].mt));
    return { ...play, frames, gaps, maxGap: Math.max(...gaps), cutGap: cut > 0 ? gaps[cut - 1] : NaN };
  };
  const base = await measure(false, boundary);
  console.log(`info  baseline, one video, same-file cut: gap at cut ${base.cutGap.toFixed(1)} ms, max ${base.maxGap.toFixed(1)} ms`);
  const gapFree = await measure(true, boundary);
  check('playback: crossed the cut into the other video element', gapFree.before !== gapFree.after && new Set(gapFree.frames.map((f) => f.slot)).size === 2,
    `slot ${gapFree.before} -> ${gapFree.after}, ${gapFree.frames.length} frames`);
  check('playback: the cut shows within one frame, no gap over 100 ms', gapFree.cutGap < 40 && gapFree.maxGap < 100,
    `gap at cut ${gapFree.cutGap.toFixed(1)} ms, max ${gapFree.maxGap.toFixed(1)} ms, median ${median(gapFree.gaps).toFixed(1)} ms`);
  check('playback: timeline kept moving', gapFree.time > boundary + 0.5, `t=${gapFree.time.toFixed(2)} boundary=${boundary.toFixed(2)}`);
  // Into a different file (talk -> bars): the one-video baseline has to load the new file.
  const fileBoundary = await evaluate('window.__vcePlayback.items[2].start');
  const base2 = await measure(false, fileBoundary);
  console.log(`info  baseline, one video, file change: gap at cut ${base2.cutGap.toFixed(1)} ms, max ${base2.maxGap.toFixed(1)} ms`);
  const free2 = await measure(true, fileBoundary);
  check('playback: file change shows within one frame, no gap over 100 ms', free2.cutGap < 40 && free2.maxGap < 100,
    `gap at cut ${free2.cutGap.toFixed(1)} ms, max ${free2.maxGap.toFixed(1)} ms`);
  await shot('e2e-3-playback');

  // 6. Caption preset: Bold pop.
  await click('Captions');
  await click(/Bold pop$/);
  const s6 = await st();
  check('caption preset: Bold pop applied', s6.project.captions.style.font === 'Impact' && s6.project.captions.maxChars === 16 && s6.project.captions.style.pop);
  await evaluate("__vce.dispatch({ type: 'time', time: 3.05 })");
  await sleep(600);
  const capText = await evaluate("document.querySelector('.stage .caption')?.textContent ?? ''");
  const popWord = await evaluate("document.querySelector('.stage .caption .pop')?.textContent ?? ''");
  check('caption preset: preview shows the line with a popped word', capText.length > 0 && popWord.length > 0, `"${capText}" pop="${popWord}"`);
  await shot('e2e-4-caption-preset');

  // 7. Export dialog: Shorts preset changes the frame; the encoder is resolved; Cancel; undo restores 16:9.
  await click('Export');
  await waitFor("document.querySelector('.export-dialog') !== null");
  await click(/^Shorts · Reels · TikTok/);
  await waitFor("!document.querySelector('.export-summary').textContent.includes('checking')", 15000);
  const summary = await evaluate("document.querySelector('.export-summary').textContent");
  const s7 = await st();
  check('export preset: Shorts sets 9:16 1080×1920', s7.project.aspect === '9:16' && summary.includes('1080 × 1920'), summary);
  check('export dialog: encoder resolved', /x264|Quick Sync|NVENC|AMF/.test(summary));
  await shot('e2e-5-export-dialog');
  await click('Cancel');
  await evaluate("__vce.dispatch({ type: 'undo' })");
  check('export preset: one undo step back to 16:9', (await st()).project.aspect === '16:9');

  // 8. Settings dialog: tool check runs.
  await click('Settings');
  await waitFor("[...document.querySelectorAll('.status li')].some((li) => li.textContent.startsWith('Encoder:'))", 20000);
  const status = await evaluate("[...document.querySelectorAll('.status li')].map((li) => li.className + ': ' + li.textContent)");
  check('settings: FFmpeg, Python, encoder and model all checked', status.length === 5 && status.slice(0, 4).every((x) => x.startsWith('ok')), status.join(' | '));
  await shot('e2e-6-settings');
  await click('Close');

  return report();
}

// ---------- CDP plumbing ----------

async function connect() {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
    } catch {
      // not up yet
    }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('Electron page did not appear on the debugging port');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const waitFor = async (expression, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await evaluate(expression)) return;
      } catch {
        // page still loading
      }
      await sleep(100);
    }
    throw new Error(`timeout waiting for ${expression}`);
  };
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
  const drag = async (x0, y0, x1, y1, steps = 12) => {
    await mouse('mouseMoved', x0, y0, { button: 'none' });
    await mouse('mousePressed', x0, y0, { clickCount: 1, buttons: 1 });
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, { buttons: 1 });
      await sleep(16);
    }
    await mouse('mouseReleased', x1, y1, { clickCount: 1, buttons: 0 });
    await sleep(150);
  };
  /** Real click on the first visible button whose label matches. */
  const click = async (label) => {
    const test = label instanceof RegExp ? `new RegExp(${JSON.stringify(label.source)})` : null;
    const pos = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((el) => el.offsetParent && (${test ? `${test}.test(el.textContent.trim())` : `el.textContent.trim() === ${JSON.stringify(label)}`}));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!pos) throw new Error(`button not found: ${label}`);
    await mouse('mouseMoved', pos.x, pos.y, { button: 'none' });
    await mouse('mousePressed', pos.x, pos.y, { clickCount: 1, buttons: 1 });
    await mouse('mouseReleased', pos.x, pos.y, { clickCount: 1, buttons: 0 });
    await sleep(250);
  };
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
  };
  return { evaluate, waitFor, drag, click, shot, send };
}

// ---------- reporting ----------

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function report() {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  return failed ? 1 : 0;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}
