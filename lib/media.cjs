'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');

const MEDIA = Object.freeze({
  '.png': ['image', 'image/png'], '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'], '.webp': ['image', 'image/webp'],
  '.gif': ['image', 'image/gif'], '.bmp': ['image', 'image/bmp'],
  '.avif': ['image', 'image/avif'], '.mp4': ['video', 'video/mp4'],
  '.webm': ['video', 'video/webm'], '.m4v': ['video', 'video/mp4'],
  '.mov': ['video', 'video/quicktime'], '.ogv': ['video', 'video/ogg']
});

function localPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) return false;
  if (/^(?:\\\\|\/\/)/.test(value)) return false; // Includes UNC and Windows device paths.
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':'))) return false;
  return true;
}

function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end, partial: true };
}

class MediaRegistry {
  constructor() {
    this.byId = new Map();
    this.byPath = new Map();
  }

  async register(input, expectedKind) {
    if (!localPath(input)) return null;
    let canonical;
    let stat;
    try {
      canonical = await fs.realpath(input);
      if (!localPath(canonical)) return null;
      stat = await fs.stat(canonical);
    } catch { return null; }
    const format = MEDIA[path.extname(canonical).toLowerCase()];
    if (!format || !stat.isFile() || stat.size === 0 || (expectedKind && expectedKind !== format[0])) return null;
    let entry = this.byPath.get(canonical);
    if (!entry) {
      const id = randomUUID();
      entry = { id, name: path.basename(canonical), path: canonical, type: format[0], mime: format[1], url: `studio-media://asset/${id}` };
      this.byId.set(id, entry);
      this.byPath.set(canonical, entry);
    }
    return { name: entry.name, path: entry.path, url: entry.url, type: entry.type };
  }

  async contains(input) {
    if (!localPath(input)) return false;
    try {
      const canonical = await fs.realpath(input);
      if (!this.byPath.has(canonical)) return false;
      return Boolean(await this.register(canonical));
    } catch { return false; }
  }

  async respond(request) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const url = new URL(request.url);
    const match = /^\/([a-f0-9-]{36})$/.exec(url.pathname);
    const entry = url.protocol === 'studio-media:' && url.hostname === 'asset' && !url.search && !url.hash && match && this.byId.get(match[1]);
    if (!entry) return new Response(null, { status: 404 });
    let handle;
    try {
      // Revalidate each access; a persisted path alone never grants a protocol URL.
      if (!await this.register(entry.path, entry.type)) return new Response(null, { status: 404 });
      handle = await fs.open(entry.path, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Not a regular media file.');
      const range = parseRange(request.headers.get('range'), stat.size);
      if (!range) {
        await handle.close();
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
      }
      const headers = {
        'Content-Type': entry.mime, 'Accept-Ranges': 'bytes',
        'Content-Length': String(Math.max(0, range.end - range.start + 1)),
        'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      };
      if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
      if (request.method === 'HEAD' || stat.size === 0) {
        await handle.close();
        return new Response(null, { status: range.partial ? 206 : 200, headers });
      }
      const stream = handle.createReadStream({ start: range.start, end: range.end, autoClose: true });
      return new Response(Readable.toWeb(stream), { status: range.partial ? 206 : 200, headers });
    } catch {
      if (handle) await handle.close().catch(() => {});
      return new Response(null, { status: 404 });
    }
  }
}

module.exports = { MediaRegistry, MEDIA, localPath, parseRange };
