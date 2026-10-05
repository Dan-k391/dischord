'use strict';

const { ipcRenderer } = require('electron');

// Relay only the validated native picker cancellation for its stream. No Node
// APIs or general IPC bridge are exposed to the hosted page.
ipcRenderer.on('dischord:screen-share-cancelled', (_event, payload) => {
  if (typeof payload?.streamId !== 'string' || !payload.streamId || payload.streamId.length > 256) return;
  window.dispatchEvent(new CustomEvent('dischord-screen-share-cancelled', {
    detail: { streamId: payload.streamId }
  }));
});

// Native window controls stay in Electron's title-bar overlay. The hosted app
// only needs a CSS marker to reserve space for its matching draggable bar.
function markDesktop() {
  document.documentElement.classList.add('desktop-client', 'desktop-' + process.platform);
  window.dispatchEvent(new Event('dischord-desktop-ready'));
}
window.addEventListener('DOMContentLoaded', markDesktop, { once: true });
