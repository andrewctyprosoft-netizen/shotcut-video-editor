// Shared harness for the end-to-end checks: launch Electron on a project with a DevTools port, drive
// it over the Chrome DevTools Protocol with real mouse input, and report PASS/FAIL lines.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import electronPath from 'electron';
import { outDir, root } from './sampleProject.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

/**
 * Open `projectFile` in the real app, run `scenario(cdp)`, quit, and exit with 0 when every check passed.
 * @param {string} projectFile
 * @param {(cdp: Awaited<ReturnType<typeof connect>>) => Promise<void>} scenario
 * @param {number} [port]
 */
export async function runE2E(projectFile, scenario, port = 9339) {
  const child = spawn(electronPath, ['.', projectFile, `--remote-debugging-port=${port}`], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
  let exitCode = 1;
  try {
    const cdp = await connect(port);
    await scenario(cdp);
    exitCode = report();
  } catch (err) {
    console.error(err);
  } finally {
    child.kill();
  }
  process.exit(exitCode);
}

/**
 * Record one check.
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
export function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function report() {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  return failed ? 1 : 0;
}

/**
 * Connect to the app page on the DevTools port.
 * @param {number} port
 */
export async function connect(port) {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
  const drag = async (x0, y0, x1, y1, steps = 12, modifiers = 0) => {
    await mouse('mouseMoved', x0, y0, { button: 'none', modifiers });
    await mouse('mousePressed', x0, y0, { clickCount: 1, buttons: 1, modifiers });
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, { buttons: 1, modifiers });
      await sleep(16);
    }
    await mouse('mouseReleased', x1, y1, { clickCount: 1, buttons: 0, modifiers });
    await sleep(150);
  };
  /** Real click at a point; `modifiers` 2 = Ctrl. */
  const clickAt = async (x, y, modifiers = 0) => {
    await mouse('mouseMoved', x, y, { button: 'none', modifiers });
    await mouse('mousePressed', x, y, { clickCount: 1, buttons: 1, modifiers });
    await mouse('mouseReleased', x, y, { clickCount: 1, buttons: 0, modifiers });
    await sleep(200);
  };
  /** Real click on the first visible button whose label matches. */
  const click = async (label) => {
    const test = label instanceof RegExp ? `new RegExp(${JSON.stringify(label.source)})` : null;
    const pos = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((el) => el.offsetParent && (${test ? `${test}.test(el.textContent.trim())` : `el.textContent.trim() === ${JSON.stringify(label)}`}));
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!pos) throw new Error(`button not found: ${label}`);
    await clickAt(pos.x, pos.y);
    await sleep(50);
  };
  /** Centre and edges of the first element matching a CSS selector. */
  const rect = (sel) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })()`);
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
  };
  return { evaluate, waitFor, drag, click, clickAt, rect, shot, send };
}
