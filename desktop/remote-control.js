'use strict';

// Remote control of this computer's screen share (Windows). Someone watching the share can ask to control it.
// The person at this computer has to agree in a native dialog: the web page and the other people in the call
// cannot answer it. Only one person controls at a time. Their input reaches only the shared screen or window,
// and it stops at once from a bar shown on top of everything, Ctrl+Alt+Esc, the tray menu, or by ending the
// share. Keys and buttons they were holding are released when it stops.

const { BrowserWindow, dialog, globalShortcut, screen } = require('electron');

const STOP_KEY = 'Control+Alt+Escape';
let win32 = null;
function native() {
  if (win32 || process.platform !== 'win32') return win32;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll'), dwmapi = koffi.load('dwmapi.dll');
  const MOUSEINPUT = koffi.struct('DischordMouseInput', { dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
  const KEYBDINPUT = koffi.struct('DischordKeyInput', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
  const INPUT = koffi.struct('DischordInput', { type: 'uint32', u: koffi.union('DischordInputUnion', { mi: MOUSEINPUT, ki: KEYBDINPUT }) });
  const RECT = koffi.struct('DischordRect', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
  win32 = {
    size: koffi.sizeof(INPUT),
    SendInput: user32.func('uint32 __stdcall SendInput(uint32 cInputs, DischordInput *pInputs, int cbSize)'),
    GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int nIndex)'),
    IsWindow: user32.func('bool __stdcall IsWindow(intptr hWnd)'),
    SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr hWnd)'),
    DwmGetWindowAttribute: dwmapi.func('long __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ DischordRect *rect, uint32 size)'),
    MapVirtualKeyW: user32.func('uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)'),
    rectSize: koffi.sizeof(RECT),
  };
  return win32;
}

// KeyboardEvent.code -> [virtual key, extended]. Physical keys: the layout of this computer applies.
const KEYS = (() => {
  const k = {
    Backspace: 0x08, Tab: 0x09, Enter: 0x0d, ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: [0xa3, 1],
    AltLeft: 0xa4, AltRight: [0xa5, 1], Pause: 0x13, CapsLock: 0x14, Escape: 0x1b, Space: 0x20, PageUp: [0x21, 1], PageDown: [0x22, 1],
    End: [0x23, 1], Home: [0x24, 1], ArrowLeft: [0x25, 1], ArrowUp: [0x26, 1], ArrowRight: [0x27, 1], ArrowDown: [0x28, 1],
    PrintScreen: [0x2c, 1], Insert: [0x2d, 1], Delete: [0x2e, 1], MetaLeft: [0x5b, 1], MetaRight: [0x5c, 1], ContextMenu: [0x5d, 1],
    NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: [0x6f, 1], NumpadEnter: [0x0d, 1],
    NumLock: [0x90, 1], ScrollLock: 0x91, Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf,
    Backquote: 0xc0, BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde, IntlBackslash: 0xe2,
  };
  for (let i = 0; i < 26; i++) k['Key' + String.fromCharCode(65 + i)] = 0x41 + i;
  for (let i = 0; i < 10; i++) { k['Digit' + i] = 0x30 + i; k['Numpad' + i] = 0x60 + i; }
  for (let i = 1; i <= 24; i++) k['F' + i] = 0x6f + i;
  const out = new Map();
  for (const [code, v] of Object.entries(k)) out.set(code, Array.isArray(v) ? { vk: v[0], ext: !!v[1] } : { vk: v, ext: false });
  return out;
})();
const BUTTONS = [[0x02, 0x04], [0x20, 0x40], [0x08, 0x10]]; // as in PointerEvent.button: left, middle, right: [down, up]

function create({ getWindow, showWindow, getShare, onChange }) {
  let session = null, asking = false;
  const owner = () => { const w = getWindow(); return w && !w.isDestroyed() ? w : null; };

  // The shared area in physical pixels: the display, or the window's visible frame.
  function area() {
    const share = getShare(), w = native();
    if (!share || !w) return null;
    if (share.sourceId.startsWith('screen:')) {
      const display = screen.getAllDisplays().find((d) => String(d.id) === String(share.displayId)) || (share.displayId ? null : screen.getPrimaryDisplay());
      if (!display) return null;
      const r = screen.dipToScreenRect(null, display.bounds);
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    const hwnd = Number((/^window:(\d+):/.exec(share.sourceId) || [])[1]);
    if (!hwnd || !w.IsWindow(hwnd)) return null;
    const rect = {};
    if (w.DwmGetWindowAttribute(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, rect, w.rectSize) !== 0) return null;
    return { x: rect.left, y: rect.top, w: rect.right - rect.left, h: rect.bottom - rect.top, hwnd };
  }
  function send(input) { const w = native(); if (w) w.SendInput(1, [input], w.size); }
  function mouse(flags, extra = {}) { send({ type: 0, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0, ...extra } } }); }
  function moveTo(x, y) {
    const a = area(), w = native();
    if (!a) return false;
    const vx = w.GetSystemMetrics(76), vy = w.GetSystemMetrics(77), vw = w.GetSystemMetrics(78), vh = w.GetSystemMetrics(79);
    const px = a.x + Math.min(a.w - 1, Math.max(0, Math.round(x * a.w))), py = a.y + Math.min(a.h - 1, Math.max(0, Math.round(y * a.h)));
    mouse(0x0001 | 0x8000 | 0x4000, { dx: Math.round((px - vx) * 65535 / Math.max(1, vw - 1)), dy: Math.round((py - vy) * 65535 / Math.max(1, vh - 1)) });
    return true;
  }
  function press(code, up) {
    const k = KEYS.get(code), w = native();
    if (!k || !w) return false;
    send({ type: 1, u: { ki: { wVk: k.vk, wScan: w.MapVirtualKeyW(k.vk, 0), dwFlags: (up ? 2 : 0) | (k.ext ? 1 : 0), time: 0, dwExtraInfo: 0 } } });
    return true;
  }

  // The bar on top of everything, on the shared screen, while someone is in control. Its Stop button sets the
  // page title, which this side watches: the bar needs no bridge into the app.
  function showBar(name) {
    const a = area(), d = a ? screen.getDisplayNearestPoint(screen.screenToDipPoint({ x: a.x + a.w / 2, y: a.y + 10 })) : screen.getPrimaryDisplay();
    const width = 460, height = 44;
    const bar = new BrowserWindow({ width, height, x: Math.round(d.workArea.x + (d.workArea.width - width) / 2), y: d.workArea.y + 8,
      frame: false, resizable: false, movable: true, minimizable: false, maximizable: false, alwaysOnTop: true, skipTaskbar: true,
      focusable: true, show: false, backgroundColor: '#1e1f22', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true } });
    bar.setAlwaysOnTop(true, 'screen-saver');
    const safe = String(name).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const html = `<!doctype html><meta charset="utf-8"><title>bar</title><body style="margin:0;height:100vh;display:flex;align-items:center;gap:10px;padding:0 6px 0 14px;box-sizing:border-box;background:#1e1f22;color:#dbdee1;font:13px 'Segoe UI',sans-serif;-webkit-app-region:drag;border:1px solid #f23f43;border-radius:8px;overflow:hidden">
      <span style="width:9px;height:9px;border-radius:50%;background:#f23f43;flex:none"></span>
      <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><b style="color:#fff">${safe}</b> is controlling your screen &middot; Ctrl+Alt+Esc</span>
      <button onclick="document.title='stop'" style="-webkit-app-region:no-drag;border:0;border-radius:6px;background:#da373c;color:#fff;font:600 13px 'Segoe UI',sans-serif;padding:7px 14px;cursor:pointer">Stop</button></body>`;
    bar.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {});
    bar.webContents.on('page-title-updated', (_e, title) => { if (title === 'stop') end('stopped'); });
    bar.webContents.on('will-navigate', (e) => e.preventDefault());
    bar.once('ready-to-show', () => bar.showInactive());
    bar.on('closed', () => { if (session && session.bar === bar) end('stopped'); });
    return bar;
  }

  // -> { allow, w, h }: the size of the shared area, so the other side can aim inside the picture
  async function ask(name) {
    if (session || asking || !native() || !area()) return { allow: false };
    asking = true;
    try {
      const w = owner();
      if (w) { showWindow(); w.flashFrame(true); }
      const options = { type: 'question', title: 'Dischord', noLink: true, buttons: ['Allow', 'Deny'], defaultId: 1, cancelId: 1,
        message: `${name} wants to control your screen.`,
        detail: 'They will be able to move your mouse, click and type on the screen or window you are sharing, until you stop it. ' +
          'Stop at any time with the bar at the top of your screen or Ctrl+Alt+Esc.' };
      const { response } = w ? await dialog.showMessageBox(w, options) : await dialog.showMessageBox(options);
      if (w && !w.isDestroyed()) w.flashFrame(false);
      const a = response === 0 ? area() : null;
      if (!a) return { allow: false };
      start(name);
      return { allow: true, w: a.w, h: a.h };
    } finally { asking = false; }
  }
  function start(name) {
    session = { name, keys: new Set(), buttons: new Set(), bar: null };
    session.bar = showBar(name);
    try { globalShortcut.register(STOP_KEY, () => end('stopped')); } catch { }
    const a = area();
    if (a && a.hwnd) try { native().SetForegroundWindow(a.hwnd); } catch { }
    onChange(true, null);
  }
  // reason: 'stopped' (by this side), 'remote' (the other side or the page), 'share' (the share ended)
  function end(reason) {
    if (!session) return;
    const s = session;
    session = null;
    for (const code of s.keys) press(code, true); // nothing stays held down
    for (const b of s.buttons) mouse(BUTTONS[b][1]);
    try { globalShortcut.unregister(STOP_KEY); } catch { }
    if (s.bar && !s.bar.isDestroyed()) s.bar.destroy();
    onChange(false, reason);
  }
  function input(ev) {
    if (!session || !ev || typeof ev !== 'object') return;
    const num = (v) => typeof v === 'number' && Number.isFinite(v);
    switch (ev.e) {
      case 'm': if (num(ev.x) && num(ev.y)) moveTo(ev.x, ev.y); break;
      case 'd': case 'u': {
        const b = ev.b === 1 || ev.b === 2 ? ev.b : 0;
        if (num(ev.x) && num(ev.y) && !moveTo(ev.x, ev.y)) break;
        mouse(BUTTONS[b][ev.e === 'd' ? 0 : 1]);
        if (ev.e === 'd') session.buttons.add(b); else session.buttons.delete(b);
        break;
      }
      case 'w': {
        const dy = num(ev.dy) ? Math.max(-1200, Math.min(1200, Math.round(-ev.dy * 1.2))) : 0;
        const dx = num(ev.dx) ? Math.max(-1200, Math.min(1200, Math.round(ev.dx * 1.2))) : 0;
        if (dy) mouse(0x0800, { mouseData: dy >>> 0 });
        if (dx) mouse(0x1000, { mouseData: dx >>> 0 });
        break;
      }
      case 'kd': case 'ku':
        if (typeof ev.c === 'string' && ev.c.length < 32 && press(ev.c, ev.e === 'ku')) {
          if (ev.e === 'ku') session.keys.delete(ev.c); else session.keys.add(ev.c);
        }
        break;
    }
  }
  return { ask, end, input, active: () => !!session, name: () => session && session.name, available: () => !!native() };
}

module.exports = { create, KEYS };
