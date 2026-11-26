'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), { EventEmitter } = require('node:events'), { pathToFileURL } = require('node:url');
const { StudioRoute, signal, childEnvironment } = require('../lib/studio-route.cjs');
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-route-test-')), handlers = new Map(), statuses = [], mainMessages = [];
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(dataDir)), await fs.realpath(os.tmpdir())); assert(path.basename(dataDir).startsWith('studio-route-test-')); await fs.rm(dataDir, { recursive: true, force: true }); });
  const mainURL = 'file:///trusted/index.html', mainFrame = { url: mainURL }, main = { isDestroyed: () => false, webContents: { mainFrame, send: (...value) => mainMessages.push(value) } };
  class Window extends EventEmitter { constructor(options) { super(); this.options = options; this.messages = []; this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: '' }; this.webContents.send = (...v) => this.messages.push(v); this.webContents.setWindowOpenHandler = fn => { this.popupPolicy = fn; }; } setMenu() {} show() {} focus() {} isDestroyed() { return false; } async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; this.emit('ready-to-show'); } close() { this.emit('closed'); } }
  let verified = 0, launched = 0, rejectPublisher = false, enabled = true;
  const route = new StudioRoute({ root: path.resolve(__dirname, '..'), dataDir, BrowserWindow: Window, outputSession: {}, mainURL, getMainWindow: () => main, isEnabled: () => enabled, verifyPublisher: async () => { verified++; if (rejectPublisher) throw new Error('Untrusted publisher'); }, launch: async () => { launched++; }, onStatus: value => statuses.push(value) });
  route.bind({ handle: (name, fn) => handlers.set(name, fn) }); t.after(() => route.close());
  const event = output => { const sender = output ? route.window.webContents : main.webContents; return { sender, senderFrame: sender.mainFrame }; };
  return { route, handlers, main, mainMessages, statuses, dataDir, event, verifyCount: () => verified, launchCount: () => launched, rejectPublisher: () => { rejectPublisher = true; }, offline: () => { enabled = false; } };
}
test('official route verifies the publisher on selection and immediately before launch', async t => {
  const f = await fixture(t), exe = path.join(f.dataDir, 'TikTok LIVE Studio.exe'); await fs.writeFile(exe, 'synthetic executable placeholder');
  await f.route.choose(exe); assert.equal(f.verifyCount(), 1); await f.route.launch(); assert.equal(f.verifyCount(), 2); assert.equal(f.launchCount(), 1);
  f.rejectPublisher(); await assert.rejects(f.route.launch(), /publisher/); assert.equal(f.launchCount(), 1);
  await assert.rejects(f.route.choose(path.join(f.dataDir, 'other.exe')), /Choose TikTok/);
  f.offline(); await assert.rejects(f.route.launch(), /Internet/);
});
test('output is isolated, has a stable capture title and never represents external broadcast status as LIVE', async t => {
  const f = await fixture(t); await assert.rejects(f.route.open({ width: 1, height: 1 }), /supported/);
  await f.route.open({ width: 720, height: 1280 }); const win = f.route.window;
  assert.equal(win.options.title, 'Local LIVE Studio — Broadcast Output'); assert.equal(win.options.webPreferences.sandbox, true); assert.equal(win.options.webPreferences.nodeIntegration, false); assert.equal(win.options.webPreferences.contextIsolation, true); assert.equal(f.route.snapshot().broadcastStatus, 'controlled-by-tiktok');
  await f.route.open({ width: 1280, height: 720 }); assert.equal(f.route.window, win); assert.equal(f.route.snapshot().audio, false);
  f.route.setAudio(true); assert.equal(win.messages.at(-1)[0], 'studio:cast-audio'); f.route.close(); assert.equal(f.route.snapshot().outputOpen, false); assert.equal(f.route.snapshot().sessionId, ''); assert.equal(f.mainMessages.at(-1)[0], 'studio:cast-closed');
});
test('signalling binds the exact two main frames, roles and current session', async t => {
  const f = await fixture(t); await f.route.open({ width: 1280, height: 720 }); const id = f.route.snapshot().sessionId, ready = f.handlers.get('studio:cast-ready'), send = f.handlers.get('studio:cast-signal');
  assert.throws(() => ready(f.event(false)), /Untrusted/); assert.equal(ready(f.event(true)).sessionId, id);
  assert.throws(() => send({ sender: {}, senderFrame: {} }, { sessionId: id }), /ended/);
  const valid = { sessionId: id, signal: { type: 'offer', sdp: 'v=0\r\n' } };
  assert.equal(send(f.event(false), valid), true); assert.equal(f.route.window.messages.at(-1)[0], 'studio:cast-signal');
  assert.throws(() => send(f.event(true), valid), /Invalid/); assert.throws(() => send({ sender: f.main.webContents, senderFrame: { url: 'file:///trusted/index.html' } }, valid), /ended/);
  assert.equal(send(f.event(true), { sessionId: id, signal: { type: 'answer', sdp: 'v=0\r\n' } }), true);
  f.route.close(); assert.throws(() => send(f.event(false), valid), /ended/);
});
test('signal schemas reject oversized descriptions, foreign roles and malformed candidates', () => {
  assert.throws(() => signal({ type: 'answer', sdp: 'v=0' }, 'studio'), /Invalid/); assert.throws(() => signal({ type: 'offer', sdp: 'v=0' + 'a'.repeat(64000) }, 'studio'), /Invalid/);
  assert.throws(() => signal({ type: 'candidate', candidate: { candidate: 'anything' } }, 'output'), /Invalid/);
  assert.equal(signal({ type: 'candidate', candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } }, 'output').type, 'candidate');
});
test('the official process environment excludes developer and account secrets', () => {
  assert(!Object.hasOwn(childEnvironment(), 'ELECTRON_RUN_AS_NODE')); assert(!Object.hasOwn(childEnvironment(), 'GH_TOKEN')); assert(!Object.hasOwn(childEnvironment(), 'TIKTOK_CLIENT_SECRET'));
});
