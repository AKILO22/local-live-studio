'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHash, createCipheriv, createDecipheriv } = require('node:crypto');
const { TikTokConnection, brokerURL, makeProof, equalState } = require('../lib/tiktok.cjs');
const { createBroker, validateRedirect, tokenData } = require('../server/tiktok-broker.cjs');
const { requestJSON } = require('../lib/tiktok-http.cjs');
const { atomicWrite } = require('../lib/storage.cjs');

const code = 'synthetic-authorization-code', accessToken = 'synthetic-access-token', refreshToken = 'synthetic-refresh-token';
const clientSecret = 'synthetic-server-secret', clientKey = 'synthetic-client-key';
const tokenBody = (change = {}) => ({ access_token: accessToken, refresh_token: refreshToken, open_id: 'synthetic-open-id', scope: 'user.info.basic', expires_in: 7200, refresh_expires_in: 15552000, ...change });
const response = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; };
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-tiktok-test-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('studio-tiktok-test-')); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
function protectedStorage() {
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async value => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptStringAsync: async value => {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28));
      return { result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') };
    }
  };
}
async function fixture(t, options = {}) {
  const root = await directory(t), calls = [], opened = [], changes = [], clock = { now: 1000000000000 }, online = { value: true };
  const vendor = async (url, init) => {
    assert.ok(url.startsWith('https://open.tiktokapis.com/'));
    calls.push({ url, init });
    if (options.vendor) { const custom = await options.vendor(url, init, calls); if (custom) return custom; }
    if (url.includes('/oauth/token/')) {
      const fields = new URLSearchParams(init.body);
      return response(tokenBody(fields.get('grant_type') === 'refresh_token' ? { access_token: 'rotated-access-token', refresh_token: 'rotated-refresh-token' } : {}));
    }
    if (url.includes('/user/info/')) return response({ data: { user: { open_id: 'synthetic-open-id', display_name: 'Synthetic Creator' } }, error: { code: 'ok' } });
    if (url.includes('/oauth/revoke/')) return response({});
    throw new Error('Unexpected provider endpoint');
  };
  const vaultKey = randomBytes(32), vaultFile = path.join(root, 'server-vault.json');
  const broker = createBroker({ clientKey, clientSecret, vaultKey, vaultFile, fetch: vendor, now: () => clock.now, write: options.write });
  await new Promise(resolve => broker.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { broker.server.closeAllConnections(); await new Promise(resolve => broker.server.close(resolve)); });
  const base = `http://127.0.0.1:${broker.server.address().port}/`;
  const storage = protectedStorage();
  const client = new TikTokConnection({ dataDir: root, safeStorage: storage, fetch, isEnabled: () => online.value, openExternal: async url => { opened.push(new URL(url)); }, now: () => clock.now, onStatus: state => changes.push(state), authorizationMs: options.authorizationMs });
  t.after(() => client.close());
  await client.saveSettings(base);
  async function authorize() {
    await client.connect();
    const request = opened.at(-1), callback = new URL(request.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', request.searchParams.get('state')); callback.searchParams.set('code', code);
    const result = await fetch(callback); return { result, callback, request };
  }
  return { root, calls, opened, changes, clock, online, broker, client, storage, base, vaultFile, vaultKey, authorize };
}

test('desktop URL and redirect policies accept only HTTPS or explicit loopback development addresses', () => {
  assert.equal(brokerURL('https://connection.example'), 'https://connection.example/');
  assert.equal(brokerURL('http://127.0.0.1:4317/'), 'http://127.0.0.1:4317/');
  for (const url of ['http://remote.example/', 'file:///secret', 'https://name:pass@host/', 'https://host/?token=secret', 'https://host/#x']) assert.throws(() => brokerURL(url));
  assert.equal(validateRedirect('http://127.0.0.1:4000/tiktok/callback/'), 'http://127.0.0.1:4000/tiktok/callback/');
  for (const url of ['http://example.com:4000/tiktok/callback/', 'http://localhost:4000/tiktok/callback/', 'http://127.0.0.1:4000/other', 'http://127.0.0.1:4000/tiktok/callback/?x=1']) assert.throws(() => validateRedirect(url));
});
test('desktop PKCE uses fresh crypto verifiers and TikTok-required SHA-256 hex challenges', () => {
  const a = makeProof(), b = makeProof();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/); assert.match(a.challenge, /^[a-f0-9]{64}$/);
  assert.equal(a.challenge, createHash('sha256').update(a.verifier).digest('hex'));
  assert.notEqual(a.verifier, b.verifier); assert.notEqual(a.state, b.state);
  assert.equal(equalState(a.state, a.state), true); assert.equal(equalState('é'.repeat(64), a.state), false);
});
test('unconfigured and offline clients never open a browser or send an authorization request', async t => {
  const root = await directory(t); let opened = 0, requests = 0;
  const client = new TikTokConnection({ dataDir: root, safeStorage: protectedStorage(), isEnabled: () => false, fetch: async () => { requests++; }, openExternal: async () => { opened++; } });
  assert.equal((await client.initialize()).status, 'setup-required');
  await client.saveSettings('https://connection.example/');
  await assert.rejects(client.connect(), /Enable Internet/);
  assert.equal(opened, 0); assert.equal(requests, 0);
});
test('full desktop callback and broker flow return only profile data and protected opaque session credentials', async t => {
  const f = await fixture(t), { result, request } = await f.authorize();
  assert.equal(result.status, 200); assert.match(await result.text(), /TikTok account connected/);
  assert.equal(request.origin, 'https://www.tiktok.com'); assert.equal(request.pathname, '/v2/auth/authorize/');
  assert.equal(request.searchParams.get('scope'), 'user.info.basic'); assert.equal(request.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(f.client.snapshot().status, 'connected');
  assert.equal(f.client.snapshot().profile.displayName, 'Synthetic Creator');
  const stateText = JSON.stringify(f.changes); assert.ok(!stateText.includes(accessToken) && !stateText.includes(refreshToken) && !stateText.includes(clientSecret));
  const localBytes = await fs.readFile(f.client.linkFile); assert.ok(!localBytes.includes(Buffer.from(f.client.link.sessionToken)));
  const serverBytes = await fs.readFile(f.vaultFile, 'utf8'); assert.ok(!serverBytes.includes(accessToken) && !serverBytes.includes(refreshToken));
  const tokenCall = f.calls.find(call => call.url.includes('/oauth/token/')), fields = new URLSearchParams(tokenCall.init.body);
  assert.equal(fields.get('client_secret'), clientSecret); assert.equal(fields.get('code'), code);
  assert.equal(createHash('sha256').update(fields.get('code_verifier')).digest('hex'), request.searchParams.get('code_challenge'));
  assert.equal(fields.get('redirect_uri'), request.searchParams.get('redirect_uri'));
});
test('invalid and duplicate callback parameters leave the legitimate authorization usable', async t => {
  const f = await fixture(t); await f.client.connect();
  const auth = f.opened[0], callback = new URL(auth.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', 'a'.repeat(64)); callback.searchParams.set('code', code);
  assert.equal((await fetch(callback)).status, 400);
  callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.append('code', 'duplicate');
  assert.equal((await fetch(callback)).status, 400); assert.equal(f.calls.length, 0);
  callback.searchParams.delete('code'); callback.searchParams.set('code', code);
  assert.equal((await fetch(callback)).status, 200);
});
test('declined consent never exchanges codes and never echoes provider error text into HTML', async t => {
  const f = await fixture(t); await f.client.connect();
  const callback = new URL(f.opened[0].searchParams.get('redirect_uri'));
  callback.searchParams.set('state', f.opened[0].searchParams.get('state')); callback.searchParams.set('error', 'access_denied'); callback.searchParams.set('error_description', '<script>secret</script>');
  const result = await fetch(callback), html = await result.text();
  assert.ok(!html.includes('script>')); assert.equal(f.calls.length, 0);
  assert.equal(f.client.snapshot().connected, false); assert.match(f.client.snapshot().message, /declined/);
});
test('a saved desktop link restores as unverified and is verified only after refreshing with the server', async t => {
  const f = await fixture(t); await f.authorize(); await f.client.close();
  const next = new TikTokConnection({ dataDir: f.root, safeStorage: f.storage, fetch, isEnabled: () => true, openExternal: async () => {}, now: () => f.clock.now }); t.after(() => next.close());
  assert.equal((await next.initialize()).status, 'saved');
  const state = await next.refresh(); assert.equal(state.status, 'connected'); assert.equal(state.busy, false);
  assert.equal((await next.initialize()).status, 'connected');
});
test('backend rotates and persists refresh tokens once before concurrent profile requests proceed', async t => {
  const f = await fixture(t); await f.authorize(); f.clock.now += 7200000;
  const token = f.client.link.sessionToken;
  const [a, b] = await Promise.all([fetch(f.base + 'v1/tiktok/profile', { headers: { Authorization: 'Bearer ' + token } }), fetch(f.base + 'v1/tiktok/profile', { headers: { Authorization: 'Bearer ' + token } })]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const refreshes = f.calls.filter(call => call.url.includes('/oauth/token/') && new URLSearchParams(call.init.body).get('grant_type') === 'refresh_token');
  assert.equal(refreshes.length, 1); assert.equal(new URLSearchParams(refreshes[0].init.body).get('refresh_token'), refreshToken);
  const data = await f.broker.vault.read(), record = Object.values(data.sessions)[0];
  assert.equal(record.refreshToken, 'rotated-refresh-token'); assert.equal(record.accessToken, 'rotated-access-token');
});
test('disconnect revokes the provider authorization, removes the server session and clears the protected local link', async t => {
  const f = await fixture(t); await f.authorize();
  const state = await f.client.disconnect(); assert.equal(state.hasSavedLink, false);
  assert.equal((await fs.readFile(f.client.linkFile)).length, 0);
  assert.equal(Object.keys((await f.broker.vault.read()).sessions).length, 0);
  const revoke = f.calls.find(call => call.url.includes('/oauth/revoke/'));
  assert.equal(new URLSearchParams(revoke.init.body).get('token'), accessToken);
});
test('offline cancellation closes the loopback listener, and local forgetting performs no remote revocation', async t => {
  const f = await fixture(t); await f.client.connect(); const redirect = f.opened[0].searchParams.get('redirect_uri');
  f.online.value = false; f.client.cancel(); await assert.rejects(fetch(redirect));
  assert.equal(f.calls.length, 0); f.online.value = true; await f.authorize();
  const count = f.calls.length; f.online.value = false; await f.client.forget();
  assert.equal(f.calls.length, count); assert.equal(f.client.snapshot().hasSavedLink, false);
});
test('authorization times out and browser-launch failures never leak authorization URLs', async t => {
  const f = await fixture(t, { authorizationMs: 20 }); await f.client.connect();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.client.snapshot().busy, false); assert.match(f.client.snapshot().message, /timed out/);
  f.client.options.openExternal = async url => { throw new Error(url); };
  await assert.rejects(f.client.connect(), /browser could not open/);
  assert.ok(!f.client.snapshot().message.includes('code_challenge'));
});
test('protected-storage failures stop authorization before the browser is opened', async t => {
  const f = await fixture(t); f.storage.isAsyncEncryptionAvailable = async () => false;
  await assert.rejects(f.client.connect(), /protected storage/); assert.equal(f.opened.length, 0);
});
test('cancel while encrypting discards the local link and cleans up the newly issued broker session', async t => {
  const f = await fixture(t), started = deferred(), release = deferred(), original = f.storage.encryptStringAsync;
  f.storage.encryptStringAsync = async value => { started.resolve(); await release.promise; return original(value); };
  const completed = f.authorize(); await started.promise; f.client.cancel(); release.resolve();
  await assert.rejects(completed, /fetch failed/); await f.client.close(); assert.equal(f.client.snapshot().hasSavedLink, false);
  assert.equal(Object.keys((await f.broker.vault.read()).sessions).length, 0);
});
test('backend rejects unknown bearer sessions and browser-origin requests and keeps credentials server-side', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + 'v1/tiktok/profile')).status, 401);
  assert.equal((await fetch(f.base + 'v1/tiktok/profile', { headers: { Authorization: 'Bearer ' + '0'.repeat(64) } })).status, 401);
  assert.equal((await fetch(f.base + 'v1/tiktok/config', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const config = await (await fetch(f.base + 'v1/tiktok/config')).json(); assert.equal(config.clientKey, clientKey); assert.ok(!JSON.stringify(config).includes(clientSecret));
});
test('backend validates authorization request schema, body sizes and granted scope', async t => {
  const f = await fixture(t);
  const post = body => fetch(f.base + 'v1/tiktok/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ code, codeVerifier: 'short', redirectUri: 'file:///secret' })).status, 400);
  assert.equal((await post({ padding: 'x'.repeat(9000) })).status, 413);
  assert.throws(() => tokenData(tokenBody({ scope: 'video.list' }), 0), /required profile/);
  assert.throws(() => tokenData(tokenBody({ expires_in: 0 }), 0), /required profile/);
});
test('a damaged encrypted vault fails closed and is never overwritten', async t => {
  const f = await fixture(t); await fs.writeFile(f.vaultFile, '{bad');
  const result = await fetch(f.base + 'v1/tiktok/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, codeVerifier: makeProof().verifier, redirectUri: 'http://127.0.0.1:4000/tiktok/callback/' }) });
  assert.equal(result.status, 503); assert.equal(await fs.readFile(f.vaultFile, 'utf8'), '{bad'); assert.equal(f.calls.length, 0);
});
test('failed refresh persistence prevents reusing a rotated refresh token in the running broker', async t => {
  let deny = false;
  const f = await fixture(t, { write: async (file, bytes) => { if (deny) throw new Error('disk denied'); return atomicWrite(file, bytes); } });
  await f.authorize(); f.clock.now += 7200000; deny = true;
  const get = () => fetch(f.base + 'v1/tiktok/profile', { headers: { Authorization: 'Bearer ' + f.client.link.sessionToken } });
  assert.equal((await get()).status, 503); assert.equal((await get()).status, 401);
  assert.equal(f.calls.filter(call => call.url.includes('/oauth/token/')).length, 2);
});
test('bounded JSON transport cancels stalled fetches, rejects oversized responses and skips pre-aborted work', async () => {
  await assert.rejects(requestJSON(() => new Promise(() => {}), 'https://unused.example', { timeout: 5 }), /cancelled or timed out/);
  await assert.rejects(requestJSON(async () => response({ large: 'x'.repeat(70000) }), 'https://unused.example'), /valid data/);
  const controller = new AbortController(); controller.abort(); let called = false;
  await assert.rejects(requestJSON(async () => { called = true; }, 'https://unused.example', { signal: controller.signal }), /cancelled or timed out/); assert.equal(called, false);
});
