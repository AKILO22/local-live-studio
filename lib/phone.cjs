'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { atomicWrite } = require('./storage.cjs');
const execute = promisify(execFile);
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const MODES = new Set(['camera', 'monitor', 'both']);
const token = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && SECRET.test(a) && SECRET.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function signal(value, sender) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid phone connection message.');
  if (value.type === (sender === 'desktop' ? 'offer' : 'answer')) {
    if (typeof value.sdp !== 'string' || !value.sdp.startsWith('v=0') || value.sdp.length > 64000) throw new Error('Invalid phone session description.');
    return { type: value.type, sdp: value.sdp };
  }
  if (value.type === 'candidate') {
    const c = value.candidate;
    if (!c || typeof c.candidate !== 'string' || c.candidate.length > 2048 || !/^candidate:/.test(c.candidate) ||
      (c.sdpMid !== null && (typeof c.sdpMid !== 'string' || c.sdpMid.length > 80)) ||
      (c.sdpMLineIndex !== null && (!Number.isInteger(c.sdpMLineIndex) || c.sdpMLineIndex < 0 || c.sdpMLineIndex > 8))) throw new Error('Invalid phone network candidate.');
    return { type: 'candidate', candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } };
  }
  throw new Error('Unsupported phone connection message.');
}

class PhoneBridge {
  constructor(options) {
    this.options = options; this.now = options.now || Date.now;
    this.devices = new Map(); this.server = null; this.tunnel = null; this.epoch = 0;
    this.status = 'stopped'; this.message = 'Create a phone link to connect a camera or monitor.';
    this.helperPath = ''; this.origin = ''; this.rootToken = ''; this.expiresAt = 0;
    this.settingsFile = path.join(options.dataDir, 'phone-helper.json');
  }
  snapshot() {
    return { status: this.status, message: this.message, helperReady: !!this.helperPath || !!this.options.createTunnel,
      pairingURL: this.status === 'ready' && this.now() < this.expiresAt ? this.origin + '/#' + this.rootToken : '', expiresAt: this.expiresAt,
      devices: [...this.devices.values()].filter(d => d.status !== 'closed').map(d => ({ id: d.id, name: d.name, mode: d.mode, status: d.status, connection: d.connection })) };
  }
  notify() { this.options.onStatus?.(this.snapshot()); }
  async initialize() {
    this.assets = new Map();
    for (const [url, name, type] of [['/', 'index.html', 'text/html'], ['/phone-client.js', 'phone-client.js', 'text/javascript'], ['/phone.css', 'phone.css', 'text/css']]) {
      this.assets.set(url, { bytes: await fs.readFile(path.join(this.options.assetDir, name)), type });
    }
    if (this.options.createTunnel) return this.snapshot();
    let saved; try { if ((await fs.stat(this.settingsFile)).size < 8192) saved = JSON.parse(await fs.readFile(this.settingsFile, 'utf8')); } catch { /* Optional helper preference. */ }
    const candidates = [saved?.helperPath, this.options.downloadsDir && path.join(this.options.downloadsDir, 'cloudflared.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe')].filter(Boolean);
    try { const found = await execute(process.platform === 'win32' ? 'where.exe' : 'which', ['cloudflared'], { windowsHide: true, timeout: 2000, maxBuffer: 8192 }); candidates.push(...found.stdout.trim().split(/\r?\n/)); } catch { /* Optional external helper. */ }
    for (const candidate of candidates) { try { await this.checkHelper(candidate); break; } catch { /* Try next known location. */ } }
    return this.snapshot();
  }
  async checkHelper(file) {
    if (!path.isAbsolute(file) || !/^cloudflared(?:-windows-amd64)?(?:\.exe)?$/i.test(path.basename(file)) || !(await fs.stat(file)).isFile()) throw new Error('Choose the official cloudflared executable.');
    const result = await execute(file, ['--version'], { windowsHide: true, timeout: 15000, maxBuffer: 8192 });
    if (!/cloudflared version /i.test(result.stdout + result.stderr)) throw new Error('This file is not the Cloudflare connection helper.');
    this.helperPath = file;
  }
  async setHelper(file) {
    if (this.server || this.starting) throw new Error('Stop phone connections before changing the helper.');
    await this.checkHelper(file); await atomicWrite(this.settingsFile, JSON.stringify({ helperPath: file })); this.notify(); return this.snapshot();
  }
  async createTunnel(localURL, epoch) {
    if (this.options.createTunnel) return this.options.createTunnel(localURL);
    this.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-live-phone-'));
    const config = path.join(this.tempDir, 'config.yml'); await fs.writeFile(config, '{}\n');
    return new Promise((resolve, reject) => {
      const environment = {};
      for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) if (process.env[name]) environment[name] = process.env[name];
      const child = spawn(this.helperPath, ['tunnel', '--config', config, '--no-autoupdate', '--url', localURL], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: environment });
      let settled = false, tail = '';
      const fail = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('The secure phone link could not start. Check Internet access and the Cloudflare helper.')); } };
      const timer = setTimeout(() => { child.kill(); fail(); }, 40000); timer.unref?.();
      const read = bytes => {
        tail = (tail + bytes.toString()).slice(-8192);
        const match = tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
        if (match && !settled) { settled = true; clearTimeout(timer); resolve({ url: match[0], close: () => child.kill() }); }
      };
      child.stdout.on('data', read); child.stderr.on('data', read);
      child.once('error', fail);
      child.once('close', () => { if (!settled) fail(); else if (this.epoch === epoch && this.status === 'ready') void this.stop().then(() => { this.status = 'error'; this.message = 'The phone link disconnected. Create a fresh link to reconnect.'; this.notify(); }); });
      this.pendingChild = child;
    });
  }
  async start() {
    if (!this.options.isEnabled()) throw new Error('Enable Internet access to connect a phone.');
    if (this.starting) throw new Error('A phone link is already starting.');
    if (this.server) {
      if (this.status === 'ready' && (!this.rootToken || this.now() >= this.expiresAt)) { this.rootToken = token(); this.expiresAt = this.now() + 15 * 60 * 1000; this.message = 'New pairing link ready. Existing phones remain connected.'; this.notify(); }
      return this.snapshot();
    }
    if (!this.helperPath && !this.options.createTunnel) throw new Error('Choose cloudflared.exe to create a secure phone link.');
    this.starting = true; const epoch = ++this.epoch;
    this.status = 'starting'; this.message = 'Creating your secure phone link…'; this.notify();
    try {
      this.rootToken = token(); this.expiresAt = this.now() + 15 * 60 * 1000;
      this.server = http.createServer((req, res) => { void this.request(req, res).catch(() => this.json(res, 400, { error: 'Invalid phone request.' })); });
      this.server.requestTimeout = 10000; this.server.headersTimeout = 10000; this.server.maxConnections = 32;
      await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
      if (this.epoch !== epoch || !this.server) throw new Error('Phone connection cancelled.');
      this.localURL = 'http://127.0.0.1:' + this.server.address().port;
      const connection = await this.createTunnel(this.localURL, epoch);
      if (this.epoch !== epoch) { connection.close(); throw new Error('Phone connection cancelled.'); }
      const url = new URL(connection.url);
      if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname) || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) { connection.close(); throw new Error('The helper did not return a supported secure phone address.'); }
      this.tunnel = connection; this.origin = url.origin; this.status = 'ready';
      this.message = 'Scan the QR code on your phone, choose a mode, then allow the phone here.';
      this.monitor = setInterval(() => this.expire(), 5000); this.monitor.unref?.(); this.notify(); return this.snapshot();
    } catch (error) {
      if (this.epoch === epoch) { await this.stop(); this.status = 'error'; this.message = error.message; this.notify(); }
      throw error;
    } finally { this.starting = false; }
  }
  expire() {
    for (const d of this.devices.values()) {
      if (d.status === 'closed' && this.now() - d.closedAt > 15000) this.devices.delete(d.id);
      else if (d.status !== 'closed' && this.now() - d.lastSeen > (d.status === 'pending' ? 90000 : 120000)) this.remove(d.id, 'Phone connection timed out. Reconnect from the phone.');
    }
    if (this.now() >= this.expiresAt && this.rootToken) { this.rootToken = ''; this.message = 'The pairing link expired. Connected phones can continue; stop and create a new link to add another phone.'; this.notify(); }
  }
  json(res, status, body) {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body));
  }
  async body(req) {
    let length = 0; const chunks = [];
    for await (const chunk of req) { length += chunk.length; if (length > 70000) throw new Error('Phone request too large.'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  push(d, event) {
    d.events.push({ sequence: ++d.sequence, ...event });
    if (d.events.length > 128) { this.remove(d.id, 'Too many pending connection messages. Reconnect the phone.'); return; }
    if (d.waiter) { const waiter = d.waiter; d.waiter = null; clearTimeout(waiter.timer); this.events(d, waiter.res, waiter.after); }
  }
  events(d, res, after) {
    const events = d.events.filter(e => e.sequence > after);
    this.json(res, 200, { events, cursor: events.at(-1)?.sequence || after, status: d.status });
    d.events = d.events.filter(e => e.sequence > after);
  }
  device(bearer) { return [...this.devices.values()].find(d => equal(bearer, d.token)); }
  async request(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const allowedHosts = [new URL(this.localURL).host, this.origin && new URL(this.origin).host];
    if (!allowedHosts.includes(req.headers.host)) return this.json(res, 403, { error: 'Invalid phone host.' });
    if (req.headers.origin && ![this.localURL, this.origin].includes(req.headers.origin)) return this.json(res, 403, { error: 'This origin cannot use the phone connection.' });
    if (req.method === 'GET' && this.assets.has(url.pathname)) {
      const asset = this.assets.get(url.pathname);
      res.writeHead(200, { 'Content-Type': asset.type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" }); res.end(asset.bytes); return;
    }
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
    if (req.method === 'POST' && url.pathname === '/api/join') {
      if (!equal(bearer, this.rootToken) || this.now() >= this.expiresAt) return this.json(res, 401, { error: 'This pairing link expired. Create a new link in the desktop studio.' });
      if ([...this.devices.values()].filter(d => d.status !== 'closed').length >= 4) return this.json(res, 429, { error: 'The studio already has four phones waiting or connected.' });
      const input = await this.body(req);
      if (!MODES.has(input.mode) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60 || /[\x00-\x1f\x7f]/.test(input.name)) return this.json(res, 400, { error: 'Choose a phone name and connection mode.' });
      const d = { id: randomUUID(), token: token(), name: input.name.trim(), mode: input.mode, status: 'pending', connection: 'waiting', events: [], sequence: 0, lastSeen: this.now() };
      this.devices.set(d.id, d); this.notify(); return this.json(res, 201, { deviceToken: d.token, status: 'pending' });
    }
    const d = this.device(bearer);
    if (!d) return this.json(res, 401, { error: 'This phone connection ended. Reconnect from a fresh pairing link.' });
    d.lastSeen = this.now();
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const after = Number(url.searchParams.get('after') || '0');
      if (!Number.isSafeInteger(after) || after < 0 || after > d.sequence) return this.json(res, 400, { error: 'Invalid phone event cursor.' });
      if (d.waiter) return this.json(res, 409, { error: 'This phone already has an active connection reader.' });
      if (d.events.some(e => e.sequence > after) || d.status === 'closed') return this.events(d, res, after);
      const timer = setTimeout(() => { if (d.waiter?.res === res) { d.waiter = null; this.events(d, res, after); } }, this.options.pollMs || 18000);
      d.waiter = { res, after, timer }; res.on('close', () => { if (d.waiter?.res === res) { clearTimeout(timer); d.waiter = null; } }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/signal') {
      if (d.status !== 'accepted') return this.json(res, 403, { error: 'Wait for the desktop studio to approve this phone.' });
      const value = signal(await this.body(req), 'phone');
      const now = this.now(); if (!d.rate || now - d.rate.at > 10000) d.rate = { at: now, count: 0 };
      if (++d.rate.count > 120) { this.remove(d.id, 'Phone sent too many connection messages.'); return this.json(res, 429, { error: 'Connection message limit exceeded.' }); }
      this.options.onSignal?.({ deviceId: d.id, signal: value }); return this.json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/leave') { this.remove(d.id, 'Phone disconnected.'); return this.json(res, 200, { ok: true }); }
    return this.json(res, 404, { error: 'Phone route not found.' });
  }
  accept(id) {
    const d = this.devices.get(id); if (!d || d.status !== 'pending') throw new Error('This phone is no longer waiting.');
    if (d.mode !== 'monitor' && [...this.devices.values()].some(other => other.status === 'accepted' && other.mode !== 'monitor')) throw new Error('Disconnect the existing phone camera before allowing another camera.');
    d.status = 'accepted'; d.connection = 'connecting'; this.push(d, { type: 'accepted' }); this.notify(); return this.snapshot();
  }
  remove(id, message = 'Disconnected in the desktop studio.') {
    const d = this.devices.get(id); if (!d || d.status === 'closed') return this.snapshot();
    d.status = 'closed'; d.closedAt = this.now(); d.events = d.events.slice(-64); this.push(d, { type: 'closed', message });
    this.options.onSignal?.({ deviceId: d.id, closed: true }); this.notify(); return this.snapshot();
  }
  send(id, value) {
    const d = this.devices.get(id); if (!d || d.status !== 'accepted') throw new Error('This phone is not connected.');
    this.push(d, { type: 'signal', signal: signal(value, 'desktop') }); return true;
  }
  setPeerState(id, value) {
    const d = this.devices.get(id); if (!d || d.status !== 'accepted') return false;
    if (!['connecting', 'connected', 'disconnected', 'failed'].includes(value)) throw new Error('Invalid phone connection state.');
    d.connection = value; if (value === 'failed') return this.remove(id, 'Video connection failed. Check that both devices use the same Wi-Fi, then reconnect.');
    this.notify(); return true;
  }
  async stop() {
    ++this.epoch; clearInterval(this.monitor);
    for (const d of this.devices.values()) { if (d.waiter) { clearTimeout(d.waiter.timer); this.json(d.waiter.res, 200, { events: [{ sequence: d.sequence + 1, type: 'closed', message: 'Desktop phone connection stopped.' }], cursor: d.sequence + 1 }); } }
    this.devices.clear(); this.tunnel?.close(); this.tunnel = null; this.pendingChild?.kill(); this.pendingChild = null;
    const server = this.server; this.server = null;
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    if (this.tempDir) {
      const directory = await fs.realpath(this.tempDir).catch(() => '');
      const parent = await fs.realpath(os.tmpdir());
      if (directory && path.dirname(directory) === parent && path.basename(directory).startsWith('local-live-phone-')) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      this.tempDir = null;
    }
    this.origin = ''; this.rootToken = ''; this.expiresAt = 0; this.localURL = ''; this.status = 'stopped'; this.message = 'Phone connections stopped.'; this.notify(); return this.snapshot();
  }
}

module.exports = { PhoneBridge, signal, equal };
