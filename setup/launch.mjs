// One-click setup and start for ShotCut on Windows, macOS and Linux.
// The launchers (ShotCut.bat, ShotCut.command, ShotCut.sh) put a portable Node.js in runtime/node and run this
// file with it. The first run installs everything else into runtime/ and node_modules/ inside the app folder:
// the app's npm packages and the Electron runtime, FFmpeg, Python with faster-whisper, and the Whisper model.
// Later runs skip what is already there, rebuild the interface (about a second) and open the window.
// Nothing is installed system-wide: deleting runtime/ and node_modules/ undoes it.
//
//   node setup/launch.mjs [project.shotcut]     set up if needed, then start
//   node setup/launch.mjs --setup-only          set up, check, do not start
//   node setup/launch.mjs --repair              redo every step (after a failed or interrupted download)

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { bundledPython } from '../electron/tools.js';

const UV_VERSION = '0.13.5';
const PYTHON_VERSION = '3.12';
const WHISPER_REPO = 'Systran/faster-whisper-small';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(appRoot, 'runtime');
const stateFile = join(runtime, 'state.json');
const lockFile = join(runtime, 'setup.lock');
const isWin = process.platform === 'win32';
const exe = isWin ? '.exe' : '';

const args = process.argv.slice(2);
const setupOnly = args.includes('--setup-only');
const repair = args.includes('--repair');
const appArgs = args.filter((a) => !a.startsWith('--'));

// Keep every download cache inside the app folder too.
const env = {
  ...process.env,
  npm_config_cache: join(runtime, 'cache', 'npm'),
  npm_config_update_notifier: 'false',
  electron_config_cache: join(runtime, 'cache', 'electron'),
  UV_CACHE_DIR: join(runtime, 'cache', 'uv'),
  UV_PYTHON_INSTALL_DIR: join(runtime, 'python'),
  HF_HUB_DISABLE_TELEMETRY: '1',
  HF_HUB_DOWNLOAD_TIMEOUT: '60',
  PYTHONUTF8: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
// npm runs install scripts with `node` from PATH: make that this (portable) Node.js.
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
env[pathKey] = [dirname(process.execPath), env[pathKey]].filter(Boolean).join(delimiter);

// Run only as the entry script, so tests can import the helpers below.
if (isEntry()) main().catch((err) => {
  console.error(`\nShotCut could not start: ${err.message}`);
  console.error('Check the internet connection and run the launcher again (it resumes where it stopped).');
  console.error('If it keeps failing, run it with --repair, or delete the "runtime" folder and try again.');
  process.exit(1);
});

async function main() {
  mkdirSync(runtime, { recursive: true });
  takeLock();
  // Python's packages nest about 140 characters deep under runtime\, and Windows will not load a DLL from a path
  // longer than 260 ("The filename or extension is too long").
  if (isWin && appRoot.length > 110) {
    console.log(`Note: this folder's path is long (${appRoot.length} characters). If auto captions fail to set up,`);
    console.log('move the ShotCut folder somewhere shorter, such as C:\\ShotCut, and start it again.');
  }
  const state = repair ? {} : readState();
  const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const warnings = [];

  // 1. The app's npm packages (React, Vite, Electron). Redone when package-lock.json changes.
  const lockHash = hashFile(join(appRoot, 'package-lock.json'));
  if (state.npm !== lockHash || !existsSync(join(appRoot, 'node_modules', 'vite', 'bin', 'vite.js'))) {
    step('Installing the app components (npm)');
    await run(process.execPath, [npmCli(), 'ci', '--no-audit', '--no-fund', '--loglevel=error'], 'npm install');
    state.npm = lockHash;
    save();
  }

  // 2. The Electron runtime. Electron 45 downloads its program on first use, not during npm install.
  if (!electronPath()) {
    step('Downloading the Electron runtime (about 100 MB)');
    await run(process.execPath, [join(appRoot, 'node_modules', 'electron', 'install.js')], 'Electron download');
    if (!electronPath()) throw new Error('the Electron runtime did not install');
  }

  // 3. Python with faster-whisper (captions) and onnxruntime (AI background removal), through uv.
  const reqHash = hashText(['asr/requirements.txt', 'vision/requirements.txt'].map((f) => readFileSync(join(appRoot, f), 'utf8')).join('\n')
    + PYTHON_VERSION);
  if (state.python !== reqHash || !bundledPython(appRoot)) {
    try {
      await setUpPython();
      state.python = reqHash;
      save();
    } catch (err) {
      warnings.push(`Python for auto captions and AI background removal could not be set up (${err.message}).`);
    }
  }

  // 4. FFmpeg and FFprobe (import, preview copies, effects, export).
  if (!existsSync(join(runtime, 'ffmpeg', `ffmpeg${exe}`)) || !existsSync(join(runtime, 'ffmpeg', `ffprobe${exe}`))) {
    try {
      await setUpFfmpeg();
    } catch (err) {
      warnings.push(`FFmpeg could not be downloaded (${err.message}); import and export need it.`);
    }
  }

  // 5. The Whisper speech model (about 480 MB), so the first transcription does not wait for a download.
  const modelDir = join(runtime, 'models', 'faster-whisper-small');
  if (bundledPython(appRoot) && !existsSync(join(modelDir, 'model.bin'))) {
    try {
      await setUpModel(modelDir);
    } catch (err) {
      warnings.push(`The Whisper model could not be downloaded (${err.message}); the first transcription will try again.`);
    }
  }

  // 6. Build the interface from the source, so the app always matches it.
  step('Building the interface');
  await run(process.execPath, [join(appRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'error'], 'interface build');

  if (process.platform === 'linux') addLinuxMenuEntry();
  releaseLock();

  if (warnings.length) {
    console.log('\nShotCut will open, but:');
    for (const w of warnings) console.log(`  - ${w}`);
    console.log('Run the launcher again later to retry.');
  }
  if (setupOnly) {
    console.log('\nSetup finished.');
    process.exit(warnings.length ? 2 : 0);
  }
  startApp();
  if (warnings.length && process.stdin.isTTY) await pause(15);
}

// ---------------------------------------------------------------- steps

async function setUpPython() {
  const uv = await getUv();
  step(`Installing Python ${PYTHON_VERSION}`);
  await run(uv, ['python', 'install', PYTHON_VERSION, '--no-bin'], 'Python install');
  const python = bundledPython(appRoot);
  if (!python) throw new Error('Python did not install');
  step('Installing faster-whisper and onnxruntime (about 300 MB)');
  await run(uv, ['pip', 'install', '--python', python, '--break-system-packages', '--no-cache',
    '-r', join(appRoot, 'asr', 'requirements.txt'), '-r', join(appRoot, 'vision', 'requirements.txt')], 'Python packages');
  await run(python, ['-c', 'import faster_whisper, onnxruntime, numpy, PIL'], 'Python package check');
  rmSync(join(runtime, 'cache', 'uv'), { recursive: true, force: true });
}

/** uv, a single-file Python manager, downloaded and checked against its published SHA-256. */
async function getUv() {
  const dir = join(runtime, 'uv');
  const uv = join(dir, `uv${exe}`);
  if (existsSync(uv)) return uv;
  const triple = {
    'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
    'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu',
  }[`${process.platform}-${process.arch}`];
  if (!triple) throw new Error(`no uv build for ${process.platform} ${process.arch}`);
  const name = `uv-${triple}${isWin ? '.zip' : '.tar.gz'}`;
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${name}`;
  step(`Downloading uv ${UV_VERSION} (Python installer)`);
  const file = await download(url, join(runtime, 'downloads', name), await publishedHash(`${url}.sha256`, name));
  mkdirSync(dir, { recursive: true });
  if (isWin) {
    unzip(file, (entry) => (basename(entry) === 'uv.exe' ? uv : null));
  } else {
    await run('tar', ['-xzf', file, '-C', dir, '--strip-components=1'], 'uv unpack');
    chmodSync(uv, 0o755);
  }
  unlinkSync(file);
  return uv;
}

async function setUpFfmpeg() {
  const dir = join(runtime, 'ffmpeg');
  const downloads = join(runtime, 'downloads');
  mkdirSync(dir, { recursive: true });
  const pick = (entry) => (/^(ffmpeg|ffprobe)(\.exe)?$/.test(basename(entry)) && !entry.startsWith('__MACOSX') ? join(dir, basename(entry)) : null);
  if (isWin) {
    // BtbN's GPL builds: static, with libx264, libvpx and libass.
    const arch = process.arch === 'arm64' ? 'winarm64' : 'win64';
    const { url, name, sha } = await btbnBuild(arch);
    step(`Downloading FFmpeg (${name}, about 200 MB)`);
    const file = await download(url, join(downloads, name), sha);
    unzip(file, pick);
    unlinkSync(file);
  } else {
    // Martin Riedl's static builds for macOS and Linux (release channel), one zip per program.
    const os = process.platform === 'darwin' ? 'macos' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    for (const prog of ['ffmpeg', 'ffprobe']) {
      const res = await fetchOk(`https://ffmpeg.martin-riedl.de/redirect/latest/${os}/${arch}/release/${prog}.zip`, { method: 'GET' });
      res.body?.cancel();
      step(`Downloading ${prog} (${res.url.split('/').slice(-2, -1)[0].replace(/^\d+_/, 'version ')})`);
      const file = await download(res.url, join(downloads, `${prog}.zip`), await publishedHash(`${res.url}.sha256`, `${prog}.zip`));
      unzip(file, pick);
      unlinkSync(file);
    }
  }
  for (const prog of ['ffmpeg', 'ffprobe']) {
    const path = join(dir, `${prog}${exe}`);
    if (!existsSync(path)) throw new Error(`${prog} was not in the download`);
    if (process.platform === 'darwin') await adHocSignIfNeeded(path);
    await run(path, ['-hide_banner', '-version'], `${prog} check`, { quiet: true });
  }
}

/** The newest numbered BtbN release build (e.g. ffmpeg-n8.1-latest-win64-gpl-8.1.zip) with its SHA-256. */
export async function btbnBuild(arch) {
  const base = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';
  const sums = await (await fetchOk(`${base}/checksums.sha256`)).text();
  const builds = [...sums.matchAll(new RegExp(`^([0-9a-f]{64})\\s+\\*?(ffmpeg-n(\\d+)\\.(\\d+)-latest-${arch}-gpl-[\\d.]+\\.zip)$`, 'gm'))]
    .map((m) => ({ sha: m[1], name: m[2], v: Number(m[3]) * 1000 + Number(m[4]) }))
    .sort((a, b) => b.v - a.v);
  const build = builds[0] ?? (() => {
    const name = `ffmpeg-master-latest-${arch}-gpl.zip`;
    const m = new RegExp(`^([0-9a-f]{64})\\s+\\*?${name.replace(/\./g, '\\.')}$`, 'm').exec(sums);
    if (!m) throw new Error(`no FFmpeg build for ${arch}`);
    return { sha: m[1], name };
  })();
  return { ...build, url: `${base}/${build.name}` };
}

async function setUpModel(modelDir) {
  step('Downloading the Whisper speech model (about 480 MB, once)');
  const code = [
    'import sys',
    'from huggingface_hub import snapshot_download',
    `snapshot_download('${WHISPER_REPO}', local_dir=sys.argv[1],`,
    "  allow_patterns=['config.json', 'preprocessor_config.json', 'model.bin', 'tokenizer.json', 'vocabulary.*'])",
  ].join('\n');
  await run(bundledPython(appRoot), ['-c', code, modelDir], 'model download');
  if (!existsSync(join(modelDir, 'model.bin'))) throw new Error('model.bin is missing');
}

function startApp() {
  const electron = electronPath();
  const flags = [];
  // Ubuntu 23.10+ and others block the user namespaces Chromium's sandbox needs; the SUID helper inside
  // node_modules is not set up either, so Electron would exit at once.
  if (process.platform === 'linux' && linuxNeedsNoSandbox(electron)) flags.push('--no-sandbox');
  step('Starting ShotCut');
  const child = spawn(electron, [...flags, '.', ...appArgs], { cwd: appRoot, env, detached: true, stdio: 'ignore' });
  child.unref();
}

function addLinuxMenuEntry() {
  const dir = join(homedir(), '.local', 'share', 'applications');
  const file = join(dir, 'shotcut-caption-editor.desktop');
  const launcher = join(appRoot, 'ShotCut.sh');
  const entry = [
    '[Desktop Entry]', 'Type=Application', 'Name=ShotCut', 'Comment=Video editor with auto captions',
    `Exec=bash "${launcher}" %f`, `Path=${appRoot}`, 'Icon=video-x-generic', 'Terminal=true', 'Categories=AudioVideo;Video;', '',
  ].join('\n');
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === entry) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, entry);
    console.log('Added ShotCut to the applications menu.');
  } catch {
    // no menu entry; the launcher still works
  }
}

// ---------------------------------------------------------------- helpers

/** Path of the Electron program, or null when it is not downloaded yet. */
function electronPath() {
  try {
    const path = createRequire(join(appRoot, 'package.json'))('electron');
    return typeof path === 'string' && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/** npm's CLI script next to this Node.js (portable or installed). */
function npmCli() {
  const bin = dirname(process.execPath);
  const candidates = [join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('npm was not found next to Node.js; delete runtime/node and run the launcher again');
  return found;
}

function linuxNeedsNoSandbox(electron) {
  const read = (p) => {
    try {
      return readFileSync(p, 'utf8').trim();
    } catch {
      return null;
    }
  };
  const helper = join(dirname(electron), 'chrome-sandbox');
  let suid = false;
  try {
    const st = statSync(helper);
    suid = st.uid === 0 && (st.mode & 0o4000) !== 0;
  } catch {
    // no helper
  }
  if (suid) return false;
  return read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1'
    || read('/proc/sys/kernel/unprivileged_userns_clone') === '0'
    || read('/proc/sys/user/max_user_namespaces') === '0';
}

/** macOS on Apple silicon refuses unsigned programs; give a downloaded one an ad-hoc signature if it does not run. */
async function adHocSignIfNeeded(path) {
  chmodSync(path, 0o755);
  try {
    await run(path, ['-hide_banner', '-version'], basename(path), { quiet: true });
  } catch {
    await run('codesign', ['--force', '--sign', '-', path], 'codesign', { quiet: true });
  }
}

/**
 * Run a program with the console attached; rejects with `what` when it fails.
 * @param {string} cmd
 * @param {string[]} argv
 * @param {string} what
 * @param {{quiet?: boolean}} [opts]
 * @returns {Promise<void>}
 */
function run(cmd, argv, what, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd: appRoot, env, stdio: opts.quiet ? 'ignore' : 'inherit', windowsHide: true });
    child.on('error', (err) => reject(new Error(`${what}: ${err.message}`)));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${what} failed (exit code ${code})`))));
  });
}

async function fetchOk(url, init) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', ...init, headers: { 'user-agent': 'ShotCut-launcher', ...init?.headers } });
      if (res.ok) return res;
      last = new Error(`${url} answered ${res.status}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      last = new Error(`${url}: ${err.cause?.message ?? err.message}`);
    }
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  throw last;
}

/** The SHA-256 in a published checksum file ("<hash>  <name>", or the bare hash). */
export async function publishedHash(url, name) {
  const text = await (await fetchOk(url)).text();
  const line = text.split(/\r?\n/).find((l) => l.includes(name)) ?? text;
  const m = /\b([0-9a-f]{64})\b/i.exec(line);
  if (!m) throw new Error(`no checksum in ${url}`);
  return m[1].toLowerCase();
}

/**
 * Download to `dest` through a .part file, showing progress, and check the SHA-256.
 * A .part file left by an interrupted run is resumed (HTTP Range); a connection silent for 60 s is dropped and retried.
 * @param {string} url
 * @param {string} dest
 * @param {string} sha256
 * @returns {Promise<string>} dest
 */
export async function download(url, dest, sha256) {
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const abort = new AbortController();
    let timer = null;
    const stallGuard = () => {
      clearTimeout(timer);
      timer = setTimeout(() => abort.abort(new Error('no data for 60 s')), 60_000);
    };
    try {
      const have = existsSync(part) ? statSync(part).size : 0;
      stallGuard();
      const res = await fetchOk(url, { signal: abort.signal, headers: have ? { range: `bytes=${have}-` } : {} });
      const resumed = have > 0 && res.status === 206;
      const hash = createHash('sha256');
      if (resumed) await pipeline(createReadStream(part), async function* (src) { for await (const c of src) hash.update(c); });
      let got = resumed ? have : 0;
      const total = (Number(res.headers.get('content-length')) || 0) + (resumed ? have : 0);
      let shown = -1;
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        stallGuard();
        hash.update(chunk);
        got += chunk.length;
        const pct = total ? Math.floor((got / total) * 100) : Math.floor(got / 1e7);
        if (pct !== shown && process.stdout.isTTY) {
          shown = pct;
          process.stdout.write(`\r  ${(got / 1e6).toFixed(0)} MB${total ? ` of ${(total / 1e6).toFixed(0)} MB (${pct}%)` : ''}   `);
        }
      });
      await pipeline(body, createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
      clearTimeout(timer);
      if (process.stdout.isTTY) process.stdout.write('\n');
      if (hash.digest('hex') !== sha256) {
        rmSync(part, { force: true });
        throw new Error(`${basename(dest)} is damaged (checksum mismatch)`);
      }
      renameSync(part, dest);
      return dest;
    } catch (err) {
      clearTimeout(timer);
      lastError = abort.signal.aborted ? abort.signal.reason : err;
      if (process.stdout.isTTY) process.stdout.write('\n');
      if (attempt < 5) console.log(`  Download interrupted (${lastError.message}), resuming...`);
    }
  }
  throw lastError;
}

/**
 * Extract the entries of a zip file that `pick` maps to a destination path (stored or deflated entries).
 * Executables keep their exec bit on macOS and Linux.
 * @param {string} file
 * @param {(entry: string) => string|null} pick
 */
export function unzip(file, pick) {
  const buf = readFileSync(file);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error(`${basename(file)} is not a zip file`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${basename(file)}: damaged zip directory`);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const target = name.endsWith('/') ? null : pick(name);
    if (!target) continue;
    if (size === 0xffffffff || local === 0xffffffff) throw new Error(`${basename(file)}: zip64 entries are not supported`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error(`${basename(file)}: unsupported compression in ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, method === 0 ? data : inflateRawSync(data));
    if (!isWin) chmodSync(target, 0o755);
  }
}

/** True when this file is the script Node was started with (paths compared after resolving links and subst drives). */
function isEntry() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
}

function step(text) {
  console.log(`\n> ${text}...`);
}

/** One setup at a time: a second double-click while the first run is still downloading just says so. */
function takeLock() {
  try {
    writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
  } catch {
    const pid = Number(readFileSync(lockFile, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = pid !== process.pid;
    } catch {
      // stale lock from a run that was closed
    }
    if (alive) {
      console.log('ShotCut is already being set up in another window. Let that one finish.');
      process.exit(0);
    }
    writeFileSync(lockFile, String(process.pid));
  }
  process.on('exit', releaseLock);
}

function releaseLock() {
  try {
    if (readFileSync(lockFile, 'utf8') === String(process.pid)) unlinkSync(lockFile);
  } catch {
    // already gone
  }
}

function pause(seconds) {
  return new Promise((r) => setTimeout(r, seconds * 1000));
}
