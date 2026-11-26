'use strict';
(() => {
  const $ = s => document.querySelector(s), api = window.studio; let hooks, peer, state = { installed: false, outputOpen: false, connection: 'closed', audio: false }, enabled = true;
  const note = text => { $('#cast-status').textContent = text; };
  function closePeer() { const p = peer; if (!p) return; peer = null; clearTimeout(p.timeout); p.pc.onicecandidate = null; p.pc.close(); p.stream?.getTracks().forEach(t => t.stop()); }
  function apply(next) { state = next; $('#cast-install-status').textContent = state.installed ? 'TikTok LIVE Studio is installed and its publisher signature was verified.' : 'Install TikTok LIVE Studio, or choose its signed executable.'; $('#cast-open-official').disabled = !enabled || !state.installed; $('#cast-close-output').disabled = !state.outputOpen; $('#cast-audio').disabled = !state.outputOpen; $('#cast-audio').checked = state.audio; $('#cast-output-state').textContent = ({ closed: 'Output closed', opening: 'Opening output…', connecting: 'Connecting output…', connected: 'Output ready for capture', disconnected: 'Output interrupted', failed: 'Output connection failed' })[state.connection] || state.connection; if (!state.outputOpen) closePeer(); }
  async function start({ sessionId }) {
    if (!hooks) return; closePeer();
    const pc = new RTCPeerConnection({ iceServers: [] }), p = peer = { pc, sessionId, queue: [], tail: Promise.resolve() };
    try {
      pc.onicecandidate = e => { if (e.candidate && peer === p) api.sendCastSignal({ sessionId, signal: { type: 'candidate', candidate: e.candidate.toJSON() } }).catch(() => fail(p)); };
      p.stream = await hooks.createStream(); if (peer !== p) { p.stream.getTracks().forEach(t => t.stop()); return; }
      for (const track of p.stream.getTracks()) { const sender = pc.addTrack(track, p.stream); pc.getTransceivers().find(t => t.sender === sender).direction = 'sendonly'; }
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer); await api.sendCastSignal({ sessionId, signal: { type: 'offer', sdp: pc.localDescription.sdp } });
      p.timeout = setTimeout(() => { if (peer === p && pc.connectionState !== 'connected') fail(p); }, 25000);
    } catch { fail(p); }
  }
  function fail(p) { if (peer === p) { closePeer(); note('Output could not connect. Close studio output and reopen it.'); } }
  api.onCastReady(start); api.onCastStatus(apply); api.onCastClosed(input => { if (peer?.sessionId === input.sessionId) closePeer(); });
  api.onCastSignal(input => { const p = peer; if (!p || p.sessionId !== input.sessionId) return; p.tail = p.tail.then(async () => { if (peer !== p) return; const value = input.signal; if (value.type === 'answer') { await p.pc.setRemoteDescription(value); for (const c of p.queue) await p.pc.addIceCandidate(c); p.queue = []; } else if (p.pc.remoteDescription) await p.pc.addIceCandidate(value.candidate); else p.queue.push(value.candidate); }).catch(() => fail(p)); });
  function action(id, fn) { $(id).addEventListener('click', () => Promise.resolve().then(fn).catch(e => note(e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')))); }
  action('#cast-open', () => $('#cast-dialog').showModal());
  action('#cast-open-output', async () => { apply(await api.openCastOutput(hooks.getSettings())); note('In TikTok LIVE Studio, add a Window Capture source and select Local LIVE Studio — Broadcast Output.'); });
  action('#cast-close-output', async () => { apply(await api.closeCastOutput()); note('Studio output closed. End your broadcast in TikTok LIVE Studio if it is still LIVE.'); });
  action('#cast-open-official', async () => { await api.openOfficialStudio(); note('Continue in TikTok LIVE Studio. Check its account, add the output window as a source, then start LIVE there.'); });
  action('#cast-pick-official', async () => apply(await api.chooseOfficialStudio()));
  action('#cast-download', () => api.downloadOfficialStudio());
  $('#cast-audio').addEventListener('change', async () => { try { apply(await api.setCastAudio($('#cast-audio').checked)); } catch (e) { note(e.message); } });
  window.studioCast = Object.freeze({ initialize(initial, value) { hooks = value; apply(initial || state); }, setInternetEnabled(value) { enabled = value; apply(state); }, close: closePeer });
  window.addEventListener('beforeunload', closePeer);
})();
