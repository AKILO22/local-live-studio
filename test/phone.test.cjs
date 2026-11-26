'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { PhoneBridge, signal } = require('../lib/phone.cjs');
const { ignoreFile } = require('../scripts/package.cjs');
const ROOT = path.resolve(__dirname, '..');

async function fixture(t, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-phone-test-'));
  let closed = 0, signals = [];
  const bridge = new PhoneBridge({ dataDir: dir, assetDir: path.join(ROOT, 'phone'), isEnabled: () => true, pollMs: 40,
    createTunnel: async () => ({ url: 'https://fixture.trycloudflare.com', close: () => closed++ }), onSignal: value => signals.push(value), ...extra });
  await bridge.initialize();
  t.after(async () => { await bridge.stop(); const real = await fs.realpath(dir); assert.equal(path.dirname(real), await fs.realpath(os.tmpdir())); assert.ok(path.basename(real).startsWith('studio-phone-test-')); await fs.rm(real, { recursive: true, force: true }); });
  await bridge.start(); const pair = bridge.snapshot().pairingURL.split('#')[1];
  const request = async (route, bearer = pair, body, headers = {}) => {
    const response = await fetch(bridge.localURL + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + bearer, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const join = async (mode = 'monitor', name = 'Test phone') => { const response = await request('/api/join', pair, { mode, name }); assert.equal(response.status, 201); const id = bridge.snapshot().devices.at(-1).id; return { id, token: response.value.deviceToken }; };
  return { bridge, pair, request, join, signals, directory: dir, closes: () => closed };
}

test('phone pages require no camera automatically and never embed pairing secrets or local files', async t => {
  const f = await fixture(t);
  const page = await fetch(f.bridge.localURL + '/'); assert.equal(page.status, 200);
  assert.match(page.headers.get('permissions-policy'), /microphone=\(\)/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.doesNotMatch(await page.text(), new RegExp(f.pair));
  assert.notEqual((await f.request('/main.cjs')).status, 200);
  assert.equal((await f.request('/api/join', 'not-a-token', { mode: 'camera', name: 'No access' })).status, 401);
  assert.equal((await f.request('/api/join', f.pair, { mode: 'monitor', name: 'Foreign page' }, { Origin: 'https://unrelated.invalid' })).status, 403);
});

test('pending phones cannot signal or receive an offer until explicitly approved', async t => {
  const f = await fixture(t); const d = await f.join('camera');
  assert.equal(f.bridge.snapshot().devices[0].status, 'pending');
  assert.equal((await f.request('/api/signal', d.token, { type: 'answer', sdp: 'v=0\r\n' })).status, 403);
  assert.throws(() => f.bridge.send(d.id, { type: 'offer', sdp: 'v=0\r\n' }), /not connected/);
  f.bridge.accept(d.id); f.bridge.send(d.id, { type: 'offer', sdp: 'v=0\r\n' });
  const events = await f.request('/api/events?after=0', d.token);
  assert.equal(events.status, 200); assert.deepEqual(events.value.events.map(e => e.type), ['accepted', 'signal']);
  assert.equal(events.value.events[1].signal.type, 'offer');
  const answer = await f.request('/api/signal', d.token, { type: 'answer', sdp: 'v=0\r\n' });
  assert.equal(answer.status, 200); assert.equal(f.signals.at(-1).deviceId, d.id);
  assert.equal(f.signals.at(-1).signal.type, 'answer');
  assert.equal(f.bridge.setPeerState(d.id, 'connected'), true);
  assert.equal(f.bridge.snapshot().devices[0].connection, 'connected');
});

test('long polling delivers a later ICE candidate and rejects duplicate event readers', async t => {
  const f = await fixture(t, { pollMs: 1000 }); const d = await f.join(); f.bridge.accept(d.id);
  const first = await f.request('/api/events?after=0', d.token);
  const pending = f.request('/api/events?after=' + first.value.cursor, d.token);
  for (let i = 0; i < 50 && !f.bridge.devices.get(d.id).waiter; i++) await new Promise(r => setTimeout(r, 2));
  assert.ok(f.bridge.devices.get(d.id).waiter);
  assert.equal((await f.request('/api/events?after=' + first.value.cursor, d.token)).status, 409);
  f.bridge.send(d.id, { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 1234 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
  const delivered = await pending; assert.equal(delivered.value.events[0].signal.type, 'candidate');
});

test('separate phone credentials cannot authorize new phones or poll using the pairing token', async t => {
  const f = await fixture(t); const a = await f.join(), b = await f.join();
  assert.notEqual(a.token, b.token); assert.notEqual(a.token, f.pair);
  assert.equal((await f.request('/api/events', f.pair)).status, 401);
  assert.equal((await f.request('/api/join', a.token, { name: 'Other', mode: 'monitor' })).status, 401);
  f.bridge.accept(a.id); f.bridge.send(a.id, { type: 'offer', sdp: 'v=0\r\n' });
  assert.deepEqual((await f.request('/api/events', b.token)).value.events, []);
  assert.equal(JSON.stringify(f.bridge.snapshot().devices).includes(a.token), false);
});

test('camera approval is exclusive while monitors can coexist, and disconnect releases the slot', async t => {
  const f = await fixture(t), camera = await f.join('camera'), both = await f.join('both'), viewer = await f.join();
  f.bridge.accept(camera.id); assert.throws(() => f.bridge.accept(both.id), /existing phone camera/);
  f.bridge.accept(viewer.id); f.bridge.remove(camera.id); f.bridge.accept(both.id);
  assert.equal(f.bridge.snapshot().devices.find(d => d.id === both.id).status, 'accepted');
  const closed = await f.request('/api/events', camera.token); assert.equal(closed.value.events.at(-1).type, 'closed');
  assert.equal((await f.request('/api/signal', camera.token, { type: 'answer', sdp: 'v=0\r\n' })).status, 403);
});

test('pairing expires and renews without discarding accepted device credentials', async t => {
  let now = Date.now(); const f = await fixture(t, { now: () => now }), d = await f.join(); f.bridge.accept(d.id);
  now += 15 * 60 * 1000 + 1;
  assert.equal(f.bridge.snapshot().pairingURL, '');
  assert.equal((await f.request('/api/join', f.pair, { name: 'Late phone', mode: 'monitor' })).status, 401);
  await f.bridge.start(); const fresh = f.bridge.snapshot().pairingURL.split('#')[1]; assert.notEqual(fresh, f.pair);
  assert.equal((await f.request('/api/join', f.pair, { name: 'Old link', mode: 'monitor' })).status, 401);
  assert.equal((await f.request('/api/events', d.token)).status, 200);
  assert.equal(f.bridge.snapshot().devices[0].status, 'accepted');
});

test('phone counts and message schemas are bounded and cannot invoke arbitrary commands', async t => {
  const f = await fixture(t);
  for (const bad of [{ name: 'Bad', mode: 'shell' }, { name: '\u0000', mode: 'monitor' }, { name: 'x'.repeat(61), mode: 'camera' }]) assert.equal((await f.request('/api/join', f.pair, bad)).status, 400);
  const d = await f.join(); f.bridge.accept(d.id);
  assert.equal((await f.request('/api/signal', d.token, { type: 'offer', sdp: 'v=0\r\n' })).status, 400);
  assert.equal((await f.request('/api/signal', d.token, { type: 'answer', sdp: 'x'.repeat(65000) })).status, 400);
  for (let i = 0; i < 3; i++) await f.join();
  assert.equal((await f.request('/api/join', f.pair, { name: 'Extra', mode: 'monitor' })).status, 429);
  assert.throws(() => signal({ type: 'execute', command: 'ignored' }, 'phone'), /Unsupported/);
});

test('stopping ends long polls, closes the tunnel, clears secrets and removes the listener', async t => {
  const f = await fixture(t, { pollMs: 1000 }), d = await f.join(); f.bridge.accept(d.id);
  const first = await f.request('/api/events', d.token);
  const pending = f.request('/api/events?after=' + first.value.cursor, d.token);
  for (let i = 0; i < 50 && !f.bridge.devices.get(d.id).waiter; i++) await new Promise(r => setTimeout(r, 2));
  const localURL = f.bridge.localURL; await f.bridge.stop();
  assert.equal((await pending).value.events[0].type, 'closed');
  assert.equal(f.closes(), 1); assert.equal(f.bridge.snapshot().pairingURL, ''); assert.equal(f.bridge.devices.size, 0);
  await assert.rejects(fetch(localURL + '/'));
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('cancelled tunnel startup cannot become ready later', async t => {
  let resolveTunnel, closed = false;
  const f = await fixture(t); await f.bridge.stop();
  f.bridge.options.createTunnel = () => new Promise(resolve => { resolveTunnel = resolve; });
  const starting = f.bridge.start();
  for (let i = 0; i < 50 && !resolveTunnel; i++) await new Promise(r => setTimeout(r, 2));
  assert.ok(resolveTunnel); await f.bridge.stop(); resolveTunnel({ url: 'https://fixture.trycloudflare.com', close: () => { closed = true; } });
  await assert.rejects(starting, /cancelled/); assert.equal(closed, true); assert.equal(f.bridge.snapshot().status, 'stopped');
});

test('offline mode refuses a new phone service and the package contains only named phone assets', async t => {
  const f = await fixture(t); await f.bridge.stop(); f.bridge.options.isEnabled = () => false;
  await assert.rejects(f.bridge.start(), /Internet access/); assert.equal(f.bridge.server, null);
  for (const file of ['phones.js', 'phone-studio.css', 'lib/phone.cjs', 'phone/index.html', 'phone/phone-client.js', 'phone/phone.css', 'vendor/qrcode.js']) assert.equal(ignoreFile(file), false);
  for (const file of ['phone/credentials.json', 'vendor/private.txt', 'phone-helper.json']) assert.equal(ignoreFile(file), true);
});
