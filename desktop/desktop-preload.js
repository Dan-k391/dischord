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

function restartDetails(payload) {
  return typeof payload?.streamId === 'string' && payload.streamId.length > 0 && payload.streamId.length <= 256 &&
    typeof payload.requestId === 'string' && payload.requestId.length > 0 && payload.requestId.length <= 128;
}
window.addEventListener('dischord-screen-quality-restart', async (event) => {
  const detail = event.detail;
  if (!restartDetails(detail)) return;
  const payload = { streamId: detail.streamId, requestId: detail.requestId };
  let result;
  try { result = await ipcRenderer.invoke('dischord:screen-quality-restart', payload); }
  catch { result = { ok: false, error: 'The desktop sharing bridge is unavailable.' }; }
  window.dispatchEvent(new CustomEvent('dischord-screen-quality-restart-ready', {
    detail: { ...payload, ok: result?.ok === true, ...(typeof result?.error === 'string' ? { error: result.error } : {}) }
  }));
});
window.addEventListener('dischord-screen-quality-restart-cancel', (event) => {
  if (!restartDetails(event.detail)) return;
  ipcRenderer.send('dischord:screen-quality-restart-cancel', {
    streamId: event.detail.streamId, requestId: event.detail.requestId
  });
});
window.addEventListener('dischord-screen-quality-restart-run', async (event) => {
  if (!restartDetails(event.detail)) return;
  const payload = { streamId: event.detail.streamId, requestId: event.detail.requestId };
  let result;
  try { result = await ipcRenderer.invoke('dischord:screen-quality-restart-run', payload); }
  catch { result = { ok: false, error: 'The desktop sharing bridge is unavailable.' }; }
  window.dispatchEvent(new CustomEvent('dischord-screen-quality-restart-ran', {
    detail: { ...payload, ok: result?.ok === true, ...(typeof result?.error === 'string' ? { error: result.error } : {}) }
  }));
});
window.addEventListener('dischord-screen-share-stopped', (event) => {
  if (typeof event.detail?.streamId !== 'string' || !event.detail.streamId || event.detail.streamId.length > 256) return;
  ipcRenderer.send('dischord:screen-share-stopped', { streamId: event.detail.streamId });
});
ipcRenderer.on('dischord:screen-quality-restart-failed', (_event, payload) => {
  if (!restartDetails(payload)) return;
  window.dispatchEvent(new CustomEvent('dischord-screen-quality-restart-failed', {
    detail: { streamId: payload.streamId, requestId: payload.requestId,
      error: typeof payload.error === 'string' ? payload.error : 'The sharing source could not be restarted.' }
  }));
});

// Native window controls stay in Electron's title-bar overlay. The hosted app
// only needs a CSS marker to reserve space for its matching draggable bar.
// desktop-unload-guard: this shell asks before closing during a file transfer (see will-prevent-unload),
// so the page may object to closing then.
// desktop-update: Settings can offer "Check for updates"; the check and its dialogs run in the app.
function markDesktop() {
  document.documentElement.classList.add('desktop-client', 'desktop-' + process.platform, 'desktop-unload-guard', 'desktop-update');
  // desktop-control: this app can be remotely controlled while it shares a screen (Windows only)
  if (process.platform === 'win32') document.documentElement.classList.add('desktop-control');
  ipcRenderer.invoke('dischord:app-version').then((v) => { if (typeof v === 'string' && v.length < 32) document.documentElement.dataset.appVersion = v; }).catch(() => {});
  window.dispatchEvent(new Event('dischord-desktop-ready'));
}
window.addEventListener('DOMContentLoaded', markDesktop, { once: true });
window.addEventListener('dischord-check-updates', () => ipcRenderer.send('dischord:check-updates'));

// Remote control of this computer's screen share. The page relays a viewer's request; the app itself asks the
// person here (a native dialog the page cannot answer) and injects the approved viewer's input.
const rcEvent = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
window.addEventListener('dischord-rc', async (event) => {
  const d = event.detail || {};
  if (d.op === 'ask' && typeof d.id === 'string' && typeof d.name === 'string') {
    let answer = null;
    try { answer = await ipcRenderer.invoke('dischord:rc-ask', { name: d.name.slice(0, 64) }); } catch { }
    const size = (n) => (Number.isInteger(n) && n > 0 && n < 100000 ? n : undefined);
    rcEvent('dischord-rc-answer', { id: d.id, allow: answer?.allow === true, w: size(answer?.w), h: size(answer?.h) });
  } else if (d.op === 'input' && d.ev && typeof d.ev === 'object') {
    const ev = d.ev, n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    ipcRenderer.send('dischord:rc-input', { e: String(ev.e).slice(0, 2), x: n(ev.x), y: n(ev.y), b: n(ev.b), dx: n(ev.dx), dy: n(ev.dy), c: typeof ev.c === 'string' ? ev.c.slice(0, 31) : undefined });
  } else if (d.op === 'end') ipcRenderer.send('dischord:rc-end');
});
ipcRenderer.on('dischord:rc-ended', (_event, payload) => rcEvent('dischord-rc-ended', { reason: typeof payload?.reason === 'string' ? payload.reason : 'stopped' }));
