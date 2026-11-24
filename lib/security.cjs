'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

const NETWORK_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:']);
const ACTION_WINDOW_MS = 15000;

function sameDocument(candidate, expected) {
  try {
    const url = new URL(candidate);
    url.hash = '';
    return url.href === expected;
  } catch { return false; }
}

function insideDirectory(file, root) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function allowedResource(urlString, root, internetEnabled = false) {
  try {
    const url = new URL(urlString);
    if (NETWORK_SCHEMES.has(url.protocol)) return internetEnabled && url.protocol !== 'ftp:';
    if (url.protocol === 'file:') return !url.hostname && insideDirectory(fileURLToPath(url), root);
    return ['studio-media:', 'blob:', 'data:', 'devtools:'].includes(url.protocol);
  } catch { return false; }
}

class LocalAccess {
  constructor(getWindow, entryURL, now = Date.now) {
    this.getWindow = getWindow;
    this.entryURL = entryURL;
    this.now = now;
    this.lastAction = -Infinity;
    this.capture = null;
  }

  trustedContents(contents) {
    const win = this.getWindow();
    return Boolean(win && !win.isDestroyed() && contents === win.webContents && !contents.isDestroyed() && sameDocument(contents.getURL(), this.entryURL));
  }

  trustedFrame(contents, frame) {
    return Boolean(this.trustedContents(contents) && frame && frame === contents.mainFrame && sameDocument(frame.url, this.entryURL));
  }

  authorize(event) {
    if (!this.trustedFrame(event.sender, event.senderFrame)) throw new Error('Only the local main frame may use Studio.');
  }

  noteAction(event) {
    this.authorize(event);
    if (this.getWindow().isFocused()) this.lastAction = this.now();
  }

  recentAction() { return this.now() - this.lastAction <= ACTION_WINDOW_MS; }

  requireAction() {
    if (!this.recentAction() || !this.getWindow()?.isFocused()) throw new Error('Use a button in Local LIVE Studio to perform this action.');
  }

  permission(contents, permission, details) {
    return ['media', 'display-capture'].includes(permission) && this.trustedContents(contents) &&
      details?.isMainFrame === true && sameDocument(details.requestingUrl, this.entryURL) && this.recentAction() &&
      this.getWindow().isFocused();
  }

  select(id, systemAudio) {
    this.requireAction();
    this.capture = { id, systemAudio: systemAudio === true, expires: this.now() + ACTION_WINDOW_MS };
  }

  consumeCapture(request) {
    const selection = this.capture;
    this.capture = null; // One request only, including a denied/expired request.
    const contents = this.getWindow()?.webContents;
    if (!selection || selection.expires < this.now() || !request.videoRequested ||
      !this.trustedFrame(contents, request.frame) || !this.recentAction()) return null;
    return selection;
  }

  reset() { this.lastAction = -Infinity; this.capture = null; }
}

function installNetworkPolicy(session, root, onBlocked, isEnabled = () => false) {
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const cancel = !allowedResource(details.url, root, isEnabled());
    if (cancel) onBlocked();
    callback({ cancel });
  });
  session.setDevicePermissionHandler(() => false);
  session.on('will-download', (event) => event.preventDefault());
}

module.exports = { LocalAccess, allowedResource, sameDocument, insideDirectory, installNetworkPolicy, installOfflinePolicy: installNetworkPolicy, ACTION_WINDOW_MS };
