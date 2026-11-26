'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const tls = require('node:tls');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('./storage.cjs');
const execute = promisify(execFile);
const MAX_CHUNK = 4 * 1024 * 1024;
const MAX_PENDING = 8 * 1024 * 1024;

function destination(input) {
  if (!input || !['tiktok', 'custom'].includes(input.provider)) throw new Error('Choose TikTok or a custom streaming server.');
  if (typeof input.serverURL !== 'string' || input.serverURL.length > 2048 || /[\s\x00-\x1f\x7f\\]/.test(input.serverURL)) throw new Error('Enter the LIVE server URL supplied by your platform.');
  let url; try { url = new URL(input.serverURL); } catch { throw new Error('Enter a valid RTMP or RTMPS server URL.'); }
  if (!['rtmp:', 'rtmps:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || url.search) throw new Error('Use an RTMP or RTMPS server URL without credentials or a query. Put the stream key in its own field.');
  if (typeof input.streamKey !== 'string' || !input.streamKey.length || input.streamKey.length > 2048 || /[\s\x00-\x1f\x7f\\]/.test(input.streamKey)) throw new Error('Enter the stream key supplied by your platform.');
  return { provider: input.provider, serverURL: url.href.replace(/\/+$/, ''), streamKey: input.streamKey };
}

function encoderArguments(settings, target, caFile) {
  const { fps, bitrate } = settings;
  return ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-nostats', '-stats_period', '0.5', '-progress', 'pipe:1',
    '-protocol_whitelist', 'pipe,rtmp,rtmps,tcp,tls,crypto', '-analyzeduration', '1000000', '-probesize', '1048576', '-fflags', '+genpts', '-f', 'webm', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-r', String(fps), '-g', String(fps * 2), '-b:v', String(bitrate), '-maxrate', String(bitrate), '-bufsize', String(bitrate * 2),
    '-c:a', 'aac', '-b:a', '128000', '-ar', '48000', '-ac', '2', '-flvflags', 'no_duration_filesize', '-rtmp_live', 'live', '-rw_timeout', '15000000',
    ...(target.startsWith('rtmps:') ? ['-tls_verify', '1', '-ca_file', caFile] : []), '-f', 'flv', target];
}

class LiveStream {
  constructor(options) {
    this.options = options;
    this.target = null;
    this.encoderPath = '';
    this.encoderReady = false;
    this.status = 'idle'; this.message = 'Set up your LIVE destination to begin.';
    this.active = null; this.epoch = 0; this.startedAt = 0; this.bytesSent = 0; this.durationMs = 0;
    this.spawn = options.spawn || spawn;
    this.execute = options.execute || execute;
    this.settingsFile = path.join(options.dataDir, 'live-encoder.json');
  }
  snapshot() {
    return { status: this.status, message: this.message, configured: !!this.target, provider: this.target?.provider || 'tiktok',
      serverHost: this.target ? new URL(this.target.serverURL).host : '', encoderReady: this.encoderReady,
      encoderName: this.encoderReady ? path.basename(this.encoderPath) : '', active: !!this.active, startedAt: this.startedAt, durationMs: this.durationMs, bytesSent: this.bytesSent };
  }
  notify() { this.options.onStatus?.(this.snapshot()); }
  async initialize() {
    let saved;
    try { const file = await fs.stat(this.settingsFile); if (file.size < 8192) saved = JSON.parse(await fs.readFile(this.settingsFile, 'utf8')); } catch { /* First launch. */ }
    const candidates = [saved?.encoderPath,
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'ffmpeg', 'bin', 'ffmpeg.exe')].filter(Boolean);
    try { const found = await this.execute(process.platform === 'win32' ? 'where.exe' : 'which', ['ffmpeg'], { windowsHide: true, timeout: 3000, maxBuffer: 8192 }); candidates.push(...found.stdout.trim().split(/\r?\n/)); } catch { /* Optional external encoder. */ }
    for (const candidate of [...new Set(candidates)]) { try { await this.checkEncoder(candidate); break; } catch { /* Try next known installation. */ } }
    return this.snapshot();
  }
  async checkEncoder(file) {
    if (!path.isAbsolute(file) || !/^ffmpeg(?:\.exe)?$/i.test(path.basename(file))) throw new Error('Choose ffmpeg.exe from an FFmpeg installation.');
    const stat = await fs.stat(file); if (!stat.isFile()) throw new Error('The encoder executable was not found.');
    const { stdout } = await this.execute(file, ['-version'], { windowsHide: true, timeout: 5000, maxBuffer: 65536 });
    if (!/^ffmpeg version /m.test(stdout) || !stdout.includes('--enable-libx264')) throw new Error('Use an FFmpeg build with the libx264 video encoder.');
    this.encoderPath = file; this.encoderReady = true;
  }
  async setEncoder(file) {
    if (this.active || this.status === 'connecting') throw new Error('End Live before changing the encoder.');
    await this.checkEncoder(file);
    await atomicWrite(this.settingsFile, JSON.stringify({ version: 1, encoderPath: file }));
    this.notify(); return this.snapshot();
  }
  saveDestination(input) {
    if (this.active || this.status === 'connecting') throw new Error('End Live before changing the destination.');
    this.target = destination(input); this.status = 'ready'; this.message = 'Destination ready for this app session. Check your scene, then Start Live.';
    this.notify(); return this.snapshot();
  }
  async start(settings) {
    if (this.active || this.status === 'connecting') throw new Error('A LIVE output is already starting or active.');
    if (!this.options.isEnabled()) throw new Error('Enable Internet access before starting a LIVE output.');
    if (!this.target) throw new Error('Add your platform’s LIVE server URL and stream key first.');
    if (!this.encoderReady) throw new Error('Install FFmpeg with libx264, then choose ffmpeg.exe in LIVE setup.');
    if (![24, 30, 60].includes(settings?.fps) || ![1500000, 3000000, 6000000, 9000000].includes(settings?.bitrate)) throw new Error('Choose a supported frame rate and bitrate.');
    const epoch = ++this.epoch;
    this.status = 'connecting'; this.startedAt = 0; this.bytesSent = 0; this.durationMs = 0; this.message = 'Preparing LIVE output…'; this.notify();
    try {
      if (this.target.provider === 'tiktok') await this.options.verifyTikTok();
      if (epoch !== this.epoch || !this.options.isEnabled()) throw new Error('LIVE start was cancelled.');
      const target = this.target;
      let caFile = '';
      if (target.serverURL.startsWith('rtmps:')) {
        caFile = path.join(this.options.dataDir, 'live-ca-roots.pem');
        const certificates = [...new Set([...tls.rootCertificates, ...(tls.getCACertificates?.('system') || [])])];
        await atomicWrite(caFile, certificates.join('\n'));
      }
      if (epoch !== this.epoch || !this.options.isEnabled()) throw new Error('LIVE start was cancelled.');
      const url = target.serverURL + '/' + target.streamKey;
      const environment = { ...process.env }; delete environment.FFREPORT;
      const child = this.spawn(this.encoderPath, encoderArguments(settings, url, caFile), { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: environment });
      const active = { id: randomUUID(), child, pending: 0, sequence: 0, stopping: false, diagnostic: '', progress: '', frames: 0, started: Date.now(), lastProgress: Date.now() };
      this.active = active;
      active.closed = new Promise(resolve => { active.resolveClose = resolve; });
      child.stdin.on('error', () => {});
      child.stdout.on('data', data => this.progress(active, data));
      child.stderr.on('data', data => { active.diagnostic = (active.diagnostic + data.toString()).slice(-65536); });
      child.once('error', () => this.finish(active, false, 'The encoder could not start. Check its installation.'));
      child.once('close', () => this.finish(active, active.stopping));
      active.monitor = setInterval(() => {
        if (Date.now() - active.lastProgress > (this.options.stallMs || 20000)) { this.finish(active, false, 'LIVE output stalled. Check your connection and stream key, then start a new session.'); child.kill(); }
      }, 1000); active.monitor.unref?.();
      this.message = 'Connecting to the streaming server…'; this.notify();
      return { id: active.id, ...this.snapshot() };
    } catch (error) {
      if (epoch === this.epoch) { this.status = 'error'; this.message = error.message; this.notify(); }
      throw error;
    }
  }
  progress(active, data) {
    if (this.active !== active) return;
    active.progress += data.toString();
    if (active.progress.length > 16384) active.progress = active.progress.slice(-8192);
    const lines = active.progress.split(/\r?\n/); active.progress = lines.pop();
    for (const line of lines) {
      const [key, value] = line.split('=');
      if (key === 'frame' && Number.isFinite(+value)) active.frames = +value;
      if (key === 'total_size' && Number.isFinite(+value)) this.bytesSent = Math.max(this.bytesSent, +value);
      if (key === 'progress' && active.frames > 0) {
        active.lastProgress = Date.now();
        if (!active.stopping) {
          if (this.status !== 'live') { this.startedAt = Date.now(); this.status = 'live'; this.message = 'Sending live audio and video. Confirm your broadcast is visible on the platform.'; }
          this.notify();
        }
      }
    }
  }
  async write(input) {
    const active = this.active;
    if (!active || active.stopping || input?.id !== active.id || input.sequence !== active.sequence) throw new Error('This LIVE session is no longer accepting video.');
    const value = input.bytes;
    if (!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw new Error('Expected encoded video bytes.');
    const bytes = value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (!bytes.length || bytes.length > MAX_CHUNK || active.pending + bytes.length > MAX_PENDING) throw new Error('The connection cannot keep up with this LIVE bitrate. End Live and choose a lower bitrate.');
    active.sequence++; active.pending += bytes.length;
    try { await new Promise((resolve, reject) => active.child.stdin.write(bytes, error => error ? reject(new Error('The LIVE encoder stopped accepting video.')) : resolve())); }
    finally { active.pending -= bytes.length; }
    return true;
  }
  finish(active, normal, message) {
    if (this.active !== active) { active.resolveClose?.(); return; }
    clearInterval(active.monitor);
    this.active = null;
    this.durationMs = this.startedAt ? Math.max(0, Date.now() - this.startedAt) : 0;
    this.status = normal ? 'ended' : 'error';
    this.message = normal ? (this.target?.provider === 'tiktok' ? 'LIVE output ended. Also end the broadcast in TikTok’s app or LIVE dashboard.' : 'LIVE output ended.') : message || (/auth|BadName|denied|rejected|403/i.test(active.diagnostic) ? 'The server rejected this LIVE output. Check LIVE access and get a fresh stream key.' : 'LIVE output disconnected. Check the server URL, stream key and Internet connection.');
    active.diagnostic = ''; active.progress = '';
    if (this.target?.provider === 'tiktok') this.target = null;
    active.resolveClose?.(); this.notify();
  }
  async stop(reason) {
    ++this.epoch;
    const active = this.active;
    if (!active) { if (this.status === 'connecting') { this.status = 'ended'; this.message = 'LIVE start cancelled.'; this.notify(); } return this.snapshot(); }
    if (!active.stopping) {
      active.stopping = true; this.status = 'stopping'; this.message = 'Ending LIVE output…'; this.notify(); active.child.stdin.end();
      active.killTimer = setTimeout(() => { active.child.kill(); this.finish(active, false, reason || 'LIVE output stopped after the encoder did not finish in time.'); }, 5000); active.killTimer.unref?.();
    }
    await active.closed; clearTimeout(active.killTimer);
    if (reason) { this.status = 'error'; this.message = reason; this.notify(); }
    return this.snapshot();
  }
}
module.exports = { LiveStream, destination, encoderArguments, MAX_CHUNK, MAX_PENDING };
