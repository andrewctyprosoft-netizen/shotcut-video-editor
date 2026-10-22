// media:// protocol: serves local media files to the renderer with HTTP range support (needed for seeking).
// Only files the user picked, opened through a project, or proxies the app made are served.

import { createReadStream, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
};
const allowed = new Set();

const key = (p) => {
  const abs = resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
};

/** Allow the renderer to load this file. */
export function allowMedia(path) {
  if (path) allowed.add(key(path));
}

/** Must run before app `ready`. */
export function registerMediaScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

/** Install the handler (after app `ready`). URLs look like media://file/<encodeURIComponent(path)>. */
export function handleMediaProtocol() {
  protocol.handle('media', (request) => {
    const path = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (!allowed.has(key(path))) return new Response('Forbidden', { status: 403 });
    let size;
    try {
      size = statSync(path).size;
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') ?? '');
    if (!m) {
      return new Response(Readable.toWeb(createReadStream(path)), {
        headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
      });
    }
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, Math.min(start, size - 1));
    end = Math.min(end, size - 1);
    return new Response(Readable.toWeb(createReadStream(path, { start, end })), {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
      },
    });
  });
}
