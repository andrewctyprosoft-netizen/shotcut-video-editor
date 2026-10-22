// Child-process helper: spawn a tool, stream its output line by line, cancel with an AbortSignal.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * Split a command string such as `py -3.11` or `"C:\My Tools\python.exe" -X utf8` into [cmd, ...args].
 * @param {string} command
 * @returns {string[]}
 */
export function splitCommand(command) {
  return [...String(command).matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

/**
 * Run a process to completion.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, env?: object, signal?: AbortSignal, capture?: boolean, onStdout?: (line: string) => void,
 *   onStderr?: (line: string) => void}} [opts] capture: keep all of stdout (default: the last 60 lines)
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} stderr holds the last 60 lines
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(abortError());
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true });
    const tails = { stdout: [], stderr: [] };
    const watch = (stream, key, cb) => {
      createInterface({ input: stream }).on('line', (line) => {
        tails[key].push(line);
        if (tails[key].length > 60 && !(key === 'stdout' && opts.capture)) tails[key].shift();
        cb?.(line);
      });
    };
    watch(child.stdout, 'stdout', opts.onStdout);
    watch(child.stderr, 'stderr', opts.onStderr);
    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err.code === 'ENOENT' ? new Error(`Cannot find "${cmd}". Check Settings.`) : err);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(abortError());
      resolve({ code: code ?? -1, stdout: tails.stdout.join('\n'), stderr: tails.stderr.join('\n') });
    });
  });
}

/**
 * Run a process and throw with its last error lines when it fails.
 * @param {string} cmd
 * @param {string[]} args
 * @param {Parameters<typeof run>[2]} [opts]
 * @returns {ReturnType<typeof run>}
 */
export async function runOk(cmd, args, opts) {
  const res = await run(cmd, args, opts);
  if (res.code !== 0) {
    // The cause is usually a few lines above FFmpeg's generic tail ("Conversion failed!"), so lead with the telling lines.
    const lines = res.stderr.split('\n').filter(Boolean);
    const telling = lines.filter((l) => /error|invalid|not match|failed|unsupported|no such|cannot|traceback/i.test(l));
    const detail = [...new Set([...telling.slice(0, 6), ...lines.slice(-4)])].join('\n');
    throw new Error(`${cmd.split(/[\\/]/).pop()} exited with code ${res.code}\n${detail}`);
  }
  return res;
}

function abortError() {
  const err = new Error('Cancelled');
  err.name = 'AbortError';
  return err;
}
