'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { MEDIA } = require('./media.cjs');

const LIMITS = Object.freeze({
  sources: 4, downloads: 2, width: 1920, height: 1920, pixels: 2073600,
  fps: 8, pngBytes: 16 * 1024 * 1024, downloadBytes: 250 * 1024 * 1024,
  redirects: 5, downloadMs: 120000, connectionMs: 10000,
  loadMs: 30000, connectionBytes: 16 * 1024, offlinePollMs: 100
});
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const OFFLINE = 'Online features are off. Enable internet access to continue.';
const TOO_LARGE = 'Media downloads are limited to 250 MB.';
class OnlineError extends Error {}

function normalizeWebURL(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x1f\x7f\\]/.test(value)) {
    throw new OnlineError('Enter a valid HTTP or HTTPS address.');
  }
  const input = value.trim();
  if (!/^https?:\/\//i.test(input)) throw new OnlineError('Use an HTTP or HTTPS address.');
  let url;
  try { url = new URL(input); } catch { throw new OnlineError('Enter a valid HTTP or HTTPS address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new OnlineError('Use an HTTP or HTTPS address.');
  }
  if (url.username || url.password || input.split('/')[2].includes('@')) {
    throw new OnlineError('Addresses containing a username or password are not supported.');
  }
  return url.href;
}

// Self-contained resources support web fonts, generated images and blob videos.
// They grant no local-file or application-protocol access. Navigations use the
// stricter normalizeWebURL policy instead.
function allowedWebResource(value, enabled = true) {
  if (enabled !== true || typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      return Boolean(url.hostname && !url.username && !url.password &&
        !/[\x00-\x1f\x7f\\]/.test(value) && !value.split('/')[2]?.includes('@'));
    }
    if (url.protocol === 'data:') return true;
    if (url.protocol === 'blob:') { normalizeWebURL(url.pathname); return true; }
    return url.href === 'about:blank';
  } catch { return false; }
}

function fitWebSize(width = 1280, height = 720) {
  if (![width, height].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 1)) {
    throw new OnlineError('Browser source width and height must be positive numbers.');
  }
  const scale = Math.min(1, LIMITS.width / width, LIMITS.height / height);
  const boundedWidth = width * scale;
  const boundedHeight = height * scale;
  const pixelScale = Math.min(1, Math.sqrt(LIMITS.pixels / boundedWidth / boundedHeight));
  return { width: Math.max(1, Math.floor(boundedWidth * pixelScale)), height: Math.max(1, Math.floor(boundedHeight * pixelScale)) };
}

function mediaExtension(response, url, kind) {
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  let extension;
  try { extension = path.posix.extname(decodeURIComponent(new URL(url).pathname)).toLowerCase(); } catch { extension = ''; }
  const formats = Object.entries(MEDIA).filter(([, format]) => format[0] === kind);
  const matching = formats.filter(([, format]) => format[1] === mime);
  if (matching.length) return matching.find(([ext]) => ext === extension)?.[0] || matching[0][0];
  if ((!mime || ['application/octet-stream', 'binary/octet-stream'].includes(mime)) &&
      formats.some(([ext]) => ext === extension)) return extension;
  throw new OnlineError(`The server did not return a supported ${kind} file.`);
}

function ignore(promise) { Promise.resolve(promise).catch(() => {}); }
function bestEffort(object, method, ...args) {
  try { ignore(object[method]?.(...args)); } catch { /* Already closed or shutting down. */ }
}
function cancelBody(response) { if (response?.body) bestEffort(response.body, 'cancel'); }

function createOnlineServices({ BrowserWindow, session, dataDir, media, getWindow, isEnabled, onBlocked = () => {} }) {
  const sources = new Map();
  const tasks = new Set();
  let transferContext = null;
  let watchdog = null;
  let checking = false;
  const enabled = () => { try { return isEnabled() === true; } catch { return false; } };
  const blocked = () => { try { onBlocked(); } catch { /* Reporting cannot grant access. */ } };

  function send(channel, payload) {
    try {
      const win = getWindow();
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
      win.webContents.send(channel, payload);
      return true;
    } catch { return false; }
  }
  function status(source, state, message) {
    if (source.lastStatus === `${state}:${message}`) return;
    source.lastStatus = `${state}:${message}`;
    send('studio:web-status', { id: source.id, status: state, message });
  }
  function maintainWatchdog() {
    if (!sources.size && !tasks.size) { clearInterval(watchdog); watchdog = null; }
    else if (!watchdog) {
      watchdog = setInterval(() => { if (!enabled()) disconnect(); }, LIMITS.offlinePollMs);
      watchdog.unref?.();
    }
  }
  function requireOnline() {
    if (!enabled()) { disconnect(); throw new OnlineError(OFFLINE); }
  }

  function makeContext(purpose) {
    const context = { active: true, session: session.fromPartition(`studio-online-${purpose}-${randomUUID()}`, { cache: false }) };
    const ses = context.session;
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const online = enabled();
      if (!online) disconnect();
      let allow = context.active && allowedWebResource(details.url, online);
      if (allow && ['mainFrame', 'subFrame'].includes(details.resourceType)) {
        try { normalizeWebURL(details.url); } catch { allow = false; }
      }
      if (!allow) blocked();
      callback({ cancel: !allow });
    });
    ses.on('will-download', event => { event.preventDefault(); blocked(); });
    ses.on('file-system-access-restricted', (_event, _details, callback) => callback('deny'));
    return context;
  }
  function retireContext(context) {
    if (!context?.active) return;
    context.active = false; // Keep its request handler installed, denying late worker requests.
    bestEffort(context.session, 'closeAllConnections');
    bestEffort(context.session, 'clearStorageData');
    bestEffort(context.session, 'clearCache');
    bestEffort(context.session, 'clearAuthCache');
  }

  function stopSource(source, error = new OnlineError('The browser source was stopped.')) {
    if (source.stopped) return;
    source.stopped = true;
    if (sources.get(source.id) === source) sources.delete(source.id);
    clearTimeout(source.loadTimer);
    clearTimeout(source.frameTimer);
    source.pendingImage = null;
    source.rejectLoad?.(error);
    source.rejectLoad = null;
    for (const [emitter, event, listener] of source.listeners) emitter.removeListener(event, listener);
    source.listeners.length = 0;
    if (source.window) {
      bestEffort(source.window.webContents, 'stopPainting');
      bestEffort(source.window.webContents, 'stop');
      bestEffort(source.window, 'destroy');
    }
    retireContext(source.context);
    maintainWatchdog();
  }
  function stopWebSource(id) {
    const source = sources.get(id);
    if (!source) return false;
    stopSource(source);
    return true;
  }
  function stopAll() { for (const source of [...sources.values()]) stopSource(source); }
  function disconnect() {
    // AbortSignal listeners fire synchronously: pending fetches and readers are
    // cancelled before this method returns. Cleanup finishes in their finally.
    for (const task of tasks) task.controller.abort(new OnlineError(OFFLINE));
    stopAll();
    retireContext(transferContext);
    transferContext = null;
    clearInterval(watchdog);
    watchdog = null;
  }

  async function startWebSource(options = {}) {
    requireOnline();
    const { id, url: input, width, height } = options || {};
    if (typeof id !== 'string' || !UUID.test(id)) throw new OnlineError('Choose a valid browser source.');
    const url = normalizeWebURL(input);
    const size = fitWebSize(width, height);
    if (!sources.has(id) && sources.size >= LIMITS.sources) {
      throw new OnlineError('Up to four browser sources can run at once. Stop one before adding another.');
    }
    stopWebSource(id);
    const source = { id, listeners: [], stopped: false, pendingImage: null, frameTimer: null, lastFrameAt: -Infinity };
    sources.set(id, source);
    maintainWatchdog();
    const listen = (emitter, event, listener) => {
      emitter.on(event, listener);
      source.listeners.push([emitter, event, listener]);
    };
    const fail = message => {
      if (source.stopped) return;
      status(source, 'error', message);
      stopSource(source, new OnlineError(message));
    };
    try {
      source.context = makeContext('page');
      const win = source.window = new BrowserWindow({
        ...size, show: false, frame: false, useContentSize: true, transparent: true,
        backgroundColor: '#00000000', resizable: false, fullscreenable: false,
        webPreferences: {
          session: source.context.session, offscreen: { useSharedTexture: false, deviceScaleFactor: 1 },
          sandbox: true, contextIsolation: true, nodeIntegration: false,
          nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
          webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
          backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
          devTools: false, plugins: false, spellcheck: false, disableDialogs: true,
          navigateOnDragDrop: false
        }
      });
      const contents = win.webContents;
      contents.setAudioMuted(true);
      contents.setFrameRate(LIMITS.fps);
      contents.setZoomFactor(1);
      contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      contents.setWindowOpenHandler(() => { blocked(); return { action: 'deny' }; });
      const navigate = (event, legacyURL) => {
        try { requireOnline(); normalizeWebURL(event.url || legacyURL); }
        catch { event.preventDefault(); blocked(); }
      };
      listen(contents, 'will-navigate', navigate);
      listen(contents, 'will-frame-navigate', navigate);
      listen(contents, 'will-redirect', navigate);
      listen(contents, 'will-attach-webview', event => { event.preventDefault(); blocked(); });
      listen(contents, 'content-bounds-updated', event => event.preventDefault());
      listen(contents, 'login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback(); });
      listen(contents, 'render-process-gone', () => fail('The browser source stopped responding. Try loading it again.'));
      listen(contents, 'did-start-loading', () => status(source, 'loading', 'Loading browser source…'));
      listen(contents, 'did-finish-load', () => {
        if (!source.stopped && enabled()) status(source, 'ready', 'Browser source ready. Audio is muted.');
      });
      listen(contents, 'did-fail-load', (event, code, _description, _url, mainFrame) => {
        if ((event.isMainFrame ?? mainFrame) && (event.errorCode ?? code) !== -3) {
          fail('The browser source could not load. Check its address and internet connection.');
        }
      });
      listen(win, 'closed', () => stopSource(source));
      listen(contents, 'destroyed', () => stopSource(source));

      const flushFrame = () => {
        source.frameTimer = null;
        const image = source.pendingImage;
        source.pendingImage = null;
        if (!image || source.stopped) return;
        if (!enabled()) { disconnect(); return; }
        try {
          const imageSize = image.getSize();
          if (imageSize.width !== size.width || imageSize.height !== size.height) return;
          // Electron 45's paint NativeImage is the WHOLE frame; dirtyRect is
          // metadata only. Do not crop it or reinterpret it as a complete image.
          const png = image.toPNG({ scaleFactor: 1 });
          source.lastFrameAt = performance.now();
          if (png.length && png.length <= LIMITS.pngBytes) {
            send('studio:web-frame', { id, png: new Uint8Array(png.buffer, png.byteOffset, png.byteLength) });
          }
        } catch { fail('The browser source frame could not be rendered. Try loading it again.'); }
      };
      listen(contents, 'paint', (_event, _dirtyRect, image) => {
        if (source.stopped) return;
        if (!enabled()) { disconnect(); return; }
        source.pendingImage = image; // One latest frame, one timer, no PNG queue.
        if (source.frameTimer) return;
        const delay = 1000 / LIMITS.fps - (performance.now() - source.lastFrameAt);
        if (delay <= 0) flushFrame();
        else source.frameTimer = setTimeout(flushFrame, Math.ceil(delay));
      });
      status(source, 'loading', 'Loading browser source…');
      await new Promise((resolve, reject) => {
        source.rejectLoad = reject;
        source.loadTimer = setTimeout(() => fail('The browser source took too long to load. Try again.'), LIMITS.loadMs);
        Promise.resolve(win.loadURL(url)).then(resolve, reject);
      });
      clearTimeout(source.loadTimer);
      source.rejectLoad = null;
      requireOnline();
      if (source.stopped) throw new OnlineError('The browser source was stopped.');
      status(source, 'ready', 'Browser source ready. Audio is muted.');
      return { id };
    } catch (error) {
      const safe = error instanceof OnlineError ? error :
        new OnlineError('The browser source could not load. Check its address and internet connection.');
      if (!source.stopped) status(source, 'error', safe.message);
      stopSource(source, safe);
      throw safe;
    }
  }

  function beginTask(kind, timeout, message) {
    requireOnline();
    if (kind === 'download' && [...tasks].filter(task => task.kind === kind).length >= LIMITS.downloads) {
      throw new OnlineError('Two media imports are already running. Wait for one to finish.');
    }
    const task = { kind, controller: new AbortController(), reader: null };
    task.aborted = new Promise((_resolve, reject) => {
      task.onAbort = () => {
        if (task.reader) bestEffort(task.reader, 'cancel');
        reject(task.controller.signal.reason);
      };
      task.controller.signal.addEventListener('abort', task.onAbort, { once: true });
    });
    // An abort can happen while a disk operation is awaited, before the next race.
    task.aborted.catch(() => {});
    task.timer = setTimeout(() => task.controller.abort(new OnlineError(message)), timeout);
    tasks.add(task);
    maintainWatchdog();
    return task;
  }
  function assertTask(task) {
    requireOnline();
    if (task.controller.signal.aborted) throw task.controller.signal.reason;
  }
  function endTask(task) {
    clearTimeout(task.timer);
    task.controller.signal.removeEventListener('abort', task.onAbort);
    if (task.reader) {
      bestEffort(task.reader, 'cancel');
      bestEffort(task.reader, 'releaseLock');
      task.reader = null;
    }
    tasks.delete(task);
    maintainWatchdog();
  }
  async function readChunk(task) {
    assertTask(task);
    const chunk = await Promise.race([task.reader.read(), task.aborted]);
    assertTask(task);
    return chunk;
  }
  async function fetchControlled(task, input) {
    let url = normalizeWebURL(input);
    for (let redirects = 0; ; redirects++) {
      assertTask(task);
      if (!transferContext) transferContext = makeContext('transfer');
      const request = transferContext.session.fetch(url, {
        method: 'GET', credentials: 'omit', redirect: 'manual', cache: 'no-store',
        signal: task.controller.signal, bypassCustomProtocolHandlers: true,
        headers: { 'Accept-Encoding': 'identity' }
      });
      const response = await Promise.race([
        Promise.resolve(request).then(value => {
          if (task.controller.signal.aborted || !enabled()) { cancelBody(value); assertTask(task); }
          return value;
        }), task.aborted
      ]);
      try { assertTask(task); } catch (error) { cancelBody(response); throw error; }
      if (!REDIRECTS.has(response.status)) return { response, url };
      cancelBody(response);
      if (redirects >= LIMITS.redirects) throw new OnlineError('The address redirected too many times (limit: five).');
      const location = response.headers.get('location');
      if (!location) throw new OnlineError('The server returned an invalid redirect.');
      try { url = normalizeWebURL(new URL(location, url).href); }
      catch { throw new OnlineError('The server redirected to an unsupported address.'); }
    }
  }

  async function importMedia(options = {}) {
    requireOnline();
    const { url: input, kind } = options || {};
    if (!['image', 'video'].includes(kind)) throw new OnlineError('Choose image or video to import.');
    const url = normalizeWebURL(input);
    const task = beginTask('download', LIMITS.downloadMs, 'The media download timed out after 120 seconds.');
    let handle;
    let file;
    let created = false;
    let completed = false;
    let response;
    try {
      const fetched = await fetchControlled(task, url);
      response = fetched.response;
      if (!response.ok || response.status === 206) throw new OnlineError('The server could not provide the complete media file.');
      const extension = mediaExtension(response, fetched.url, kind);
      const lengthHeader = response.headers.get('content-length');
      let expected = null;
      if (lengthHeader !== null) {
        if (!/^\d+$/.test(lengthHeader)) throw new OnlineError('The server returned an invalid media size.');
        expected = Number(lengthHeader);
        if (!Number.isSafeInteger(expected) || expected > LIMITS.downloadBytes) throw new OnlineError(TOO_LARGE);
      }
      if (!response.body || expected === 0) throw new OnlineError('The server returned an empty media file.');
      // Fetch decodes compressed bodies; their wire Content-Length still gets
      // capped above, but cannot be compared to the decoded byte count.
      const encoding = response.headers.get('content-encoding');
      const compareLength = expected !== null && (!encoding || encoding.toLowerCase() === 'identity');
      task.reader = response.body.getReader();
      const directory = path.resolve(dataDir, 'downloads');
      await fs.mkdir(directory, { recursive: true });
      assertTask(task);
      file = path.join(directory, `${randomUUID()}${extension}`);
      handle = await fs.open(file, 'wx', 0o600);
      created = true;
      assertTask(task);
      let total = 0;
      while (true) {
        const { done, value } = await readChunk(task);
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new OnlineError('The server returned invalid media data.');
        total += value.byteLength;
        if (total > LIMITS.downloadBytes) throw new OnlineError(TOO_LARGE);
        if (compareLength && total > expected) throw new OnlineError('The downloaded media size did not match the server response.');
        let offset = 0;
        while (offset < value.byteLength) {
          assertTask(task);
          const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
          if (!bytesWritten) throw new OnlineError('The media file could not be saved.');
          offset += bytesWritten;
        }
      }
      if (!total) throw new OnlineError('The server returned an empty media file.');
      if (compareLength && total !== expected) throw new OnlineError('The downloaded media size did not match the server response.');
      await handle.sync();
      await handle.close();
      handle = null;
      assertTask(task);
      const entry = await media.register(file, kind);
      assertTask(task);
      if (!entry) throw new OnlineError('The downloaded media file could not be imported.');
      completed = true;
      return entry;
    } catch (error) {
      if (!task.controller.signal.aborted) task.controller.abort(error instanceof OnlineError ? error :
        new OnlineError('The media could not be downloaded or saved. Check the address and try again.'));
      throw task.controller.signal.reason;
    } finally {
      if (!task.reader) cancelBody(response);
      endTask(task);
      if (handle) await handle.close().catch(() => {});
      if (created && !completed) await fs.unlink(file).catch(() => {});
    }
  }

  async function checkConnection() {
    if (checking) return { ok: false, message: 'A connection check is already running.' };
    let task;
    let response;
    checking = true;
    try {
      task = beginTask('connection', LIMITS.connectionMs, 'The connection check timed out after 10 seconds.');
      ({ response } = await fetchControlled(task, 'https://example.com/'));
      if (!response.ok) throw new OnlineError(`The connection check returned HTTP ${response.status}.`);
      if (response.body) {
        task.reader = response.body.getReader();
        let bytes = 0;
        while (bytes < LIMITS.connectionBytes) {
          const { done, value } = await readChunk(task);
          if (done) break;
          bytes += value.byteLength;
        }
      }
      assertTask(task);
      return { ok: true, status: response.status, message: 'Internet connection verified' };
    } catch (error) {
      const safe = task?.controller.signal.aborted ? task.controller.signal.reason : error;
      return { ok: false, message: safe instanceof OnlineError ? safe.message :
        'The internet connection could not be verified. Check your connection and try again.' };
    } finally {
      if (!task?.reader) cancelBody(response);
      if (task) endTask(task);
      checking = false;
    }
  }

  return { startWebSource, stopWebSource, stopAll, disconnect, importMedia, checkConnection };
}

module.exports = { createOnlineServices, normalizeWebURL, allowedWebResource, fitWebSize, LIMITS };
