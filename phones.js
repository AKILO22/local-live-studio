'use strict';
(() => {
  const $ = s => document.querySelector(s), api = window.studio;
  let state = { status: 'stopped', devices: [] }, hooks, enabled = true, busy = false;
  const peers = new Map();
  const modeName = mode => ({ camera: 'Phone Camera', monitor: 'Phone Monitor', both: 'Camera + Monitor' })[mode];
  const note = message => { $('#phone-status').textContent = message; };
  function button(text, action, className = '') { const b = document.createElement('button'); b.type = 'button'; b.className = className; b.textContent = text; b.addEventListener('click', () => Promise.resolve().then(action).catch(e => note(e.message))); return b; }
  function closePeer(id) {
    const p = peers.get(id); if (!p) return; peers.delete(id); clearTimeout(p.timeout);
    p.pc.onconnectionstatechange = null; p.pc.onicecandidate = null; p.pc.ontrack = null; p.pc.close();
    p.output?.getTracks().forEach(t => t.stop()); p.camera?.getTracks().forEach(t => t.stop());
    if (p.mode !== 'monitor') hooks?.removeCamera();
  }
  async function startPeer(device) {
    if (!hooks || peers.has(device.id)) return;
    const pc = new RTCPeerConnection({ iceServers: [] });
    const peer = { pc, mode: device.mode, candidates: [], tail: Promise.resolve(), name: device.name };
    peers.set(device.id, peer);
    const fail = () => { if (peers.get(device.id) === peer) { void api.setPhonePeerState(device.id, 'failed').catch(() => {}); closePeer(device.id); } };
    try {
      pc.onicecandidate = event => { if (event.candidate && peers.get(device.id) === peer) api.sendPhoneSignal({ deviceId: device.id, signal: { type: 'candidate', candidate: event.candidate.toJSON() } }).catch(fail); };
      pc.ontrack = event => {
        if (peers.get(device.id) !== peer || event.track.kind !== 'video' || device.mode === 'monitor') return;
        peer.camera = event.streams[0] || new MediaStream([event.track]);
        Promise.resolve(hooks.addCamera(peer.camera, device.name)).catch(error => { note(error.message); fail(); });
      };
      pc.onconnectionstatechange = () => {
        if (peers.get(device.id) !== peer) return;
        const connection = pc.connectionState;
        if (connection === 'connected') clearTimeout(peer.timeout);
        if (['connecting', 'connected', 'disconnected', 'failed'].includes(connection)) void api.setPhonePeerState(device.id, connection).catch(() => {});
        if (connection === 'failed') closePeer(device.id);
      };
      if (device.mode !== 'monitor') pc.addTransceiver('video', { direction: 'recvonly' });
      if (device.mode !== 'camera') {
        peer.output = await hooks.monitorStream();
        if (peers.get(device.id) !== peer) { peer.output.getTracks().forEach(t => t.stop()); return; }
        for (const track of peer.output.getTracks()) {
          const sender = pc.addTrack(track, peer.output);
          if (device.mode === 'monitor' || track.kind === 'audio') pc.getTransceivers().find(t => t.sender === sender).direction = 'sendonly';
          if (track.kind === 'video') { const parameters = sender.getParameters(); parameters.encodings = [{ maxBitrate: 1500000, maxFramerate: 24, scaleResolutionDownBy: Math.max(1, (track.getSettings().width || 1280) / 1280, (track.getSettings().height || 720) / 1280) }]; await sender.setParameters(parameters).catch(() => {}); }
        }
      }
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      await api.sendPhoneSignal({ deviceId: device.id, signal: { type: 'offer', sdp: pc.localDescription.sdp } });
      peer.timeout = setTimeout(fail, 40000);
    } catch { fail(); }
  }
  function render() {
    const active = ['starting', 'ready'].includes(state.status);
    $('#phone-create').disabled = busy || !enabled || state.status === 'starting' || (state.status === 'ready' && !!state.pairingURL);
    $('#phone-create').textContent = state.status === 'ready' && !state.pairingURL ? 'New pairing link' : 'Create phone link';
    $('#phone-stop').hidden = !active; $('#phone-stop').disabled = !active;
    $('#phone-choose-helper').disabled = active || busy; $('#phone-helper-state').textContent = state.helperReady ? 'Secure connection helper detected.' : 'Choose the Cloudflare connection helper to enable secure phone links.';
    $('#phone-link-panel').hidden = !state.pairingURL; $('#phone-link').value = state.pairingURL || '';
    if (state.pairingURL && typeof qrcode === 'function') {
      const qr = qrcode(0, 'M'); qr.addData(state.pairingURL); qr.make(); const canvas = $('#phone-qr'), ctx = canvas.getContext('2d'); const count = qr.getModuleCount(), size = 5;
      canvas.width = canvas.height = (count + 8) * size; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#08171b';
      for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (qr.isDark(row, col)) ctx.fillRect((col + 4) * size, (row + 4) * size, size, size);
    }
    const list = $('#phone-devices'); list.replaceChildren();
    for (const d of state.devices || []) {
      const item = document.createElement('li'), title = document.createElement('strong'), detail = document.createElement('p'), actions = document.createElement('div'); actions.className = 'phone-device-actions';
      title.textContent = d.name; detail.textContent = modeName(d.mode) + ' · ' + (d.status === 'pending' ? 'Waiting for your approval' : d.connection);
      if (d.status === 'pending') { actions.append(button('Allow ' + modeName(d.mode), async () => apply(await api.acceptPhone(d.id)), 'primary'), button('Decline', async () => apply(await api.disconnectPhone(d.id)))); }
      else {
        if (d.mode !== 'monitor') actions.append(button('Add camera to scene', async () => { const p = peers.get(d.id); if (!p?.camera) throw new Error('Wait for the phone camera to connect first.'); await hooks.addCamera(p.camera, d.name); }));
        actions.append(button('Disconnect phone', async () => apply(await api.disconnectPhone(d.id))));
      }
      item.append(title, detail, actions); list.append(item);
    }
    $('#phone-empty').hidden = !!state.devices?.length;
    $('#phone-summary').textContent = state.devices?.length ? `${state.devices.filter(d => d.connection === 'connected').length} connected · ${state.devices.filter(d => d.status === 'pending').length} waiting` : 'Camera and studio monitor';
    note(!enabled ? 'Enable Internet access before connecting a phone.' : state.message || 'Create a phone link to begin.');
  }
  function apply(next) {
    state = next; render(); if (!hooks) return;
    const current = new Set((state.devices || []).filter(d => d.status === 'accepted').map(d => d.id));
    for (const id of peers.keys()) if (!current.has(id)) closePeer(id);
    for (const d of state.devices || []) if (d.status === 'accepted') void startPeer(d);
  }
  api.onPhoneStatus(apply);
  api.onPhoneSignal(event => {
    if (event.closed) { closePeer(event.deviceId); return; }
    const p = peers.get(event.deviceId); if (!p) return;
    p.tail = p.tail.then(async () => {
      if (peers.get(event.deviceId) !== p) return;
      if (event.signal.type === 'answer') { await p.pc.setRemoteDescription(event.signal); for (const c of p.candidates) await p.pc.addIceCandidate(c); p.candidates = []; }
      else if (event.signal.type === 'candidate') { if (p.pc.remoteDescription) await p.pc.addIceCandidate(event.signal.candidate); else p.candidates.push(event.signal.candidate); }
    }).catch(() => { void api.setPhonePeerState(event.deviceId, 'failed').catch(() => {}); closePeer(event.deviceId); });
  });
  $('#phones-button').addEventListener('click', () => $('#phone-dialog').showModal());
  $('#phone-create').addEventListener('click', async () => { busy = true; render(); try { apply(await api.startPhones()); } catch (e) { state = { ...state, message: e.message }; } finally { busy = false; render(); } });
  $('#phone-stop').addEventListener('click', async () => { try { apply(await api.stopPhones()); } catch (e) { note(e.message); } });
  $('#phone-choose-helper').addEventListener('click', async () => { try { apply(await api.choosePhoneHelper()); } catch (e) { note(e.message); } });
  $('#phone-get-helper').addEventListener('click', () => api.openPhoneHelperDownload().catch(e => note(e.message)));
  $('#phone-copy-link').addEventListener('click', () => api.copyPhoneLink().then(() => note('Pairing link copied. Share it only with the phone you want to connect.')).catch(e => note(e.message)));
  window.phoneStudio = Object.freeze({
    initialize: (initial, value) => { hooks = value; apply(initial || state); },
    open: () => $('#phone-dialog').showModal(),
    setInternetEnabled: value => { enabled = value; if (!value) for (const id of peers.keys()) closePeer(id); render(); },
    close: () => { for (const id of peers.keys()) closePeer(id); },
  });
})();
