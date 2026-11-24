'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { GiftStore, CATALOG, MAX_HISTORY } = require('../lib/gifts.cjs');
const { validateProject } = require('../lib/storage.cjs');
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-gifts-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('studio-gifts-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
async function setup(t, options) {
  const root = await directory(t), store = new GiftStore(root, options);
  const { guest } = await store.addGuest({ name: 'Amina QA', seat: 1 });
  return { root, store, guest, request: () => ({ recipientId: guest.id, giftId: 'rose', quantity: 5, requestId: randomUUID() }) };
}
test('gift catalog is non-monetary and roster persists without online services', async t => {
  const { root, store, guest } = await setup(t);
  const state = await new GiftStore(root).snapshot();
  assert.equal(state.available, true); assert.equal(state.catalog.length, 6);
  assert.deepEqual(state.guests, [guest]); assert.equal(state.totalGifts, 0);
  for (const item of CATALOG) assert.deepEqual(Object.keys(item).sort(), ['color', 'icon', 'id', 'name']);
  state.guests[0].name = 'changed';
  assert.equal((await store.snapshot()).guests[0].name, 'Amina QA');
});
test('gift delivery records exact recipient, sender, quantity and timestamp across restart', async t => {
  const { root, store, guest, request } = await setup(t, { now: () => '2026-11-23T20:00:00.000Z' });
  const sent = await store.send(request(), 'Creator QA');
  assert.equal(sent.duplicate, false); assert.equal(sent.receipt.recipientId, guest.id);
  assert.equal(sent.receipt.recipientName, guest.name); assert.equal(sent.receipt.seat, 1);
  assert.equal(sent.receipt.sender, 'Creator QA'); assert.equal(sent.receipt.quantity, 5);
  assert.equal(sent.receipt.at, '2026-11-23T20:00:00.000Z');
  const state = await new GiftStore(root).snapshot();
  assert.equal(state.totalGifts, 5); assert.deepEqual(state.history[0], sent.receipt);
});
test('duplicate gift requests commit one receipt and mismatched reuse is rejected', async t => {
  const { store, request } = await setup(t), input = request();
  const results = await Promise.all([store.send(input), store.send(input)]);
  assert.deepEqual(results.map(result => result.duplicate), [false, true]);
  assert.equal(results[0].receipt.id, results[1].receipt.id);
  await assert.rejects(store.send({ ...input, quantity: 6 }), /different gift/);
  await assert.rejects(store.send(input, 'Different creator'), /different gift/);
  assert.equal((await store.snapshot()).totalGifts, 5);
});
test('removed guests retain historical identity and cannot receive new gifts after a box is reused', async t => {
  const { store, guest, request } = await setup(t), input = request();
  await store.send(input); await store.removeGuest(guest.id);
  const second = await store.addGuest({ name: 'New guest', seat: 1 });
  assert.notEqual(second.guest.id, guest.id);
  await assert.rejects(store.send(request()), /currently in a box/);
  const retry = await store.send(input);
  assert.equal(retry.duplicate, true); assert.equal(retry.receipt.recipientName, 'Amina QA');
  assert.equal((await store.snapshot()).history.length, 1);
});
test('guest boxes enforce bounds and serialized concurrent occupancy checks', async t => {
  const store = new GiftStore(await directory(t));
  const results = await Promise.allSettled([store.addGuest({ name: 'A', seat: 1 }), store.addGuest({ name: 'B', seat: 1 })]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  for (let seat = 2; seat <= 9; seat++) await store.addGuest({ name: 'Guest ' + seat, seat });
  assert.equal((await store.snapshot()).guests.length, 9);
  for (const input of [{ name: 'Extra', seat: 10 }, { name: 'Extra', seat: 0 }, { name: 'Extra', seat: 1.5 }, { name: '', seat: 1 }, { name: 'bad\nname', seat: 1 }]) await assert.rejects(store.addGuest(input));
});
test('invalid recipient, catalog, quantity and request identifiers leave the ledger unchanged', async t => {
  const { store, request } = await setup(t), input = request();
  for (const invalid of [{ recipientId: randomUUID() }, { giftId: 'fake-paid-gift' }, { quantity: -1 }, { quantity: 0 }, { quantity: 1.1 }, { quantity: 100 }, { requestId: 'unsafe' }]) await assert.rejects(store.send({ ...input, ...invalid }));
  assert.equal((await store.snapshot()).totalGifts, 0);
});
test('failed disk writes never commit a gift or consume its request identifier', async t => {
  const { root, store, request } = await setup(t), input = request();
  const failing = new GiftStore(root, { write: async () => { throw new Error('Disk unavailable'); } });
  await assert.rejects(failing.send(input), /Disk unavailable/);
  assert.equal((await store.snapshot()).history.length, 0);
  assert.equal((await store.send(input)).duplicate, false);
});
test('corrupt gift storage reports unavailable without replacing data', async t => {
  const root = await directory(t), store = new GiftStore(root), original = '{bad';
  await fs.writeFile(store.file, original);
  assert.equal((await store.snapshot()).available, false);
  await assert.rejects(store.addGuest({ name: 'Guest', seat: 1 }), /could not be read/);
  assert.equal(await fs.readFile(store.file, 'utf8'), original);
});
test('bounded history keeps recent idempotency records and lifetime gift counts', async t => {
  const { store, request } = await setup(t), first = await store.send(request());
  const data = JSON.parse(await fs.readFile(store.file, 'utf8'));
  data.history = Array.from({ length: MAX_HISTORY }, () => ({ ...first.receipt, id: randomUUID(), requestId: randomUUID() }));
  data.totalGifts = MAX_HISTORY * 5;
  await fs.writeFile(store.file, JSON.stringify(data));
  const final = await store.send(request());
  const saved = JSON.parse(await fs.readFile(store.file, 'utf8'));
  assert.equal(saved.history.length, MAX_HISTORY); assert.equal(final.state.history.length, 30);
  assert.equal(final.state.totalGifts, (MAX_HISTORY + 1) * 5);
  assert.equal(final.state.history[0].id, final.receipt.id);
});
test('guest-board layers persist in the existing project schema', () => {
  const scene = randomUUID();
  const project = { version: 1, activeSceneId: scene, scenes: [{ id: scene, name: 'Scene', sources: [{ id: randomUUID(), type: 'guest-board', name: 'Guest boxes', x: 0, y: 0, width: 1280, height: 720, opacity: 1, visible: true, locked: false }] }], settings: { width: 1280, height: 720, fps: 30, bitrate: 3000000 }, notes: '' };
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))), project);
});
