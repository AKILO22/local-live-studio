'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), { pathToFileURL } = require('node:url');
const { execFile, spawn } = require('node:child_process'), { promisify } = require('node:util'), { randomUUID } = require('node:crypto');
const { sameDocument } = require('./security.cjs');
const { atomicWrite } = require('./storage.cjs');
const execute = promisify(execFile);
function signal(value, role) {
  if (!value || typeof value !== 'object') throw new Error('Invalid output signal.');
  if (value.type === (role === 'studio' ? 'offer' : 'answer') && typeof value.sdp === 'string' && value.sdp.startsWith('v=0') && value.sdp.length <= 64000) return { type: value.type, sdp: value.sdp };
  const c = value.candidate;
  if (value.type === 'candidate' && c && typeof c.candidate === 'string' && /^candidate:/.test(c.candidate) && c.candidate.length <= 2048 &&
      (c.sdpMid === null || typeof c.sdpMid === 'string' && c.sdpMid.length <= 80) &&
      (c.sdpMLineIndex === null || Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex <= 8)) return { type: 'candidate', candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } };
  throw new Error('Invalid output signal.');
}
function childEnvironment() {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) if (process.env[name]) env[name] = process.env[name];
  return env;
}
async function verifyPublisher(file) {
  if (process.platform !== 'win32') throw new Error('TikTok LIVE Studio launching is supported on Windows.');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = await execute(executable, ['-NoProfile', '-NonInteractive', '-Command', "$s=Get-AuthenticodeSignature -LiteralPath $env:LOCAL_STUDIO_OFFICIAL_EXE; [pscustomobject]@{Valid=($s.Status -eq 'Valid');Subject=$s.SignerCertificate.Subject} | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 15000, maxBuffer: 8192, env: { ...childEnvironment(), LOCAL_STUDIO_OFFICIAL_EXE: file } });
  const certificate = JSON.parse(result.stdout);
  if (!certificate.Valid || !/(?:^|,\s*)O=TikTok Pte\. Ltd\.(?:,|$)/i.test(certificate.Subject || '')) throw new Error('Choose a genuine TikTok-signed LIVE Studio executable.');
}
class StudioRoute {
  constructor(options) {
    this.options = options; this.window = null; this.sessionId = ''; this.connection = 'closed'; this.audio = false; this.officialPath = ''; this.opening = null;
    this.settingsFile = path.join(options.dataDir, 'tiktok-studio.json');
    this.entry = path.join(options.root, 'cast/index.html'); this.entryURL = pathToFileURL(this.entry).href;
  }
  snapshot() { return { installed: !!this.officialPath, outputOpen: !!this.window, connection: this.connection, audio: this.audio, broadcastStatus: 'controlled-by-tiktok', sessionId: this.sessionId }; }
  notify() { this.options.onStatus?.(this.snapshot()); }
  async validExecutable(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !/^TikTok LIVE Studio(?: Launcher)?\.exe$/i.test(path.basename(file))) throw new Error('Choose TikTok LIVE Studio Launcher.exe or TikTok LIVE Studio.exe.');
    const real = await fs.realpath(file); if (!(await fs.stat(real)).isFile()) throw new Error('TikTok LIVE Studio was not found.');
    await (this.options.verifyPublisher || verifyPublisher)(real); return real;
  }
  async initialize() {
    let saved; try { if ((await fs.stat(this.settingsFile)).size < 8192) saved = JSON.parse(await fs.readFile(this.settingsFile, 'utf8')); } catch {}
    const candidates = [saved?.path, path.join(process.env.ProgramFiles || 'C:/Program Files', 'TikTok LIVE Studio/TikTok LIVE Studio Launcher.exe')].filter(Boolean);
    for (const file of candidates) { try { this.officialPath = await this.validExecutable(file); break; } catch {} }
    return this.snapshot();
  }
  async choose(file) { this.officialPath = await this.validExecutable(file); await atomicWrite(this.settingsFile, JSON.stringify({ path: this.officialPath })); this.notify(); return this.snapshot(); }
  async launch() {
    if (!this.options.isEnabled()) throw new Error('Enable Internet access before opening TikTok for broadcasting.');
    if (!this.officialPath) throw new Error('Install TikTok LIVE Studio or choose its executable.');
    const executable = await this.validExecutable(this.officialPath);
    await (this.options.launch || (file => new Promise((resolve, reject) => { const child = spawn(file, [], { detached: true, windowsHide: false, stdio: 'ignore', env: childEnvironment() }); child.once('error', () => reject(new Error('TikTok LIVE Studio could not open.'))); child.once('spawn', () => { child.unref(); resolve(); }); })))(executable);
    return this.snapshot();
  }
  authorized(event, role) {
    const window = role === 'output' ? this.window : this.options.getMainWindow();
    const url = role === 'output' ? this.entryURL : this.options.mainURL;
    return !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && sameDocument(event.senderFrame.url, url);
  }
  bind(ipc) {
    ipc.handle('studio:cast-ready', event => { if (!this.authorized(event, 'output')) throw new Error('Untrusted studio output.'); this.connection = 'connecting'; this.notify(); this.options.getMainWindow()?.webContents.send('studio:cast-ready', { sessionId: this.sessionId }); return { sessionId: this.sessionId }; });
    ipc.handle('studio:cast-signal', (event, input) => {
      const role = this.authorized(event, 'studio') ? 'studio' : this.authorized(event, 'output') ? 'output' : '';
      if (!role || !this.window || input?.sessionId !== this.sessionId) throw new Error('This studio output session ended.');
      const value = signal(input.signal, role), recipient = role === 'studio' ? this.window : this.options.getMainWindow();
      recipient?.webContents.send('studio:cast-signal', { sessionId: this.sessionId, signal: value }); return true;
    });
    ipc.handle('studio:cast-state', (event, input) => {
      if (!this.authorized(event, 'output') || input?.sessionId !== this.sessionId || !['connecting', 'connected', 'disconnected', 'failed'].includes(input.state)) throw new Error('Invalid studio output state.');
      this.connection = input.state; this.notify(); return true;
    });
  }
  async open(settings) {
    if (this.window) { this.window.show(); this.window.focus(); return this.snapshot(); }
    if (!settings || ![[1280,720],[1920,1080],[720,1280],[1080,1920]].some(([w,h]) => w === settings.width && h === settings.height)) throw new Error('Choose a supported canvas size before opening output.');
    const scale = Math.min(1, 1080 / settings.width, 780 / settings.height);
    this.sessionId = randomUUID(); this.audio = false; this.connection = 'opening';
    const win = this.window = new this.options.BrowserWindow({ title: 'Local LIVE Studio — Broadcast Output', width: Math.round(settings.width * scale), height: Math.round(settings.height * scale), useContentSize: true, minWidth: 280, minHeight: 280, show: false, backgroundColor: '#000000', autoHideMenuBar: true,
      webPreferences: { preload: path.join(this.options.root, 'cast/preload.cjs'), session: this.options.outputSession, sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', devTools: false } });
    win.setMenu(null); win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) win.webContents.on(name, event => event.preventDefault());
    win.webContents.on('render-process-gone', () => { if (this.window === win) this.close(); });
    win.on('closed', () => { if (this.window !== win) return; const id = this.sessionId; this.window = null; this.sessionId = ''; this.connection = 'closed'; this.audio = false; this.options.getMainWindow()?.webContents.send('studio:cast-closed', { sessionId: id }); this.notify(); });
    win.once('ready-to-show', () => win.show()); this.notify();
    try { await win.loadFile(this.entry); return this.snapshot(); } catch { this.close(); throw new Error('The studio output window could not load.'); }
  }
  setAudio(enabled) { if (typeof enabled !== 'boolean' || !this.window) throw new Error('Open studio output first.'); this.audio = enabled; this.window.webContents.send('studio:cast-audio', { enabled }); this.notify(); return this.snapshot(); }
  close() { this.window?.close(); return this.snapshot(); }
}
module.exports = { StudioRoute, signal, childEnvironment, verifyPublisher };
