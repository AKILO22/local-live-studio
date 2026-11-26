'use strict';
// Explicit integration check: creates a temporary HTTPS phone page, not a broadcast.
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { PhoneBridge } = require('../lib/phone.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-phone-check-'));
  const received = [];
  const bridge = new PhoneBridge({ dataDir: directory, assetDir: path.resolve(__dirname, '../phone'), downloadsDir: path.join(os.homedir(), 'Downloads'), isEnabled: () => true, onSignal: value => received.push(value) });
  try {
    await bridge.initialize(); assert(bridge.snapshot().helperReady, 'Install the official Cloudflare helper first.');
    const started = await bridge.start(); const parsed = new URL(started.pairingURL); const pairing = parsed.hash.slice(1); parsed.hash = ''; const origin = parsed.origin;
    let page;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { page = await fetch(origin, { signal: AbortSignal.timeout(10000) }); if (page.status === 200) break; } catch { /* The edge may still be registering. */ }
      await pause(500);
    }
    assert.equal(page?.status, 200, 'The secure phone page was not reachable.'); assert.match(await page.text(), /Phone Monitor/);
    for (const asset of ['/phone.css', '/phone-client.js']) assert.equal((await fetch(origin + asset, { signal: AbortSignal.timeout(10000) })).status, 200);
    const joined = await fetch(origin + '/api/join', { method: 'POST', headers: { Authorization: 'Bearer ' + pairing, 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ mode: 'monitor', name: 'Synthetic connection check' }), signal: AbortSignal.timeout(10000) });
    assert.equal(joined.status, 201); const deviceToken = (await joined.json()).deviceToken; const deviceId = bridge.snapshot().devices[0].id;
    assert.equal(bridge.snapshot().devices[0].status, 'pending'); bridge.accept(deviceId); bridge.send(deviceId, { type: 'offer', sdp: 'v=0\r\n' });
    const events = await fetch(origin + '/api/events?after=0', { headers: { Authorization: 'Bearer ' + deviceToken, Origin: origin }, signal: AbortSignal.timeout(10000) });
    assert.equal(events.status, 200); assert.deepEqual((await events.json()).events.map(e => e.type), ['accepted', 'signal']);
    const answer = await fetch(origin + '/api/signal', { method: 'POST', headers: { Authorization: 'Bearer ' + deviceToken, 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ type: 'answer', sdp: 'v=0\r\n' }), signal: AbortSignal.timeout(10000) });
    assert.equal(answer.status, 200); assert.equal(received.at(-1).signal.type, 'answer');
    await bridge.stop(); assert.equal(bridge.snapshot().pairingURL, '');
    console.log(JSON.stringify({ passed: true, httpsPage: true, desktopApproval: true, bidirectionalSignalling: true, stopped: true, mediaTested: false, physicalPhoneTested: false }));
  } finally {
    await bridge.stop(); const real = await fs.realpath(directory); const temp = await fs.realpath(os.tmpdir());
    if (path.dirname(real) !== temp || !path.basename(real).startsWith('studio-phone-check-')) throw new Error('Unexpected integration check directory.');
    await fs.rm(real, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
