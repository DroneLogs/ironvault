'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The renderer never touches Node, the filesystem, or the KDBX library. It can
 * only ask the main process to run one of the named methods in ipc.js, and it
 * only ever receives already-redacted data back.
 */
const listeners = {
  'vault:locked': new Set(),
  'clipboard:cleared': new Set(),
  'open-file': new Set(),
  'update-state': new Set(),
  approval: new Set(),
  progress: new Set(),
  'ssh-agent': new Set(),
  'autotype-result': new Set(),
  'url-search': new Set(),
  'system-theme': new Set(),
  menu: new Set()
};

for (const channel of Object.keys(listeners)) {
  ipcRenderer.on(channel, (_event, payload) => {
    for (const fn of listeners[channel]) {
      try {
        fn(payload);
      } catch (err) {
        console.error('listener failed for ' + channel, err);
      }
    }
  });
}

contextBridge.exposeInMainWorld('propolis', {
  async call(method, args) {
    const response = await ipcRenderer.invoke('propolis', method, args);
    if (response && response.ok) return response.result;
    const error = new Error(response && response.error ? response.error.message : 'Request failed');
    if (response && response.error && response.error.code) error.code = response.error.code;
    throw error;
  },
  on(channel, fn) {
    if (!listeners[channel]) throw new Error('Unknown channel: ' + channel);
    listeners[channel].add(fn);
    return () => listeners[channel].delete(fn);
  }
});
