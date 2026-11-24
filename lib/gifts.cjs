'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('./storage.cjs');

const CATALOG = Object.freeze([
  { id: 'heart', name: 'Heart', icon: '💗', color: '#ff6c9a' },
  { id: 'rose', name: 'Rose', icon: '🌹', color: '#ff7281' },
  { id: 'applause', name: 'Applause', icon: '👏', color: '#ffce79' },
  { id: 'star', name: 'Shining star', icon: '🌟', color: '#ffd56f' },
  { id: 'crown', name: 'Crown', icon: '👑', color: '#c2a0ff' },
  { id: 'rocket', name: 'Rocket', icon: '🚀', color: '#79d8ff' }
].map(Object.freeze));
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_HISTORY = 1000;
const empty = () => ({ version: 1, guests: [], history: [], totalGifts: 0 });
function text(value, maximum = 60) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Enter a guest name of 1–60 characters.');
  return value.trim();
}
function seat(value) { if (!Number.isInteger(value) || value < 1 || value > 9) throw new Error('Choose a guest box from 1 to 9.'); return value; }
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Choose a valid guest or gift request.'); return value; }
function quantity(value) { if (!Number.isInteger(value) || value < 1 || value > 99) throw new Error('Choose a gift quantity from 1 to 99.'); return value; }
function gift(value) { const item = CATALOG.find(item => item.id === value); if (!item) throw new Error('Choose a gift from the catalog.'); return item; }
function validate(data) {
  if (data?.version !== 1 || !Array.isArray(data.guests) || data.guests.length > 9 || !Array.isArray(data.history) || data.history.length > MAX_HISTORY || !Number.isSafeInteger(data.totalGifts) || data.totalGifts < 0) throw new Error();
  const ids = new Set(), seats = new Set(), requests = new Set(), events = new Set();
  for (const guest of data.guests) {
    uuid(guest.id); text(guest.name); seat(guest.seat);
    if (ids.has(guest.id) || seats.has(guest.seat)) throw new Error();
    ids.add(guest.id); seats.add(guest.seat);
  }
  let retained = 0;
  for (const event of data.history) {
    uuid(event.id); uuid(event.requestId); uuid(event.recipientId); gift(event.giftId);
    text(event.recipientName); text(event.sender, 80); seat(event.seat); quantity(event.quantity);
    if (!Number.isFinite(Date.parse(event.at)) || requests.has(event.requestId) || events.has(event.id)) throw new Error();
    requests.add(event.requestId); events.add(event.id); retained += event.quantity;
  }
  if (retained > data.totalGifts) throw new Error();
  return data;
}

class GiftStore {
  constructor(directory, options = {}) {
    this.file = path.join(directory, 'studio-gifts.json');
    this.write = options.write || atomicWrite;
    this.now = options.now || (() => new Date().toISOString());
    this.tail = Promise.resolve();
    this.pending = 0;
  }
  async read() {
    try {
      const handle = await fs.open(this.file, 'r');
      try {
        if ((await handle.stat()).size > 2 * 1024 * 1024) throw new Error();
        return validate(JSON.parse(await handle.readFile('utf8')));
      } finally { await handle.close(); }
    } catch (error) {
      if (error.code === 'ENOENT') return empty();
      throw new Error('Studio gifts could not be read. Your recording workspace is still available.');
    }
  }
  view(data) {
    return { available: true, guests: data.guests.map(guest => ({ ...guest })), catalog: CATALOG.map(item => ({ ...item })), history: data.history.slice(-30).reverse().map(event => ({ ...event })), totalGifts: data.totalGifts };
  }
  async snapshot() {
    await this.tail;
    try { return this.view(await this.read()); }
    catch (error) { return { ...this.view(empty()), available: false, message: error.message }; }
  }
  enqueue(action) {
    if (this.pending >= 8) return Promise.reject(new Error('A gift request is still running. Please wait a moment.'));
    this.pending++;
    const work = this.tail.then(action);
    this.tail = work.catch(() => {}).finally(() => this.pending--);
    return work;
  }
  addGuest(input) {
    return this.enqueue(async () => {
      const name = text(input?.name), box = seat(input?.seat);
      const data = await this.read();
      if (data.guests.some(guest => guest.seat === box)) throw new Error('This guest box is occupied. Choose an empty box.');
      const guest = { id: randomUUID(), name, seat: box };
      data.guests.push(guest); data.guests.sort((a, b) => a.seat - b.seat);
      await this.write(this.file, JSON.stringify(data));
      return { state: this.view(data), guest };
    });
  }
  removeGuest(id) {
    return this.enqueue(async () => {
      uuid(id);
      const data = await this.read();
      if (!data.guests.some(guest => guest.id === id)) throw new Error('This guest is no longer in a box.');
      data.guests = data.guests.filter(guest => guest.id !== id);
      await this.write(this.file, JSON.stringify(data));
      return this.view(data);
    });
  }
  send(input, senderName = 'Creator') {
    return this.enqueue(async () => {
      const recipientId = uuid(input?.recipientId), requestId = uuid(input?.requestId), item = gift(input?.giftId), count = quantity(input?.quantity), sender = text(senderName, 80);
      const data = await this.read();
      const previous = data.history.find(event => event.requestId === requestId);
      if (previous) {
        if (previous.recipientId !== recipientId || previous.giftId !== item.id || previous.quantity !== count || previous.sender !== sender) throw new Error('This gift request was already used for a different gift.');
        return { state: this.view(data), receipt: { ...previous }, duplicate: true };
      }
      const recipient = data.guests.find(guest => guest.id === recipientId);
      if (!recipient) throw new Error('Select a guest who is currently in a box.');
      if (!Number.isSafeInteger(data.totalGifts + count)) throw new Error('The studio gift counter has reached its limit.');
      const receipt = { id: randomUUID(), requestId, recipientId, recipientName: recipient.name, seat: recipient.seat, giftId: item.id, quantity: count, sender, at: this.now() };
      data.history.push(receipt); data.history = data.history.slice(-MAX_HISTORY); data.totalGifts += count;
      await this.write(this.file, JSON.stringify(data));
      return { state: this.view(data), receipt: { ...receipt }, duplicate: false };
    });
  }
  idle() { return this.tail; }
}

module.exports = { GiftStore, CATALOG, MAX_HISTORY };
