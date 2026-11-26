'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs/promises'), path = require('node:path');
async function fixture(t) {
  const elements = new Map(), connections = [], offers = [], peerStates = [], cameras = []; let onStatus, onSignal, requestedStreams = 0, removed = 0;
  function element() { return { textContent: '', value: '', hidden: false, disabled: false, children: [], listeners: {}, classList: { toggle() {} }, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, addEventListener(type, callback) { this.listeners[type] = callback; }, showModal() { this.open = true; }, getContext() { return { fillRect() {} }; } }; }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const outputTracks = [{ id: 'video', kind: 'video', stopped: 0, stop() { this.stopped++; }, getSettings: () => ({ width: 1280, height: 720 }) }, { id: 'audio', kind: 'audio', stopped: 0, stop() { this.stopped++; } }];
  class Stream { constructor(tracks = []) { this.tracks = tracks; } getTracks() { return this.tracks; } }
  class Peer {
    constructor() { this.transceivers = []; this.candidates = []; this.connectionState = 'new'; connections.push(this); }
    addTransceiver() { this.transceivers.push({ direction: 'recvonly', sender: {} }); }
    addTrack(track) { const sender = { track, getParameters: () => ({}), setParameters: async () => {} }; this.transceivers.push({ sender }); return sender; }
    getTransceivers() { return this.transceivers; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { this.remoteDescription = value; }
    async addIceCandidate(value) { this.candidates.push(value); }
    close() { this.closed = true; }
  }
  const api = { onPhoneStatus: callback => { onStatus = callback; }, onPhoneSignal: callback => { onSignal = callback; }, sendPhoneSignal: async value => { offers.push(value); }, setPhonePeerState: async (id, value) => { peerStates.push({ id, value }); }, startPhones: async () => { throw new Error('Choose the secure connection helper first.'); } };
  const window = { studio: api }, document = { querySelector: get, createElement: element };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../phones.js'), 'utf8'), { window, document, RTCPeerConnection: Peer, MediaStream: Stream, setTimeout, clearTimeout, console });
  const initial = { status: 'ready', helperReady: true, pairingURL: '', devices: [] };
  window.phoneStudio.initialize(initial, { monitorStream: async () => { requestedStreams++; return new Stream(outputTracks); }, addCamera: async (stream, name) => cameras.push({ stream, name }), removeCamera: () => { removed++; } });
  t.after(() => window.phoneStudio.close());
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { get, connections, offers, peerStates, cameras, outputTracks, streams: () => requestedStreams, removed: () => removed, status: devices => onStatus({ ...initial, devices }), signal: onSignal, flush, controller: window.phoneStudio };
}
test('phone UI does not send studio video before device approval', async t => {
  const f = await fixture(t); f.status([{ id: 'pending', mode: 'monitor', name: '<untrusted>', status: 'pending' }]); await f.flush();
  assert.equal(f.connections.length, 0); assert.equal(f.streams(), 0);
  assert.equal(f.get('#phone-devices').children[0].children[0].textContent, '<untrusted>');
});
test('approved monitor negotiates output and disconnect only stops its owned tracks', async t => {
  const f = await fixture(t); f.status([{ id: 'monitor', mode: 'monitor', name: 'Monitor', status: 'accepted', connection: 'connecting' }]); await f.flush();
  assert.equal(f.streams(), 1); assert.equal(f.offers[0].signal.type, 'offer'); assert.equal(f.connections[0].transceivers[0].direction, 'sendonly');
  f.signal({ deviceId: 'monitor', signal: { type: 'candidate', candidate: { candidate: 'test' } } });
  f.signal({ deviceId: 'monitor', signal: { type: 'answer', sdp: 'v=0\r\n' } }); await f.flush();
  assert.equal(f.connections[0].remoteDescription.type, 'answer'); assert.equal(f.connections[0].candidates.length, 1);
  f.connections[0].ontrack({ track: { kind: 'video' }, streams: [] }); await f.flush(); assert.equal(f.cameras.length, 0);
  f.status([]); assert.equal(f.connections[0].closed, true); assert.deepEqual(f.outputTracks.map(track => track.stopped), [1, 1]);
});
test('camera mode receives camera video without capturing studio output', async t => {
  const f = await fixture(t); f.status([{ id: 'camera', mode: 'camera', name: 'Phone camera', status: 'accepted' }]); await f.flush();
  assert.equal(f.streams(), 0); assert.equal(f.connections[0].transceivers[0].direction, 'recvonly');
  const track = { kind: 'video', stop() {} }; f.connections[0].ontrack({ track, streams: [] }); await f.flush();
  assert.equal(f.cameras.length, 1); assert.equal(f.cameras[0].name, 'Phone camera');
  f.signal({ deviceId: 'camera', closed: true }); assert.equal(f.removed(), 1);
});
test('combined mode starts both directions and offline shutdown closes the peer', async t => {
  const f = await fixture(t); f.status([{ id: 'both', mode: 'both', name: 'Both', status: 'accepted' }]); await f.flush();
  assert.equal(f.streams(), 1); const track = { kind: 'video', stop() {} }; f.connections[0].ontrack({ track, streams: [] }); await f.flush(); assert.equal(f.cameras.length, 1);
  f.controller.setInternetEnabled(false); assert.equal(f.connections[0].closed, true); assert.equal(f.get('#phone-create').disabled, true);
});
test('connection setup failures remain visible instead of being overwritten by rendering', async t => {
  const f = await fixture(t); await f.get('#phone-create').listeners.click(); assert.equal(f.get('#phone-status').textContent, 'Choose the secure connection helper first.');
});
