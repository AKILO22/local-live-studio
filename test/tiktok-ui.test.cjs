'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const base = { status: 'setup-required', configured: false, hasSavedLink: false, connected: false, busy: false, internetEnabled: true, brokerURL: '', message: '' };
async function fixture(api = {}) {
  const elements = new Map(); let status;
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, hidden: false, textContent: '', listeners: {}, classList: { toggle() {} }, addEventListener(name, callback) { this.listeners[name] = callback; } });
    return elements.get(id);
  };
  const document = { querySelector: get, activeElement: null }, window = { studio: { ...api, onTikTokStatus(callback) { status = callback; } } };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '..', 'tiktok.js'), 'utf8'), { window, document });
  window.tiktokConnection.initialize({ ...base });
  return { get, document, subject: window.tiktokConnection, status: next => status(next), event: (id, name) => get(id).listeners[name]({ preventDefault() {} }) };
}
test('TikTok setup opens with Connect disabled until a connection server has been saved', async () => {
  const f = await fixture(); assert.equal(f.get('#tiktok-state').textContent, 'Setup required');
  assert.equal(f.get('#tiktok-connect').disabled, true); assert.equal(f.get('#tiktok-connection-details').open, true);
});
test('saving setup preserves the typed URL through busy rendering and enables authorization', async () => {
  let saved;
  const f = await fixture({ saveTikTokSettings: async url => { saved = url; return { ...base, configured: true, brokerURL: url, status: 'ready' }; } });
  f.get('#tiktok-broker-url').value = 'https://connection.example/';
  f.document.activeElement = f.get('#tiktok-save-settings');
  await f.event('#tiktok-setup-form', 'submit');
  assert.equal(saved, 'https://connection.example/'); assert.equal(f.get('#tiktok-connect').disabled, false);
});
test('connected profile is rendered as text, saved offline, and has refresh and disconnect controls', async () => {
  const f = await fixture(); f.status({ ...base, configured: true, brokerURL: 'https://connection.example/', hasSavedLink: true, connected: true, status: 'connected', profile: { displayName: '<synthetic creator>' } });
  assert.equal(f.get('#tiktok-state').textContent, 'Connected'); assert.equal(f.get('#tiktok-profile').textContent, '<synthetic creator>');
  assert.equal(f.get('#tiktok-disconnect').hidden, false); assert.equal(f.get('#tiktok-connect').hidden, true);
  f.subject.setInternetEnabled(false);
  assert.equal(f.get('#tiktok-state').textContent, 'Saved link'); assert.equal(f.get('#tiktok-refresh').disabled, true);
  assert.equal(f.get('#tiktok-forget').disabled, false);
});
test('authorization failures display a retryable message without claiming a connected account', async () => {
  const f = await fixture({ connectTikTok: async () => { throw new Error('Login Kit setup is not ready.'); } });
  f.status({ ...base, configured: true, brokerURL: 'https://connection.example/', status: 'ready' });
  await f.event('#tiktok-connect', 'click');
  assert.equal(f.get('#tiktok-status').textContent, 'Login Kit setup is not ready.'); assert.equal(f.get('#tiktok-connect').disabled, false);
  assert.equal(f.get('#tiktok-state').textContent, 'Not connected');
});
