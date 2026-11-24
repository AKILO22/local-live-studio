'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { MediaRegistry } = require('../lib/media.cjs');
const { createOnlineServices, normalizeWebURL, allowedWebResource, fitWebSize, LIMITS } = require('../lib/online.cjs');

const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function event(properties = {}) {
  return { ...properties, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-online-test-'));
  t.after(async () => {
    // Only remove this test's verified mkdtemp directory.
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('studio-online-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
function setup(t, overrides = {}) {
  const windows = [], sessions = [], sent = [], requests = [];
  let enabled = true, blocked = 0, mainAlive = true;
  class FakeContents extends EventEmitter {
    isDestroyed() { return this.destroyed === true; }
    setAudioMuted(value) { this.muted = value; }
    setFrameRate(value) { this.fps = value; }
    setZoomFactor(value) { this.zoom = value; }
    setWebRTCIPHandlingPolicy(value) { this.rtc = value; }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    stopPainting() { this.paintStopped = true; }
    stop() { this.loadStopped = true; }
  }
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new FakeContents(); windows.push(this);
    }
    loadURL(url) { this.loaded = url; return overrides.load ? overrides.load(this, url) : Promise.resolve(); }
    isDestroyed() { return this.destroyed === true; }
    destroy() {
      this.destroyCount = (this.destroyCount || 0) + 1;
      this.destroyed = true; this.webContents.destroyed = true;
      this.webContents.emit('destroyed'); this.emit('closed');
    }
  }
  const session = {
    fromPartition(partition, options) {
      const ses = new EventEmitter();
      Object.assign(ses, {
        partition, options,
        webRequest: { onBeforeRequest(filter, handler) { ses.filter = filter; ses.policy = handler; } },
        setPermissionRequestHandler(handler) { this.permissionRequest = handler; },
        setPermissionCheckHandler(handler) { this.permissionCheck = handler; },
        setDevicePermissionHandler(handler) { this.devicePermission = handler; },
        setDisplayMediaRequestHandler(handler) { this.displayMedia = handler; },
        closeAllConnections() { this.connectionsClosed = true; return Promise.resolve(); },
        clearStorageData() { this.storageCleared = true; return Promise.resolve(); },
        clearCache() { this.cacheCleared = true; return Promise.resolve(); },
        clearAuthCache() { this.authCleared = true; return Promise.resolve(); },
        fetch(url, options) {
          requests.push({ url, options, session: this });
          return overrides.fetch ? overrides.fetch(url, options, this) : Promise.resolve(new Response('ok'));
        }
      });
      sessions.push(ses);
      return ses;
    }
  };
  const main = {
    isDestroyed: () => !mainAlive,
    webContents: { isDestroyed: () => !mainAlive, send: (channel, payload) => sent.push({ channel, payload }) }
  };
  const services = createOnlineServices({
    BrowserWindow: FakeWindow, session, dataDir: overrides.dataDir || os.tmpdir(),
    media: overrides.media || new MediaRegistry(), getWindow: () => mainAlive ? main : null,
    isEnabled: () => enabled, onBlocked: () => { blocked++; }
  });
  t.after(() => services.disconnect());
  return {
    services, windows, sessions, sent, requests,
    setEnabled: value => { enabled = value; }, setMainAlive: value => { mainAlive = value; },
    get blocked() { return blocked; }
  };
}
function policy(ses, url, resourceType = 'image') {
  let result;
  ses.policy({ url, resourceType }, response => { result = response.cancel; });
  return result;
}
function image(width, height, marker = 'full frame') {
  return {
    encodes: 0,
    getSize: () => ({ width, height }),
    toPNG(options) { assert.equal(options.scaleFactor, 1); this.encodes++; return Buffer.from(marker); }
  };
}
function streamResponse(chunks, headers = {}, status = 200) {
  const state = { reads: 0, cancelled: false };
  const response = new Response(new ReadableStream({
    pull(controller) {
      state.reads++;
      if (chunks.length) controller.enqueue(Uint8Array.from(chunks.shift()));
      else controller.close();
    },
    cancel() { state.cancelled = true; }
  }, { highWaterMark: 0 }), { status, headers });
  return { response, state };
}
async function cachedFiles(root) {
  try { return await fs.readdir(path.join(root, 'downloads')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

test('URL validation only accepts explicit HTTP(S) without credentials and never echoes secrets', () => {
  assert.equal(normalizeWebURL(' HTTPS://Example.COM:443/a?q=secret#frame '), 'https://example.com/a?q=secret#frame');
  assert.equal(normalizeWebURL('http://[::1]:8080/'), 'http://[::1]:8080/');
  const invalid = [null, {}, '', '//example.com', 'example.com', 'file:///C:/private.png',
    'studio-media://asset/x', 'data:text/html,x', 'javascript:alert(1)', 'ftp://example.com',
    'https://user:secret@example.com/?token=secret', 'https://@example.com/',
    'https://example.com\n/secret', 'https://example.com\\secret', 'https://', 'https://' + 'x'.repeat(17000)];
  for (const input of invalid) assert.throws(() => normalizeWebURL(input), error => !error.message.includes('secret'));
});

test('web resource policy permits online network and self-contained assets, never local protocols', () => {
  const safe = ['https://example.com/', 'http://127.0.0.1/', 'ws://example.com/live', 'wss://example.com/live',
    'data:image/png;base64,AA==', 'blob:https://example.com/abc', 'about:blank'];
  for (const url of safe) { assert.equal(allowedWebResource(url, true), true, url); assert.equal(allowedWebResource(url, false), false, url); }
  for (const url of ['file:///C:/app/index.html', 'studio-media://asset/x', 'blob:file:///C:/secret',
    'blob:studio-media://asset/x', 'devtools://page', 'chrome://settings', 'ftp://example.com/',
    'javascript:alert(1)', 'https://user:secret@example.com/', 'not a url']) {
    assert.equal(allowedWebResource(url, true), false, url);
  }
});

test('source dimensions preserve aspect while fitting side and pixel bounds', () => {
  assert.deepEqual(fitWebSize(), { width: 1280, height: 720 });
  assert.deepEqual(fitWebSize(3840, 2160), { width: 1920, height: 1080 });
  assert.deepEqual(fitWebSize(1920, 1920), { width: 1440, height: 1440 });
  assert.deepEqual(fitWebSize(1, 1), { width: 1, height: 1 });
  assert.deepEqual(fitWebSize(1e308, 1e308), { width: 1440, height: 1440 });
  for (const [width, height] of [[4000, 3000], [3000, 4000], [800, 1900]]) {
    const fit = fitWebSize(width, height);
    assert.ok(fit.width <= 1920 && fit.height <= 1920 && fit.width * fit.height <= LIMITS.pixels);
    assert.ok(Math.abs(fit.width / fit.height - width / height) < 0.002);
  }
  for (const value of [0, -1, NaN, Infinity, null, '1280']) assert.throws(() => fitWebSize(value, 720));
});

test('browser sources use sandboxed offscreen windows, unique memory sessions and all-denied permissions', async t => {
  const h = setup(t);
  const id = randomUUID();
  assert.deepEqual(await h.services.startWebSource({ id, url: 'https://example.com/', width: 3840, height: 2160 }), { id });
  const win = h.windows[0], ses = h.sessions[0], preferences = win.options.webPreferences;
  for (const key of ['show', 'frame', 'resizable', 'fullscreenable']) assert.equal(win.options[key], false);
  for (const key of ['useContentSize', 'transparent']) assert.equal(win.options[key], true);
  for (const key of ['sandbox', 'contextIsolation', 'webSecurity']) assert.equal(preferences[key], true);
  for (const key of ['nodeIntegration', 'nodeIntegrationInWorker', 'nodeIntegrationInSubFrames', 'webviewTag',
    'allowRunningInsecureContent', 'backgroundThrottling', 'devTools', 'plugins', 'spellcheck', 'navigateOnDragDrop']) assert.equal(preferences[key], false);
  assert.equal(Object.hasOwn(preferences, 'preload'), false);
  assert.equal(Object.hasOwn(preferences, 'partition'), false);
  assert.equal(preferences.session, ses);
  assert.deepEqual(preferences.offscreen, { useSharedTexture: false, deviceScaleFactor: 1 });
  assert.equal(preferences.autoplayPolicy, 'no-user-gesture-required');
  assert.equal(preferences.disableDialogs, true);
  assert.equal(ses.partition.startsWith('persist:'), false);
  assert.deepEqual(ses.options, { cache: false });
  assert.equal(win.options.width, 1920); assert.equal(win.options.height, 1080);
  assert.equal(win.webContents.muted, true); assert.equal(win.webContents.fps, 8);
  assert.equal(ses.permissionCheck(), false); assert.equal(ses.devicePermission(), false);
  let permission, capture;
  ses.permissionRequest(null, 'media', result => { permission = result; });
  ses.displayMedia({}, result => { capture = result; });
  assert.equal(permission, false); assert.deepEqual(capture, {});
  assert.deepEqual(win.webContents.openHandler({ url: 'https://example.com/' }), { action: 'deny' });
  const download = event(); ses.emit('will-download', download); assert.equal(download.defaultPrevented, true);
  let action;
  ses.emit('file-system-access-restricted', event(), {}, result => { action = result; });
  assert.equal(action, 'deny');
  assert.ok(h.sent.some(item => item.payload.id === id && item.payload.status === 'loading'));
  assert.ok(h.sent.some(item => item.payload.id === id && item.payload.status === 'ready'));
  await h.services.startWebSource({ id: randomUUID(), url: 'https://example.org/' });
  assert.notEqual(h.sessions[0].partition, h.sessions[1].partition);
});

test('request and navigation handlers block local files, app media, popups and unsafe redirects', async t => {
  const h = setup(t);
  await h.services.startWebSource({ id: randomUUID(), url: 'https://example.com/' });
  const ses = h.sessions[0], contents = h.windows[0].webContents;
  for (const url of ['https://example.com/', 'wss://example.com/socket']) assert.equal(policy(ses, url), false);
  for (const url of ['file:///C:/app/index.html', 'studio-media://asset/x', 'ftp://example.com/', 'blob:file:///C:/secret']) {
    assert.equal(policy(ses, url), true);
  }
  assert.equal(policy(ses, 'data:text/html,hello', 'subFrame'), true);
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    for (const url of ['file:///C:/secret', 'studio-media://asset/x', 'javascript:alert(1)', 'https://u:p@example.com/']) {
      const navigation = event({ url }); contents.emit(name, navigation); assert.equal(navigation.defaultPrevented, true);
    }
    const safe = event({ url: 'https://example.org/' }); contents.emit(name, safe); assert.equal(safe.defaultPrevented, false);
  }
  const legacy = event(); contents.emit('will-redirect', legacy, 'file:///secret'); assert.equal(legacy.defaultPrevented, true);
  const resize = event(); contents.emit('content-bounds-updated', resize); assert.equal(resize.defaultPrevented, true);
  h.setEnabled(false);
  assert.equal(policy(ses, 'https://example.com/'), true);
  assert.equal(h.windows[0].destroyed, true);
  h.setEnabled(true);
  assert.equal(policy(ses, 'https://example.com/'), true, 'retired sessions cannot restart network activity');
  assert.ok(h.blocked > 0);
});

test('four-source bound, replacement, stopAll and crash cleanup release browser resources', async t => {
  const h = setup(t);
  const ids = Array.from({ length: 4 }, randomUUID);
  for (const id of ids) await h.services.startWebSource({ id, url: 'https://example.com/' });
  await assert.rejects(h.services.startWebSource({ id: randomUUID(), url: 'https://example.com/' }), /four browser sources/);
  const old = h.windows[0], oldSession = h.sessions[0];
  await h.services.startWebSource({ id: ids[0], url: 'https://example.org/' });
  assert.equal(old.destroyCount, 1);
  assert.equal(old.webContents.eventNames().length, 0);
  assert.equal(old.webContents.paintStopped, true); assert.equal(old.webContents.loadStopped, true);
  assert.equal(oldSession.connectionsClosed, true); assert.equal(oldSession.storageCleared, true);
  assert.equal(h.services.stopWebSource(ids[1]), true); assert.equal(h.services.stopWebSource(ids[1]), false);
  h.windows[2].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(h.windows[2].destroyed, true);
  assert.ok(h.sent.some(item => item.payload.id === ids[2] && item.payload.status === 'error'));
  h.services.stopAll();
  assert.ok(h.windows.every(win => win.destroyed));
  assert.ok(h.windows.every(win => win.destroyCount === 1));
  assert.ok(h.sessions.every(ses => policy(ses, 'https://example.com/') === true));
});

test('stopping or replacing a loading source rejects promptly even when loadURL never settles', async t => {
  const h = setup(t, { load: () => new Promise(() => {}) });
  const id = randomUUID();
  const first = h.services.startWebSource({ id, url: 'https://example.com/' });
  const firstRejected = assert.rejects(first, /stopped/);
  const second = h.services.startWebSource({ id, url: 'https://example.org/' });
  const secondRejected = assert.rejects(second, /stopped/);
  h.services.stopAll();
  await Promise.all([firstRejected, secondRejected]);
  assert.ok(h.windows.every(win => win.destroyed));
});

test('browser errors are safe and offline calls do not create sessions or windows', async t => {
  const h = setup(t, { load: () => Promise.reject(new Error('https://secret.test/?token=private-value')) });
  await assert.rejects(h.services.startWebSource({ id: randomUUID(), url: 'https://example.com/?token=private-value' }),
    error => /could not load/.test(error.message) && !error.message.includes('private-value'));
  assert.ok(h.sent.every(item => !item.payload.message?.includes('private-value')));
  assert.equal(h.windows[0].destroyed, true);
  h.setEnabled(false);
  await assert.rejects(h.services.startWebSource({ id: randomUUID(), url: 'https://example.com/' }), /Online features are off/);
  await assert.rejects(h.services.importMedia({ url: 'https://example.com/file.png', kind: 'image' }), /Online features are off/);
  assert.deepEqual(await h.services.checkConnection(), { ok: false, message: 'Online features are off. Enable internet access to continue.' });
  assert.equal(h.windows.length, 1); assert.equal(h.sessions.length, 1); assert.equal(h.requests.length, 0);
});

test('paint sends full PNGs at at most eight fps, keeping only the latest pending frame and cancelling its timer', async t => {
  const h = setup(t);
  const id = randomUUID();
  await h.services.startWebSource({ id, url: 'https://example.com/', width: 320, height: 180 });
  const contents = h.windows[0].webContents;
  const full = image(320, 180, 'whole target');
  contents.emit('paint', {}, { x: 20, y: 30, width: 1, height: 1 }, full);
  const frames = () => h.sent.filter(item => item.channel === 'studio:web-frame');
  assert.equal(frames().length, 1); assert.ok(frames()[0].payload.png instanceof Uint8Array);
  assert.equal(Buffer.from(frames()[0].payload.png).toString(), 'whole target');
  const stale = image(320, 180, 'stale'), latest = image(320, 180, 'latest');
  for (let index = 0; index < 25; index++) contents.emit('paint', {}, {}, stale);
  contents.emit('paint', {}, {}, latest);
  assert.equal(frames().length, 1); assert.equal(stale.encodes, 0);
  await new Promise(resolve => setTimeout(resolve, 145));
  assert.equal(frames().length, 2); assert.equal(stale.encodes, 0); assert.equal(latest.encodes, 1);
  assert.equal(Buffer.from(frames()[1].payload.png).toString(), 'latest');
  contents.emit('paint', {}, {}, latest);
  h.services.stopWebSource(id);
  await new Promise(resolve => setTimeout(resolve, 145));
  assert.equal(frames().length, 2, 'stopped source has no pending frame timer');
});

test('paint rejects incomplete target images and tolerates a closed main window', async t => {
  const h = setup(t);
  await h.services.startWebSource({ id: randomUUID(), url: 'https://example.com/', width: 320, height: 180 });
  const contents = h.windows[0].webContents;
  contents.emit('paint', {}, {}, image(10, 10));
  assert.equal(h.sent.filter(item => item.channel === 'studio:web-frame').length, 0);
  h.setMainAlive(false);
  assert.doesNotThrow(() => contents.emit('paint', {}, {}, image(320, 180)));
  h.services.disconnect();
});

test('media import streams to an exclusive cache file, follows relative redirects, and registers only after closing', async t => {
  const root = await directory(t);
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
  const final = streamResponse([bytes.subarray(0, 4), bytes.subarray(4)], { 'Content-Type': 'image/png; charset=binary', 'Content-Length': String(bytes.length) });
  const redirected = streamResponse([], { Location: '/final.png' }, 302);
  const registry = new MediaRegistry(); let registered = 0;
  const h = setup(t, { dataDir: root,
    fetch: url => Promise.resolve(url.endsWith('/start') ? redirected.response : final.response),
    media: { async register(file, kind) {
      registered++;
      assert.deepEqual(await fs.readFile(file), bytes);
      assert.equal(kind, 'image');
      return registry.register(file, kind);
    } }
  });
  assert.equal(h.requests.length, 0, 'there are no background connection checks');
  const imported = await h.services.importMedia({ url: 'https://example.com/start', kind: 'image' });
  assert.equal(imported.type, 'image'); assert.equal(imported.path, path.join(root, 'downloads', imported.name));
  assert.match(imported.name, /^[a-f\d-]{36}\.png$/); assert.match(imported.url, /^studio-media:\/\/asset\//);
  assert.equal(registered, 1); assert.deepEqual(await fs.readFile(imported.path), bytes);
  assert.deepEqual(h.requests.map(request => request.url), ['https://example.com/start', 'https://example.com/final.png']);
  assert.equal(redirected.state.cancelled, true);
  for (const request of h.requests) {
    assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.redirect, 'manual');
    assert.equal(request.options.cache, 'no-store'); assert.equal(request.options.bypassCustomProtocolHandlers, true);
    assert.ok(request.options.signal instanceof AbortSignal);
  }
});

test('media MIME validation refuses HTML even with an image extension and accepts only known generic extension fallbacks', async t => {
  const root = await directory(t);
  for (const [url, mime, kind, allowed] of [
    ['file.png', 'text/html', 'image', false], ['file.png', 'image/svg+xml', 'image', false],
    ['file.mp4', 'video/mp4', 'image', false], ['file.bin', 'application/octet-stream', 'image', false],
    ['file.png', 'application/octet-stream', 'image', true], ['file.webp', '', 'image', true],
    ['file.mp4', 'video/mp4', 'video', true], ['not-a-file', 'image/jpeg', 'image', true]
  ]) {
    const response = new Response('media bytes', { headers: mime ? { 'Content-Type': mime } : {} });
    // A string body supplies text/plain automatically; delete it to exercise absent MIME.
    if (!mime) response.headers.delete('content-type');
    const h = setup(t, { dataDir: root, fetch: () => Promise.resolve(response) });
    const operation = h.services.importMedia({ url: `https://example.com/${url}`, kind });
    if (allowed) assert.equal((await operation).type, kind);
    else await assert.rejects(operation, /supported .* file/);
  }
  assert.equal((await cachedFiles(root)).length, 4);
});

test('media size bounds validate headers and remove partial writes on truncated, oversized, empty and broken streams', async t => {
  const root = await directory(t);
  const cases = [
    () => new Response('x', { headers: { 'content-type': 'image/png', 'content-length': String(LIMITS.downloadBytes + 1) } }),
    () => new Response('x', { headers: { 'content-type': 'image/png', 'content-length': 'bogus' } }),
    () => new Response('abc', { headers: { 'content-type': 'image/png', 'content-length': '4' } }),
    () => new Response('abc', { headers: { 'content-type': 'image/png', 'content-length': '2' } }),
    () => new Response(null, { headers: { 'content-type': 'image/png' } }),
    () => new Response('', { headers: { 'content-type': 'image/png', 'content-length': '0' } }),
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('secret URL query')); } }), { headers: { 'content-type': 'image/png' } }),
    () => new Response('x', { status: 206, headers: { 'content-type': 'image/png' } }),
    () => new Response('x', { status: 404, headers: { 'content-type': 'image/png' } })
  ];
  for (const make of cases) {
    const h = setup(t, { dataDir: root, fetch: () => Promise.resolve(make()) });
    await assert.rejects(h.services.importMedia({ url: 'https://example.com/file.png', kind: 'image' }),
      error => !error.message.includes('secret'));
    assert.deepEqual(await cachedFiles(root), []);
  }
});

test('media registration or disk failures clean up without leaking network errors', async t => {
  const root = await directory(t);
  const response = () => Promise.resolve(new Response('bytes', { headers: { 'content-type': 'image/png' } }));
  const h = setup(t, { dataDir: root, fetch: response, media: { register: async () => null } });
  await assert.rejects(h.services.importMedia({ url: 'https://example.com/file.png', kind: 'image' }), /could not be imported/);
  assert.deepEqual(await cachedFiles(root), []);
  await fs.rmdir(path.join(root, 'downloads'));
  await fs.writeFile(path.join(root, 'downloads'), 'sentinel');
  const disk = setup(t, { dataDir: root, fetch: response });
  await assert.rejects(disk.services.importMedia({ url: 'https://example.com/file.png', kind: 'image' }), /could not be downloaded or saved/);
  assert.equal(await fs.readFile(path.join(root, 'downloads'), 'utf8'), 'sentinel');
});

test('redirects validate every destination and stop after five hops', async t => {
  for (const location of ['file:///C:/private.png', 'studio-media://asset/id', 'https://user:private@example.com/file.png']) {
    const h = setup(t, { fetch: () => Promise.resolve(new Response(null, { status: 302, headers: { location } })) });
    await assert.rejects(h.services.importMedia({ url: 'https://example.com/file.png', kind: 'image' }),
      error => /unsupported address/.test(error.message) && !error.message.includes('private'));
    assert.equal(h.requests.length, 1);
  }
  const h = setup(t, { fetch: () => Promise.resolve(new Response(null, { status: 302, headers: { location: '/again.png' } })) });
  await assert.rejects(h.services.importMedia({ url: 'https://example.com/file.png', kind: 'image' }), /five/);
  assert.equal(h.requests.length, 6, 'initial GET plus at most five redirected GETs');
});

test('disconnect aborts pending fetches synchronously, isolates transfer sessions, and allows a later reconnect', async t => {
  const root = await directory(t);
  const waiting = deferred();
  let first = true;
  const h = setup(t, { dataDir: root, fetch: () => {
    if (first) { first = false; return waiting.promise; }
    return Promise.resolve(new Response('bytes', { headers: { 'content-type': 'image/png' } }));
  } });
  const pending = h.services.importMedia({ url: 'https://example.com/file.png', kind: 'image' });
  const rejected = assert.rejects(pending, /Online features are off/);
  const signal = h.requests[0].options.signal;
  h.services.disconnect();
  assert.equal(signal.aborted, true);
  assert.equal(h.sessions[0].connectionsClosed, true);
  assert.equal(policy(h.sessions[0], 'https://example.com/'), true);
  await rejected;
  const late = streamResponse([[1]], { 'content-type': 'image/png' }); waiting.resolve(late.response); await turn();
  assert.equal(late.state.cancelled, true, 'a response arriving after abort is cancelled');
  const entry = await h.services.importMedia({ url: 'https://example.com/file.png', kind: 'image' });
  assert.equal(entry.type, 'image'); assert.notEqual(h.sessions[0].partition, h.sessions[1].partition);
});

test('disconnect cancels a stalled reader and removes its partially written file', async t => {
  const root = await directory(t);
  let count = 0, cancelled = false;
  const reading = deferred();
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (!count++) controller.enqueue(Uint8Array.from([1, 2, 3]));
      else reading.resolve();
    },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'image/png' } });
  const h = setup(t, { dataDir: root, fetch: () => Promise.resolve(response) });
  const operation = h.services.importMedia({ url: 'https://example.com/file.png', kind: 'image' });
  const rejected = assert.rejects(operation, /Online features are off/);
  await reading.promise;
  assert.equal((await cachedFiles(root)).length, 1);
  h.setEnabled(false); h.services.disconnect();
  assert.equal(cancelled, true);
  await rejected;
  assert.deepEqual(await cachedFiles(root), []);
});

test('offline state changes are detected without new requests or incoming stream chunks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = setup(t, { fetch: () => new Promise(() => {}) });
  await h.services.startWebSource({ id: randomUUID(), url: 'https://example.com/' });
  const operation = h.services.importMedia({ url: 'https://example.com/file.png', kind: 'image' });
  const rejected = assert.rejects(operation, /Online features are off/);
  h.setEnabled(false); t.mock.timers.tick(LIMITS.offlinePollMs);
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.windows[0].destroyed, true);
  await rejected;
});

test('download timeout and two-import concurrency bound abort cleanly', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = setup(t, { fetch: () => new Promise(() => {}) });
  const first = h.services.importMedia({ url: 'https://example.com/1.png', kind: 'image' });
  const second = h.services.importMedia({ url: 'https://example.com/2.png', kind: 'image' });
  const rejected = [assert.rejects(first, /120 seconds/), assert.rejects(second, /120 seconds/)];
  await assert.rejects(h.services.importMedia({ url: 'https://example.com/3.png', kind: 'image' }), /Two media imports/);
  t.mock.timers.tick(LIMITS.downloadMs);
  assert.ok(h.requests.every(request => request.options.signal.aborted));
  await Promise.all(rejected);
});

test('browser loading timeout destroys the pending window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = setup(t, { load: () => new Promise(() => {}) });
  const operation = h.services.startWebSource({ id: randomUUID(), url: 'https://example.com/' });
  const rejected = assert.rejects(operation, /too long/);
  t.mock.timers.tick(LIMITS.loadMs);
  await rejected; assert.equal(h.windows[0].destroyed, true);
});

test('manual connection check uses a small bounded GET and cancels the remaining body', async t => {
  let cancelled = false, reads = 0;
  const response = new Response(new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(4096)); },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 }));
  const h = setup(t, { fetch: () => Promise.resolve(response) });
  assert.equal(h.requests.length, 0); assert.equal(h.sessions.length, 0);
  assert.deepEqual(await h.services.checkConnection(), { ok: true, status: 200, message: 'Internet connection verified' });
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].url, 'https://example.com/');
  assert.equal(h.requests[0].options.method, 'GET'); assert.equal(h.requests[0].options.credentials, 'omit');
  assert.equal(reads, 4); assert.equal(cancelled, true);
});

test('connection checks time out, reject duplicates and sanitize failures', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = setup(t, { fetch: () => new Promise(() => {}) });
  const pending = h.services.checkConnection();
  assert.deepEqual(await h.services.checkConnection(), { ok: false, message: 'A connection check is already running.' });
  t.mock.timers.tick(LIMITS.connectionMs);
  assert.deepEqual(await pending, { ok: false, message: 'The connection check timed out after 10 seconds.' });
  assert.equal(h.requests[0].options.signal.aborted, true);
  const failing = setup(t, { fetch: () => Promise.reject(new Error('https://secret.test/?token=private')) });
  const result = await failing.services.checkConnection();
  assert.equal(result.ok, false); assert.equal(result.message.includes('private'), false);
  const http = setup(t, { fetch: () => Promise.resolve(new Response(null, { status: 503 })) });
  assert.deepEqual(await http.services.checkConnection(), { ok: false, message: 'The connection check returned HTTP 503.' });
});
