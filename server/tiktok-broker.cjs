'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv, createHash } = require('node:crypto');
const { atomicWrite } = require('../lib/storage.cjs');
const { requestJSON } = require('../lib/tiktok-http.cjs');

const CALLBACK_PATH = '/tiktok/callback/';
const SCOPE = 'user.info.basic';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';
const PROFILE_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name';
class BrokerError extends Error { constructor(status, message) { super(message); this.status = status; } }
function bounded(value, min, max) { return typeof value === 'string' && value.length >= min && value.length <= max && !/[\x00-\x1f\x7f]/.test(value); }
function validateRedirect(input) {
  let url; try { url = new URL(input); } catch { throw new BrokerError(400, 'Invalid desktop callback address.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== CALLBACK_PATH || url.search || url.hash || url.username || url.password) throw new BrokerError(400, 'Invalid desktop callback address.');
  return url.href;
}
function tokenData(body, now) {
  if (!bounded(body.access_token, 1, 8192) || !bounded(body.refresh_token, 1, 8192) || !bounded(body.open_id, 1, 256) ||
      !Number.isSafeInteger(body.expires_in) || body.expires_in <= 0 || body.expires_in > 31536000 ||
      !Number.isSafeInteger(body.refresh_expires_in) || body.refresh_expires_in <= 0 || body.refresh_expires_in > 315360000 ||
      typeof body.scope !== 'string' || !body.scope.split(',').map(scope => scope.trim()).includes(SCOPE)) throw new BrokerError(502, 'TikTok did not return the required profile authorization.');
  return { accessToken: body.access_token, refreshToken: body.refresh_token, openId: body.open_id, scope: SCOPE, expiresAt: now + body.expires_in * 1000, refreshExpiresAt: now + body.refresh_expires_in * 1000 };
}
function profileData(body, openId) {
  const user = body.data?.user;
  if (body.error?.code !== 'ok' || user?.open_id !== openId || !bounded(user.display_name, 1, 200)) throw new BrokerError(502, 'TikTok profile information could not be verified.');
  return { displayName: user.display_name };
}
function keyHash(token) { return createHash('sha256').update(token).digest('hex'); }

class BrokerVault {
  constructor(file, key, write = atomicWrite) { this.file = file; this.key = key; this.write = write; this.tail = Promise.resolve(); this.pending = 0; }
  async read() {
    try {
      const stat = await fs.stat(this.file); if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error();
      const envelope = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (envelope.version !== 1) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
      if (data.version !== 1 || !data.sessions || Array.isArray(data.sessions) || Object.keys(data.sessions).length > 1000) throw new Error();
      for (const [id, record] of Object.entries(data.sessions)) {
        if (!/^[a-f0-9]{64}$/.test(id) || !bounded(record.accessToken, 1, 8192) || !bounded(record.refreshToken, 1, 8192) || !bounded(record.openId, 1, 256) || record.scope !== SCOPE ||
            ![record.expiresAt, record.refreshExpiresAt, record.sessionExpiresAt].every(Number.isSafeInteger)) throw new Error();
      }
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, sessions: {} };
      throw new BrokerError(503, 'The encrypted TikTok session store is unavailable.');
    }
  }
  async save(data) {
    if (Buffer.byteLength(JSON.stringify(data)) > 8 * 1024 * 1024) throw new BrokerError(503, 'The TikTok session store is full.');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    await this.write(this.file, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: bytes.toString('base64') }));
  }
  transact(action) {
    if (this.pending >= 16) return Promise.reject(new BrokerError(429, 'The TikTok connection service is busy. Please retry.'));
    this.pending++;
    const result = this.tail.then(async () => action(await this.read()));
    this.tail = result.catch(() => {}).finally(() => this.pending--);
    return result;
  }
}

function createBroker(options) {
  const { clientKey, clientSecret, vaultKey, vaultFile } = options;
  if (!bounded(clientKey, 1, 256) || !bounded(clientSecret, 1, 512) || !Buffer.isBuffer(vaultKey) || vaultKey.length !== 32 || !path.isAbsolute(vaultFile)) throw new Error('Configure TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_VAULT_KEY (32 bytes in base64), and a persistent vault path.');
  const fetcher = options.fetch || fetch, now = options.now || Date.now;
  const vault = new BrokerVault(vaultFile, vaultKey, options.write);
  const limits = new Map();
  const failedRotations = new Set();
  async function upstream(url, fields, token) {
    const result = await requestJSON(fetcher, url, fields ? { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() } : { headers: { Authorization: `Bearer ${token}` } });
    if (result.status < 200 || result.status >= 300 || result.body.error && (typeof result.body.error === 'string' || result.body.error.code !== 'ok')) {
      throw new BrokerError(502, 'TikTok declined the request. Check Login Kit approval, credentials, and the registered callback address.');
    }
    return result.body;
  }
  async function connect(input) {
    if (!bounded(input?.code, 1, 4096) || !/^[A-Za-z0-9._~-]{43,128}$/.test(input?.codeVerifier || '')) throw new BrokerError(400, 'Invalid authorization response.');
    const redirectUri = validateRedirect(input.redirectUri);
    return vault.transact(async data => {
      for (const [key, session] of Object.entries(data.sessions)) if (session.sessionExpiresAt <= now() || session.refreshExpiresAt <= now()) { delete data.sessions[key]; failedRotations.delete(key); }
      if (Object.keys(data.sessions).length >= 1000) throw new BrokerError(503, 'The TikTok connection service has reached its session limit.');
      const tokens = tokenData(await upstream(TOKEN_URL, { client_key: clientKey, client_secret: clientSecret, code: input.code, code_verifier: input.codeVerifier, redirect_uri: redirectUri, grant_type: 'authorization_code' }), now());
      let profile;
      try { profile = profileData(await upstream(PROFILE_URL, null, tokens.accessToken), tokens.openId); }
      catch (error) { await upstream(REVOKE_URL, { client_key: clientKey, client_secret: clientSecret, token: tokens.accessToken }).catch(() => {}); throw error; }
      const sessionToken = randomBytes(32).toString('hex');
      const sessionExpiresAt = Math.min(now() + 30 * 86400000, tokens.refreshExpiresAt);
      data.sessions[keyHash(sessionToken)] = { ...tokens, sessionExpiresAt };
      try { await vault.save(data); }
      catch { await upstream(REVOKE_URL, { client_key: clientKey, client_secret: clientSecret, token: tokens.accessToken }).catch(() => {}); throw new BrokerError(503, 'The TikTok connection could not be saved. Please retry.'); }
      return { sessionToken, profile, sessionExpiresAt, scope: SCOPE };
    });
  }
  async function account(token, disconnect = false) {
    if (!/^[a-f0-9]{64}$/.test(token || '')) throw new BrokerError(401, 'Reconnect your TikTok account.');
    return vault.transact(async data => {
      const id = keyHash(token), record = data.sessions[id];
      if (failedRotations.has(id)) throw new BrokerError(401, 'A refreshed connection could not be saved. Reconnect your TikTok account.');
      if (!record || record.sessionExpiresAt <= now() || record.refreshExpiresAt <= now()) throw new BrokerError(401, 'Your saved TikTok connection expired. Reconnect your account.');
      if (record.expiresAt <= now() + 60000) {
        const updated = tokenData(await upstream(TOKEN_URL, { client_key: clientKey, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: record.refreshToken }), now());
        if (updated.openId !== record.openId) throw new BrokerError(502, 'TikTok returned a different account during refresh.');
        Object.assign(record, updated); record.sessionExpiresAt = Math.min(record.sessionExpiresAt, updated.refreshExpiresAt);
        // Persist rotation before any other request can reuse the previous token.
        try { await vault.save(data); }
        catch { failedRotations.add(id); await upstream(REVOKE_URL, { client_key: clientKey, client_secret: clientSecret, token: record.accessToken }).catch(() => {}); throw new BrokerError(503, 'A refreshed connection could not be saved. Reconnect your TikTok account after fixing session storage.'); }
      }
      if (disconnect) {
        await upstream(REVOKE_URL, { client_key: clientKey, client_secret: clientSecret, token: record.accessToken });
        delete data.sessions[id]; await vault.save(data);
        return { disconnected: true };
      }
      return { profile: profileData(await upstream(PROFILE_URL, null, record.accessToken), record.openId), sessionExpiresAt: record.sessionExpiresAt, scope: SCOPE };
    });
  }
  async function readBody(req) {
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new BrokerError(415, 'Use JSON requests.');
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) throw new BrokerError(413, 'The request is too large.'); chunks.push(chunk); }
    try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; }
    catch { throw new BrokerError(400, 'Invalid JSON request.'); }
  }
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
    try {
      if (req.headers.origin) throw new BrokerError(403, 'Browser requests are not supported by this service.');
      const time = now(); for (const [key, value] of limits) if (value.until <= time) limits.delete(key);
      const peer = req.socket.remoteAddress || 'unknown', limit = limits.get(peer) || { count: 0, until: time + 60000 };
      if (limit.count >= 60 || !limits.has(peer) && limits.size >= 1000) { res.setHeader('Retry-After', '60'); throw new BrokerError(429, 'Please wait a minute before retrying.'); }
      limit.count++; limits.set(peer, limit);
      if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
      if (req.method === 'GET' && req.url === '/v1/tiktok/config') return send(200, { version: 1, clientKey, scope: SCOPE, callbackPath: CALLBACK_PATH });
      if (req.method === 'POST' && req.url === '/v1/tiktok/connect') return send(200, await connect(await readBody(req)));
      const match = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
      if (req.method === 'GET' && req.url === '/v1/tiktok/profile') return send(200, await account(match?.[1]));
      if (req.method === 'POST' && req.url === '/v1/tiktok/disconnect') return send(200, await account(match?.[1], true));
      throw new BrokerError(404, 'This endpoint does not exist.');
    } catch (error) { if (!res.headersSent) send(error instanceof BrokerError ? error.status : 502, { error: error instanceof BrokerError ? error.message : 'The TikTok connection service could not complete this request.' }); else res.destroy(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 32;
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return { server, vault };
}
if (require.main === module) {
  try {
    const instance = createBroker({ clientKey: process.env.TIKTOK_CLIENT_KEY, clientSecret: process.env.TIKTOK_CLIENT_SECRET, vaultKey: Buffer.from(process.env.TIKTOK_VAULT_KEY || '', 'base64'), vaultFile: path.resolve(process.env.TIKTOK_VAULT_FILE || 'data/tiktok-vault.json') });
    const port = Number(process.env.TIKTOK_BROKER_PORT || 4317);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a valid TIKTOK_BROKER_PORT.');
    instance.server.on('error', () => { console.error('The TikTok broker could not bind its listening address.'); process.exitCode = 1; });
    instance.server.listen(port, process.env.TIKTOK_BROKER_HOST || '127.0.0.1', () => console.log(`TikTok connection broker listening on port ${port}. Keep its credentials private.`));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { createBroker, BrokerVault, validateRedirect, tokenData, CALLBACK_PATH, SCOPE };
