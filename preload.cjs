'use strict';

// Sandboxed preload: Electron's limited require is the only privileged dependency.
const { contextBridge, ipcRenderer } = require('electron');
const MAX_CHUNK = 16 * 1024 * 1024;

function bytesBuffer(value, limit) {
  const isBuffer = Object.prototype.toString.call(value) === '[object ArrayBuffer]';
  if (!isBuffer && !ArrayBuffer.isView(value)) throw new TypeError('Expected an ArrayBuffer.');
  if (value.byteLength > limit) throw new RangeError('The data exceeds the allowed size.');
  return isBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

// Trusted input is observed in the isolated world. The page cannot manufacture an
// isTrusted event or directly access ipcRenderer to authorize permission requests.
for (const name of ['pointerdown', 'click', 'keydown']) {
  document.addEventListener(name, event => {
    if (event.isTrusted && !event.repeat) ipcRenderer.send('studio:user-action');
  }, { capture: true, passive: true });
}

const invoke = (name, ...args) => ipcRenderer.invoke(`studio:${name}`, ...args);
function subscribeClose(callback) {
  if (typeof callback !== 'function') throw new TypeError('Expected a close handler.');
  const listener = () => {
    try { Promise.resolve(callback()).catch(error => console.error('Studio close handler failed:', error)); }
    catch (error) { console.error('Studio close handler failed:', error); }
  };
  ipcRenderer.on('studio:finish-before-close', listener);
  return () => ipcRenderer.removeListener('studio:finish-before-close', listener);
}
const studio = Object.freeze({
  bootstrap: () => invoke('bootstrap'),
  startPhones: () => invoke('phone-start'),
  stopPhones: () => invoke('phone-stop'),
  acceptPhone: id => invoke('phone-accept', id),
  disconnectPhone: id => invoke('phone-disconnect', id),
  sendPhoneSignal: input => invoke('phone-signal', { deviceId: input?.deviceId, signal: input?.signal }),
  setPhonePeerState: (id, state) => invoke('phone-peer-state', id, state),
  copyPhoneLink: () => invoke('phone-copy-link'),
  choosePhoneHelper: () => invoke('phone-pick-helper'),
  openPhoneHelperDownload: () => invoke('phone-helper-download'),
  onPhoneStatus: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a phone status handler.');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('studio:phone-status', listener);
    return () => ipcRenderer.removeListener('studio:phone-status', listener);
  },
  onPhoneSignal: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a phone signal handler.');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('studio:phone-signal', listener);
    return () => ipcRenderer.removeListener('studio:phone-signal', listener);
  },
  saveLiveDestination: input => invoke('live-save-destination', { provider: input?.provider, serverURL: input?.serverURL, streamKey: input?.streamKey }),
  startLive: input => invoke('live-start', { fps: input?.fps, bitrate: input?.bitrate }),
  writeLive: input => invoke('live-write', { id: input?.id, sequence: input?.sequence, bytes: bytesBuffer(input?.bytes, 4 * 1024 * 1024) }),
  stopLive: () => invoke('live-stop'),
  chooseLiveEncoder: () => invoke('live-pick-encoder'),
  openLiveHelp: () => invoke('live-open-help'),
  onLiveStatus: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a LIVE status handler.');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('studio:live-status', listener);
    return () => ipcRenderer.removeListener('studio:live-status', listener);
  },
  createAccount: input => invoke('account-create', { name: input?.name, email: input?.email, password: input?.password }),
  signIn: input => invoke('account-sign-in', { email: input?.email, password: input?.password }),
  signOut: () => invoke('account-sign-out'),
  saveTikTokSettings: url => invoke('tiktok-save-settings', url),
  connectTikTok: () => invoke('tiktok-connect'),
  cancelTikTok: () => invoke('tiktok-cancel'),
  refreshTikTok: () => invoke('tiktok-refresh'),
  disconnectTikTok: () => invoke('tiktok-disconnect'),
  forgetTikTok: () => invoke('tiktok-forget'),
  onTikTokStatus: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a connection status handler.');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('studio:tiktok-status', listener);
    return () => ipcRenderer.removeListener('studio:tiktok-status', listener);
  },
  addGiftGuest: input => invoke('gift-add-guest', { name: input?.name, seat: input?.seat }),
  removeGiftGuest: id => invoke('gift-remove-guest', id),
  sendGift: input => invoke('gift-send', { recipientId: input?.recipientId, giftId: input?.giftId, quantity: input?.quantity, requestId: input?.requestId }),
  saveProject: project => invoke('save-project', project),
  importProject: () => invoke('import-project'),
  exportProject: project => invoke('export-project', project),
  pickMedia: kind => {
    if (!['image', 'video'].includes(kind)) throw new TypeError('Media kind must be image or video.');
    return invoke('pick-media', kind);
  },
  registerMedia: file => invoke('register-media', file),
  listSources: () => invoke('list-sources'),
  selectCapture: selection => invoke('select-capture', { id: selection?.id, systemAudio: selection?.systemAudio === true }),
  recordingStart: options => invoke('recording-start', { mimeType: options?.mimeType }),
  recordingWrite: options => invoke('recording-write', { id: options?.id, bytes: bytesBuffer(options?.bytes, MAX_CHUNK) }),
  recordingFinish: options => invoke('recording-finish', { id: options?.id }),
  recordingCancel: options => invoke('recording-cancel', { id: options?.id }),
  saveSnapshot: bytes => invoke('save-snapshot', bytesBuffer(bytes, 64 * 1024 * 1024)),
  revealFile: file => invoke('reveal-file', file),
  openRecordings: () => invoke('open-recordings'),
  getStats: () => invoke('get-stats'),
  setInternetEnabled: enabled => invoke('network-set-enabled', enabled),
  checkConnection: () => invoke('network-check'),
  startWebSource: options => invoke('web-source-start', { id: options?.id, url: options?.url, width: options?.width, height: options?.height }),
  stopWebSource: id => invoke('web-source-stop', id),
  importOnlineMedia: options => invoke('import-online-media', { url: options?.url, kind: options?.kind }),
  onWebFrame: callback => {
    const listener = (_event, frame) => callback(frame);
    ipcRenderer.on('studio:web-frame', listener);
    return () => ipcRenderer.removeListener('studio:web-frame', listener);
  },
  onWebStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('studio:web-status', listener);
    return () => ipcRenderer.removeListener('studio:web-status', listener);
  },
  onBeforeClose: subscribeClose,
  onCloseRequested: subscribeClose,
  finishClose: () => invoke('finish-close')
});

contextBridge.exposeInMainWorld('studio', studio);
