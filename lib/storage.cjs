'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_PROJECT_BYTES = 8 * 1024 * 1024;
const SOURCE_TYPES = new Set(['screen', 'camera', 'phone-camera', 'image', 'video', 'text', 'color', 'browser', 'guest-board']);
const PRESETS = new Set(['1280x720', '1920x1080', '720x1280', '1080x1920']);

function validateProject(project) {
  const fail = message => { throw new TypeError(`Invalid studio project: ${message}`); };
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const string = (value, maximum) => typeof value === 'string' && value.length <= maximum;
  const finite = (value, minimum, maximum) => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
  const ids = new Set();
  const checkId = id => {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || ids.has(id.toLowerCase())) fail('scene and source IDs must be unique UUID-shaped strings.');
    ids.add(id.toLowerCase());
  };
  if (!object(project) || project.version !== 1) fail('version 1 is required.');
  if (!Array.isArray(project.scenes) || project.scenes.length < 1 || project.scenes.length > 64) fail('use 1–64 scenes.');
  let totalSources = 0;
  for (const scene of project.scenes) {
    if (!object(scene) || !string(scene.name, 2000)) fail('each scene needs a name.');
    checkId(scene.id);
    if (!Array.isArray(scene.sources) || scene.sources.length > 256) fail('a scene can contain up to 256 sources.');
    totalSources += scene.sources.length;
    if (totalSources > 1024) fail('use at most 1024 sources in a project.');
    for (const source of scene.sources) {
      if (!object(source) || !SOURCE_TYPES.has(source.type) || !string(source.name, 2000)) fail('invalid source type or name.');
      checkId(source.id);
      if (!finite(source.x, -10000, 10000) || !finite(source.y, -10000, 10000) ||
        !finite(source.width, 1, 10000) || !finite(source.height, 1, 10000) || !finite(source.opacity, 0, 1)) fail('invalid source geometry or opacity.');
      if (typeof source.visible !== 'boolean' || typeof source.locked !== 'boolean') fail('source visible and locked must be booleans.');
      if ('fontSize' in source && !finite(source.fontSize, 8, 400)) fail('fontSize must be between 8 and 400.');
      if ('color' in source && (typeof source.color !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(source.color))) fail('colors must be hex colors.');
      if ('text' in source && !string(source.text, 50000)) fail('source text is too long.');
      if ('path' in source && !string(source.path, 32767)) fail('invalid media path.');
      if ('loop' in source && typeof source.loop !== 'boolean') fail('loop must be a boolean.');
      if (source.type === 'browser') {
        let url;
        try { url = new URL(source.url); } catch { fail('browser sources need a valid website URL.'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || source.url.length > 8192) fail('browser sources require HTTP or HTTPS without embedded credentials.');
      }
    }
  }
  if (!project.scenes.some(scene => scene.id === project.activeSceneId)) fail('activeSceneId must name an existing scene.');
  const settings = project.settings;
  if (!object(settings) || !PRESETS.has(`${settings.width}x${settings.height}`) ||
    typeof settings.width !== 'number' || typeof settings.height !== 'number' ||
    ![24, 30, 60].includes(settings.fps) || ![1500000, 3000000, 6000000, 9000000].includes(settings.bitrate)) fail('choose supported canvas, frame-rate, and bitrate presets.');
  if (!string(project.notes, 50000)) fail('notes must be a string of up to 50000 characters.');
  return project;
}

function encodeProject(project) {
  validateProject(project);
  const text = JSON.stringify(project, null, 2);
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_PROJECT_BYTES) {
    throw new Error('The project exceeds the 8 MiB limit.');
  }
  const decoded = JSON.parse(text);
  validateProject(decoded);
  return Buffer.from(`${text}\n`);
}

async function readProject(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_PROJECT_BYTES + 1) throw new Error('Invalid project file.');
    const project = JSON.parse(await handle.readFile('utf8'));
    encodeProject(project);
    return project;
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Windows does not provide directory fsync through Node. File fsync still applies.
    if (!['EPERM', 'EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function atomicWrite(file, bytes) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  let committed = false;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    // Never unlink the destination: if replacement is denied (e.g. antivirus lock),
    // the previous committed file remains intact and the caller receives a failure.
    await fs.rename(temporary, file);
    committed = true;
    await syncDirectory(directory);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!committed) await fs.unlink(temporary).catch(() => {});
  }
}

class ProjectStore {
  constructor(directory, log = () => {}) {
    this.file = path.join(directory, 'project.json');
    this.backup = `${this.file}.bak`;
    this.tail = Promise.resolve();
    this.log = log;
  }

  async load() {
    await this.tail;
    for (const file of [this.file, this.backup]) {
      try {
        return await readProject(file);
      } catch (error) {
        if (error.code !== 'ENOENT') this.log('project-load', { file: path.basename(file), message: error.message });
      }
    }
    return null;
  }

  save(project) {
    // Snapshot now so caller mutation cannot alter a queued save.
    const bytes = encodeProject(project);
    const operation = this.tail.then(async () => {
      let previous;
      try {
        previous = await readProject(this.file);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          // A corrupt primary must never replace the last valid backup.
          if (['EACCES', 'EPERM', 'ENOSPC', 'EIO'].includes(error.code)) throw error;
          this.log('project-invalid-primary', { message: error.message });
        }
      }
      if (previous) await atomicWrite(this.backup, encodeProject(previous));
      await atomicWrite(this.file, bytes);
      return true;
    });
    this.tail = operation.catch(error => this.log('project-save', { message: error.message }));
    return operation;
  }

  idle() { return this.tail; }
}

function createLogger(directory) {
  const file = path.join(directory, 'studio.log');
  let tail = Promise.resolve();
  const log = (event, details = {}) => {
    tail = tail.then(async () => {
      await fs.mkdir(directory, { recursive: true });
      const stat = await fs.stat(file).catch(() => null);
      if (stat && stat.size > 2 * 1024 * 1024) {
        await fs.rename(file, `${file}.previous`).catch(() => {});
      }
      await fs.appendFile(file, `${JSON.stringify({ time: new Date().toISOString(), event, ...details })}\n`, { mode: 0o600 });
    }).catch(() => {});
  };
  log.idle = () => tail;
  return log;
}

module.exports = { ProjectStore, atomicWrite, encodeProject, readProject, validateProject, syncDirectory, createLogger, MAX_PROJECT_BYTES };
