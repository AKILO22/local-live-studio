'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { AccountStore } = require('../lib/accounts.cjs');
const password = 'Synthetic-studio-password-2026';
const input = { name: 'Studio QA', email: 'studio@example.invalid', password };

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-account-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('studio-account-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test('local accounts store salted password hashes and only expose public identity', async t => {
  const root = await directory(t), accounts = new AccountStore(root);
  assert.deepEqual(await accounts.status(), { user: null, available: true });
  const user = await accounts.create({ ...input, name: ' Studio QA ', email: ' STUDIO@EXAMPLE.INVALID ' });
  assert.deepEqual(Object.keys(user).sort(), ['email', 'id', 'name']);
  assert.equal(user.email, input.email);
  assert.equal(user.name, input.name);
  assert.deepEqual((await accounts.status()).user, user);
  const text = await fs.readFile(accounts.file, 'utf8');
  assert.ok(!text.includes(password));
  const stored = JSON.parse(text).users[0];
  assert.equal(stored.algorithm, 'scrypt-v1');
  assert.match(stored.salt, /^[a-f0-9]{32}$/);
  assert.match(stored.hash, /^[a-f0-9]{64}$/);
  const other = await accounts.create({ ...input, email: 'other@example.invalid' });
  const users = JSON.parse(await fs.readFile(accounts.file, 'utf8')).users;
  assert.notEqual(users[0].hash, users[1].hash);
  assert.notEqual(user.id, other.id);
});

test('sign-in works across a restart while signed-in sessions are not persisted', async t => {
  const root = await directory(t), first = new AccountStore(root);
  const created = await first.create(input);
  const next = new AccountStore(root);
  assert.equal((await next.status()).user, null);
  assert.deepEqual(await next.signIn({ email: 'STUDIO@EXAMPLE.INVALID', password }), created);
  await next.signOut();
  assert.equal((await next.status()).user, null);
  assert.equal(JSON.parse(await fs.readFile(next.file, 'utf8')).users.length, 1);
});

test('wrong and unknown credentials return the same failure and preserve the current session', async t => {
  const accounts = new AccountStore(await directory(t));
  const user = await accounts.create(input);
  await assert.rejects(accounts.signIn({ email: input.email, password: 'wrong-password-long-enough' }), { message: 'Email or password is incorrect.' });
  await assert.rejects(accounts.signIn({ email: 'unknown@example.invalid', password }), { message: 'Email or password is incorrect.' });
  assert.deepEqual((await accounts.status()).user, user);
});

test('sign-in rate limits expire and a successful sign-in clears failed attempts', async t => {
  let now = 1;
  const accounts = new AccountStore(await directory(t), { now: () => now });
  await accounts.create(input);
  for (let i = 0; i < 5; i++) await assert.rejects(accounts.signIn({ email: input.email, password: 'wrong-password-long-enough' }), /incorrect/);
  await assert.rejects(accounts.signIn(input), /Too many/);
  now += 60001;
  await accounts.signIn(input);
  assert.equal(accounts.attempts.size, 0);
});

test('invalid account input is rejected before any file is created', async t => {
  const accounts = new AccountStore(await directory(t));
  for (const change of [{ name: 'x' }, { name: 'bad\nname' }, { email: 'bad' }, { password: 'short' }, { password: 'a'.repeat(129) }]) {
    await assert.rejects(accounts.create({ ...input, ...change }));
  }
  await assert.rejects(fs.stat(accounts.file), { code: 'ENOENT' });
});

test('concurrent duplicate registration commits one account and does not lose another user', async t => {
  const accounts = new AccountStore(await directory(t));
  const results = await Promise.allSettled([accounts.create(input), accounts.create(input), accounts.create({ ...input, email: 'second@example.invalid' })]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.match(results[1].reason.message, /already exists/);
  assert.equal(JSON.parse(await fs.readFile(accounts.file, 'utf8')).users.length, 2);
});

test('a failed account write does not sign in or erase the previous account file', async t => {
  const root = await directory(t), accounts = new AccountStore(root);
  await accounts.create(input);
  const original = await fs.readFile(accounts.file, 'utf8');
  const failing = new AccountStore(root, { write: async () => { throw new Error('Write denied'); } });
  await assert.rejects(failing.create({ ...input, email: 'second@example.invalid' }), /Write denied/);
  assert.equal((await failing.status()).user, null);
  assert.equal(await fs.readFile(accounts.file, 'utf8'), original);
});

test('damaged and oversized account files report unavailable and are never silently overwritten', async t => {
  const accounts = new AccountStore(await directory(t));
  for (const contents of ['{invalid', '{"version":2,"users":[]}', JSON.stringify({ version: 1, users: [{ id: 'bad' }] }), ' '.repeat(1024 * 1024 + 1)]) {
    await fs.writeFile(accounts.file, contents);
    const status = await accounts.status();
    assert.equal(status.available, false);
    assert.match(status.message, /workspace is still available/);
    await assert.rejects(accounts.create(input), /could not be read/);
    assert.equal(await fs.readFile(accounts.file, 'utf8'), contents);
  }
});
