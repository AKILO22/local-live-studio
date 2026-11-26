'use strict';
(() => {
  const api = window.studioOutput, video = document.querySelector('#output'), status = document.querySelector('#status');
  let pc, sessionId, queue = [], tail = Promise.resolve(), timeout;
  const message = text => { status.textContent = text; status.hidden = false; };
  api.onAudio(({ enabled }) => { video.muted = !enabled; if (video.srcObject) video.play().catch(() => message('Audio playback could not start. Reopen studio output.')); });
  api.onSignal(input => { tail = tail.then(async () => {
    if (!sessionId) sessionId = input.sessionId;
    if (input.sessionId !== sessionId) return;
    const value = input.signal;
    if (value.type === 'offer') {
      if (pc) return; pc = new RTCPeerConnection({ iceServers: [] }); const remote = new MediaStream();
      pc.onicecandidate = e => { if (e.candidate) api.signal({ sessionId, signal: { type: 'candidate', candidate: e.candidate.toJSON() } }).catch(fail); };
      pc.ontrack = e => { if (!remote.getTracks().some(t => t.id === e.track.id)) remote.addTrack(e.track); video.srcObject = e.streams[0] || remote; video.play().catch(fail); };
      pc.onconnectionstatechange = () => { const state = pc.connectionState; if (state === 'connected') { clearTimeout(timeout); status.hidden = true; } if (['connecting','connected','disconnected','failed'].includes(state)) api.state({ sessionId, state }).catch(() => {}); if (state === 'failed') fail(); if (state === 'disconnected') message('Studio output interrupted. Reopen it from Local LIVE Studio.'); };
      await pc.setRemoteDescription(value); const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); await api.signal({ sessionId, signal: { type: 'answer', sdp: pc.localDescription.sdp } }); for (const c of queue) await pc.addIceCandidate(c); queue = [];
    } else if (pc?.remoteDescription) await pc.addIceCandidate(value.candidate); else queue.push(value.candidate);
  }).catch(fail); });
  function fail() { clearTimeout(timeout); message('Studio output could not connect. Close this window and reopen it from the studio.'); if (sessionId) api.state({ sessionId, state: 'failed' }).catch(() => {}); }
  video.addEventListener('playing', () => { status.hidden = true; });
  api.ready().then(value => { sessionId = value.sessionId; timeout = setTimeout(() => { if (pc?.connectionState !== 'connected') fail(); }, 25000); }).catch(fail);
  window.addEventListener('beforeunload', () => { clearTimeout(timeout); pc?.close(); video.srcObject?.getTracks().forEach(t => t.stop()); });
})();
