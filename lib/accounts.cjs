'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { atomicWrite } = require('./storage.cjs');
const derive = promisify(scrypt);
const COST = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_BYTES = 1024 * 1024;
const INVALID = 'Email or password is incorrect.';

function emailAddress(value) {
  if (typeof value !== 'string') throw new Error('Enter a valid email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(email)) throw new Error('Enter a valid email address.');
  return email;
}
function passwordValue(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) throw new Error('Use a password between 12 and 128 characters.');
  return value;
}
function displayName(value) {
  if (typeof value !== 'string' || value.trim().length < 2 || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Enter a display name between 2 and 80 characters.');
  return value.trim();
}
function publicUser(user) { return user ? { id: user.id, name: user.name, email: user.email } : null; }

class AccountStore {
  constructor(directory, options = {}) {
    this.file = path.join(directory, 'accounts.json');
    this.write = options.write || atomicWrite;
    this.now = options.now || Date.now;
    this.user = null;
    this.tail = Promise.resolve();
    this.pending = 0;
    this.attempts = new Map();
    this.dummySalt = randomBytes(16).toString('hex');
  }
  async read() {
    let contents;
    try {
      const handle = await fs.open(this.file, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('invalid account file');
        contents = JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, users: [] };
      throw new Error('Local accounts could not be read. Your workspace is still available.');
    }
    const ids = new Set(), emails = new Set();
    try {
      if (contents?.version !== 1 || !Array.isArray(contents.users) || contents.users.length > 100) throw new Error();
      for (const user of contents.users) {
        if (!user || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(user.id) || ids.has(user.id) || emails.has(user.email) ||
            emailAddress(user.email) !== user.email || displayName(user.name) !== user.name ||
            !/^[a-f0-9]{32}$/.test(user.salt) || !/^[a-f0-9]{64}$/.test(user.hash) || user.algorithm !== 'scrypt-v1') throw new Error();
        ids.add(user.id); emails.add(user.email);
      }
    } catch { throw new Error('Local accounts could not be read. Your workspace is still available.'); }
    return contents;
  }
  async status() {
    try { await this.tail; await this.read(); return { user: publicUser(this.user), available: true }; }
    catch (error) { return { user: null, available: false, message: error.message }; }
  }
  enqueue(action) {
    if (this.pending >= 4) return Promise.reject(new Error('An account request is still running. Please try again shortly.'));
    this.pending++;
    const work = this.tail.then(action);
    this.tail = work.catch(() => {}).finally(() => { this.pending--; });
    return work;
  }
  create(input) {
    return this.enqueue(async () => {
      const name = displayName(input?.name), email = emailAddress(input?.email), password = passwordValue(input?.password);
      const data = await this.read();
      if (data.users.some(user => user.email === email)) throw new Error('An account with this email already exists. Sign in instead.');
      if (data.users.length >= 100) throw new Error('This computer has reached its local account limit.');
      const salt = randomBytes(16).toString('hex');
      const hash = (await derive(password, salt, 32, COST)).toString('hex');
      const user = { id: randomUUID(), name, email, salt, hash, algorithm: 'scrypt-v1' };
      await this.write(this.file, JSON.stringify({ version: 1, users: [...data.users, user] }));
      this.user = user;
      return publicUser(user);
    });
  }
  signIn(input) {
    return this.enqueue(async () => {
      let email, password;
      try { email = emailAddress(input?.email); password = passwordValue(input?.password); }
      catch { throw new Error(INVALID); }
      const now = this.now();
      for (const [key, attempt] of this.attempts) if (attempt.until <= now) this.attempts.delete(key);
      const attempt = this.attempts.get(email) || { count: 0, until: now + 60000 };
      if (attempt.count >= 5 || (!this.attempts.has(email) && this.attempts.size >= 100)) throw new Error('Too many sign-in attempts. Try again in a minute.');
      attempt.count++; this.attempts.set(email, attempt);
      const data = await this.read();
      const user = data.users.find(item => item.email === email);
      const hash = await derive(password, user?.salt || this.dummySalt, 32, COST);
      const expected = user ? Buffer.from(user.hash, 'hex') : Buffer.alloc(32);
      const matches = timingSafeEqual(hash, expected);
      if (!user || !matches) throw new Error(INVALID);
      this.attempts.delete(email);
      this.user = user;
      return publicUser(user);
    });
  }
  signOut() { return this.enqueue(async () => { this.user = null; return true; }); }
  idle() { return this.tail; }
}

module.exports = { AccountStore };
