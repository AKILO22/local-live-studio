'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, Menu, dialog, ipcMain, desktopCapturer, protocol, session, shell, safeStorage, clipboard } = require('electron');
const { ProjectStore, atomicWrite, encodeProject, readProject, createLogger } = require('./lib/storage.cjs');
const { MediaRegistry, MEDIA, localPath } = require('./lib/media.cjs');
const { RecordingStore } = require('./lib/recordings.cjs');
const { LocalAccess, installNetworkPolicy, sameDocument } = require('./lib/security.cjs');
const { createOnlineServices } = require('./lib/online.cjs');
const { AccountStore } = require('./lib/accounts.cjs');
const { GiftStore } = require('./lib/gifts.cjs');
const { TikTokConnection } = require('./lib/tiktok.cjs');
const { LiveStream } = require('./lib/livestream.cjs');
const { PhoneBridge } = require('./lib/phone.cjs');
const { StudioRoute } = require('./lib/studio-route.cjs');

const NAME = 'Local LIVE Studio';
const ROOT = __dirname;
const ENTRY = path.join(ROOT, 'index.html');
const ENTRY_URL = pathToFileURL(ENTRY).href;
app.setName(NAME);
app.setPath('userData', path.join(app.getPath('appData'), NAME));
app.setAppUserModelId('independent.local-live-studio');
for (const flag of ['disable-background-networking', 'disable-component-update', 'disable-domain-reliability', 'disable-sync', 'no-pings']) app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch('disable-features', 'MediaRouter,OptimizationHints,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions,WebRtcAllowInputVolumeAdjustment');
protocol.registerSchemesAsPrivileged([{ scheme: 'studio-media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

let win = null;
let recorder;
let projects;
let log = () => {};
let blockedRequests = 0;
let closeInProgress = false;
let allowClose = false;
let quitting = false;
let closeAcknowledgement = null;
let internetEnabled = true;
let online;
let accounts;
let gifts;
let tiktok;
let tiktokSession;
let livestream;
let phones;
let studioRoute;
let studioSession;
let preferencesFile;
let preferenceWrites = Promise.resolve();
const media = new MediaRegistry();
const access = new LocalAccess(() => win, ENTRY_URL);

function report(event, error) { log(event, { message: error?.message || String(error) }); }
function handle(name, callback) {
  ipcMain.handle(`studio:${name}`, async (event, ...args) => {
    access.authorize(event);
    try { return await callback(...args); } catch (error) { report(`ipc-${name}`, error); throw new Error(error.message); }
  });
}

function registerBridge(outputDir) {
  ipcMain.on('studio:user-action', event => {
    try { access.noteAction(event); } catch { /* untrusted frame */ }
  });
  handle('bootstrap', async () => ({ project: await projects.load(), recordings: await recorder.list(), outputDir, appVersion: app.getVersion(), network: { enabled: internetEnabled }, account: await accounts.status(), gifts: await gifts.snapshot(), tiktok: await tiktok.initialize(), live: livestream.snapshot(), phones: phones.snapshot(), studioRoute: studioRoute.snapshot() }));
  handle('cast-open', settings => { access.requireAction(); return studioRoute.open(settings); });
  handle('cast-close', () => studioRoute.close());
  handle('cast-audio', enabled => { access.requireAction(); return studioRoute.setAudio(enabled); });
  handle('cast-open-official', () => { access.requireAction(); return studioRoute.launch(); });
  handle('cast-download', () => { access.requireAction(); return shell.openExternal('https://www.tiktok.com/studio/download'); });
  handle('cast-pick-official', async () => {
    access.requireAction();
    const selected = await dialog.showOpenDialog(win, { title: 'Choose the official TikTok LIVE Studio executable', properties: ['openFile'], filters: [{ name: 'TikTok LIVE Studio executable', extensions: ['exe'] }] });
    return selected.canceled || !selected.filePaths[0] ? studioRoute.snapshot() : studioRoute.choose(selected.filePaths[0]);
  });
  handle('phone-start', () => { access.requireAction(); return phones.start(); });
  handle('phone-stop', () => phones.stop());
  handle('phone-accept', id => { access.requireAction(); return phones.accept(id); });
  handle('phone-disconnect', id => { access.requireAction(); return phones.remove(id); });
  handle('phone-signal', input => phones.send(input?.deviceId, input?.signal));
  handle('phone-peer-state', (id, state) => phones.setPeerState(id, state));
  handle('phone-copy-link', () => { access.requireAction(); const url = phones.snapshot().pairingURL; if (!url) throw new Error('Create a phone link first.'); clipboard.writeText(url); return true; });
  handle('phone-helper-download', () => { access.requireAction(); return shell.openExternal('https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'); });
  handle('phone-pick-helper', async () => {
    access.requireAction();
    const selected = await dialog.showOpenDialog(win, { title: 'Choose the Cloudflare phone connection helper', properties: ['openFile'], filters: [{ name: 'Cloudflare executable', extensions: ['exe'] }] });
    return selected.canceled || !selected.filePaths[0] ? phones.snapshot() : phones.setHelper(selected.filePaths[0]);
  });
  handle('live-save-destination', input => { access.requireAction(); return livestream.saveDestination(input); });
  handle('live-start', settings => { access.requireAction(); return livestream.start(settings); });
  handle('live-write', input => livestream.write(input));
  handle('live-stop', () => livestream.stop());
  handle('live-pick-encoder', async () => {
    access.requireAction();
    const result = await dialog.showOpenDialog(win, { title: 'Choose FFmpeg livestream encoder', properties: ['openFile'], filters: [{ name: 'FFmpeg executable', extensions: ['exe'] }] });
    return result.canceled || !result.filePaths[0] ? livestream.snapshot() : livestream.setEncoder(result.filePaths[0]);
  });
  handle('live-open-help', () => { access.requireAction(); return shell.openExternal('https://inapp.tiktokv.com/falcon/webcast_mt/page/obs_intro/index.html'); });
  handle('tiktok-save-settings', url => { access.requireAction(); return tiktok.saveSettings(url); });
  handle('tiktok-connect', () => { access.requireAction(); return tiktok.connect(); });
  handle('tiktok-cancel', () => { access.requireAction(); return tiktok.cancel(); });
  handle('tiktok-refresh', () => { access.requireAction(); return tiktok.refresh(); });
  handle('tiktok-disconnect', () => { access.requireAction(); if (livestream.active || livestream.status === 'connecting') throw new Error('End Live before disconnecting TikTok.'); return tiktok.disconnect(); });
  handle('tiktok-forget', () => { access.requireAction(); if (livestream.active || livestream.status === 'connecting') throw new Error('End Live before forgetting the account.'); return tiktok.forget(); });
  handle('gift-add-guest', input => { access.requireAction(); return gifts.addGuest(input); });
  handle('gift-remove-guest', id => { access.requireAction(); return gifts.removeGuest(id); });
  handle('gift-send', async input => { access.requireAction(); return gifts.send(input, (await accounts.status()).user?.name || 'Creator'); });
  handle('account-create', input => { access.requireAction(); return accounts.create(input); });
  handle('account-sign-in', input => { access.requireAction(); return accounts.signIn(input); });
  handle('account-sign-out', () => { access.requireAction(); return accounts.signOut(); });
  handle('network-set-enabled', enabled => {
    access.requireAction();
    if (typeof enabled !== 'boolean') throw new TypeError('Choose whether Internet access is enabled.');
    const operation = preferenceWrites.then(async () => {
      if (!enabled) { await livestream.stop('LIVE output stopped because Internet access was turned off.'); await phones.stop(); studioRoute.close(); }
      await atomicWrite(preferencesFile, JSON.stringify({ internetEnabled: enabled }));
      internetEnabled = enabled;
      if (!enabled) {
        tiktok.cancel();
        await tiktokSession.closeAllConnections();
        await online.disconnect();
        await studioSession.closeAllConnections();
      }
      return { enabled: internetEnabled };
    });
    preferenceWrites = operation.catch(error => report('network-preference', error));
    return operation;
  });
  handle('network-check', () => { access.requireAction(); return online.checkConnection(); });
  handle('web-source-start', options => online.startWebSource(options));
  handle('web-source-stop', id => online.stopWebSource(id));
  handle('import-online-media', options => { access.requireAction(); return online.importMedia(options); });
  handle('save-project', async project => {
    try { return await projects.save(project); } catch (error) { report('save-project', error); return false; }
  });
  handle('import-project', async () => {
    access.requireAction();
    const result = await dialog.showOpenDialog(win, { title: 'Import a Local LIVE Studio project', properties: ['openFile'], filters: [{ name: 'Studio project', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    if (!localPath(result.filePaths[0])) throw new Error('Choose a project on a local drive.');
    return readProject(result.filePaths[0]);
  });
  handle('export-project', async project => {
    access.requireAction();
    const bytes = encodeProject(project);
    const result = await dialog.showSaveDialog(win, { title: 'Export studio project', defaultPath: 'Local LIVE Studio Project.json', filters: [{ name: 'Studio project', extensions: ['json'] }], properties: ['showOverwriteConfirmation'] });
    if (result.canceled || !result.filePath) return false;
    if (!localPath(result.filePath)) throw new Error('Choose a destination on a local drive.');
    await atomicWrite(result.filePath, bytes);
    return true;
  });
  handle('pick-media', async kind => {
    access.requireAction();
    if (!['image', 'video'].includes(kind)) throw new TypeError('Choose image or video.');
    const extensions = Object.entries(MEDIA).filter(([, value]) => value[0] === kind).map(([extension]) => extension.slice(1));
    const result = await dialog.showOpenDialog(win, { title: `Choose a local ${kind}`, properties: ['openFile'], filters: [{ name: kind === 'image' ? 'Images' : 'Videos', extensions }] });
    return result.canceled || !result.filePaths[0] ? null : media.register(result.filePaths[0], kind);
  });
  handle('register-media', file => media.register(file));
  handle('list-sources', async () => {
    access.requireAction();
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
    return sources.map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() }));
  });
  handle('select-capture', async selection => {
    access.requireAction();
    if (!selection || typeof selection.id !== 'string' || selection.id.length > 250) throw new TypeError('Choose a capture source.');
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    if (!sources.some(source => source.id === selection.id)) throw new Error('The chosen capture source is no longer available.');
    access.select(selection.id, selection.systemAudio);
    return true;
  });
  handle('recording-start', options => recorder.start(options));
  handle('recording-write', options => recorder.write(options));
  handle('recording-finish', options => recorder.finish(options));
  handle('recording-cancel', options => recorder.cancel(options));
  handle('finish-close', async () => {
    if (!closeAcknowledgement || recorder.active || livestream.active) return false;
    await projects.idle();
    closeAcknowledgement(true);
    return true;
  });
  handle('save-snapshot', async bytes => {
    access.requireAction();
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 24 || bytes.byteLength > 64 * 1024 * 1024) throw new TypeError('Expected PNG bytes (up to 64 MiB).');
    const buffer = Buffer.from(bytes);
    if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new TypeError('The snapshot is not a PNG.');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const result = await dialog.showSaveDialog(win, { title: 'Save preview snapshot', defaultPath: path.join(app.getPath('pictures'), `Studio-${stamp}.png`), filters: [{ name: 'PNG image', extensions: ['png'] }], properties: ['showOverwriteConfirmation'] });
    if (result.canceled || !result.filePath) return null;
    if (!localPath(result.filePath)) throw new Error('Choose a destination on a local drive.');
    await atomicWrite(result.filePath, buffer);
    return { name: path.basename(result.filePath), path: result.filePath };
  });
  handle('reveal-file', async file => {
    access.requireAction();
    if (!await media.contains(file) && !await recorder.contains(file)) return false;
    shell.showItemInFolder(path.resolve(file));
    return true;
  });
  handle('open-recordings', async () => {
    access.requireAction();
    await fs.mkdir(outputDir, { recursive: true });
    const error = await shell.openPath(outputDir);
    if (error) throw new Error(error);
    return true;
  });
  handle('get-stats', () => {
    const metrics = app.getAppMetrics();
    return {
      cpuPercent: Math.round(metrics.reduce((sum, item) => sum + (item.cpu?.percentCPUUsage || 0), 0) * 10) / 10,
      memoryMB: Math.round(metrics.reduce((sum, item) => sum + (item.memory?.workingSetSize || 0), 0) / 1024),
      blockedRequests, internetEnabled
    };
  });
}

async function prepareSession() {
  const studioSession = session.fromPartition('studio-workspace');
  installNetworkPolicy(studioSession, ROOT, () => { blockedRequests += 1; }, () => internetEnabled);
  studioSession.setPermissionCheckHandler((contents, permission, origin, details) => access.permission(contents, permission, details));
  studioSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(access.permission(contents, permission, details)));
  studioSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const selection = access.consumeCapture(request);
    if (!selection) { callback({}); return; }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(item => item.id === selection.id);
      if (!source || !access.trustedFrame(win?.webContents, request.frame)) { callback({}); return; }
      const streams = { video: source };
      if (process.platform === 'win32' && selection.systemAudio && request.audioRequested) streams.audio = 'loopback';
      callback(streams);
    } catch (error) {
      report('display-capture', error);
      try { callback({}); } catch { /* frame may have closed */ }
    }
  }, { useSystemPicker: false });
  studioSession.protocol.handle('studio-media', request => media.respond(request));
  return studioSession;
}

function requestRendererClose() {
  return new Promise(resolve => {
    const done = value => {
      clearTimeout(timer);
      if (closeAcknowledgement === done) closeAcknowledgement = null;
      resolve(value);
    };
    const timer = setTimeout(() => done(false), 12000);
    closeAcknowledgement = done;
    win.webContents.send('studio:finish-before-close');
  });
}

async function confirmClose() {
  if (closeInProgress || allowClose) return;
  closeInProgress = true;
  try {
    let keepPartial = false;
    if (livestream.active || livestream.status === 'connecting') {
      const result = await dialog.showMessageBox(win, { type: 'question', title: 'LIVE output in progress', message: 'End Live and close the studio?', detail: 'This stops audio and video transmission. Also end the broadcast in TikTok’s app or dashboard.', buttons: ['End Live and close', 'Keep Live'], defaultId: 1, cancelId: 1, noLink: true });
      if (result.response !== 0) { quitting = false; return; }
      await livestream.stop();
    }
    if (recorder.active) {
      const { response } = await dialog.showMessageBox(win, { type: 'question', title: 'Recording in progress', message: 'Finish the recording before closing?', detail: 'Finishing saves the final video. Keeping a partial leaves received video chunks in the recordings folder for recovery.', buttons: ['Finish recording', 'Keep recording', 'Keep partial and quit'], defaultId: 0, cancelId: 1, noLink: true });
      if (response === 1) { quitting = false; return; }
      keepPartial = response === 2;
    }
    if (keepPartial) {
      await recorder.cancelAll();
    } else if (!await requestRendererClose()) {
      const retry = await dialog.showMessageBox(win, { type: 'warning', title: 'Studio is still saving', message: 'The studio has not confirmed that it finished saving.', detail: 'Closing now keeps the last committed project and any received recording chunks. Continue editing to wait for the save.', buttons: ['Continue editing', 'Close with saved data'], defaultId: 0, cancelId: 0, noLink: true });
      if (retry.response === 0) { quitting = false; return; }
      await recorder.cancelAll();
    }
    if (recorder.active) { quitting = false; return; }
    await projects.idle();
    await preferenceWrites;
    await accounts.idle();
    await gifts.idle();
    await tiktok.close();
    await livestream.stop();
    await phones.stop();
    studioRoute.close();
    await online.disconnect();
    await log.idle?.();
    allowClose = true;
    if (win && !win.isDestroyed()) win.close();
    if (quitting) app.quit();
  } catch (error) {
    report('close', error);
    quitting = false;
  } finally {
    closeInProgress = false;
  }
}

function createWindow(studioSession) {
  allowClose = false;
  win = new BrowserWindow({
    title: NAME, width: 1480, height: 940, minWidth: 1080, minHeight: 700,
    backgroundColor: '#101116', show: false, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.cjs'), session: studioSession,
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      backgroundThrottling: false, devTools: !app.isPackaged, spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required',
      navigateOnDragDrop: false
    }
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-frame-navigate', event => event.preventDefault());
  win.webContents.on('will-redirect', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
    if (isMainFrame && !sameDocument(url, ENTRY_URL)) access.reset();
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    log('renderer-crash', details);
    access.reset();
    online.disconnect();
    tiktok.cancel();
    livestream.stop('LIVE output stopped because the studio window closed unexpectedly.').catch(() => {});
    phones.stop().catch(() => {});
    studioRoute.close();
    recorder.cancelAll().catch(error => report('crash-recording-recovery', error));
  });
  win.webContents.on('preload-error', (_event, file, error) => report('preload-error', error));
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) log('renderer-load-failure', { code, description, url });
  });
  win.on('unresponsive', () => log('renderer-unresponsive'));
  win.once('ready-to-show', () => win?.show());
  win.on('close', event => {
    if (allowClose) return;
    event.preventDefault();
    void confirmClose();
  });
  win.on('closed', () => { win = null; access.reset(); });
  void win.loadFile(ENTRY).catch(error => report('load-window', error));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  app.on('before-quit', event => {
    if (win && !allowClose) {
      event.preventDefault();
      quitting = true;
      void confirmClose();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => {
    log = createLogger(path.join(app.getPath('userData'), 'logs'));
    projects = new ProjectStore(app.getPath('userData'), log);
    accounts = new AccountStore(app.getPath('userData'));
    gifts = new GiftStore(app.getPath('userData'));
    preferencesFile = path.join(app.getPath('userData'), 'preferences.json');
    try {
      const preferences = JSON.parse(await fs.readFile(preferencesFile, 'utf8'));
      if (typeof preferences.internetEnabled === 'boolean') internetEnabled = preferences.internetEnabled;
    } catch (error) {
      if (error.code !== 'ENOENT') report('network-preference-load', error);
    }
    let videos;
    try { videos = app.getPath('videos'); } catch { videos = app.getPath('documents'); }
    if (!localPath(videos)) throw new Error('The recordings folder must be on a local drive.');
    const outputDir = path.join(videos, NAME);
    recorder = new RecordingStore(outputDir, log);
    await fs.mkdir(outputDir, { recursive: true });
    Menu.setApplicationMenu(null);
    studioSession = await prepareSession();
    tiktokSession = session.fromPartition('studio-tiktok-connection');
    installNetworkPolicy(tiktokSession, ROOT, () => { blockedRequests++; }, () => internetEnabled);
    tiktokSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    tiktokSession.setPermissionCheckHandler(() => false);
    tiktok = new TikTokConnection({ dataDir: app.getPath('userData'), safeStorage, isEnabled: () => internetEnabled,
      fetch: (url, options) => tiktokSession.fetch(url, options),
      openExternal: url => shell.openExternal(url),
      onStatus: state => { if (win && !win.isDestroyed()) win.webContents.send('studio:tiktok-status', state); } });
    await tiktok.initialize();
    livestream = new LiveStream({ dataDir: app.getPath('userData'), isEnabled: () => internetEnabled,
      verifyTikTok: async () => {
        if (!tiktok.snapshot().hasSavedLink) throw new Error('Connect your TikTok account in Account before starting TikTok LIVE.');
        const linked = await tiktok.refresh();
        if (linked.status !== 'connected') throw new Error('Refresh your TikTok account connection before starting LIVE.');
      },
      onStatus: state => { if (win && !win.isDestroyed()) win.webContents.send('studio:live-status', state); } });
    await livestream.initialize();
    phones = new PhoneBridge({ dataDir: app.getPath('userData'), downloadsDir: app.getPath('downloads'), assetDir: path.join(ROOT, 'phone'), isEnabled: () => internetEnabled,
      onStatus: state => { if (win && !win.isDestroyed()) win.webContents.send('studio:phone-status', state); },
      onSignal: event => { if (win && !win.isDestroyed()) win.webContents.send('studio:phone-signal', event); } });
    await phones.initialize();
    const outputSession = session.fromPartition('studio-output');
    installNetworkPolicy(outputSession, ROOT, () => {}, () => false);
    outputSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    outputSession.setPermissionCheckHandler(() => false);
    studioRoute = new StudioRoute({ root: ROOT, dataDir: app.getPath('userData'), BrowserWindow, outputSession, mainURL: ENTRY_URL, getMainWindow: () => win, isEnabled: () => internetEnabled,
      onStatus: state => { if (win && !win.isDestroyed()) win.webContents.send('studio:cast-status', state); } });
    studioRoute.bind(ipcMain); await studioRoute.initialize();
    online = createOnlineServices({ BrowserWindow, session, dataDir: app.getPath('userData'), media, getWindow: () => win, isEnabled: () => internetEnabled, onBlocked: () => { blockedRequests += 1; } });
    registerBridge(outputDir);
    createWindow(studioSession);
    log('app-start', { version: app.getVersion(), internetEnabled });
  }).catch(async error => {
    report('startup', error);
    await log.idle?.();
    dialog.showErrorBox(NAME, `Local LIVE Studio could not start.\n${error.message}`);
    allowClose = true;
    app.quit();
  });
}

process.on('uncaughtException', error => report('uncaught-exception', error));
process.on('unhandledRejection', error => report('unhandled-rejection', error));
