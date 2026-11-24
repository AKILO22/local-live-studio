'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { randomUUID, createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { ProjectStore, encodeProject, readProject, validateProject, atomicWrite } = require('../lib/storage.cjs');
const { RecordingStore, MAX_CHUNK_BYTES } = require('../lib/recordings.cjs');
const { MediaRegistry, parseRange, localPath } = require('../lib/media.cjs');
const { LocalAccess, allowedResource, installOfflinePolicy } = require('../lib/security.cjs');
const { packageOptions, ignoreFile, launcherText, checkOutput, localElectronZip } = require('../scripts/package.cjs');

const ROOT = path.resolve(__dirname, '..');
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-live-test-'));
  t.after(async () => {
    // The exact mkdtemp directory is the only recursive cleanup target.
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('local-live-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
function project(notes = '') {
  const sceneId = randomUUID();
  return {
    version: 1, activeSceneId: sceneId,
    scenes: [{ id: sceneId, name: 'Scene', sources: [{ id: randomUUID(), type: 'text', name: 'Title', x: -15.5, y: 12, width: 640, height: 360, opacity: 0.75, visible: true, locked: false, text: 'Local studio', color: '#eafff8', fontSize: 52 }] }],
    settings: { width: 1280, height: 720, fps: 30, bitrate: 3000000 }, notes
  };
}
const arrayBuffer = text => Uint8Array.from(Buffer.from(text)).buffer;

test('renderer default project validates without changing scene/source scalar values', async () => {
  const renderer = await fs.readFile(path.join(ROOT, 'renderer.js'), 'utf8');
  const start = renderer.indexOf('function layer(');
  const end = renderer.indexOf('function currentScene(');
  assert.ok(start >= 0 && end > start);
  const original = vm.runInNewContext(`${renderer.slice(start, end)}\nJSON.stringify(defaultProject());`, { crypto: { randomUUID } });
  assert.equal(JSON.stringify(JSON.parse(encodeProject(JSON.parse(original)))), original);
});

test('schema rejects malformed projects and unsupported/scalar settings without coercion', () => {
  const changes = [
    p => { p.version = 2; }, p => { p.scenes = []; },
    p => { p.scenes = Array.from({ length: 65 }, () => p.scenes[0]); },
    p => { p.activeSceneId = randomUUID(); },
    p => { p.scenes[0].sources[0].id = p.scenes[0].id; },
    p => { p.scenes[0].sources[0].id = 'not-an-id'; },
    p => { p.scenes[0].sources[0].type = 'browser'; },
    p => { p.scenes[0].sources[0].x = Infinity; },
    p => { p.scenes[0].sources[0].y = -10001; },
    p => { p.scenes[0].sources[0].width = 0; },
    p => { p.scenes[0].sources[0].height = 10001; },
    p => { p.scenes[0].sources[0].opacity = 1.01; },
    p => { p.scenes[0].sources[0].visible = 'true'; },
    p => { p.scenes[0].sources[0].fontSize = 401; },
    p => { p.scenes[0].sources[0].color = 'red'; },
    p => { p.scenes[0].sources[0].path = {}; },
    p => { p.scenes[0].sources[0].loop = 1; },
    p => { p.settings.width = '1280'; }, p => { p.settings.height = 721; },
    p => { p.settings.fps = 25; }, p => { p.settings.bitrate = 1; },
    p => { p.notes = 'x'.repeat(50001); }
  ];
  assert.throws(() => encodeProject({}), /version 1/);
  for (const change of changes) {
    const value = project(); change(value);
    assert.throws(() => encodeProject(value), /Invalid studio project/);
  }
  const valid = project('notes');
  Object.assign(valid.scenes[0].sources[0], { path: 'C:\\old-machine\\missing.mp4', loop: false });
  const original = JSON.stringify(valid);
  assert.equal(validateProject(valid), valid);
  assert.equal(JSON.stringify(JSON.parse(encodeProject(valid))), original);
});

test('project saves serialize, snapshot input, and recover the last good backup', async t => {
  const root = await directory(t);
  const store = new ProjectStore(root);
  const first = project('first');
  const second = project('second');
  const last = project('last');
  const expectedLast = structuredClone(last);
  const pending = [store.save(first), store.save(second), store.save(last)];
  last.notes = 'caller mutated';
  assert.deepEqual(await Promise.all(pending), [true, true, true]);
  assert.deepEqual(await store.load(), expectedLast);
  assert.deepEqual(await readProject(store.backup), second);
  await fs.writeFile(store.file, '{}');
  assert.deepEqual(await store.load(), second);
  await store.save(first);
  assert.deepEqual(await readProject(store.backup), second);
  await fs.unlink(store.file);
  assert.deepEqual(await store.load(), second);
  assert.throws(() => store.save({}), /Invalid studio project/);
  assert.deepEqual(await fs.readdir(root), ['project.json.bak']);
});

test('a denied atomic replacement leaves the existing destination intact', async t => {
  const root = await directory(t);
  const destination = path.join(root, 'existing-directory');
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'keep'), 'unchanged');
  await assert.rejects(atomicWrite(destination, Buffer.from('replacement')));
  assert.equal(await fs.readFile(path.join(destination, 'keep'), 'utf8'), 'unchanged');
  assert.deepEqual(await fs.readdir(root), ['existing-directory']);
});

test('recording writes preserve order, finish drains writes, and finalization does not overwrite', async t => {
  const root = await directory(t);
  const store = new RecordingStore(root);
  const { id } = await store.start({ mimeType: 'video/webm;codecs=vp9,opus' });
  await assert.rejects(store.start({ mimeType: 'video/webm' }), /already/);
  const mutable = new Uint8Array(arrayBuffer('first-'));
  const first = store.write({ id, bytes: mutable });
  mutable.fill(0);
  const second = store.write({ id, bytes: arrayBuffer('second') });
  assert.deepEqual(await store.list(), []);
  const finishing = store.finish({ id });
  assert.throws(() => store.write({ id, bytes: arrayBuffer('late') }), /not writable/);
  const [, , saved] = await Promise.all([first, second, finishing]);
  assert.equal(await fs.readFile(saved.path, 'utf8'), 'first-second');
  assert.equal(saved.size, 12);
  assert.ok(Number.isFinite(Date.parse(saved.modified)));
  assert.equal(store.active, false);
  assert.deepEqual((await store.list()).map(item => item.name), [saved.name]);

  const next = await store.start({ mimeType: 'video/webm' });
  await store.write({ id: next.id, bytes: arrayBuffer('new data') });
  const collision = store.sessions.get(next.id).final;
  await fs.writeFile(collision, 'existing recording');
  await assert.rejects(store.finish(next), error => error.code === 'EEXIST');
  assert.equal(await fs.readFile(collision, 'utf8'), 'existing recording');
  assert.ok((await store.list()).some(item => item.name.endsWith('.partial.webm')));
});

test('cancel retains nonempty recoverable partials, discards empty files, and rejects large chunks', async t => {
  const root = await directory(t);
  const store = new RecordingStore(root);
  await assert.rejects(store.start({ mimeType: 'video/mp4' }), /video\/webm/);
  const empty = await store.start({ mimeType: 'video/webm' });
  assert.throws(() => store.write({ id: empty.id, bytes: new ArrayBuffer(MAX_CHUNK_BYTES + 1) }), /16 MiB/);
  await store.cancel(empty);
  assert.deepEqual(await fs.readdir(root), []);
  const partial = await store.start({ mimeType: 'video/webm' });
  const writing = store.write({ id: partial.id, bytes: arrayBuffer('recoverable') });
  const cancelling = store.cancel(partial);
  await Promise.all([writing, cancelling]);
  const recovered = await new RecordingStore(root).list();
  assert.equal(recovered.length, 1);
  assert.ok(recovered[0].name.endsWith('.partial.webm'));
  assert.equal(await fs.readFile(recovered[0].path, 'utf8'), 'recoverable');
  assert.equal(await store.contains(path.join(root, '..', 'other.webm')), false);
  assert.equal(await store.contains(recovered[0].path), true);
});

test('disk write failure is reported and later writes cannot silently succeed', async t => {
  const root = await directory(t);
  const store = new RecordingStore(root);
  const { id } = await store.start({ mimeType: 'video/webm' });
  const handle = store.sessions.get(id).handle;
  const originalWrite = handle.write.bind(handle);
  await store.write({ id, bytes: arrayBuffer('header') });
  handle.write = async () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); };
  await assert.rejects(store.write({ id, bytes: arrayBuffer('chunk') }), /Disk full/);
  await assert.rejects(store.write({ id, bytes: arrayBuffer('later') }), /Disk full/);
  await assert.rejects(store.finish({ id }), /Disk full/);
  handle.write = originalWrite;
  assert.equal(store.active, false);
  assert.equal((await store.list())[0].size, 6);
});

test('media mapping is local and opaque, supports seeking, and survives re-registration', async t => {
  const root = await directory(t);
  const file = path.join(root, 'original.webm');
  await fs.writeFile(file, '0123456789');
  const registry = new MediaRegistry();
  const selected = await registry.register(file, 'video');
  assert.equal(selected.type, 'video');
  assert.match(selected.url, /^studio-media:\/\/asset\/[a-f0-9-]{36}$/);
  assert.ok(!selected.url.includes('original'));
  assert.deepEqual(await registry.register(file), selected);
  assert.equal(await registry.register(file, 'image'), null);
  assert.equal(await registry.register(path.join(root, 'missing.webm')), null);
  const html = path.join(root, 'unsafe.html'); await fs.writeFile(html, 'x');
  assert.equal(await registry.register(html), null);
  assert.equal(localPath('https://example.com/a.webm'), false);
  assert.equal(localPath('\\\\server\\a.webm'), false);
  const range = await registry.respond(new Request(selected.url, { headers: { range: 'bytes=2-5' } }));
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(range.headers.get('access-control-allow-origin'), '*');
  assert.equal(await range.text(), '2345');
  const head = await registry.respond(new Request(selected.url, { method: 'HEAD' }));
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  assert.equal((await registry.respond(new Request(selected.url, { headers: { range: 'bytes=20-' } }))).status, 416);
  assert.equal((await registry.respond(new Request(`${selected.url}?path=elsewhere`))).status, 404);
  const restarted = new MediaRegistry();
  assert.equal((await restarted.respond(new Request(selected.url))).status, 404);
  const restored = await restarted.register(selected.path);
  assert.equal(await (await restarted.respond(new Request(restored.url))).text(), '0123456789');
});

test('range parsing handles suffix/open ranges and rejects multipart/unsafe ranges', () => {
  assert.deepEqual(parseRange('bytes=-4', 10), { start: 6, end: 9, partial: true });
  assert.deepEqual(parseRange('bytes=5-', 10), { start: 5, end: 9, partial: true });
  assert.deepEqual(parseRange('bytes=0-999', 10), { start: 0, end: 9, partial: true });
  for (const value of ['bytes=1-2,4-5', 'bytes=-0', 'bytes=9-2', 'bytes=999999999999999999999-']) assert.equal(parseRange(value, 10), null);
});

test('offline interception blocks HTTP HTTPS WS WSS and files outside bundled assets', () => {
  let intercept;
  let blocked = 0;
  const ses = { webRequest: { onBeforeRequest: (_filter, callback) => { intercept = callback; } }, setDevicePermissionHandler: callback => assert.equal(callback(), false), on: () => {} };
  installOfflinePolicy(ses, ROOT, () => blocked++);
  for (const url of ['http://example.com/', 'https://127.0.0.1:8080/', 'ws://localhost/', 'wss://example.com/', pathToFileURL(path.resolve(ROOT, '..', 'outside.txt')).href]) {
    intercept({ url }, result => assert.equal(result.cancel, true));
  }
  assert.equal(blocked, 5);
  for (const url of [pathToFileURL(path.join(ROOT, 'renderer.js')).href, 'studio-media://asset/id', 'blob:null/id', 'data:image/png;base64,AA==']) assert.equal(allowedResource(url, ROOT), true);
  assert.equal(allowedResource('file://server/share/video.webm', ROOT), false);
});

test('internet mode enables network schemes and can revoke access without granting arbitrary file access', () => {
  let enabled = true;
  let intercept;
  const ses = { webRequest: { onBeforeRequest: (_filter, callback) => { intercept = callback; } }, setDevicePermissionHandler: () => {}, on: () => {} };
  installOfflinePolicy(ses, ROOT, () => {}, () => enabled);
  for (const url of ['https://example.com/', 'http://example.com/', 'wss://example.com/', 'ws://localhost/']) intercept({ url }, result => assert.equal(result.cancel, false));
  const outside = pathToFileURL(path.resolve(ROOT, '..', 'outside.txt')).href;
  intercept({ url: outside }, result => assert.equal(result.cancel, true));
  intercept({ url: 'ftp://example.com/' }, result => assert.equal(result.cancel, true));
  enabled = false;
  intercept({ url: 'https://example.com/' }, result => assert.equal(result.cancel, true));
  intercept({ url: pathToFileURL(path.join(ROOT, 'renderer.js')).href }, result => assert.equal(result.cancel, false));
});

test('old projects remain readable while browser sources preserve valid website URLs', () => {
  assert.ok(validateProject(project()));
  const document = project();
  const source = document.scenes[0].sources[0];
  source.type = 'browser';
  source.url = 'https://example.com/overlay?theme=dark';
  assert.equal(JSON.parse(encodeProject(document)).scenes[0].sources[0].url, source.url);
  for (const value of ['file:///C:/private.txt', 'javascript:alert(1)', 'https://name:password@example.com/', 'invalid']) {
    source.url = value;
    assert.throws(() => validateProject(document), /browser sources/);
  }
});

test('permissions require local main frame plus trusted recent action; display selection is single-use', () => {
  let now = 1000;
  const entryURL = pathToFileURL(path.join(ROOT, 'index.html')).href;
  const mainFrame = { url: entryURL };
  const contents = { mainFrame, getURL: () => entryURL, isDestroyed: () => false };
  const win = { webContents: contents, isDestroyed: () => false, isFocused: () => true };
  const access = new LocalAccess(() => win, entryURL, () => now);
  const event = { sender: contents, senderFrame: mainFrame };
  const details = { isMainFrame: true, requestingUrl: entryURL };
  assert.equal(access.permission(contents, 'media', details), false);
  assert.throws(() => access.select('screen:1:0', true), /button/);
  assert.throws(() => access.authorize({ ...event, senderFrame: { url: entryURL } }), /main frame/);
  access.noteAction(event);
  assert.equal(access.permission(contents, 'media', details), true);
  assert.equal(access.permission(contents, 'display-capture', details), true);
  assert.equal(access.permission(contents, 'notifications', details), false);
  assert.equal(access.permission(contents, 'media', { ...details, isMainFrame: false }), false);
  assert.equal(access.permission(contents, 'media', { ...details, requestingUrl: 'https://example.com' }), false);
  access.select('screen:1:0', true);
  const request = { frame: mainFrame, videoRequested: true, userGesture: false };
  assert.equal(access.consumeCapture(request).systemAudio, true);
  assert.equal(access.consumeCapture(request), null);
  access.select('screen:1:0', false);
  now += 15001;
  assert.equal(access.consumeCapture(request), null);
  assert.equal(access.permission(contents, 'media', details), false);
});

test('sandboxed preload exposes only the intended bridge and close acknowledgement', async () => {
  let exposed;
  const calls = [];
  const listeners = new Map();
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'studio'); exposed = value; } },
    ipcRenderer: {
      invoke: async (...args) => { calls.push(args); return true; },
      send: (...args) => calls.push(args),
      on: (name, callback) => listeners.set(name, callback),
      removeListener: name => listeners.delete(name)
    }
  };
  const documentListeners = new Map();
  vm.runInNewContext(await fs.readFile(path.join(ROOT, 'preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return electron; },
    document: { addEventListener: (name, callback) => documentListeners.set(name, callback) },
    ArrayBuffer, console
  });
  assert.equal(Object.isFrozen(exposed), true);
  assert.equal(exposed.ipcRenderer, undefined);
  documentListeners.get('click')({ isTrusted: false });
  assert.equal(calls.length, 0);
  documentListeners.get('click')({ isTrusted: true });
  assert.equal(calls[0][0], 'studio:user-action');
  await exposed.recordingWrite({ id: 'id', bytes: arrayBuffer('x') });
  assert.equal(calls.at(-1)[0], 'studio:recording-write');
  assert.throws(() => exposed.pickMedia('remote'), /image or video/);
  let closing = 0;
  const unsubscribe = exposed.onCloseRequested(() => closing++);
  listeners.get('studio:finish-before-close')({ sender: 'never exposed' });
  assert.equal(closing, 1);
  await exposed.finishClose();
  assert.equal(calls.at(-1)[0], 'studio:finish-close');
  unsubscribe();
  assert.equal(listeners.size, 0);
});

test('packaging includes only runtime source and emits a movable Windows launcher', async t => {
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const options = packageOptions(manifest);
  assert.equal(options.electronVersion, '45.4.1');
  assert.equal(options.asar, true);
  assert.equal(options.platform, 'win32');
  assert.equal(options.arch, 'x64');
  for (const file of ['', '/package.json', '/main.cjs', '/preload.cjs', '/renderer.js', '/styles.css', '/index.html', '/lib', '/lib/media.cjs']) assert.equal(ignoreFile(file), false, file);
  for (const file of ['/node_modules', '/node_modules/electron', '/evidence', '/test/main.test.cjs', '/.git/config', '/release', '/package-lock.json', '/README.md', '/scripts/package.cjs', '/lib/secret.txt']) assert.equal(ignoreFile(file), true, file);
  assert.match(launcherText(), /%~dp0release\\Local LIVE Studio-win32-x64\\Local LIVE Studio\.exe/);
  assert.match(launcherText(), /ELECTRON_RUN_AS_NODE=/);
  const root = await directory(t);
  await checkOutput(root);
  await fs.writeFile(path.join(root, 'release', 'Local LIVE Studio-win32-x64'), 'unexpected file');
  await assert.rejects(checkOutput(root), /unexpected release/);
});

test('main source enables sandbox, isolation, no Node, and no renderer throttling', async () => {
  const source = await fs.readFile(path.join(ROOT, 'main.cjs'), 'utf8');
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /backgroundThrottling:\s*false/);
  assert.match(source, /setDisplayMediaRequestHandler/);
  assert.match(source, /streams\.audio\s*=\s*'loopback'/);
  assert.doesNotMatch(source, /autoUpdater|crashReporter\.start/);
  assert.match(source, /openExternal: url => shell\.openExternal\(url\)/);
});

test('packaging reuses the verified local Electron ZIP and rejects incomplete or altered archives', async t => {
  const root = await directory(t);
  assert.equal(await localElectronZip(root, '45.4.1'), null);
  const cache = path.join(root, '.cache');
  const filename = 'electron-v45.4.1-win32-x64.zip';
  const electron = path.join(root, 'node_modules', 'electron');
  await fs.mkdir(cache);
  await fs.mkdir(electron, { recursive: true });
  await fs.writeFile(path.join(cache, filename), '');
  await assert.rejects(localElectronZip(root, '45.4.1'), /incomplete/);
  const content = 'test archive content';
  await fs.writeFile(path.join(cache, filename), content);
  await fs.writeFile(path.join(electron, 'checksums.json'), JSON.stringify({ [filename]: createHash('sha256').update(content).digest('hex') }));
  assert.equal(await localElectronZip(root, '45.4.1'), cache);
  await fs.appendFile(path.join(cache, filename), 'modified');
  await assert.rejects(localElectronZip(root, '45.4.1'), /official SHA256/);
});
