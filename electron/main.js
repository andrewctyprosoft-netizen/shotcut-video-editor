// Electron main process: window, media:// protocol, dialogs and background jobs (proxy, transcribe, align, export).

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_EXTENSIONS } from '../core/media.js';
import { alignTranscript, transcribe } from './asr.js';
import { runExport } from './export.js';
import { makeProxy, probe } from './media.js';
import { allowMedia, handleMediaProtocol, registerMediaScheme } from './mediaProtocol.js';
import {
  loadSettings, resetPythonCache, resolveEncoder, resolveFfmpeg, resolveModel, resolvePython, saveSettings, toolStatus,
} from './tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const asrDir = join(appRoot, 'asr');
const PROJECT_FILTER = { name: 'ShotCut project', extensions: ['shotcut'] };

registerMediaScheme();

let win = null;
let settings = null;
const settingsFile = () => join(app.getPath('userData'), 'settings.json');
const jobs = new Map();
let jobSeq = 0;

app.whenReady().then(() => {
  settings = loadSettings(settingsFile());
  handleMediaProtocol();
  createWindow();
});
app.on('window-all-closed', () => app.quit());

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#15161a',
    title: 'ShotCut',
    autoHideMenuBar: true,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.env.VCE_DEV_URL) win.loadURL(process.env.VCE_DEV_URL);
  else win.loadFile(join(appRoot, 'build', 'renderer', 'index.html'));
  if (process.env.VCE_SMOKE) runSmoke();
  else openFromCommandLine();
}

/** `ShotCut.exe project.shotcut` (or `electron . project.shotcut`) opens that project. */
function openFromCommandLine() {
  const file = process.argv.slice(1).find((a) => a.toLowerCase().endsWith('.shotcut'));
  if (!file) return;
  win.webContents.once('did-finish-load', () => {
    try {
      win.webContents.send('project:loaded', { ...readProject(file), time: 0 });
    } catch (err) {
      dialog.showErrorBox('Cannot open project', err.message);
    }
  });
}

// ---------- IPC: settings, tools, dialogs ----------

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, next) => {
  settings = saveSettings(settingsFile(), { ...settings, ...next });
  resetPythonCache();
  return settings;
});
ipcMain.handle('tools:status', () => toolStatus(settings, appRoot));

ipcMain.handle('media:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import media',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video and audio', extensions: MEDIA_EXTENSIONS }],
  });
  if (res.canceled) return [];
  const { ffprobe } = resolveFfmpeg(settings, appRoot);
  const out = [];
  for (const path of res.filePaths) {
    try {
      out.push(await probe(ffprobe, path));
      allowMedia(path);
    } catch (err) {
      out.push({ path, error: err.message });
    }
  }
  return out;
});

ipcMain.handle('project:open', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Open project', properties: ['openFile'], filters: [PROJECT_FILTER] });
  if (res.canceled) return null;
  return readProject(res.filePaths[0]);
});

ipcMain.handle('project:save', async (_e, { project, filePath, saveAs }) => {
  let target = filePath;
  if (!target || saveAs) {
    const res = await dialog.showSaveDialog(win, { title: 'Save project', defaultPath: filePath || 'Untitled.shotcut', filters: [PROJECT_FILTER] });
    if (res.canceled) return null;
    target = res.filePath;
  }
  writeFileSync(target, JSON.stringify(project, null, 1), 'utf8');
  return target;
});

ipcMain.handle('transcript:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Clean transcript (one caption per line)',
    properties: ['openFile'],
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  return res.canceled ? null : readFileSync(res.filePaths[0], 'utf8');
});

ipcMain.handle('captions:saveSrt', async (_e, { text, name }) => {
  const res = await dialog.showSaveDialog(win, { title: 'Save captions', defaultPath: name || 'captions.srt', filters: [{ name: 'SubRip', extensions: ['srt'] }] });
  if (res.canceled) return null;
  writeFileSync(res.filePath, text, 'utf8');
  return res.filePath;
});

ipcMain.handle('export:pick', async (_e, { name }) => {
  const res = await dialog.showSaveDialog(win, { title: 'Export video', defaultPath: name || 'export.mp4', filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('shell:showItem', (_e, path) => shell.showItemInFolder(path));
ipcMain.handle('export:encoder', () => resolveEncoder(settings, resolveFfmpeg(settings, appRoot).ffmpeg));

// ---------- IPC: jobs ----------

const JOBS = {
  async proxy({ mediaId, info }, signal, progress) {
    const { ffmpeg } = resolveFfmpeg(settings, appRoot);
    const proxyPath = await makeProxy(ffmpeg, info, join(app.getPath('userData'), 'proxies'), { signal, onProgress: progress });
    allowMedia(proxyPath);
    return { mediaId, proxyPath };
  },
  async transcribe({ mediaId, path }, signal, progress, workDir) {
    const python = await resolvePython(settings);
    if (!python.ok) throw new Error(python.error);
    const words = await transcribe({
      python: python.command,
      asrDir,
      workDir,
      media: path,
      model: resolveModel(settings, appRoot),
      language: settings.language,
      signal,
      onProgress: progress,
    });
    return { mediaId, words };
  },
  async align({ mediaId, text, words }, signal, _progress, workDir) {
    const python = await resolvePython(settings);
    if (!python.ok) throw new Error(python.error);
    return { mediaId, words: await alignTranscript({ python: python.command, asrDir, workDir, text, words, signal }) };
  },
  async export({ project, output }, signal, progress, workDir) {
    const { ffmpeg } = resolveFfmpeg(settings, appRoot);
    const encoder = await resolveEncoder(settings, ffmpeg);
    return { ...(await runExport({ ffmpeg, project, output, workDir, encoder, signal, onProgress: progress })), encoder };
  },
};

ipcMain.handle('job:start', (e, { kind, label, payload }) => {
  const fn = JOBS[kind];
  if (!fn) throw new Error(`unknown job ${kind}`);
  const id = `job_${++jobSeq}`;
  const ctrl = new AbortController();
  const workDir = join(app.getPath('userData'), 'jobs', id);
  jobs.set(id, ctrl);
  const send = (patch) => {
    if (!e.sender.isDestroyed()) e.sender.send('job:update', { id, kind, label, ...patch });
  };
  let last = 0;
  const progress = (fraction, detail) => {
    const now = Date.now();
    if (now - last < 120) return;
    last = now;
    send({ status: 'running', progress: fraction, detail });
  };
  send({ status: 'running', progress: 0 });
  fn(payload, ctrl.signal, progress, workDir)
    .then((result) => {
      rmSync(workDir, { recursive: true, force: true });
      send({ status: 'done', progress: 1, result });
    })
    .catch((err) => send({ status: err.name === 'AbortError' ? 'cancelled' : 'error', error: err.message }))
    .finally(() => jobs.delete(id));
  return id;
});

ipcMain.handle('job:cancel', (_e, id) => jobs.get(id)?.abort());

// ---------- helpers ----------

function readProject(filePath) {
  const project = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!project || typeof project !== 'object' || !project.media || !Array.isArray(project.clips)) {
    throw new Error(`${basename(filePath)} is not a ShotCut project.`);
  }
  for (const m of Object.values(project.media)) {
    allowMedia(m.path);
    allowMedia(m.proxyPath);
  }
  return { project, filePath };
}

/** Dev check: VCE_SMOKE=<project> opens it, VCE_SMOKE_SHOT=<png> saves a screenshot, then the app quits. */
function runSmoke() {
  const wc = win.webContents;
  wc.on('console-message', (event) => console.log(`[renderer] ${event.message}`));
  wc.once('did-finish-load', async () => {
    const loaded = readProject(process.env.VCE_SMOKE);
    wc.send('project:loaded', { ...loaded, time: Number(process.env.VCE_SMOKE_TIME ?? 0) });
    await new Promise((r) => setTimeout(r, 500));
    // VCE_SMOKE_CLICK="Transcript,Captions" clicks those buttons (by label) before the screenshot.
    for (const label of (process.env.VCE_SMOKE_CLICK ?? '').split(',').filter(Boolean)) {
      await wc.executeJavaScript(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`);
    }
    await new Promise((r) => setTimeout(r, Number(process.env.VCE_SMOKE_WAIT ?? 3000)));
    if (process.env.VCE_SMOKE_SHOT) {
      const image = await wc.capturePage();
      mkdirSync(dirname(process.env.VCE_SMOKE_SHOT), { recursive: true });
      writeFileSync(process.env.VCE_SMOKE_SHOT, image.toPNG());
      console.log(`screenshot: ${process.env.VCE_SMOKE_SHOT}`);
    }
    app.quit();
  });
}
