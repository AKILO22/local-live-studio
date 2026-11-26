'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const status = message => { $('#status').textContent = message; };
  let pairing = location.hash.slice(1), auth = '', pc, camera, pollAbort, session = 0, cursor = 0, candidateQueue = [], sendTail = Promise.resolve(), wake, connectionTimer, facing = 'environment';
  if (/^[A-Za-z0-9_-]{43}$/.test(pairing)) { sessionStorage.setItem('studio-phone-pairing', pairing); history.replaceState(null, '', location.pathname); }
  else pairing = sessionStorage.getItem('studio-phone-pairing') || '';
  const wantsCamera = () => ['camera', 'both'].includes(document.querySelector('[name=mode]:checked').value);
  const wantsMonitor = () => ['monitor', 'both'].includes(document.querySelector('[name=mode]:checked').value);
  function modeChanged() { $('#camera-choice').hidden = !wantsCamera(); }
  document.querySelectorAll('[name=mode]').forEach(e => e.addEventListener('change', modeChanged)); modeChanged();
  if (!pairing) { status('This page needs a pairing link. Scan the QR code in Local LIVE Studio.'); $('#connect').disabled = true; }
  if (!navigator.wakeLock) $('#awake').hidden = true;

  async function request(route, method, body, bearer = auth) {
    const controller = new AbortController(), parent = pollAbort;
    const cancel = () => controller.abort(); parent?.signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, 26000);
    try {
      const response = await fetch(route, { method, headers: { Authorization: 'Bearer ' + bearer, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, cache: 'no-store' });
      const value = await response.json(); if (!response.ok) throw new Error(value.error || 'The studio connection is unavailable.'); return value;
    } finally { clearTimeout(timeout); parent?.signal.removeEventListener('abort', cancel); }
  }
  function send(value) {
    const ticket = session;
    const operation = sendTail.then(() => ticket === session && auth ? request('/api/signal', 'POST', value) : undefined);
    sendTail = operation.catch(() => {}); return operation;
  }
  function end(message, notify = true) {
    const oldAuth = auth; ++session; auth = ''; pollAbort?.abort(); pollAbort = null; clearTimeout(connectionTimer);
    if (notify && oldAuth) fetch('/api/leave', { method: 'POST', headers: { Authorization: 'Bearer ' + oldAuth }, keepalive: true }).catch(() => {});
    if (pc) { pc.onconnectionstatechange = null; pc.ontrack = null; pc.onicecandidate = null; pc.close(); pc = null; }
    camera?.getTracks().forEach(t => t.stop()); camera = null; wake?.release().catch(() => {}); wake = null;
    $('#monitor').srcObject = null; $('#camera-preview').srcObject = null; $('#video-card').hidden = true; $('#disconnect').hidden = true; $('#pair-card').hidden = false; $('#connect').disabled = !pairing;
    $('#monitor').muted = true; $('#audio').textContent = 'Enable monitor audio'; $('#awake').textContent = 'Keep screen awake';
    document.querySelectorAll('#pair-card input, #pair-card select').forEach(e => { e.disabled = false; });
    if (message) status(message);
  }
  async function offer(value, ticket) {
    if (pc) throw new Error('A connection is already active. Disconnect before pairing again.');
    pc = new RTCPeerConnection({ iceServers: [] }); const connection = pc;
    const remote = new MediaStream();
    pc.onicecandidate = e => { if (e.candidate && ticket === session) send({ type: 'candidate', candidate: e.candidate.toJSON() }).catch(() => { if (ticket === session) end('Connection signalling failed. Reconnect the phone.'); }); };
    pc.ontrack = e => {
      if (ticket !== session) return;
      if (!remote.getTracks().some(t => t.id === e.track.id)) remote.addTrack(e.track);
      $('#monitor').srcObject = e.streams[0] || remote; $('#monitor').play().catch(() => status('Tap Full screen or Enable monitor audio to play the studio video.'));
    };
    pc.onconnectionstatechange = () => {
      if (ticket !== session) return;
      if (connection.connectionState === 'connected') { clearTimeout(connectionTimer); status(wantsCamera() ? 'Connected. Your phone camera is available in the studio.' : 'Connected. Watching your studio output.'); }
      else if (connection.connectionState === 'failed') end('Video could not connect. Use the same Wi-Fi as the computer, then try again.');
      else if (connection.connectionState === 'disconnected') status('Video connection interrupted. Keep this page open while the connection recovers.');
    };
    await pc.setRemoteDescription(value);
    if (camera) camera.getTracks().forEach(track => pc.addTrack(track, camera));
    const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
    await send({ type: 'answer', sdp: pc.localDescription.sdp });
    for (const candidate of candidateQueue) await pc.addIceCandidate(candidate); candidateQueue = [];
    connectionTimer = setTimeout(() => { if (ticket === session && connection.connectionState !== 'connected') end('The video link timed out. Make sure both devices use the same Wi-Fi and reconnect.'); }, 35000);
  }
  async function poll(ticket) {
    while (ticket === session && auth) {
      const value = await request('/api/events?after=' + cursor, 'GET'); if (ticket !== session) return;
      for (const event of value.events || []) {
        if (event.type === 'closed') { end(event.message || 'The desktop ended this connection.', false); return; }
        if (event.type === 'accepted') status('Approved. Connecting video…');
        if (event.type === 'signal' && event.signal.type === 'offer') await offer(event.signal, ticket);
        if (event.type === 'signal' && event.signal.type === 'candidate') { if (pc?.remoteDescription) await pc.addIceCandidate(event.signal.candidate); else candidateQueue.push(event.signal.candidate); }
      }
      cursor = value.cursor;
    }
  }
  $('#connect').addEventListener('click', async () => {
    const ticket = ++session; cursor = 0; candidateQueue = []; sendTail = Promise.resolve(); pollAbort = new AbortController(); $('#connect').disabled = true; $('#disconnect').hidden = false;
    document.querySelectorAll('#pair-card input, #pair-card select').forEach(e => { e.disabled = true; });
    try {
      const mode = document.querySelector('[name=mode]:checked').value;
      if (wantsCamera()) {
        if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Phone Camera requires the secure HTTPS link from your desktop studio.');
        status('Allow camera access on this phone. Your microphone is not requested.');
        facing = $('#camera-facing').value;
        const acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } }, audio: false });
        if (ticket !== session) { acquired.getTracks().forEach(t => t.stop()); return; } camera = acquired;
        $('#video-card').hidden = false; $('#video-card').classList.toggle('camera-only', mode === 'camera'); $('#monitor').hidden = mode === 'camera';
        $('#camera-preview').srcObject = camera; $('#camera-preview').hidden = false; $('#camera-preview').play().catch(() => {});
      }
      status('Waiting for approval in Local LIVE Studio on your computer.');
      const joined = await request('/api/join', 'POST', { name: $('#phone-name').value.trim(), mode }, pairing); if (ticket !== session) return;
      auth = joined.deviceToken; $('#pair-card').hidden = true; $('#video-card').hidden = false;
      $('#video-card').classList.toggle('camera-only', mode === 'camera'); $('#monitor').hidden = mode === 'camera';
      $('#video-label').textContent = mode === 'camera' ? 'Phone camera' : 'Studio monitor'; $('#audio').hidden = !wantsMonitor(); $('#fullscreen').hidden = !wantsMonitor(); $('#switch-camera').hidden = !wantsCamera();
      document.querySelectorAll('#pair-card input, #pair-card select').forEach(e => { e.disabled = true; });
      await poll(ticket);
    } catch (error) { if (ticket === session) end(error.name === 'NotAllowedError' ? 'Camera access was declined. Allow the camera in your browser or choose Phone Monitor.' : error.message || 'Connection unavailable. Reconnect from the desktop link.'); }
  });
  $('#disconnect').addEventListener('click', () => end('Disconnected. You can connect again while this pairing link is valid.'));
  $('#audio').addEventListener('click', async () => {
    const video = $('#monitor'); video.muted = !video.muted;
    try { await video.play(); $('#audio').textContent = video.muted ? 'Enable monitor audio' : 'Mute monitor audio'; } catch { video.muted = true; status('Tap the video to start playback, then enable audio.'); }
  });
  $('#fullscreen').addEventListener('click', async () => {
    const video = $('#monitor'); try { await video.play(); if (video.requestFullscreen) await video.requestFullscreen(); else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); } catch { status('Full screen is not available in this browser. Rotate your phone for a larger view.'); }
  });
  $('#switch-camera').addEventListener('click', async () => {
    if (!camera || !pc || $('#switch-camera').disabled) return;
    const next = facing === 'environment' ? 'user' : 'environment', ticket = session, connection = pc, previous = camera;
    let fresh; $('#switch-camera').disabled = true;
    try {
      fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: next }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (ticket !== session || pc !== connection) return;
      const sender = connection.getSenders().find(s => s.track?.kind === 'video'); if (!sender) return;
      await sender.replaceTrack(fresh.getVideoTracks()[0]);
      if (ticket !== session || pc !== connection) return;
      previous.getTracks().forEach(t => t.stop()); camera = fresh; fresh = null; facing = next;
      $('#camera-preview').srcObject = camera; $('#camera-preview').play().catch(() => {});
    } catch { if (ticket === session) status('This browser could not switch cameras. Disconnect and choose the other camera before reconnecting.'); }
    finally { fresh?.getTracks().forEach(t => t.stop()); $('#switch-camera').disabled = false; }
  });
  $('#awake').addEventListener('click', async () => { try { if (wake) { await wake.release(); wake = null; $('#awake').textContent = 'Keep screen awake'; } else { wake = await navigator.wakeLock.request('screen'); $('#awake').textContent = 'Allow screen to sleep'; wake.addEventListener('release', () => { wake = null; $('#awake').textContent = 'Keep screen awake'; }); } } catch { status('Screen wake lock is unavailable. Keep the page in the foreground.'); } });
  window.addEventListener('pagehide', () => end('', true));
})();
