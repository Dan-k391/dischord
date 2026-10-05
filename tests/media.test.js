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
  target.dispatchEvent = (event) => { target.dispatch(event.type, event); return true; };
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
    tagName: tag.toUpperCase(), children: [], dataset: {}, style: { setProperty(name, value) { this[name] = value; } },
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
          node.audio.globalVolume = Math.max(0, Math.min(1, Number(message.volume)));
          if (message.target) perStream.set(message.target, node.audio.globalVolume);
        }
        if (message.target && message.settings && Object.prototype.hasOwnProperty.call(message.settings, 'volume')) {
          // A native HTMLMediaElement cannot amplify above one. Boost tests
          // must exercise the actual Web Audio gain bridge, not a permissive
          // mock accepting an impossible volume=2 assignment.
          perStream.set(message.target, Math.max(0, Math.min(1, Number(message.settings.volume))));
        }
        if (node.runVdoMessage) node.runVdoMessage(message);
      },
    };
  }
  return node;
}

function createApp({ micOn = true, deaf = false, av = {}, legacyAv = false, vol = {} } = {}) {
  const clock = createClock(), nodes = new Map(), frames = [];
  let randomSequence = 0;
  const me = { id: 'alice', name: 'Alice', color: '#5865f2' };
  const server = { id: 'testserver', key: 'secret', name: 'Test server', v: 1,
    channels: [{ id: 'lounge', name: 'Lounge', type: 'voice' }, { id: 'games', name: 'Games', type: 'voice' }] };
  const stored = new Map(Object.entries({ me, servers: [server], micOn, deaf, vol,
    av: { ...(legacyAv ? {} : { v8: 1, v9: 1 }), ...av } }).map(([key, value]) => ['dischord.' + key, JSON.stringify(value)]));
  const document = eventTarget({
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, createElement()); return nodes.get(id); },
    createElement(tag) { const el = createElement(tag); if (tag === 'iframe') frames.push(el); return el; },
    querySelectorAll: () => [], querySelector: () => null,
    body: createElement('body'), documentElement: createElement('html'), hidden: false, fullscreenElement: null,
  });
  const window = eventTarget({ innerHeight: 800, innerWidth: 1200 });
  const DateMock = class extends Date { constructor(...args) { super(...(args.length ? args : [clock.now()])); } static now() { return clock.now(); } };
  const context = vm.createContext({
    window, document, console, URL, URLSearchParams, Date: DateMock,
    location: { search: '', hash: '', pathname: '/', protocol: 'https:', hostname: 'localhost', href: 'https://localhost/' },
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    history: { replaceState() {} }, navigator: {},
    localStorage: { getItem: (key) => stored.has(key) ? stored.get(key) : null,
      setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
    crypto: { getRandomValues(values) { const seed = ++randomSequence; for (let i = 0; i < values.length; i++) values[i] = seed * 17 + frames.length * 7 + i; return values; } },
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
    renderStage = () => {};
    wireProfileEditor = () => {};
    playTone = () => {};
    showVoice = () => {};
    window.mediaTest = {
      joinVoice, leaveVoice, toggleMic, toggleDeaf, toggleCam,
      toggleShare, stopShare, voiceUrl, screenUrl, myState, applyVolumes, setVol, saveAv,
      settingsModal, closeModal, userMenu,
      setMicGain: (value) => setMicGain(value),
      get voice() { return voice; }, get av() { return av; },
      get micOn() { return micOn; }, get deaf() { return deaf; },
      setAudio(mic, muted) { micOn = mic; deaf = muted; },
      members, userVol, cur,
    };
  `;
  const source = appSource.replace(boot, '').replace(/\}\)\(\);\s*$/, hooks + '\n})();');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'file-transfer.js'), 'utf8'), context, { filename: 'file-transfer.js' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'screen-quality.js'), 'utf8'), context, { filename: 'screen-quality.js' });
  vm.runInContext(source, context, { filename: 'app.js' });
  const api = window.mediaTest;
  const emit = (frame, data, origin = 'https://vdo.ninja') => window.dispatch('message', { source: frame.contentWindow, data, origin });
  return { api, clock, document, window, frames, emit, stored, server,
    node: (id) => document.getElementById(id),
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

function openAudioSettings(app) {
  app.api.settingsModal('av');
  app.node('mName').value = 'Alice';
  const controls = {
    aCamQ: 'camQ', aCamFps: 'camFps', aCamBr: 'camBr', aSsQ: 'ssQ',
    aSsFps: 'ssFps', aSsBr: 'ssBr', aSsHint: 'ssHint', aRecv: 'recvCap',
    aCodec: 'codec', aSelf: 'selfPreview', aMicGain: 'micGain',
  };
  // These lightweight DOM nodes do not parse HTML. Initialize controls from
  // the real settings draft before invoking its actual Save/Cancel handlers.
  for (const [id, key] of Object.entries(controls)) app.node(id).value = String(app.api.av[key]);
  app.node('aStats').checked = app.api.av.showStats;
}

function installVdoAudio(frame) {
  let sequence = 1;
  const connections = [], gains = [], sources = [], processed = [], originalCalls = [], micCalls = [];
  function track(prefix) {
    return { id: prefix + sequence++, kind: 'audio', readyState: 'live', stops: 0,
      stop() { this.stops++; this.readyState = 'ended'; } };
  }
  class MediaStreamMock {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
    getTracks() { return [...this.tracks]; }
  }
  function node(type) {
    return { type, disconnected: false, outputs: [],
      connect(destination) {
        assert.notStrictEqual(destination, audioCtx.destination, 'Boosted audio must retain VDO media-element playback');
        this.outputs.push(destination);
        destination.input = this;
        connections.push([this, destination]);
        return destination;
      },
      disconnect() { this.disconnected = true; this.outputs.length = 0; },
    };
  }
  const audioCtx = {
    currentTime: 0, state: 'running', destination: { type: 'device-output' },
    createMediaStreamSource(stream) { const source = Object.assign(node('source'), { stream }); sources.push(source); return source; },
    createGain() {
      const gain = Object.assign(node('gain'), { gain: { value: 1, setValueAtTime(value) { this.value = value; } } });
      gains.push(gain);
      return gain;
    },
    createMediaStreamDestination() {
      const destination = node('stream-destination');
      const output = track('owned');
      output.destination = destination;
      destination.stream = new MediaStreamMock([output]);
      return destination;
    },
    async resume() { this.state = 'running'; },
  };
  const session = { rpcs: {}, audioCtx, audioGain: 100, audioEffects: false, muted: false };
  const vdoWindow = eventTarget({});
  const original = function (uuid, input) {
    originalCalls.push({ uuid, input });
    const output = track('native-processed');
    processed.push(output);
    session.rpcs[uuid].inboundAudioPipeline = { input, output };
    return output;
  };
  let context;
  function rebuild(uuid) {
    const peer = session.rpcs[uuid];
    const raw = peer.streamSrc.getAudioTracks()[0];
    const output = session.audioEffects ? context.addAudioPipeline(uuid, raw) : raw;
    peer.videoElement.srcObject = new MediaStreamMock([output]);
  }
  context = vm.createContext({ window: vdoWindow, session, MediaStream: MediaStreamMock, console,
    addAudioPipeline: original, updateIncomingAudioElement: rebuild,
    changeMainGain(percent) { micCalls.push(percent); session.appliedMicGain = percent / 100; },
  });
  frame.runVdoMessage = (message) => {
    if (message.function === 'eval') vm.runInContext(message.value, context, { filename: 'actual-vdo-audio-bridge.js' });
    if (Object.prototype.hasOwnProperty.call(message, 'mute')) {
      session.muted = message.mute;
      for (const peer of Object.values(session.rpcs)) peer.videoElement.muted = session.muted;
    }
    if (message.settings && Object.prototype.hasOwnProperty.call(message.settings, 'volume')) {
      for (const peer of Object.values(session.rpcs)) if (peer.streamID === message.target) {
        peer.videoElement.volume = Math.max(0, Math.min(1, message.settings.volume));
      }
    }
    if (message.close) vdoWindow.dispatch('pagehide');
  };
  const api = { session, gains, sources, processed, originalCalls, micCalls, connections, window: vdoWindow, context,
    add(uuid, streamID) {
      const raw = track('original');
      const peer = { streamID, originalTrack: raw, streamSrc: new MediaStreamMock([raw]), inboundAudioPipeline: null,
        videoElement: { srcObject: new MediaStreamMock([raw]), volume: 1, muted: session.muted, sinkId: 'chosen-headphones' } };
      session.rpcs[uuid] = peer;
      return peer;
    },
    replace(uuid) {
      const raw = track('replacement');
      session.rpcs[uuid].originalTrack = raw;
      session.rpcs[uuid].streamSrc = new MediaStreamMock([raw]);
      session.audioEffects = true;
      rebuild(uuid);
      session.audioEffects = false;
      return raw;
    },
    gain(streamID) {
      const peer = Object.values(session.rpcs).find((p) => p.streamID === streamID);
      if (!peer) return 1;
      const element = peer.videoElement;
      if (element.muted) return 0;
      const output = element.srcObject.getAudioTracks()[0];
      return element.volume * (output.destination ? output.destination.input.gain.value : 1);
    },
  };
  frame.audio.gain = api.gain;
  return api;
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

test('microphone gain defaults to 100 percent and configures VDO Web Audio on join', () => {
  const app = createApp();
  assert.strictEqual(app.api.av.micGain, 100);
  assert.strictEqual(new URL(app.join().src).searchParams.get('audiogain'), '100');
});

test('saved microphone and per-person 200 percent preferences survive loading', () => {
  const app = createApp({ av: { micGain: 200 }, vol: { bob: { v: 200, sv: 175, m: false } } });
  assert.strictEqual(app.api.av.micGain, 200);
  assert.strictEqual(new URL(app.join().src).searchParams.get('audiogain'), '200');
  assert.strictEqual(app.api.userVol.bob.v, 200);
  assert.strictEqual(app.api.userVol.bob.sv, 175);
});

test('microphone gain setters clamp the supported range and persist without changing capture settings', () => {
  const app = createApp({ av: { ssFps: 15, ssBr: 4000, camQ: '1080' } });
  app.api.setMicGain(250);
  assert.strictEqual(app.api.av.micGain, 200);
  assert.strictEqual(JSON.parse(app.stored.get('dischord.av')).micGain, 200);
  app.api.setMicGain(-10);
  assert.strictEqual(app.api.av.micGain, 0);
  for (const [key, value] of Object.entries({ ssFps: 15, ssBr: 4000, camQ: '1080' })) {
    assert.strictEqual(app.api.av[key], value, 'Gain adjustments must retain ' + key);
  }
});

test('settings Cancel leaves microphone gain and saved preferences unchanged', () => {
  const app = createApp({ av: { micGain: 125 } });
  const before = app.stored.get('dischord.av');
  openAudioSettings(app);
  assert(/id="aMicGain"[^>]*max="200"|max="200"[^>]*id="aMicGain"/.test(app.node('modal').innerHTML),
    'The settings control must expose the 200 percent limit');
  app.node('aMicGain').value = '200';
  if (app.node('aMicGain').oninput) app.node('aMicGain').oninput();
  app.api.closeModal();
  assert.strictEqual(app.api.av.micGain, 125);
  assert.strictEqual(app.stored.get('dischord.av'), before);
});

test('settings Save applies microphone gain without reconnecting or changing screen choices', () => {
  const app = createApp({ av: { micGain: 100, ssFps: 15, ssQ: 'source', ssBr: 4000 } });
  const frame = app.join();
  app.api.toggleShare();
  const screen = app.api.voice.ssFrame;
  openAudioSettings(app);
  app.node('aMicGain').value = '200';
  app.node('mOk').onclick();
  assert.strictEqual(app.api.av.micGain, 200);
  assert.strictEqual(JSON.parse(app.stored.get('dischord.av')).micGain, 200);
  assert.strictEqual(app.api.voice.iframe, frame, 'Live gain adjustment does not require a device reconnect');
  assert.strictEqual(app.api.voice.ssFrame, screen);
  assert.strictEqual(app.api.av.ssFps, 15);
  assert.strictEqual(app.api.av.ssQ, 'source');
  assert.strictEqual(app.api.av.ssBr, 4000);
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
  const timeout = app.api.voice.ssTimer, screen = app.api.voice.ssFrame;
  app.emit(screen, { action: 'screen-share-state', value: true }, 'https://cdn-backup.vdo.ninja');
  assert.strictEqual(app.api.voice.ss, true);
  assert(!app.clock.pending(timeout));
  app.api.saveAv({ ssBr: 16000 });
  const config = screenQualityConfig(screen);
  assert.strictEqual(lastMessage(screen, 'function')._origin, 'https://cdn-backup.vdo.ninja', 'Hot changes must target the actual trusted fallback publisher');
  app.emit(screen, { dischordScreenQuality: { requestId: config.requestId, ok: true, active: true, mode: 'hot' } }, 'https://untrusted.example');
  assert.strictEqual(app.api.myState().sb, 12000, 'An unrelated origin must not acknowledge a fallback update');
  app.emit(screen, { dischordScreenQuality: { requestId: config.requestId, ok: true, active: true, mode: 'hot' } }, 'https://cdn-backup.vdo.ninja');
  assert.strictEqual(app.api.myState().sb, 16000);
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

test('live microphone 200 percent executes the VDO gain API and survives readiness events', () => {
  const app = createApp();
  const frame = app.join(), vdo = installVdoAudio(frame);
  app.api.setMicGain(200);
  assert.strictEqual(vdo.session.audioGain, 200);
  assert.strictEqual(vdo.session.appliedMicGain, 2, 'Execute changeMainGain rather than asserting an outgoing message');
  assert.strictEqual(JSON.parse(app.stored.get('dischord.av')).micGain, 200);
  app.emit(frame, { action: 'local-microphone-event', value: true });
  app.clock.advance(250);
  assert.strictEqual(vdo.session.appliedMicGain, 2);
  app.api.setMicGain(NaN);
  assert.strictEqual(app.api.av.micGain, 100);
  assert.strictEqual(vdo.session.appliedMicGain, 1);
});

test('200 percent voice and screen boosts execute independent media-stream gain graphs', () => {
  const app = createApp(), frame = app.join(), vdo = installVdoAudio(frame);
  app.addPeer('bob', 'bobsvoice', 'bobsscreen');
  const voicePeer = vdo.add('bob-voice', 'bobsvoice'), screenPeer = vdo.add('bob-screen', 'bobsscreen');
  app.api.setVol('bob', { v: 200, sv: 175 });
  assert.strictEqual(vdo.gain('bobsvoice'), 2);
  assert.strictEqual(vdo.gain('bobsscreen'), 1.75);
  assert.strictEqual(voicePeer.videoElement.volume, 1);
  assert.strictEqual(screenPeer.videoElement.volume, 1);
  assert.strictEqual(vdo.gains.length, 2);
  assert.strictEqual(vdo.originalCalls.length, 2, 'The boost wrapper must first run the existing VDO processing pipeline');
  assert(vdo.sources.every((source) => source.stream.getAudioTracks()[0].id.startsWith('native-processed')),
    'The graph processes the native pipeline output rather than bypassing it');
  assert(vdo.connections.every(([, destination]) => destination !== vdo.session.audioCtx.destination));
  assert.strictEqual(vdo.session.audioEffects, false, 'A one-time rebuild restores VDO processing preferences');
  assert.strictEqual(voicePeer.videoElement.sinkId, 'chosen-headphones');
  assert.strictEqual(screenPeer.videoElement.sinkId, 'chosen-headphones');
  assert.strictEqual(frame.audio.globalVolume, 1);
  assert.strictEqual(voicePeer.originalTrack.stops, 0);
  assert(vdo.processed.every((track) => track.stops === 0));
});

test('lowering a boosted peer to 50 percent restores unity gain and native half volume', () => {
  const app = createApp(), frame = app.join(), vdo = installVdoAudio(frame);
  app.addPeer('bob');
  const peer = vdo.add('bob', 'streambob');
  app.api.setVol('bob', { v: 200 });
  app.api.setVol('bob', { v: 50 });
  assert.strictEqual(vdo.gains.length, 1, 'Reusing the owned graph avoids duplicate audio sources');
  assert.strictEqual(vdo.gains[0].gain.value, 1);
  assert.strictEqual(peer.videoElement.volume, 0.5);
  assert.strictEqual(vdo.gain('streambob'), 0.5);
  assert.strictEqual(JSON.parse(app.stored.get('dischord.vol')).bob.v, 50);
  app.api.setVol('bob', { v: 250, sv: -10 });
  assert.strictEqual(app.api.userVol.bob.v, 200);
  assert.strictEqual(app.api.userVol.bob.sv, 0);
  assert.strictEqual(vdo.gain('streambob'), 2);
  app.api.setVol('bob', { v: NaN });
  assert.strictEqual(app.api.userVol.bob.v, 100);
  assert.strictEqual(vdo.gain('streambob'), 1);
});

test('mute and deafen silence boosted graphs and restore the saved 200 percent level', () => {
  const app = createApp({ av: { micGain: 200 } }), frame = app.join(), vdo = installVdoAudio(frame);
  app.addPeer('bob');
  const peer = vdo.add('bob', 'streambob');
  app.api.setVol('bob', { v: 200 });
  app.api.setVol('bob', { m: true });
  assert.strictEqual(vdo.gain('streambob'), 0);
  assert.strictEqual(vdo.gains[0].gain.value, 0);
  app.api.setVol('bob', { m: false });
  assert.strictEqual(vdo.gain('streambob'), 2);
  app.api.toggleDeaf();
  assert.strictEqual(peer.videoElement.muted, true);
  assert.strictEqual(vdo.gains[0].gain.value, 0);
  assert.strictEqual(vdo.gain('streambob'), 0);
  app.api.toggleDeaf();
  assert.strictEqual(peer.videoElement.muted, false);
  assert.strictEqual(vdo.gain('streambob'), 2);
  assert.strictEqual(vdo.session.appliedMicGain, 2);
  app.api.toggleMic();
  assert.strictEqual(lastMessage(frame, 'mic').mic, false);
  assert.strictEqual(vdo.gain('streambob'), 2, 'Muting input must leave amplified remote playback audible');
  assert.strictEqual(frame.audio.globalVolume, 1);
});

test('a new default-volume peer joins audibly without inheriting another person boost', () => {
  const app = createApp(), frame = app.join(), vdo = installVdoAudio(frame);
  app.addPeer('bob');
  vdo.add('bob', 'streambob');
  app.api.setVol('bob', { v: 200 });
  app.addPeer('carol');
  const carol = vdo.add('carol', 'streamcarol');
  app.emit(frame, { action: 'new-audio-track-added', value: true, streamID: 'streamcarol' });
  app.clock.advance(250);
  assert.strictEqual(vdo.gain('streambob'), 2);
  assert.strictEqual(vdo.gain('streamcarol'), 1);
  assert.strictEqual(carol.videoElement.volume, 1);
  assert.strictEqual(vdo.gains.length, 1, 'A 100 percent stream uses the existing playback pipeline');
  assert.strictEqual(frame.audio.globalVolume, 1);
});

test('a suspended audio context resumes when the receiver activates a boost', () => {
  const app = createApp(), frame = app.join(), vdo = installVdoAudio(frame);
  app.addPeer('bob');
  vdo.add('bob', 'streambob');
  vdo.session.audioCtx.state = 'suspended';
  app.api.setVol('bob', { v: 200 });
  assert.strictEqual(vdo.session.audioCtx.state, 'running');
  assert.strictEqual(vdo.gain('streambob'), 2);
  app.emit(frame, { action: 'new-stream-added', value: true });
  app.clock.advance(250);
  assert.strictEqual(vdo.gains.length, 1, 'Ready events reuse the installed graph');
});

test('replaced tracks and departed peers release owned graphs without stopping native tracks', () => {
  const app = createApp(), frame = app.join(), vdo = installVdoAudio(frame);
  app.addPeer('bob');
  const peer = vdo.add('bob', 'streambob'), originalInput = peer.originalTrack;
  app.api.setVol('bob', { v: 200 });
  const firstOutput = peer.videoElement.srcObject.getAudioTracks()[0];
  const replacement = vdo.replace('bob');
  assert.strictEqual(firstOutput.stops, 1);
  assert.strictEqual(vdo.sources[0].disconnected, true);
  assert.strictEqual(vdo.gains[0].disconnected, true);
  assert.strictEqual(originalInput.stops, 0);
  assert.strictEqual(replacement.stops, 0);
  assert(vdo.processed.every((track) => track.stops === 0));
  assert.strictEqual(vdo.gain('streambob'), 2);
  const finalOutput = peer.videoElement.srcObject.getAudioTracks()[0];
  delete vdo.session.rpcs.bob;
  delete app.api.members[app.server.id].bob;
  app.api.applyVolumes(true);
  assert.strictEqual(finalOutput.stops, 1);
  assert.strictEqual(vdo.window.__dischordAudioGainV1.records.size, 0);
  assert.strictEqual(replacement.stops, 0);
  app.api.leaveVoice();
  assert.strictEqual(vdo.window.__dischordAudioGainV1, undefined);
});

test('camera reconnect reapplies microphone and peer gain while retiring the old bridge', () => {
  const app = createApp({ av: { micGain: 200 }, vol: { bob: { v: 200 } } });
  const oldFrame = app.join(), oldVdo = installVdoAudio(oldFrame);
  app.addPeer('bob');
  const oldPeer = oldVdo.add('bob', 'streambob');
  app.emit(oldFrame, { action: 'joined-room-complete' });
  const output = oldPeer.videoElement.srcObject.getAudioTracks()[0];
  app.api.toggleCam();
  assert.strictEqual(output.stops, 1);
  assert.strictEqual(oldVdo.window.__dischordAudioGainV1, undefined);
  app.clock.advance(500);
  const newFrame = app.api.voice.iframe, newVdo = installVdoAudio(newFrame);
  newVdo.add('bob', 'streambob');
  const oldMessageCount = oldFrame.messages.length;
  app.emit(newFrame, { action: 'joined-room-complete' });
  app.clock.advance(250);
  assert.strictEqual(newVdo.gain('streambob'), 2);
  assert.strictEqual(newVdo.session.appliedMicGain, 2);
  assert.strictEqual(new URL(newFrame.src).searchParams.get('audiogain'), '200');
  oldFrame.dispatch('load');
  app.clock.advance(3000);
  assert.strictEqual(oldFrame.messages.length, oldMessageCount, 'Retired loads must not send gain commands');
  assert.strictEqual(newVdo.gains.length, 1);
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

function screenQualityConfig(frame) {
  const message = [...frame.messages].reverse().find((entry) => entry.function === 'eval' && entry.value.includes('__dischordScreenQualityV1'));
  assert(message, 'Quality changes must reach the active screen publisher');
  const config = message.value.match(/\)\((\{[\s\S]*\})\);$/);
  assert(config, 'The fixed quality adapter must receive a JSON configuration');
  return JSON.parse(config[1]);
}

test('live screen settings commit only after the active publisher acknowledges them', () => {
  const app = createApp({ av: { ssBr: 8000, ssFps: 30 } }), camera = app.join(true);
  app.api.toggleShare();
  const screen = app.api.voice.ssFrame, initialUrl = screen.src;
  app.emit(screen, { action: 'screen-share-state', value: true });
  const cameraCommands = camera.messages.length;
  app.api.saveAv({ ssQ: '1440', ssFps: 60, ssBr: 16000, ssHint: 'detail' });
  const config = screenQualityConfig(screen);
  assert.strictEqual(config.operation, 'apply');
  assert.strictEqual(config.ssFps, 60);
  assert.strictEqual(app.api.myState().sb, 8000, 'Unacknowledged bitrate must not be advertised');
  assert.strictEqual(screen.src, initialUrl, 'Live controls must preserve the existing capture iframe');
  assert.strictEqual(camera.messages.length, cameraCommands, 'Screen quality must not interrupt camera/microphone');
  app.emit(camera, { dischordScreenQuality: { requestId: config.requestId, ok: true } });
  app.emit(screen, { dischordScreenQuality: { requestId: config.requestId, ok: true } }, 'https://untrusted.example');
  assert.strictEqual(app.api.myState().sb, 8000, 'Unrelated frames/origins cannot acknowledge an update');
  app.emit(screen, { dischordScreenQuality: { requestId: config.requestId, ok: true, active: true, mode: 'hot' } });
  assert.strictEqual(app.api.myState().sb, 16000);
  assert.strictEqual(app.api.voice.ssSettings.ssFps, 60);
  assert.strictEqual(app.api.voice.ssSettings.ssQ, '1440');
  assert.strictEqual(app.api.voice.iframe, camera);
  assert.strictEqual(app.api.voice.ssFrame, screen);
});

test('rapid quality changes serialize requests and ignore acknowledgements for superseded requests', () => {
  const app = createApp(); app.join(); app.api.toggleShare();
  const screen = app.api.voice.ssFrame;
  app.emit(screen, { action: 'screen-share-state', value: true });
  app.api.saveAv({ ssBr: 16000 });
  const first = screenQualityConfig(screen), count = screen.messages.length;
  app.api.saveAv({ ssBr: 20000, ssFps: 30 });
  assert.strictEqual(screen.messages.length, count, 'Only one update may be in flight');
  app.emit(screen, { dischordScreenQuality: { requestId: first.requestId, ok: true, active: true, mode: 'hot' } });
  const second = screenQualityConfig(screen);
  assert.notStrictEqual(second.requestId, first.requestId);
  assert.strictEqual(second.ssBr, 20000);
  assert.strictEqual(second.ssFps, 30);
  assert.strictEqual(app.api.myState().sb, 16000);
  app.emit(screen, { dischordScreenQuality: { requestId: first.requestId, ok: false, active: false } });
  assert.strictEqual(app.api.voice.ssFrame, screen, 'A stale acknowledgement must not stop the newer request');
  app.emit(screen, { dischordScreenQuality: { requestId: second.requestId, ok: true, active: true, mode: 'hot' } });
  assert.strictEqual(app.api.myState().sb, 20000);
  assert.strictEqual(app.api.voice.ssSettings.ssFps, 30);
});

test('desktop fallback prepares a same-source restart before asking the host to run it', () => {
  const app = createApp(); app.document.documentElement.classList.add('desktop-client');
  const events = [];
  for (const type of ['dischord-screen-quality-restart', 'dischord-screen-quality-restart-run']) {
    app.window.addEventListener(type, (event) => events.push({ type, detail: event.detail }));
  }
  app.join(); app.api.toggleShare(); const screen = app.api.voice.ssFrame;
  app.emit(screen, { action: 'screen-share-state', value: true });
  app.api.saveAv({ ssQ: '2160' }); const config = screenQualityConfig(screen);
  app.emit(screen, { dischordScreenQuality: { requestId: config.requestId, ok: false, active: true, needsRestart: true } });
  assert.strictEqual(events[0].type, 'dischord-screen-quality-restart');
  app.window.dispatchEvent({ type: 'dischord-screen-quality-restart-ready', detail: { streamId: app.api.voice.ssVs, requestId: config.requestId, ok: true } });
  assert.strictEqual(screenQualityConfig(screen).operation, 'prepareRestart');
  assert.strictEqual(events.length, 1, 'Native capture may start only after the iframe prepares its restart');
  app.emit(screen, { dischordScreenQuality: { requestId: config.requestId, ok: true, prepared: true, mode: 'prepared', active: true } });
  assert.strictEqual(events[1].type, 'dischord-screen-quality-restart-run');
  app.emit(screen, { action: 'screen-share-state', value: false });
  assert.strictEqual(app.api.voice.ssFrame, screen, 'A temporary capture-end notification during restart must await its result');
  app.emit(screen, { dischordScreenQuality: { requestId: config.requestId, ok: false, active: true, error: 'The encoder refused the replacement.' } });
  assert.strictEqual(app.api.voice.ssFrame, screen, 'Failed replacement with a live original must retain sharing');
  assert.strictEqual(app.api.voice.ssSettings.ssQ, '1080');
});

test('camera rejoin preserves a pending quality request and manual stop ignores its late result', () => {
  const app = createApp(); app.join(); app.api.toggleShare(); const screen = app.api.voice.ssFrame;
  app.emit(screen, { action: 'screen-share-state', value: true });
  app.api.saveAv({ ssFps: 30 }); const config = screenQualityConfig(screen);
  app.api.toggleCam(); app.clock.advance(500);
  app.emit(screen, { dischordScreenQuality: { requestId: config.requestId, ok: true, active: true, mode: 'hot' } });
  assert.strictEqual(app.api.voice.ssSettings.ssFps, 30);
  app.api.saveAv({ ssBr: 20000 }); const stoppedConfig = screenQualityConfig(screen);
  app.api.stopShare();
  app.emit(screen, { dischordScreenQuality: { requestId: stoppedConfig.requestId, ok: true, active: true, mode: 'restart' } });
  app.clock.advance(45000);
  assert.strictEqual(app.api.voice.ssFrame, null, 'A late result must never resurrect a manually stopped capture');
  assert.strictEqual(app.api.voice.ss, false);
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
