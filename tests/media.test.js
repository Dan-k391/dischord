'use strict';

// Run with `node tests/media.test.js`. These tests exercise the application's
// actual media lifecycle without a browser or third-party test dependencies.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const tests = [];
const test = (name, run) => tests.push({ name, run });

function eventTarget(target = {}) {
  const listeners = new Map();
  target.addEventListener = (type, listener) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(listener);
  };
  target.removeEventListener = (type, listener) => {
    listeners.set(type, (listeners.get(type) || []).filter((l) => l !== listener));
  };
  target.dispatch = (type, event = {}) => {
    for (const listener of [...(listeners.get(type) || [])]) listener({ target, ...event });
  };
  return target;
}

function createClock() {
  let time = 1000, nextId = 1;
  const timers = new Map();
  const schedule = (callback, delay, interval) => {
    const id = nextId++;
    timers.set(id, { callback, at: time + Math.max(0, Number(delay) || 0), interval });
    return id;
  };
  return {
    now: () => time,
    setTimeout: (callback, delay) => schedule(callback, delay, 0),
    setInterval: (callback, delay) => schedule(callback, delay, Math.max(1, Number(delay) || 1)),
    clear: (id) => timers.delete(id),
    pending: (id) => timers.has(id),
    advance(ms) {
      const until = time + ms;
      let count = 0;
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        if (++count > 10000) throw new Error('Timer loop did not settle');
        const [id, timer] = next;
        time = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else timers.delete(id);
        timer.callback();
      }
      time = until;
    },
  };
}

function createElement(tag = 'div') {
  const classes = new Set();
  const node = eventTarget({
    tagName: tag.toUpperCase(), children: [], dataset: {}, style: {},
    innerHTML: '', textContent: '', value: '', src: '', srcHistory: [],
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
    },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    remove() {
      this.removed = true;
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
      this.parentNode = null;
    },
    setAttribute(name, value) { this[name] = String(value); },
    removeAttribute(name) { delete this[name]; },
    querySelectorAll: () => [], querySelector: () => null, closest: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 100, right: 100, width: 100, height: 100 }),
    focus() {}, select() {}, scrollIntoView() {},
  });
  let src = '';
  Object.defineProperty(node, 'src', {
    get: () => src,
    set(value) { src = String(value); node.srcHistory.push(src); },
  });
  if (tag === 'iframe') {
    node.messages = [];
    // Match VDO.Ninja's important distinction: a plain volume request changes
    // its global volume default, while target + settings only changes a stream.
    const perStream = new Map();
    node.audio = { globalVolume: 1, gain: (id) => perStream.has(id) ? perStream.get(id) : node.audio.globalVolume };
    node.contentWindow = {
      postMessage(message, origin) {
        node.messages.push({ ...JSON.parse(JSON.stringify(message)), _origin: origin });
        if (Object.prototype.hasOwnProperty.call(message, 'volume')) {
          node.audio.globalVolume = message.volume;
          if (message.target) perStream.set(message.target, message.volume);
        }
        if (message.target && message.settings && Object.prototype.hasOwnProperty.call(message.settings, 'volume')) {
          perStream.set(message.target, message.settings.volume);
        }
      },
    };
  }
  return node;
}

function createApp({ micOn = true, deaf = false, av = {}, legacyAv = false } = {}) {
  const clock = createClock(), nodes = new Map(), frames = [];
  const me = { id: 'alice', name: 'Alice', color: '#5865f2' };
  const server = { id: 'testserver', key: 'secret', name: 'Test server', v: 1,
    channels: [{ id: 'lounge', name: 'Lounge', type: 'voice' }, { id: 'games', name: 'Games', type: 'voice' }] };
  const stored = new Map(Object.entries({ me, servers: [server], micOn, deaf,
    av: { ...(legacyAv ? {} : { v8: 1, v9: 1 }), ...av } }).map(([key, value]) => ['dischord.' + key, JSON.stringify(value)]));
  const document = eventTarget({
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, createElement()); return nodes.get(id); },
    createElement(tag) { const el = createElement(tag); if (tag === 'iframe') frames.push(el); return el; },
    querySelectorAll: () => [], querySelector: () => null,
    body: createElement('body'), hidden: false, fullscreenElement: null,
  });
  const window = eventTarget({ innerHeight: 800, innerWidth: 1200 });
  const DateMock = class extends Date { constructor(...args) { super(...(args.length ? args : [clock.now()])); } static now() { return clock.now(); } };
  const context = vm.createContext({
    window, document, console, URL, URLSearchParams, Date: DateMock,
    location: { search: '', hash: '', pathname: '/', protocol: 'https:', hostname: 'localhost' },
    history: { replaceState() {} }, navigator: {},
    localStorage: { getItem: (key) => stored.has(key) ? stored.get(key) : null,
      setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
    crypto: { getRandomValues(values) { for (let i = 0; i < values.length; i++) values[i] = frames.length * 7 + i; return values; } },
    indexedDB: { open: () => ({}) },
    btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    setTimeout: clock.setTimeout, clearTimeout: clock.clear,
    setInterval: clock.setInterval, clearInterval: clock.clear,
    requestAnimationFrame: (callback) => clock.setTimeout(callback, 16),
    cancelAnimationFrame: clock.clear,
  });
  // Keep real event handlers and media functions. Skip page boot/rendering and
  // expose private bindings only in this isolated test copy of the source.
  const boot = /  checkInviteHash\(\);\s*\r?\n  if \(!me\) \{ profileModal\(true\); \} else start\(\);/;
  assert(boot.test(appSource), 'Unable to locate app boot block');
  const hooks = `
    render = () => {};
    renderControls = () => {};
    renderPresence = () => {};
    renderTyping = () => {};
    playTone = () => {};
    showVoice = () => {};
    window.mediaTest = {
      joinVoice, leaveVoice, toggleMic, toggleDeaf, toggleCam,
      toggleShare, stopShare, voiceUrl, screenUrl, myState, applyVolumes,
      get voice() { return voice; }, get av() { return av; },
      get micOn() { return micOn; }, get deaf() { return deaf; },
      setAudio(mic, muted) { micOn = mic; deaf = muted; },
      members, userVol, cur,
    };
  `;
  const source = appSource.replace(boot, '').replace(/\}\)\(\);\s*$/, hooks + '\n})();');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'file-transfer.js'), 'utf8'), context, { filename: 'file-transfer.js' });
  vm.runInContext(source, context, { filename: 'app.js' });
  const api = window.mediaTest;
  const emit = (frame, data, origin = 'https://vdo.ninja') => window.dispatch('message', { source: frame.contentWindow, data, origin });
  return { api, clock, document, frames, emit, stored, server,
    join(camera = false) { api.joinVoice(server.id, 'lounge', camera); clock.advance(camera ? 500 : 0); return api.voice.iframe; },
    addPeer(id, stream = 'stream' + id, screen = null) {
      if (!api.members[server.id]) api.members[server.id] = {};
      api.members[server.id][id] = { user: { id, name: id, color: '#5865f2' }, vc: 'lounge',
        vs: stream, vss: screen, st: { m: false, d: false, c: false, s: !!screen }, seen: clock.now(), uuids: new Set([id]) };
    } };
}

function lastMessage(frame, key) {
  return [...frame.messages].reverse().find((message) => Object.prototype.hasOwnProperty.call(message, key));
}

for (const fps of [5, 15, 30, 60]) {
  test(`screen capture uses selected ${fps} FPS as its primary frame rate`, () => {
    const app = createApp({ av: { ssFps: fps } });
    app.join();
    app.api.toggleShare();
    const query = new URL(app.api.voice.ssFrame.src).searchParams;
    assert.strictEqual(query.get('maxframerate'), String(fps));
    assert.strictEqual(query.get('screensharefps'), String(fps));
  });
}

for (const [resolution, quality] of [['720', 1], ['1080', 0], ['1440', -3], ['2160', -2], ['source', -1]]) {
  test(`screen capture uses ${resolution} as its primary quality`, () => {
    const app = createApp({ av: { ssQ: resolution } });
    app.join();
    app.api.toggleShare();
    const query = new URL(app.api.voice.ssFrame.src).searchParams;
    assert.strictEqual(query.get('quality'), String(quality));
    assert.strictEqual(query.get('screensharequality'), String(quality));
  });
}

test('new screen shares use the motion content hint by default', () => {
  const app = createApp();
  app.join();
  app.api.toggleShare();
  const query = new URL(app.api.voice.ssFrame.src).searchParams;
  assert.strictEqual(query.get('contenthint'), 'motion');
  assert.strictEqual(query.get('screensharecontenthint'), 'motion');
});

test('screen capture targets its selected bitrate and disables the hidden publisher preview', () => {
  const app = createApp({ av: { ssBr: 16000 } });
  app.join();
  app.api.toggleShare();
  const query = new URL(app.api.voice.ssFrame.src).searchParams;
  assert.strictEqual(query.get('outboundvideobitrate'), '16000');
  assert.strictEqual(query.get('maxvideobitrate'), '16000');
  assert(query.has('nopreview'));
});

test('fresh capture settings prioritize a stable 60 FPS share with a low cost self preview', () => {
  const app = createApp();
  assert.strictEqual(app.api.av.ssFps, 60);
  assert.strictEqual(app.api.av.ssQ, '1080');
  assert.strictEqual(app.api.av.ssHint, 'motion');
  assert.strictEqual(app.api.av.selfPreview, 'low');
});

test('saved media preferences survive loading and migrations', () => {
  const saved = { ssQ: 'source', ssFps: 15, ssBr: 4000, ssHint: 'detail', selfPreview: 'full', codec: '' };
  const app = createApp({ av: saved, legacyAv: true });
  for (const [key, value] of Object.entries(saved)) assert.strictEqual(app.api.av[key], value, key + ' must be preserved');
});

test('microphone muted on join does not put the publisher into speaker mute mode', () => {
  const app = createApp({ micOn: false });
  const frame = app.join();
  const query = new URL(frame.src).searchParams;
  assert(query.has('mute'), 'VDO URL mute initializes the microphone mute preference');
  assert(!query.has('mutespeaker'), 'Microphone mute must not initialize speaker mute');
});

for (const [micOn, deaf] of [[false, false], [true, false], [true, true]]) {
  test(`publisher readiness reconciles microphone=${micOn} and deaf=${deaf}`, () => {
    const app = createApp({ micOn, deaf });
    const frame = app.join();
    frame.messages.length = 0;
    app.emit(frame, { action: 'joined-room-complete' });
    app.clock.advance(0);
    assert.strictEqual(lastMessage(frame, 'mic').mic, micOn && !deaf);
    assert.strictEqual(lastMessage(frame, 'mute').mute, deaf);
    assert.strictEqual(lastMessage(frame, 'getLoudness').getLoudness, true);
  });
}

for (const action of ['new-audio-track-added', 'view-connection']) {
  test(`a ${action} event reapplies current microphone and playback state`, () => {
    const app = createApp();
    const frame = app.join();
    app.api.toggleMic();
    frame.messages.length = 0;
    app.emit(frame, { action, value: true, UUID: 'remotepeer' });
    app.clock.advance(0);
    assert.strictEqual(lastMessage(frame, 'mic').mic, false);
    assert.strictEqual(lastMessage(frame, 'mute').mute, false);
  });
}

test('microphone and playback acknowledgements do not create a command echo loop', () => {
  const app = createApp();
  const frame = app.join();
  frame.messages.length = 0;
  app.emit(frame, { action: 'audio-mute-state', value: false });
  app.emit(frame, { action: 'mic-mute-state', value: false });
  assert.strictEqual(frame.messages.length, 0);
});

test('loudness subscription media events do not resubscribe after acknowledgement, including camera rejoin', () => {
  const app = createApp();
  function exercise(frame) {
    let requests = 0;
    const postMessage = frame.contentWindow.postMessage;
    frame.contentWindow.postMessage = (message, origin) => {
      postMessage(message, origin);
      if (message.getLoudness) {
        if (++requests > 10) throw new Error('Loudness subscription triggered an event loop');
        // Older VDO.Ninja hosts can announce an audio track while installing
        // the subscription. This callback deliberately arrives synchronously.
        app.emit(frame, { action: 'new-audio-track-added', value: true });
        app.emit(frame, { loudness: {} });
      }
    };
    frame.dispatch('load');
    app.emit(frame, { action: 'joined-room-complete' });
    assert.strictEqual(requests, 1);
    assert.strictEqual(app.api.voice.loudnessRequested, true);
    assert.strictEqual(app.api.voice.loudnessReady, true);
    app.clock.advance(6000);
    app.emit(frame, { action: 'new-stream-added', value: true });
    app.emit(frame, { action: 'local-microphone-event', value: true });
    app.clock.advance(250);
    assert.strictEqual(requests, 1, 'Media events and delayed startup retries must not duplicate an acknowledged subscription');
  }
  const first = app.join();
  exercise(first);
  app.api.toggleCam();
  app.clock.advance(500);
  assert.notStrictEqual(app.api.voice.iframe, first);
  exercise(app.api.voice.iframe);
  assert.strictEqual(first.messages.filter((m) => m.getLoudness).length, 1, 'Camera rejoin must leave the retired subscription alone');
});

test('publisher startup retries loudness only until a snapshot acknowledges the subscription', () => {
  const app = createApp();
  const frame = app.join();
  frame.dispatch('load');
  app.clock.advance(0);
  assert.strictEqual(frame.messages.filter((m) => m.getLoudness).length, 1);
  app.clock.advance(1000);
  assert.strictEqual(frame.messages.filter((m) => m.getLoudness).length, 2, 'A lost subscription must receive a bounded startup retry');
  app.emit(frame, { loudness: {} });
  app.clock.advance(5000);
  assert.strictEqual(frame.messages.filter((m) => m.getLoudness).length, 2, 'Startup retries must stop subscribing after the first snapshot');
});

test('a publisher redirected to a fallback host still reconciles readiness by iframe source', () => {
  const app = createApp({ micOn: false });
  const frame = app.join();
  app.emit(frame, { action: 'joined-room-complete' }, 'https://cdn-backup.vdo.ninja');
  assert.strictEqual(lastMessage(frame, 'mic').mic, false);
  assert.strictEqual(lastMessage(frame, 'mute').mute, false);
});

test('screen capture started by its iframe on a fallback host still clears the picker timeout', () => {
  const app = createApp();
  app.join();
  app.api.toggleShare();
  const timeout = app.api.voice.ssTimer;
  app.emit(app.api.voice.ssFrame, { action: 'screen-share-state', value: true }, 'https://cdn-backup.vdo.ninja');
  assert.strictEqual(app.api.voice.ss, true);
  assert(!app.clock.pending(timeout));
});

test('per-user mute preserves the global playback default for a peer joining later', () => {
  const app = createApp();
  const frame = app.join();
  app.addPeer('bob');
  app.api.userVol.bob = { m: true };
  app.api.applyVolumes(true);
  assert.strictEqual(frame.audio.gain('streambob'), 0);
  assert.strictEqual(frame.audio.globalVolume, 1, 'Per-user mute must not change the global playback default');
  app.addPeer('carol');
  app.emit(frame, { action: 'new-audio-track-added', value: true, streamID: 'streamcarol' });
  app.clock.advance(0);
  assert.strictEqual(frame.audio.gain('streambob'), 0);
  assert.strictEqual(frame.audio.gain('streamcarol'), 1, 'A default-volume peer must join audibly');
  const carol = frame.messages.find((m) => m.target === 'streamcarol' && m.settings && m.settings.volume === 1);
  assert(carol, 'Reconciliation must explicitly apply the default 100% stream volume');
});

test('voice and screen volumes target their own streams and restore 100% on reconciliation', () => {
  const app = createApp();
  const frame = app.join();
  app.addPeer('bob', 'bobsvoice', 'bobsscreen');
  app.api.userVol.bob = { v: 35, sv: 60 };
  app.api.applyVolumes(true);
  assert.strictEqual(frame.audio.gain('bobsvoice'), 0.35);
  assert.strictEqual(frame.audio.gain('bobsscreen'), 0.6);
  assert.strictEqual(frame.audio.globalVolume, 1);
  app.api.userVol.bob = { v: 100, sv: 100 };
  app.api.applyVolumes(true);
  assert.strictEqual(frame.audio.gain('bobsvoice'), 1);
  assert.strictEqual(frame.audio.gain('bobsscreen'), 1);
});

test('muting microphone leaves speaker playback enabled', () => {
  const app = createApp();
  const frame = app.join();
  app.api.toggleMic();
  assert.strictEqual(app.api.micOn, false);
  assert.strictEqual(app.api.deaf, false);
  assert.strictEqual(lastMessage(frame, 'mic').mic, false);
  const speaker = lastMessage(frame, 'mute');
  assert(speaker && speaker.mute === false, 'Speaker mute must be explicitly independent of microphone state');
});

test('deafen restores the previous microphone preference when disabled', () => {
  const app = createApp({ micOn: false });
  const frame = app.join();
  app.api.toggleDeaf();
  assert.strictEqual(lastMessage(frame, 'mute').mute, true);
  assert.strictEqual(lastMessage(frame, 'mic').mic, false);
  app.api.toggleDeaf();
  assert.strictEqual(lastMessage(frame, 'mute').mute, false);
  assert.strictEqual(lastMessage(frame, 'mic').mic, false);
  assert.strictEqual(app.api.micOn, false);
});

test('unmuting microphone while deafened restores speaker playback', () => {
  const app = createApp({ deaf: true, micOn: false });
  const frame = app.join();
  app.api.toggleMic();
  assert.strictEqual(app.api.deaf, false);
  assert.strictEqual(app.api.micOn, true);
  assert.strictEqual(lastMessage(frame, 'mute').mute, false);
  assert.strictEqual(lastMessage(frame, 'mic').mic, true);
});

test('leaving before delayed camera rejoin prevents the abandoned frame loading', () => {
  const app = createApp();
  app.join();
  app.api.toggleCam();
  const abandoned = app.api.voice.iframe;
  app.api.leaveVoice();
  app.clock.advance(5000);
  assert.strictEqual(app.api.voice, null);
  assert(!abandoned.srcHistory.some((src) => src.includes('vdo.ninja')), 'Leaving must cancel the pending publisher navigation');
  assert.strictEqual(abandoned.removed, true);
});

test('a stale publisher load cannot apply delayed commands to a new call', () => {
  const app = createApp({ micOn: false });
  const oldFrame = app.join();
  oldFrame.dispatch('load');
  app.api.leaveVoice();
  const newFrame = app.join();
  newFrame.messages.length = 0;
  app.clock.advance(3000);
  assert.strictEqual(newFrame.messages.length, 0, 'A retired publisher must never send to the replacement publisher');
});

test('camera rejoin keeps the active screen and excludes its actual stream ID', () => {
  const app = createApp();
  app.join();
  app.api.toggleShare();
  const shareFrame = app.api.voice.ssFrame;
  const shareId = app.api.voice.ssVs;
  app.emit(shareFrame, { action: 'screen-share-state', value: true });
  app.api.toggleCam();
  app.clock.advance(500);
  assert.strictEqual(app.api.voice.ssFrame, shareFrame);
  assert.strictEqual(app.api.voice.ssVs, shareId);
  assert.strictEqual(app.api.voice.ss, true);
  assert.strictEqual(new URL(app.api.voice.iframe.src).searchParams.get('exclude'), shareId);
  assert(!shareFrame.removed, 'Rejoining for camera settings must keep the current share');
});

test('screen restart after a camera rejoin uses the publisher\'s reserved excluded stream ID', () => {
  const app = createApp();
  app.join();
  app.api.toggleShare();
  const stream = app.api.voice.ssVs;
  app.emit(app.api.voice.ssFrame, { action: 'screen-share-state', value: true });
  app.api.toggleCam();
  app.clock.advance(500);
  app.api.stopShare();
  app.api.toggleShare();
  assert.strictEqual(app.api.voice.ssVs, stream);
  assert.strictEqual(new URL(app.api.voice.ssFrame.src).searchParams.get('push'), stream);
  assert.strictEqual(new URL(app.api.voice.iframe.src).searchParams.get('exclude'), stream);
});

test('an active share advertises its captured settings until sharing restarts', () => {
  const app = createApp({ av: { ssBr: 8000, ssFps: 30 } });
  app.join();
  app.api.toggleShare();
  const frame = app.api.voice.ssFrame;
  app.emit(frame, { action: 'screen-share-state', value: true });
  app.api.av.ssBr = 16000;
  app.api.av.ssFps = 60;
  app.api.toggleCam();
  app.clock.advance(500);
  assert.strictEqual(app.api.voice.ssFrame, frame);
  assert.strictEqual(app.api.voice.ssSettings.ssBr, 8000);
  assert.strictEqual(app.api.voice.ssSettings.ssFps, 30);
  assert.strictEqual(app.api.myState().sb, 8000, 'Viewers must not be told the active share already uses the newly saved bitrate');
  app.api.stopShare();
  app.api.toggleShare();
  assert.strictEqual(app.api.voice.ssSettings.ssBr, 16000);
  assert.strictEqual(new URL(app.api.voice.ssFrame.src).searchParams.get('screensharefps'), '60');
  assert.strictEqual(app.api.myState().sb, 16000);
});

test('stopping a screen share clears its picker timeout', () => {
  const app = createApp();
  app.join();
  app.api.toggleShare();
  const timeout = app.api.voice.ssTimer;
  assert(app.clock.pending(timeout), 'Share picker must have a timeout');
  app.api.stopShare();
  assert(!app.clock.pending(timeout), 'Stopping share must clear its pending timer');
  assert.strictEqual(app.api.voice.ssFrame, null);
  assert.strictEqual(app.api.voice.ss, false);
});

test('starting a share clears its picker timeout', () => {
  const app = createApp();
  app.join();
  app.api.toggleShare();
  const timeout = app.api.voice.ssTimer;
  app.emit(app.api.voice.ssFrame, { action: 'screen-share-state', value: true });
  assert(!app.clock.pending(timeout));
  assert.strictEqual(app.api.voice.ss, true);
});

test('camera rejoin preserves a pending share timeout so the picker can still be cancelled', () => {
  const app = createApp();
  app.join();
  app.api.toggleShare();
  const timeout = app.api.voice.ssTimer;
  app.api.toggleCam();
  assert.strictEqual(app.api.voice.ssTimer, timeout);
  assert(app.clock.pending(timeout));
  app.api.stopShare();
  assert(!app.clock.pending(timeout));
});

let failed = 0;
for (const { name, run } of tests) {
  try { run(); console.log('ok - ' + name); }
  catch (error) { failed++; console.error('not ok - ' + name + '\n' + error.stack); }
}
console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
if (failed) process.exitCode = 1;
