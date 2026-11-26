'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs/promises'), path = require('node:path');
async function fixture(t) {
  const elements = new Map(), oldTrack = { kind: 'video', stopped: 0, stop() { this.stopped++; } }, freshTrack = { kind: 'video', stopped: 0, stop() { this.stopped++; } };
  const stream = track => ({ getTracks: () => [track], getVideoTracks: () => [track] });
  function element(id) { if (!elements.has(id)) elements.set(id, { value: id === '#phone-name' ? 'Test camera' : id === '#camera-facing' ? 'environment' : 'camera', disabled: false, hidden: false, listeners: {}, classList: { toggle() {} }, addEventListener(type, fn) { this.listeners[type] = fn; }, play: async () => {} }); return elements.get(id); }
  let acquireFresh, acquisition = 0, polls = 0, replaceCalls = 0, rejectReplacement = false;
  const sender = { track: oldTrack, replaceTrack: async () => { replaceCalls++; if (rejectReplacement) throw new Error('replace failed'); } };
  class Peer { constructor() { this.connectionState = 'connected'; } async setRemoteDescription(v) { this.remoteDescription = v; } addTrack() {} async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' }; } async setLocalDescription(v) { this.localDescription = v; } getSenders() { return [sender]; } close() { this.closed = true; } }
  const fetch = async (url, options) => {
    let value;
    if (url === '/api/join') value = { deviceToken: 'fixture-only' };
    else if (url.startsWith('/api/events') && !polls++) value = { cursor: 1, events: [{ type: 'signal', signal: { type: 'offer', sdp: 'v=0\r\n' } }] };
    else if (url.startsWith('/api/events')) return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    else value = { ok: true };
    return { ok: true, json: async () => value };
  };
  const document = { querySelector: element, querySelectorAll: () => [] }, window = { addEventListener() {} };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../phone/phone-client.js'), 'utf8'), {
    document, window, navigator: { mediaDevices: { getUserMedia: async () => ++acquisition === 1 ? stream(oldTrack) : new Promise(resolve => { acquireFresh = () => resolve(stream(freshTrack)); }) } },
    location: { hash: '#' + 'a'.repeat(43), pathname: '/' }, history: { replaceState() {} }, sessionStorage: { setItem() {} },
    isSecureContext: true, RTCPeerConnection: Peer, MediaStream: class { getTracks() { return []; } addTrack() {} }, fetch,
    AbortController, setTimeout, clearTimeout, console,
  });
  const connecting = element('#connect').listeners.click();
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
  await flush(); assert.equal(acquisition, 1);
  t.after(async () => { element('#disconnect').listeners.click(); await connecting; });
  return { element, oldTrack, freshTrack, flush, acquire: () => acquireFresh(), replacements: () => replaceCalls, reject: () => { rejectReplacement = true; } };
}
test('disconnect during camera switching stops the newly acquired camera', async t => {
  const f = await fixture(t), switching = f.element('#switch-camera').listeners.click(); await f.flush();
  f.element('#disconnect').listeners.click(); f.acquire(); await switching;
  assert.equal(f.freshTrack.stopped, 1); assert.equal(f.oldTrack.stopped, 1); assert.equal(f.replacements(), 0);
});
test('failed camera replacement releases the new track and retains the current camera', async t => {
  const f = await fixture(t); f.reject(); const switching = f.element('#switch-camera').listeners.click(); await f.flush(); f.acquire(); await switching;
  assert.equal(f.freshTrack.stopped, 1); assert.equal(f.oldTrack.stopped, 0); assert.match(f.element('#status').textContent, /could not switch/);
});
test('successful camera switching releases the previous track and keeps the new one until disconnect', async t => {
  const f = await fixture(t), switching = f.element('#switch-camera').listeners.click(); await f.flush(); f.acquire(); await switching;
  assert.equal(f.oldTrack.stopped, 1); assert.equal(f.freshTrack.stopped, 0); assert.equal(f.replacements(), 1);
  f.element('#disconnect').listeners.click(); assert.equal(f.freshTrack.stopped, 1);
});
