'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { syncDirectory } = require('./storage.cjs');

const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function metadata(file, stat) {
  return { name: path.basename(file), path: file, size: stat.size, modified: stat.mtime.toISOString() };
}

class RecordingStore {
  constructor(directory, log = () => {}) {
    this.directory = path.resolve(directory);
    this.sessions = new Map();
    this.starting = false;
    this.waiters = new Set();
    this.log = log;
  }

  get active() { return this.sessions.size > 0 || this.starting; }

  async start({ mimeType } = {}) {
    if (this.active) throw new Error('A recording is already in progress.');
    if (typeof mimeType !== 'string' || !/^video\/webm(?:\s*;\s*codecs\s*=\s*[a-z0-9., "-]+)?$/i.test(mimeType) || mimeType.length > 200) {
      throw new TypeError('Recording requires a video/webm MIME type.');
    }
    this.starting = true;
    let startDone;
    this.startReady = new Promise(resolve => { startDone = resolve; });
    try {
      await fs.mkdir(this.directory, { recursive: true });
      const id = randomUUID();
      const stem = `Recording-${timestamp()}-${id}`;
      const partial = path.join(this.directory, `${stem}.partial.webm`);
      const final = path.join(this.directory, `${stem}.webm`);
      const handle = await fs.open(partial, 'wx', 0o600);
      this.sessions.set(id, { id, partial, final, handle, tail: Promise.resolve(), queued: 0, written: 0, closing: false, error: null });
      return { id };
    } finally {
      this.starting = false;
      startDone();
      this.notifyIdle();
    }
  }

  write({ id, bytes } = {}) {
    const session = this.sessions.get(id);
    if (!session || session.closing) throw new Error('The recording session is not writable.');
    if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) throw new TypeError('Recording bytes must be an ArrayBuffer.');
    if (bytes.byteLength > MAX_CHUNK_BYTES) throw new Error('Recording chunks must not exceed 16 MiB.');
    if (session.queued + bytes.byteLength > MAX_QUEUED_BYTES) throw new Error('Recording queue is full. Await recordingWrite before sending more data.');
    const buffer = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    session.queued += buffer.length;
    const operation = session.tail.then(async () => {
      if (session.error) throw session.error;
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await session.handle.write(buffer, offset, buffer.length - offset);
        if (!bytesWritten) throw new Error('The recording disk stopped accepting data.');
        offset += bytesWritten;
        session.written += bytesWritten;
      }
      return true;
    });
    session.tail = operation.catch(error => { session.error ||= error; }).finally(() => { session.queued -= buffer.length; });
    return operation;
  }

  async finish({ id } = {}) {
    const session = this.sessions.get(id);
    if (!session || session.closing) throw new Error('The recording session is not open.');
    session.closing = true;
    try {
      await session.tail;
      if (session.error) throw session.error;
      if (!session.written) throw new Error('No recording data was received.');
      await session.handle.sync();
      await session.handle.close();
      session.handle = null;
      // Hard-link commit is atomic and fails on collision, unlike rename which can
      // overwrite. Keep the partial intact if the filesystem cannot commit safely.
      await fs.link(session.partial, session.final);
      await syncDirectory(this.directory);
      await fs.unlink(session.partial).catch(error => this.log('partial-cleanup', { message: error.message }));
      return metadata(session.final, await fs.stat(session.final));
    } finally {
      await this.release(session);
    }
  }

  async cancel({ id } = {}) {
    const session = this.sessions.get(id);
    if (!session) return true;
    if (session.closing) throw new Error('The recording is already being closed.');
    session.closing = true;
    await session.tail;
    await this.release(session);
    return true;
  }

  async release(session) {
    if (session.handle) {
      await session.handle.sync().catch(error => this.log('recording-sync', { message: error.message }));
      await session.handle.close().catch(error => this.log('recording-close', { message: error.message }));
      session.handle = null;
    }
    if (!session.written) await fs.unlink(session.partial).catch(() => {});
    this.sessions.delete(session.id);
    this.notifyIdle();
  }

  async cancelAll() {
    if (this.starting) await this.startReady;
    await Promise.allSettled([...this.sessions.values()].map(session => session.closing ? session.tail : this.cancel({ id: session.id })));
    if (this.active) await this.waitForIdle(10000);
  }

  waitForIdle(timeoutMs = 12000) {
    if (!this.active) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = value => { clearTimeout(timer); this.waiters.delete(done); resolve(value); };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.waiters.add(done);
    });
  }

  notifyIdle() { if (!this.active) for (const done of [...this.waiters]) done(true); }

  async list() {
    await fs.mkdir(this.directory, { recursive: true });
    const activePaths = new Set([...this.sessions.values()].map(item => item.partial));
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^Recording-[a-z0-9.-]+\.webm$/i.test(entry.name)) continue;
      const file = path.join(this.directory, entry.name);
      if (activePaths.has(file)) continue;
      const stat = await fs.lstat(file).catch(() => null);
      if (stat && stat.isFile() && stat.size > 0) records.push(metadata(file, stat));
    }
    return records.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async contains(file) {
    if (typeof file !== 'string' || path.dirname(path.resolve(file)) !== this.directory) return false;
    return (await this.list()).some(record => record.path === path.resolve(file));
  }
}

module.exports = { RecordingStore, MAX_CHUNK_BYTES, MAX_QUEUED_BYTES, metadata };
