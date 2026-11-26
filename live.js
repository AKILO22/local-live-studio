'use strict';

(() => {
  const $ = selector => document.querySelector(selector), api = window.studio;
  let state = { status: 'idle', configured: false, provider: 'tiktok', encoderReady: false, active: false, startedAt: 0, bytesSent: 0, message: 'Set up your LIVE destination to begin.' };
  let profile = {}, context, producer = null, working = false, cancelStart = false, enabled = true;
  const labels = { idle: 'NOT LIVE', ready: 'READY', connecting: 'CONNECTING', live: 'LIVE', stopping: 'ENDING', ended: 'ENDED', error: 'DISCONNECTED' };
  function errorMessage(error) { return (error.message || String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); }
  function active() { return state.active || state.status === 'connecting' || !!producer; }
  function render() {
    const isActive = active(), tiktok = state.provider !== 'custom';
    $('#live-state').textContent = labels[state.status] || 'NOT LIVE';
    $('#live-state').classList.toggle('is-live', state.status === 'live');
    $('#live-platform').textContent = tiktok ? 'TikTok LIVE' : 'Custom RTMP';
    $('#live-account').textContent = tiktok ? profile.profile?.displayName || 'Connect your TikTok profile' : state.serverHost || 'Choose your streaming server';
    $('#live-status').textContent = state.message || 'Set up your LIVE destination to begin.';
    $('#live-start').hidden = isActive;
    $('#live-start').disabled = working || !enabled || !state.encoderReady || !state.configured || (tiktok && !profile.hasSavedLink);
    $('#live-end').hidden = !isActive;
    $('#live-end').disabled = state.status === 'stopping' || producer?.stopping === true;
    $('#live-end').textContent = state.status === 'connecting' ? 'Cancel connection' : 'End Live';
    $('#live-setup-open').disabled = isActive || working;
    $('#live-setup-open').textContent = state.configured ? 'Change LIVE destination' : 'Set up LIVE destination';
    $('#live-account-open').hidden = !tiktok || !!profile.hasSavedLink;
    $('#live-check-encoder').textContent = state.encoderReady ? '✓' : '○';
    $('#live-check-destination').textContent = state.configured ? '✓' : '○';
    $('#live-check-internet').textContent = enabled ? '✓' : '○';
    $('#live-encoder-status').textContent = state.encoderReady ? 'FFmpeg detected. H.264 and AAC output are available.' : 'FFmpeg was not detected. Install an FFmpeg build with libx264, then choose ffmpeg.exe.';
    $('#live-choose-encoder').disabled = isActive || working;
    $('#live-save-destination').disabled = isActive || working;
    $('#preview-mode').textContent = state.status === 'live' ? 'LIVE · Output transmitting' : state.status === 'connecting' ? 'Connecting LIVE output…' : 'Preview · Not live';
    context?.lockControls(isActive || working);
    updateClock();
  }
  function updateClock() {
    const elapsed = ['live', 'stopping'].includes(state.status) && state.startedAt ? Math.max(0, Date.now() - state.startedAt) : state.durationMs || 0;
    const seconds = Math.floor(elapsed / 1000);
    $('#live-clock').textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
    $('#live-size').textContent = (Math.max(0, state.bytesSent || 0) / 1048576).toFixed(1) + ' MB';
  }
  function apply(next) {
    state = next;
    if (producer && !producer.stopping && ['error', 'ended'].includes(state.status)) {
      producer.error = state.status === 'error' ? state.message : '';
      if (producer.recorder.state !== 'inactive') producer.recorder.stop();
    }
    render();
  }
  async function begin() {
    if (working || active() || !context) return;
    working = true; cancelStart = false; render();
    let stream, session;
    try {
      stream = await context.createStream();
      const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'].find(value => MediaRecorder.isTypeSupported(value));
      if (!mimeType) throw new Error('This system cannot prepare live video.');
      if (cancelStart) { stream.getVideoTracks().forEach(track => track.stop()); return; }
      const settings = context.getSettings();
      const output = await api.startLive(settings);
      if (cancelStart || ['error', 'ended'].includes(state.status)) { await api.stopLive(); stream.getVideoTracks().forEach(track => track.stop()); return; }
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: settings.bitrate, audioBitsPerSecond: 128000 });
      session = { id: output.id, recorder, stream, sequence: 0, pending: 0, writes: Promise.resolve(), error: '', stopping: false };
      session.finished = new Promise(resolve => { session.complete = resolve; });
      producer = session;
      recorder.addEventListener('dataavailable', event => {
        if (!event.data.size || session.error) return;
        session.pending += event.data.size;
        if (event.data.size > 4 * 1024 * 1024 || session.pending > 8 * 1024 * 1024) {
          session.error = 'The upload cannot keep up. Choose a lower bitrate and start a new LIVE output.';
          if (recorder.state !== 'inactive') recorder.stop(); return;
        }
        session.writes = session.writes.then(async () => {
          if (session.error || session.stopping) return;
          await api.writeLive({ id: session.id, sequence: session.sequence++, bytes: await event.data.arrayBuffer() });
        }).catch(error => { if (!session.stopping) { session.error = errorMessage(error); if (recorder.state !== 'inactive') recorder.stop(); } }).finally(() => { session.pending -= event.data.size; });
      });
      recorder.addEventListener('error', () => { session.error = 'Live video capture stopped unexpectedly.'; if (recorder.state !== 'inactive') recorder.stop(); });
      recorder.addEventListener('stop', () => finishProducer(session), { once: true });
      recorder.start(500);
    } catch (error) {
      stream?.getVideoTracks().forEach(track => track.stop());
      try { await api.stopLive(); } catch { /* Already stopped. */ }
      if (session) { producer = null; session.complete(); }
      state = { ...state, active: false, status: cancelStart ? 'ended' : 'error', message: cancelStart ? 'LIVE start cancelled.' : errorMessage(error) };
    } finally { working = false; render(); }
  }
  async function finishProducer(session) {
    if (session.stopping) return session.finished;
    session.stopping = true; render();
    try {
      const ending = api.stopLive();
      await session.writes;
      apply(await ending);
      if (session.error) { state = { ...state, status: 'error', message: session.error }; context?.notify(session.error, true); }
    } catch (error) { state = { ...state, active: false, status: 'error', message: errorMessage(error) }; }
    finally {
      session.stream.getVideoTracks().forEach(track => track.stop());
      if (producer === session) producer = null;
      session.complete(); render();
    }
  }
  async function end() {
    cancelStart = true;
    const session = producer;
    if (session) {
      if (session.recorder.state !== 'inactive') session.recorder.stop();
      await session.finished;
    } else { apply(await api.stopLive()); }
  }
  $('#live-start').addEventListener('click', begin);
  $('#live-end').addEventListener('click', () => end().catch(error => { state.message = errorMessage(error); render(); }));
  $('#live-account-open').addEventListener('click', () => $('#account-dialog').showModal());
  $('#live-setup-open').addEventListener('click', () => { $('#live-setup-status').textContent = ''; $('#live-setup-dialog').showModal(); });
  $('#live-setup-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      apply(await api.saveLiveDestination({ provider: $('#live-provider').value, serverURL: $('#live-server-url').value.trim(), streamKey: $('#live-stream-key').value.trim() }));
      $('#live-stream-key').value = ''; $('#live-setup-dialog').close();
    } catch (error) { $('#live-setup-status').textContent = errorMessage(error); }
  });
  $('#live-choose-encoder').addEventListener('click', async () => { try { apply(await api.chooseLiveEncoder()); } catch (error) { $('#live-setup-status').textContent = errorMessage(error); } });
  $('#live-help').addEventListener('click', () => api.openLiveHelp().catch(error => { $('#live-setup-status').textContent = errorMessage(error); }));
  api?.onLiveStatus(apply);
  setInterval(updateClock, 500);
  window.liveOutput = Object.freeze({
    initialize(next, callbacks) { context = callbacks; if (next) state = next; render(); },
    setTikTok(next) { profile = next || {}; render(); },
    setInternetEnabled(next) { enabled = next; render(); },
    isActive: active, stop: end, render,
  });
})();
