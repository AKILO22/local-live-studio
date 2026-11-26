'use strict';
const { contextBridge, ipcRenderer } = require('electron');
function subscribe(channel, callback) { const listener = (_event, value) => callback(value); ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener); }
contextBridge.exposeInMainWorld('studioOutput', Object.freeze({ ready: () => ipcRenderer.invoke('studio:cast-ready'), signal: input => ipcRenderer.invoke('studio:cast-signal', input), state: input => ipcRenderer.invoke('studio:cast-state', input), onSignal: fn => subscribe('studio:cast-signal', fn), onAudio: fn => subscribe('studio:cast-audio', fn) }));
