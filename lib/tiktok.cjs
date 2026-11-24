'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { atomicWrite } = require('./storage.cjs');
const { requestJSON } = require('./tiktok-http.cjs');
const CALLBACK_PATH = '/tiktok/callback/';
const SCOPE = 'user.info.basic';
const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
function brokerURL(input) {
  if (typeof input !== 'string' || input.length > 2048 || /[\x00-\x1f\x7f\\]/.test(input)) throw new Error('Enter your TikTok connection server URL.');
  let url; try { url = new URL(input.trim()); } catch { throw new Error('Enter a valid connection server URL.'); }
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol) ||
      url.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Use HTTPS, or HTTP on localhost for development. Do not include credentials, query parameters, or fragments.');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url.href;
}
function makeProof() { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('hex'), state: randomBytes(32).toString('hex') }; }
function equalState(a, b) { return typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function profile(value) {
  if (typeof value?.displayName !== 'string' || !value.displayName || value.displayName.length > 200 || /[\x00-\x1f\x7f]/.test(value.displayName)) throw new Error('The connection server returned an invalid profile.');
  return { displayName: value.displayName };
}

class TikTokConnection {
  constructor(options) {
    this.options = options;
    this.settingsFile = path.join(options.dataDir, 'tiktok-settings.json');
    this.linkFile = path.join(options.dataDir, 'tiktok-link.bin');
    this.url = ''; this.link = null; this.verified = false; this.flow = null; this.busy = false; this.message = '';
    this.requests = new Set(); this.epoch = 0; this.initPromise = null; this.tail = Promise.resolve();
    this.callbacks = new Set();
    this.cleanupRequests = new Set();
    this.now = options.now || Date.now;
  }
  async encryptionAvailable() {
    const storage = this.options.safeStorage;
    if (process.platform === 'linux' && storage.getSelectedStorageBackend?.() === 'basic_text') return false;
    return storage.isAsyncEncryptionAvailable ? storage.isAsyncEncryptionAvailable() : storage.isEncryptionAvailable?.() === true;
  }
  async encrypt(value) { const storage = this.options.safeStorage; return storage.encryptStringAsync ? storage.encryptStringAsync(value) : storage.encryptString(value); }
  async decrypt(bytes) {
    const storage = this.options.safeStorage;
    const result = storage.decryptStringAsync ? await storage.decryptStringAsync(bytes) : storage.decryptString(bytes);
    return typeof result === 'string' ? result : result.result;
  }
  initialize() {
    this.initPromise ||= (async () => {
      try {
        const stat = await fs.stat(this.settingsFile); if (stat.size > 4096) throw new Error();
        const data = JSON.parse(await fs.readFile(this.settingsFile, 'utf8'));
        this.url = data.brokerURL ? brokerURL(data.brokerURL) : '';
      } catch (error) { if (error.code !== 'ENOENT') this.message = 'The saved connection server could not be read. Save its address again.'; }
      try {
        const stat = await fs.stat(this.linkFile); if (stat.size > 65536) throw new Error();
        if (stat.size) {
          if (!await this.encryptionAvailable()) throw new Error();
          const data = JSON.parse(await this.decrypt(await fs.readFile(this.linkFile)));
          if (data.version !== 1 || data.brokerURL !== this.url || !/^[a-f0-9]{64}$/.test(data.sessionToken) || !Number.isSafeInteger(data.sessionExpiresAt)) throw new Error();
          this.link = { version: 1, brokerURL: this.url, sessionToken: data.sessionToken, sessionExpiresAt: data.sessionExpiresAt, profile: profile(data.profile) };
        }
      } catch (error) { if (error.code !== 'ENOENT') this.message = 'The saved TikTok connection could not be read. Use Forget local link, then reconnect.'; }
      return this.snapshot();
    })();
    return this.initPromise.then(() => this.snapshot());
  }
  snapshot() {
    const expired = !!this.link && this.link.sessionExpiresAt <= this.now(), online = this.options.isEnabled() === true;
    return { configured: !!this.url, brokerURL: this.url, hasSavedLink: !!this.link, connected: !!this.link && !expired,
      status: this.flow ? 'authorizing' : this.busy ? 'working' : expired ? 'expired' : this.link ? this.verified && online ? 'connected' : 'saved' : this.url ? 'ready' : 'setup-required', busy: this.busy || !!this.flow,
      profile: this.link ? { ...this.link.profile } : null, internetEnabled: online, message: this.message, scope: SCOPE, callbackPath: CALLBACK_PATH,
      sessionExpiresAt: this.link?.sessionExpiresAt || null };
  }
  notify() { try { this.options.onStatus?.(this.snapshot()); } catch { /* Closing workspace. */ } }
  requireOnline() { if (!this.options.isEnabled()) throw new Error('Enable Internet access to connect to TikTok.'); }
  async api(endpoint, body, sessionToken, cleanup = false) {
    this.requireOnline();
    if (!this.url) throw new Error('Save your TikTok connection server address first.');
    const controller = new AbortController(), requests = cleanup ? this.cleanupRequests : this.requests; requests.add(controller);
    try {
      const result = await requestJSON(this.options.fetch, new URL('v1/tiktok/' + endpoint, this.url).href, {
        method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(sessionToken ? { Authorization: 'Bearer ' + sessionToken } : {}) }
      });
      this.requireOnline();
      if (result.status < 200 || result.status >= 300) {
        if (result.status === 401) throw new Error('The TikTok connection expired or was revoked. Forget the local link and reconnect.');
        if (result.status === 429) throw new Error('The connection service is busy. Please retry shortly.');
        throw new Error('The TikTok connection service could not complete this request. Check its setup and try again.');
      }
      return result.body;
    } finally { requests.delete(controller); }
  }
  async saveSettings(input) {
    await this.initialize();
    if (this.flow || this.busy || this.link) throw new Error('Cancel authorization or disconnect the saved account before changing servers.');
    const url = brokerURL(input);
    const operation = this.tail.then(async () => { await atomicWrite(this.settingsFile, JSON.stringify({ version: 1, brokerURL: url })); this.url = url; this.message = 'Connection server saved. Choose Connect TikTok when Login Kit is ready.'; this.notify(); return this.snapshot(); });
    this.tail = operation.catch(() => {}); return operation;
  }
  persistLink(link, epoch) {
    const operation = this.tail.then(async () => {
      if (epoch !== this.epoch) throw new Error('TikTok authorization was cancelled.');
      let bytes;
      try { bytes = await this.encrypt(JSON.stringify(link)); }
      catch { throw new Error('The TikTok link could not be protected by Windows storage.'); }
      if (epoch !== this.epoch) throw new Error('TikTok authorization was cancelled.');
      await atomicWrite(this.linkFile, bytes);
      if (epoch !== this.epoch) { await atomicWrite(this.linkFile, Buffer.alloc(0)); throw new Error('TikTok authorization was cancelled.'); }
      this.link = link;
    });
    this.tail = operation.catch(() => {}); return operation;
  }
  async checkServer() {
    const config = await this.api('config');
    if (config.version !== 1 || typeof config.clientKey !== 'string' || !/^[A-Za-z0-9._-]{1,256}$/.test(config.clientKey) || config.scope !== SCOPE || config.callbackPath !== CALLBACK_PATH) throw new Error('This server does not provide the expected TikTok Login Kit configuration.');
    return config;
  }
  async connect() {
    await this.initialize(); await this.tail; this.requireOnline();
    if (this.flow || this.busy) throw new Error('A TikTok authorization is already running.');
    if (this.link) throw new Error('Disconnect or forget the saved TikTok account before connecting another.');
    if (!await this.encryptionAvailable()) throw new Error('Windows protected storage is unavailable. The account cannot be saved safely.');
    this.busy = true; const epoch = ++this.epoch; this.message = 'Checking the TikTok connection server…'; this.notify();
    try {
      const config = await this.checkServer();
      if (epoch !== this.epoch) throw new Error('TikTok authorization was cancelled.');
      const proof = makeProof(), flow = { ...proof, epoch, claimed: false, server: null, timer: null };
      const server = http.createServer((req, res) => {
        const task = this.callback(flow, req, res).catch(() => { if (!res.headersSent) this.reply(res, 500, false); else res.end(); this.finish(flow, 'TikTok authorization could not be saved. Please retry.'); });
        this.callbacks.add(task); task.finally(() => this.callbacks.delete(task)).catch(() => {});
      });
      server.headersTimeout = 5000; server.requestTimeout = 5000; server.maxConnections = 8; server.maxHeadersCount = 24;
      flow.server = server; this.flow = flow;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); server.on('error', () => this.finish(flow, 'The local TikTok callback stopped unexpectedly.')); resolve(); }); });
      if (epoch !== this.epoch || this.flow !== flow) throw new Error('TikTok authorization was cancelled.');
      flow.redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;
      flow.timer = setTimeout(() => this.finish(flow, 'TikTok authorization timed out. Choose Connect TikTok to retry.'), this.options.authorizationMs || 180000); flow.timer.unref?.();
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({ client_key: config.clientKey, response_type: 'code', scope: SCOPE, redirect_uri: flow.redirectUri, state: proof.state, code_challenge: proof.challenge, code_challenge_method: 'S256' }).toString();
      this.message = 'Finish sign-in and approval on TikTok’s website, then return to the studio.'; this.notify();
      try { await this.options.openExternal(url.href); }
      catch { throw new Error('Your browser could not open TikTok. Check the default browser and retry.'); }
      if (epoch === this.epoch) this.busy = false;
      return this.snapshot();
    } catch (error) { if (this.flow?.epoch === epoch) this.finish(this.flow, 'TikTok authorization could not start. Check your connection server.'); if (epoch === this.epoch) this.message = error.message; throw error; }
    finally { if (epoch === this.epoch) { this.busy = false; this.notify(); } }
  }
  reply(res, code, success) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Local LIVE Studio</title><h1>${success ? 'TikTok account connected' : 'TikTok authorization was not completed'}</h1><p>Return to Local LIVE Studio to continue.</p></html>`);
  }
  async callback(flow, req, res) {
    if (this.flow !== flow || flow.epoch !== this.epoch || !flow.redirectUri) return this.reply(res, 410, false);
    const expected = new URL(flow.redirectUri);
    if (req.method !== 'GET' || req.headers.host !== expected.host || req.url.length > 8192) return this.reply(res, 400, false);
    let url; try { url = new URL(req.url, flow.redirectUri); } catch { return this.reply(res, 400, false); }
    const query = url.searchParams;
    if (url.origin !== expected.origin || url.pathname !== CALLBACK_PATH || query.getAll('state').length !== 1 || !equalState(query.get('state'), flow.state)) return this.reply(res, 400, false);
    if (flow.claimed) return this.reply(res, 409, false);
    if (query.has('error')) { flow.claimed = true; this.reply(res, 200, false); this.finish(flow, 'TikTok authorization was declined or cancelled.'); return; }
    if (query.getAll('code').length !== 1 || !query.get('code') || query.get('code').length > 4096) return this.reply(res, 400, false);
    flow.claimed = true;
    let receipt;
    try {
      receipt = await this.api('connect', { code: query.get('code'), codeVerifier: flow.verifier, redirectUri: flow.redirectUri });
      if (this.flow !== flow || flow.epoch !== this.epoch) throw new Error('TikTok authorization was cancelled.');
      if (!/^[a-f0-9]{64}$/.test(receipt.sessionToken || '') || !Number.isSafeInteger(receipt.sessionExpiresAt) || receipt.sessionExpiresAt <= this.now() || receipt.scope !== SCOPE) throw new Error('The connection server returned an invalid session.');
      const link = { version: 1, brokerURL: this.url, sessionToken: receipt.sessionToken, profile: profile(receipt.profile), sessionExpiresAt: receipt.sessionExpiresAt };
      await this.persistLink(link, flow.epoch);
      this.verified = true;
      this.reply(res, 200, true); this.finish(flow, 'TikTok profile connected successfully.');
    } catch {
      if (receipt?.sessionToken && /^[a-f0-9]{64}$/.test(receipt.sessionToken)) await this.api('disconnect', {}, receipt.sessionToken, true).catch(() => {});
      this.reply(res, 400, false); this.finish(flow, 'TikTok authorization could not be completed. Check Login Kit setup and try again.');
    }
  }
  finish(flow, message) {
    clearTimeout(flow.timer);
    try { flow.server?.close(); flow.server?.closeIdleConnections(); } catch { /* Listener never started. */ }
    if (this.flow === flow) { this.flow = null; this.message = message; this.notify(); }
  }
  cancel() {
    this.epoch++;
    for (const request of this.requests) request.abort();
    if (!this.options.isEnabled()) for (const request of this.cleanupRequests) request.abort();
    if (this.flow) { this.flow.server?.closeAllConnections(); this.finish(this.flow, 'TikTok authorization cancelled.'); }
    this.busy = false; this.verified = false; this.notify();
    return this.snapshot();
  }
  async refresh() {
    await this.initialize();
    if (this.busy || this.flow) throw new Error('Wait for the current TikTok request to finish.');
    if (!this.link) throw new Error('Connect a TikTok account first.');
    this.busy = true; const epoch = this.epoch; this.notify();
    try {
      const result = await this.api('profile', undefined, this.link.sessionToken);
      const next = { ...this.link, profile: profile(result.profile), sessionExpiresAt: result.sessionExpiresAt };
      if (!Number.isSafeInteger(next.sessionExpiresAt) || next.sessionExpiresAt <= this.now()) throw new Error('The saved connection expired. Reconnect TikTok.');
      await this.persistLink(next, epoch);
      this.verified = true; this.busy = false; this.message = 'TikTok account refreshed.'; return this.snapshot();
    } catch (error) { this.verified = false; this.message = error.message; this.notify(); throw error; }
    finally { if (epoch === this.epoch) { this.busy = false; this.notify(); } }
  }
  async disconnect() {
    await this.initialize();
    if (this.busy || this.flow) throw new Error('Wait for the current TikTok request to finish.');
    if (!this.link) return this.forget();
    const result = await this.api('disconnect', {}, this.link.sessionToken);
    if (result.disconnected !== true) throw new Error('The connection server did not confirm disconnection.');
    await this.forget(); this.message = 'TikTok authorization revoked and the local connection removed.'; this.notify(); return this.snapshot();
  }
  async forget() {
    await this.initialize(); this.cancel();
    const operation = this.tail.then(async () => { await atomicWrite(this.linkFile, Buffer.alloc(0)); this.link = null; this.verified = false; });
    this.tail = operation.catch(() => {}); await operation;
    this.message = 'Local TikTok link removed. This action alone does not revoke access on TikTok.'; this.notify(); return this.snapshot();
  }
  async close() { this.cancel(); await Promise.allSettled([...this.callbacks]); await this.tail; }
}
module.exports = { TikTokConnection, brokerURL, makeProof, equalState, AUTH_URL, CALLBACK_PATH, SCOPE };
