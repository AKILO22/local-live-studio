'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { SOURCE_FILES, releaseNames, portableLauncher, sha256, removeStage } = require('../scripts/release.cjs');
const { ignoreFile } = require('../scripts/package.cjs');
const ROOT = path.resolve(__dirname, '..');

test('source releases use an explicit file list excluding user data and installed-app evidence', async () => {
  assert.equal(new Set(SOURCE_FILES).size, SOURCE_FILES.length);
  for (const file of SOURCE_FILES) {
    assert.ok(!file.includes('..') && !path.isAbsolute(file));
    assert.doesNotMatch(file, /^(node_modules|evidence|dist|release|\.cache|data)\//);
    assert.doesNotMatch(file, /(?:^|\/)(?:accounts|project|preferences|studio-gifts)\.json$|\.env|\.pfx$|\.pem$|EVIDENCE\.md|VERIFICATION\.md/);
    await fs.access(path.join(ROOT, file));
  }
  for (const file of ['gifting.js', 'tiktok.js', 'lib/gifts.cjs', 'lib/accounts.cjs', 'lib/online.cjs', 'lib/tiktok.cjs', 'lib/tiktok-http.cjs']) assert.equal(ignoreFile(file), false);
  assert.equal(ignoreFile('server/tiktok-broker.cjs'), true);
  assert.ok(SOURCE_FILES.includes('server/tiktok-broker.cjs'));
});
test('portable download names and launcher resolve an extracted app without development folders', () => {
  assert.equal(releaseNames('1.3.0').windows, 'Local-LIVE-Studio-1.3.0-windows-x64.zip');
  for (const version of ['../escape', 'v1.0.0', '1.0.0;cmd']) assert.throws(() => releaseNames(version));
  assert.match(portableLauncher(), /%~dp0Local LIVE Studio\\Local LIVE Studio\.exe/);
  assert.match(portableLauncher(), /ELECTRON_RUN_AS_NODE=/);
  assert.doesNotMatch(portableLauncher(), /node_modules|npm|release\\/);
});
test('release checksums are standard SHA-256 and staging cleanup refuses unrelated directories', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-release-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('studio-release-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'fixture'); await fs.writeFile(file, 'abc');
  assert.equal(await sha256(file), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const unrelated = path.join(root, 'keep'); await fs.mkdir(unrelated);
  await assert.rejects(removeStage(unrelated, root), /unexpected release/);
  await fs.access(unrelated);
  const stage = path.join(root, '.stage-fixture'); await fs.mkdir(stage);
  await removeStage(stage, root);
  await assert.rejects(fs.access(stage), { code: 'ENOENT' });
});
