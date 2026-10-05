'use strict';

const { app, BrowserWindow, Menu, desktopCapturer, dialog, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SITE = new URL('https://zjj-2785.github.io/dischord/');
const MEDIA_ORIGIN = 'https://vdo.ninja';
const PICKER_URL = pathToFileURL(path.join(__dirname, 'capture-picker.html')).href;
const OFFLINE_URL = pathToFileURL(path.join(__dirname, 'offline.html')).href;
const pickers = new Map();
const grants = new Set();
const permissionDialogs = new Map();
let mainWindow = null;
let retryDestination = SITE;
let queuedInvite = null;

app.setName('Dischord');
app.setAppUserModelId('io.github.zjj2785.dischord');

function siteURL(value) {
  try {
    const url = new URL(value);
    return url.origin === SITE.origin && !url.username && !url.password &&
      [SITE.pathname, SITE.pathname.slice(0, -1), SITE.pathname + 'index.html'].includes(url.pathname) ? url : null;
  } catch { return null; }
}
function originOf(value) {
  try { return new URL(value).origin; } catch { return ''; }
}
function appContents(contents) {
  return !!contents && !!mainWindow && !mainWindow.isDestroyed() &&
    contents === mainWindow.webContents && !contents.isDestroyed() && !!siteURL(contents.getURL());
}
function trustedFrame(contents, value) {
  return appContents(contents) && [SITE.origin, MEDIA_ORIGIN].includes(originOf(value));
}
function launchURL(commandLine) {
  return commandLine.map(siteURL).find(Boolean) || SITE;
}
function openExternal(value) {
  try {
    const url = new URL(value);
    if (['https:', 'http:', 'mailto:'].includes(url.protocol)) shell.openExternal(url.href).catch(() => {});
  } catch { }
}

function pendingPicker(event) {
  const pending = pickers.get(event.sender.id);
  return pending && event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === PICKER_URL ? pending : null;
}
function captureFrameLive(pending) {
  try {
    return appContents(mainWindow?.webContents) && pending.request.frame &&
      !pending.request.frame.detached && pending.request.frame.top === mainWindow.webContents.mainFrame &&
      trustedFrame(mainWindow.webContents, pending.request.frame.url);
  } catch { return false; }
}
function finishCapture(pending, source, includeAudio = false) {
  if (pending.finished) return;
  pending.finished = true;
  clearInterval(pending.lifetimeTimer);
  pickers.delete(pending.id);
  const streams = source && captureFrameLive(pending) ? { video: source } : {};
  if (streams.video && pending.request.audioRequested && includeAudio && process.platform === 'win32') {
    streams.audio = 'loopback';
  }
  try { pending.callback(streams); } catch { }
  if (!pending.window.isDestroyed()) pending.window.close();
}

ipcMain.handle('dischord:capture-list', async (event) => {
  const pending = pendingPicker(event);
  if (!pending || !captureFrameLive(pending)) {
    if (pending) finishCapture(pending);
    throw new Error('This sharing request has ended.');
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true
  });
  if (pending.finished || !captureFrameLive(pending)) {
    finishCapture(pending);
    throw new Error('This sharing request has ended.');
  }
  // The chooser itself is never a shareable source.
  const chooserHandle = pending.window.getNativeWindowHandle();
  const chooserId = chooserHandle.length >= 8 ? chooserHandle.readBigUInt64LE().toString() : chooserHandle.readUInt32LE().toString();
  const available = sources.filter((source) => !source.id.startsWith('window:' + chooserId + ':'));
  pending.sources = new Map(available.map((source) => [source.id, source]));
  return {
    sources: available.map((source) => ({ id: source.id, name: source.name,
      thumbnail: source.thumbnail.toDataURL(), appIcon: source.appIcon?.toDataURL() || '',
      kind: source.id.startsWith('screen:') ? 'screen' : 'window' })),
    audioRequested: !!pending.request.audioRequested && process.platform === 'win32'
  };
});
ipcMain.handle('dischord:capture-select', (event, selection) => {
  const pending = pendingPicker(event);
  if (pending && !captureFrameLive(pending)) {
    finishCapture(pending);
    return { ok: false, error: 'This sharing request has ended.' };
  }
  const source = pending && typeof selection?.sourceId === 'string' && pending.sources.get(selection.sourceId);
  if (!pending || !source) return { ok: false, error: 'That source is no longer available. Refresh the list.' };
  finishCapture(pending, source, selection.includeAudio === true);
  return { ok: true };
});
ipcMain.handle('dischord:capture-cancel', (event) => {
  const pending = pendingPicker(event);
  if (pending) finishCapture(pending);
  return { ok: true };
});

function chooseCapture(request, callback) {
  let frameIsOurs = false;
  try {
    frameIsOurs = appContents(mainWindow?.webContents) && request.frame &&
      request.frame.top === mainWindow.webContents.mainFrame && trustedFrame(mainWindow.webContents, request.frame.url);
  } catch { }
  if (!frameIsOurs || !request.videoRequested || pickers.size) { callback({}); return; }
  const picker = new BrowserWindow({
    parent: mainWindow, modal: true, width: 780, height: 620, minWidth: 540, minHeight: 460,
    title: 'Choose what to share — Dischord', backgroundColor: '#313338', show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'capture-picker-preload.js'), partition: 'capture-picker',
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true
    }
  });
  picker.setMenu(null);
  const pending = { id: picker.webContents.id, window: picker, request, callback, sources: new Map(), finished: false };
  pickers.set(picker.webContents.id, pending);
  // VDO can cancel its request or remove its iframe while the chooser is open.
  pending.lifetimeTimer = setInterval(() => {
    if (!captureFrameLive(pending)) finishCapture(pending);
  }, 1000);
  picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  picker.webContents.on('will-navigate', (event) => event.preventDefault());
  picker.once('ready-to-show', () => { if (!picker.isDestroyed()) picker.show(); });
  picker.on('closed', () => { if (!pending.finished) finishCapture(pending); });
  picker.loadFile(path.join(__dirname, 'capture-picker.html')).catch(() => finishCapture(pending));
}

function configurePermissions(ses) {
  const normal = new Set(['fullscreen', 'pointerLock', 'keyboardLock', 'clipboard-sanitized-write', 'screen-wake-lock']);
  const prompted = new Map([
    ['media', 'use your microphone and camera'],
    ['speaker-selection', 'select your audio output device'],
    ['notifications', 'show desktop notifications'],
    ['clipboard-read', 'read your clipboard'],
    ['local-network', 'connect to peers on your local network'],
    ['local-network-access', 'connect to peers on your local network']
  ]);
  const keyOf = (origin, permission) => origin + '|' + permission;
  function permissionContext(contents, permission, requesting) {
    return trustedFrame(contents, requesting) ||
      (!contents && permission === 'notifications' && originOf(requesting) === SITE.origin &&
        appContents(mainWindow?.webContents));
  }
  function automatic(contents, permission, requesting) {
    if (!trustedFrame(contents, requesting)) return false;
    if (normal.has(permission) || permission === 'display-capture') return true;
    // A chosen file handle stays under Chromium's native picker and user gesture.
    // fileSystem checks can report isMainFrame=false even for the hosted page.
    return permission === 'fileSystem' && originOf(requesting) === SITE.origin;
  }
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details = {}) => {
    const requesting = details.requestingUrl || details.securityOrigin || requestingOrigin;
    return automatic(contents, permission, requesting) ||
      permissionContext(contents, permission, requesting) && grants.has(keyOf(originOf(requesting), permission));
  });
  ses.setPermissionRequestHandler((contents, permission, callback, details = {}) => {
    const requesting = details.requestingUrl || details.securityOrigin || contents?.getURL();
    if (automatic(contents, permission, requesting)) { callback(true); return; }
    if (!permissionContext(contents, permission, requesting) || !prompted.has(permission)) { callback(false); return; }
    const origin = originOf(requesting), key = keyOf(origin, permission);
    if (grants.has(key)) { callback(true); return; }
    let pending = permissionDialogs.get(key);
    if (!pending) {
      pending = dialog.showMessageBox(mainWindow, {
        type: 'question', title: 'Dischord permission',
        message: 'Allow Dischord to ' + prompted.get(permission) + '?',
        detail: origin + '\nThis permission lasts for the current app session.',
        buttons: ['Allow', 'Don’t allow'], defaultId: 1, cancelId: 1, noLink: true
      }).then(({ response }) => {
        if (response === 0 && permissionContext(contents, permission, requesting)) { grants.add(key); return true; }
        return false;
      }).catch(() => false).finally(() => permissionDialogs.delete(key));
      permissionDialogs.set(key, pending);
    }
    pending.then((allowed) => { try { callback(allowed && permissionContext(contents, permission, requesting)); } catch { } });
  });
  ses.setDisplayMediaRequestHandler(chooseCapture);
}

function createWindow(destination) {
  retryDestination = destination;
  queuedInvite = null;
  const ses = session.fromPartition('persist:dischord');
  configurePermissions(ses);
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 720, minHeight: 500,
    title: 'Dischord', backgroundColor: '#313338', show: false, autoHideMenuBar: true,
    webPreferences: {
      session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const invite = siteURL(url);
    if (invite) acceptInvite(invite); else openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (mainWindow.webContents.getURL() === OFFLINE_URL && siteURL(url)) {
      event.preventDefault();
      loadHosted(queuedInvite || retryDestination);
    } else if (!siteURL(url)) { event.preventDefault(); openExternal(url); }
  });
  mainWindow.webContents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
    if (isMainFrame && !siteURL(url)) event.preventDefault();
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadFile(path.join(__dirname, 'offline.html')).catch(() => {});
      mainWindow.show();
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    const loaded = siteURL(mainWindow.webContents.getURL());
    if (!loaded) return;
    retryDestination = loaded;
    // Initial URL hashes are consumed by the web app during boot. Only deliver
    // a newer invite that arrived while that page was still loading.
    if (queuedInvite) {
      const invite = queuedInvite;
      queuedInvite = null;
      deliverInvite(invite);
    }
  });
  mainWindow.on('close', () => {
    for (const pending of [...pickers.values()]) finishCapture(pending);
  });
  mainWindow.on('closed', () => { mainWindow = null; grants.clear(); });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.loadURL(destination.href).catch(() => {});
}

function loadHosted(destination) {
  retryDestination = destination;
  queuedInvite = null;
  mainWindow.loadURL(destination.href).catch(() => {});
}
function deliverInvite(destination) {
  if (!destination.hash) return;
  const contents = mainWindow.webContents;
  contents.executeJavaScript('location.hash = ' + JSON.stringify(destination.hash)).catch(() => {
    if (!contents.isDestroyed() && !queuedInvite) queuedInvite = destination;
  });
}
function acceptInvite(destination) {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(destination); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
  // Adding an invite to an open client must not reload and interrupt a call.
  if (siteURL(mainWindow.webContents.getURL()) && !mainWindow.webContents.isLoadingMainFrame()) {
    deliverInvite(destination);
  } else if (mainWindow.webContents.isLoadingMainFrame()) {
    if (destination.hash) queuedInvite = destination;
  } else {
    loadHosted(destination.hash ? destination : (queuedInvite || retryDestination));
  }
}

const destination = launchURL(process.argv);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    app.whenReady().then(() => acceptInvite(launchURL(commandLine)));
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Dischord', submenu: [
        { label: 'Open website', click: () => openExternal(SITE.href) },
        { type: 'separator' }, { role: 'quit' }
      ] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] }
    ]));
    createWindow(destination);
  });
  app.on('activate', () => { if (!mainWindow) createWindow(SITE); });
  app.on('window-all-closed', () => app.quit());
}
