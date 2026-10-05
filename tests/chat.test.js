'use strict';

// Run with `node tests/chat.test.js`. Exercise the actual chat integration in
// an isolated browser VM, including the production file-transfer module.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Blob } = require('buffer');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const plain = (value) => JSON.parse(JSON.stringify(value));

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

function createElement(tag = 'div', onClick = () => {}) {
  const classes = new Set();
  return eventTarget({
    tagName: tag.toUpperCase(), children: [], dataset: {}, style: {},
    innerHTML: '', textContent: '', value: '', scrollHeight: 100,
    scrollTop: 0, clientHeight: 100,
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
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
      this.parentNode = null;
    },
    setAttribute(name, value) { this[name] = String(value); },
    removeAttribute(name) { delete this[name]; },
    querySelectorAll: () => [], querySelector: () => null, closest: () => null,
    focus() {}, select() {}, scrollIntoView() {},
    click() { onClick(this); if (this.onclick) this.onclick({ target: this }); },
    getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 100, right: 100, width: 100, height: 100 }),
  });
}

function fakeFile(name = 'notes.txt', text = 'private attachment', type = 'text/plain') {
  const bytes = Buffer.from(text);
  const state = { reads: 0 };
  const file = {
    name, size: bytes.length, type,
    async arrayBuffer() { state.reads++; return Uint8Array.from(bytes).buffer; },
    slice(start = 0, end = bytes.length) {
      return { async arrayBuffer() { state.reads++; return Uint8Array.from(bytes.subarray(start, end)).buffer; } };
    },
  };
  return { file, state };
}

function createApp() {
  const nodes = new Map(), sent = [], downloads = [], objectUrls = [], persisted = [];
  const me = { id: 'alice', name: 'Alice', color: '#5865f2' };
  const server = { id: 'testserver', key: 'secret', name: 'Test server', v: 1,
    channels: [{ id: 'general', name: 'General', type: 'text' },
      { id: 'other', name: 'Other', type: 'text' }, { id: 'voice', name: 'Voice', type: 'voice' }] };
  const stored = new Map(Object.entries({ me, servers: [server], av: { v8: 1, v9: 1 } })
    .map(([key, value]) => ['dischord.' + key, JSON.stringify(value)]));
  let time = 1000, nextTimer = 1, nextRandom = 0, idbOpens = 0;
  const timers = new Map();
  const setTimeoutMock = (callback, delay) => {
    const id = nextTimer++;
    timers.set(id, { callback, at: time + (Number(delay) || 0) });
    return id;
  };
  const clearTimeoutMock = (id) => timers.delete(id);
  const advance = (ms) => {
    const until = time + ms;
    let count = 0;
    while (true) {
      const next = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      if (++count > 1000) throw new Error('Timer loop did not settle');
      const [id, timer] = next;
      time = timer.at;
      timers.delete(id);
      timer.callback();
    }
    time = until;
  };
  const document = eventTarget({
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, createElement()); return nodes.get(id); },
    createElement(tag) { return createElement(tag, (node) => { if (tag === 'a' && node.download) downloads.push(node); }); },
    querySelectorAll: () => [], querySelector: () => null,
    body: createElement('body'), hidden: false, fullscreenElement: null,
  });
  const urlApi = class extends URL {};
  urlApi.createObjectURL = (blob) => { objectUrls.push(blob); return 'blob:test/' + objectUrls.length; };
  urlApi.revokeObjectURL = () => {};
  const window = eventTarget({ innerHeight: 800, innerWidth: 1200, Blob, Uint8Array, URL: urlApi });
  const DateMock = class extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } };
  const context = vm.createContext({
    window, document, console, URL: urlApi, URLSearchParams, Date: DateMock, Blob, Uint8Array,
    TextEncoder, TextDecoder,
    location: { search: '', hash: '', pathname: '/', protocol: 'https:', hostname: 'localhost' },
    history: { replaceState() {} }, navigator: {}, matchMedia: () => ({ matches: true }),
    localStorage: {
      getItem: (key) => stored.has(key) ? stored.get(key) : null,
      setItem: (key, value) => { stored.set(key, value); persisted.push({ key, value }); },
      removeItem: (key) => stored.delete(key),
    },
    crypto: { getRandomValues(values) { for (let i = 0; i < values.length; i++) values[i] = nextRandom++ % 256; return values; } },
    indexedDB: { open() { idbOpens++; return {}; } },
    btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    setTimeout: setTimeoutMock, clearTimeout: clearTimeoutMock,
    setInterval: () => nextTimer++, clearInterval() {},
    requestAnimationFrame: (callback) => setTimeoutMock(callback, 16), cancelAnimationFrame: clearTimeoutMock,
  });
  const fileSource = fs.readFileSync(path.join(__dirname, '..', 'file-transfer.js'), 'utf8');
  vm.runInContext(fileSource, context, { filename: 'file-transfer.js' });
  const boot = /  checkInviteHash\(\);\s*\r?\n  if \(!me\) \{ profileModal\(true\); \} else start\(\);/;
  assert(boot.test(appSource), 'Unable to locate app boot block');
  const hooks = `
    render = () => {};
    renderRail = () => {};
    renderChannels = () => {};
    renderPresence = () => {};
    playTone = () => {};
    confirmModal = (title, body, label, onConfirm) => onConfirm();
    meshes.testserver = { iframe: { contentWindow: { postMessage: window.captureWire }, remove() {} } };
    cur.sid = 'testserver'; cur.cid = 'general';
    window.chatTest = {
      cleanMsg, cleanReply, replyToMessage, cancelReply, sendMessage, addAttachments,
      getMsgs, addMsg, renderMessages, renderReplyBar, renderAttachBar,
      selectChannel, deleteMessage, pending, cur, peers, fileCardContent,
      onImgChunk, imgCache, incoming, onPeerData, mergeServer, leaveServer, composerDrafts, fileProviders,
      get replyTarget() { return replyTarget; },
      get fileTransfers() { return fileTransfers; },
    };
  `;
  window.captureWire = (envelope) => sent.push({ sid: 'testserver', packet: plain(envelope.sendData.dischord), uuid: envelope.UUID });
  const source = appSource.replace(boot, '').replace(/\}\)\(\);\s*$/, hooks + '\n})();');
  vm.runInContext(source, context, { filename: 'app.js' });
  return { api: window.chatTest, sent, downloads, objectUrls, persisted, stored, document, advance,
    get idbOpens() { return idbOpens; },
    message(overrides = {}) {
      return { id: 'message1', cid: 'general', ts: 500, a: { id: 'bob', name: 'Bob', color: '#57f287' }, text: 'Original message', ...overrides };
    },
    node: (id) => document.getElementById(id),
  };
}

test('legacy text messages remain valid without a reply or attachment', () => {
  const app = createApp();
  const clean = app.api.cleanMsg(app.message());
  assert(clean);
  assert.strictEqual(clean.text, 'Original message');
  assert(!clean.reply && !clean.file);
});

test('malformed reply snapshots are ignored safely without dropping the message', () => {
  const app = createApp();
  for (const reply of [null, [], 'reply', {}, { id: 'target', a: null, text: 'oops' },
    { id: 'x'.repeat(65), a: app.message().a, text: 'oops' }, { id: 'target', a: { id: 'invalid id', name: 'Bob' }, text: 'oops' }]) {
    const clean = app.api.cleanMsg(app.message({ reply }));
    assert(clean, 'A bad reply must not discard otherwise valid chat text');
    assert(!clean.reply, 'Invalid reply must not reach rendering or history');
  }
});

test('reply validation keeps a bounded snapshot and discards arbitrary nested payloads', () => {
  const app = createApp();
  const reply = { id: 'target', a: app.message().a, text: 'A quote', attachment: 'notes.txt',
    data: 'file bytes', url: 'https://example.com/private', anotherReply: { text: 'nested' } };
  const clean = app.api.cleanMsg(app.message({ reply }));
  assert.deepStrictEqual(plain(clean.reply), { id: 'target', a: app.message().a, text: 'A quote', attachment: 'notes.txt' });
});

test('reply action captures a reference and trims the quoted text to 240 characters', () => {
  const app = createApp();
  app.api.addMsg('testserver', app.message({ text: 'x'.repeat(1000) }));
  app.api.replyToMessage('message1');
  assert.strictEqual(app.api.replyTarget.sid, 'testserver');
  assert.strictEqual(app.api.replyTarget.cid, 'general');
  assert.strictEqual(app.api.replyTarget.reply.id, 'message1');
  assert(app.api.replyTarget.reply.text.length <= 240);
  assert(!app.node('replyBar').classList.contains('hidden'));
  app.api.cancelReply();
  assert(!app.api.replyTarget);
  assert(app.node('replyBar').classList.contains('hidden'));
});

test('sending a reply preserves its reference through message history', () => {
  const app = createApp();
  app.api.addMsg('testserver', app.message());
  app.api.replyToMessage('message1');
  assert.strictEqual(app.api.sendMessage('My reply'), true);
  const posted = app.sent.find((item) => item.packet.t === 'msg').packet.m;
  assert.strictEqual(posted.reply.id, 'message1');
  assert.strictEqual(posted.reply.a.name, 'Bob');
  assert.strictEqual(posted.reply.text, 'Original message');
  assert(!app.api.replyTarget);
  app.advance(400);
  const history = JSON.parse(app.stored.get('dischord.msgs.testserver'));
  assert.strictEqual(history.general.find((m) => m.id === posted.id).reply.id, 'message1');
});

test('reply rendering escapes author, text and attachment names', () => {
  const app = createApp();
  const reply = { id: 'absent', a: { id: 'bob', name: '<img src=x onerror=evil()>', color: '#57f287' },
    text: '<script>evil()</script>', attachment: '" onmouseover="evil()' };
  app.api.addMsg('testserver', app.api.cleanMsg(app.message({ reply })));
  app.api.renderMessages();
  const html = app.node('messages').innerHTML;
  assert(!html.includes('<script>') && !html.includes('<img src=x') && !html.includes('" onmouseover="evil()'));
  assert(html.includes('&lt;script&gt;evil()&lt;/script&gt;'));
});

test('a reply to a deleted message shows its deletion instead of the old snapshot', () => {
  const app = createApp();
  app.api.addMsg('testserver', app.message({ text: 'Original secret content' }));
  app.api.replyToMessage('message1');
  app.api.sendMessage('Reply remains');
  app.api.addMsg('testserver', app.message({ del: true, text: '' }));
  app.api.renderMessages();
  const html = app.node('messages').innerHTML;
  assert(html.includes('Original message deleted'));
  assert(!html.includes('Original secret content'));
});

test('a deleted message cannot become a new reply target', () => {
  const app = createApp();
  app.api.addMsg('testserver', app.message({ del: true, text: '' }));
  app.api.replyToMessage('message1');
  assert(!app.api.replyTarget);
});

test('attachment-only messages can be replied to using the attachment name', () => {
  const app = createApp();
  const meta = { id: 'file1', name: 'notes.txt', size: 17, type: 'text/plain' };
  const original = app.api.cleanMsg(app.message({ text: '', file: meta }));
  assert(original, 'Attachment-only messages must survive validation');
  app.api.addMsg('testserver', original);
  app.api.replyToMessage('message1');
  app.api.sendMessage('Thanks for the file');
  const posted = app.sent.find((item) => item.packet.t === 'msg').packet.m;
  assert.strictEqual(posted.reply.id, 'message1');
  assert.strictEqual(posted.reply.attachment, 'notes.txt');
});

test('new attachment messages broadcast and persist metadata without reading file bytes', async () => {
  const app = createApp();
  const { file, state } = fakeFile();
  await app.api.addAttachments([file]);
  assert.strictEqual(app.api.pending.length, 1);
  assert.strictEqual(state.reads, 0);
  assert.strictEqual(app.api.sendMessage('See attached'), true);
  app.advance(400);
  assert.strictEqual(state.reads, 0, 'Offering a file must not read its contents');
  assert.strictEqual(app.idbOpens, 0, 'New files must not enter the image IndexedDB cache');
  assert.strictEqual(app.downloads.length, 0);
  assert.strictEqual(app.objectUrls.length, 0);
  assert.deepStrictEqual(app.sent.map((item) => item.packet.t), ['msg']);
  const metadata = app.sent[0].packet.m.file;
  assert.deepStrictEqual(Object.keys(metadata).sort(), ['id', 'name', 'size', 'type']);
  assert.strictEqual(metadata.name, 'notes.txt');
  assert.strictEqual(metadata.size, file.size);
  assert(!JSON.stringify(app.sent).includes('private attachment'));
  assert(!app.stored.get('dischord.msgs.testserver').includes('private attachment'));
  assert.strictEqual(app.api.pending.length, 0);
});

test('image attachments use the same explicit-download file offer without automatic image transfer', async () => {
  const app = createApp();
  const { file, state } = fakeFile('picture.png', 'private image bytes', 'image/png');
  await app.api.addAttachments([file]);
  app.api.sendMessage('');
  app.api.renderMessages();
  assert.strictEqual(state.reads, 0);
  assert.strictEqual(app.idbOpens, 0);
  assert.deepStrictEqual(app.sent.map((item) => item.packet.t), ['msg']);
  assert(app.sent[0].packet.m.file && !app.sent[0].packet.m.img);
  assert(!app.node('messages').innerHTML.includes('data-img='));
  assert.strictEqual(app.downloads.length, 0);
});

test('images in older history render as explicit download offers without automatic cache reads', () => {
  const app = createApp();
  const message = app.api.cleanMsg(app.message({ text: '', img: { id: 'oldimage', w: 50, h: 50, n: 100 } }));
  app.api.addMsg('testserver', message);
  app.api.renderMessages();
  assert(app.node('messages').innerHTML.includes('data-legacy-download="oldimage"'));
  assert(!app.node('messages').innerHTML.includes('data-img='));
  assert.strictEqual(app.sent.length, 0);
  assert.strictEqual(app.idbOpens, 0);
  assert.strictEqual(app.downloads.length, 0);
});

test('unsolicited legacy image chunks are discarded without caching or saving bytes', () => {
  const app = createApp();
  app.api.onImgChunk('testserver', { id: 'oldimage', i: 0, n: 1,
    d: 'data:image/png;base64,cHJpdmF0ZSBieXRlcw==' }, 'bobuuid');
  assert.strictEqual(app.api.imgCache.size, 0);
  assert.deepStrictEqual(Object.keys(app.api.incoming), []);
  assert.strictEqual(app.idbOpens, 0);
  assert.strictEqual(app.downloads.length, 0);
  assert.strictEqual(app.objectUrls.length, 0);
});

test('rendering received file metadata offers a download without requesting or storing contents', () => {
  const app = createApp();
  const message = app.api.cleanMsg(app.message({ text: '', file: { id: 'file1', name: 'notes.txt', size: 17, type: 'text/plain' } }));
  app.api.addMsg('testserver', message);
  app.api.renderMessages();
  assert(app.node('messages').innerHTML.includes('notes.txt'));
  assert(app.node('messages').innerHTML.includes('Download'));
  assert.strictEqual(app.sent.length, 0);
  assert.strictEqual(app.downloads.length, 0);
  assert.strictEqual(app.objectUrls.length, 0);
  assert.strictEqual(app.idbOpens, 0);
});

test('the Download button requests a file only from its sender after a click', () => {
  const app = createApp();
  const message = app.api.cleanMsg(app.message({ text: '', file: { id: 'file1', name: 'notes.txt', size: 17, type: 'text/plain' } }));
  app.api.addMsg('testserver', message);
  app.api.peers.testserver = new Map([['bobuuid', { uid: 'bob', rx: 1000 }]]);
  app.api.renderMessages();
  assert.strictEqual(app.sent.length, 0);
  const button = { dataset: { fileDownload: message.id } };
  app.node('messages').onclick({ target: { closest: (selector) => selector === '[data-file-download]' ? button : null } });
  assert.strictEqual(app.sent.length, 1);
  assert.strictEqual(app.sent[0].packet.t, 'f-request');
  assert.strictEqual(app.sent[0].uuid, 'bobuuid');
  assert.strictEqual(app.sent[0].packet.mid, message.id);
  assert.strictEqual(app.sent[0].packet.fid, message.file.id);
  assert.strictEqual(app.downloads.length, 0, 'Starting a download must wait for bytes from the sender');
  assert.strictEqual(app.idbOpens, 0);
});

test('download progress displays the actual percentage reported by the transfer', () => {
  const app = createApp();
  const chunkSize = 12 * 1024;
  const message = app.api.cleanMsg(app.message({ text: '', file: { id: 'file1', name: 'notes.txt', size: chunkSize * 2, type: 'text/plain' } }));
  app.api.addMsg('testserver', message);
  app.api.peers.testserver = new Map([['bobuuid', { uid: 'bob', rx: 1000 }]]);
  app.api.fileTransfers.download('testserver', 'general', message.id);
  const request = app.sent[0].packet;
  app.api.fileTransfers.onPacket('testserver', { ...request, t: 'f-chunk', index: 0,
    data: Buffer.alloc(chunkSize).toString('base64') }, 'bobuuid', 'bob');
  assert.strictEqual(app.api.fileTransfers.status('testserver', 'general', message.id).progress, 50);
  assert(app.api.fileCardContent('testserver', message).includes('Downloading 50%'));
  assert.strictEqual(app.downloads.length, 0);
  assert.strictEqual(app.idbOpens, 0);
});

test('an owner can download their selected file only after pressing Download', async () => {
  const app = createApp();
  const { file, state } = fakeFile();
  await app.api.addAttachments([file]);
  app.api.sendMessage('');
  assert.strictEqual(app.downloads.length, 0);
  const message = app.sent[0].packet.m;
  const button = { dataset: { fileDownload: message.id } };
  app.node('messages').onclick({ target: { closest: (selector) => selector === '[data-file-download]' ? button : null } });
  assert.strictEqual(app.downloads.length, 1);
  assert.strictEqual(app.downloads[0].download, 'notes.txt');
  assert.strictEqual(app.objectUrls.length, 1);
  assert.strictEqual(state.reads, 0);
});

test('malformed file metadata is removed and cannot create a blank message', () => {
  const app = createApp();
  for (const file of [null, {}, { id: 'file1', name: 'x', size: -1, type: '' },
    { id: 'invalid id', name: 'x', size: 1, type: '' },
    { id: 'file1', name: 'x', size: 101 * 1024 * 1024, type: '' }]) {
    const withText = app.api.cleanMsg(app.message({ file }));
    assert(withText && !withText.file);
    assert.strictEqual(app.api.cleanMsg(app.message({ text: '', file })), null);
  }
});

test('editing message text retains its existing reply and attachment metadata', () => {
  const app = createApp();
  const reply = { id: 'target', a: app.message().a, text: 'Quote' };
  const file = { id: 'file1', name: 'notes.txt', size: 17, type: 'text/plain' };
  app.api.addMsg('testserver', app.api.cleanMsg(app.message({ reply, file })));
  app.api.addMsg('testserver', app.api.cleanMsg(app.message({ text: 'Edited text', ed: 1 })));
  const edited = app.api.getMsgs('testserver').general[0];
  assert.strictEqual(edited.text, 'Edited text');
  assert.deepStrictEqual(plain(edited.reply), reply);
  assert.deepStrictEqual(plain(edited.file), file);
});

test('an overlong message keeps text, attachments and the reply draft for correction', async () => {
  const app = createApp();
  const { file, state } = fakeFile();
  app.api.addMsg('testserver', app.message());
  app.api.replyToMessage('message1');
  await app.api.addAttachments([file]);
  const text = 'x'.repeat(4001);
  app.node('msgInput').value = text;
  app.node('msgInput').dispatch('keydown', { key: 'Enter', preventDefault() {} });
  assert.strictEqual(app.node('msgInput').value, text);
  assert.strictEqual(app.api.pending.length, 1);
  assert.strictEqual(app.api.replyTarget.reply.id, 'message1');
  assert.strictEqual(app.sent.length, 0);
  assert.strictEqual(state.reads, 0);
});

test('switching channels keeps each draft and prevents attachment or reply leakage', async () => {
  const app = createApp();
  const { file, state } = fakeFile();
  app.api.addMsg('testserver', app.message());
  app.api.replyToMessage('message1');
  await app.api.addAttachments([file]);
  app.node('msgInput').value = 'Draft for General';
  app.api.selectChannel('other');
  assert.strictEqual(app.node('msgInput').value, '');
  assert.strictEqual(app.api.pending.length, 0);
  assert(!app.api.replyTarget);
  app.api.sendMessage('Message for Other');
  const posted = app.sent.find((item) => item.packet.t === 'msg').packet.m;
  assert.strictEqual(posted.cid, 'other');
  assert(!posted.reply && !posted.file);
  app.api.selectChannel('general');
  assert.strictEqual(app.node('msgInput').value, 'Draft for General');
  assert.strictEqual(app.api.pending.length, 1);
  assert.strictEqual(app.api.replyTarget.reply.id, 'message1');
  assert.strictEqual(state.reads, 0);
});

test('a voice channel cannot consume a chat attachment draft', async () => {
  const app = createApp();
  const { file } = fakeFile();
  await app.api.addAttachments([file]);
  app.api.cur.cid = 'voice';
  assert.strictEqual(app.api.sendMessage('Cannot post here'), false);
  assert.strictEqual(app.api.pending.length, 1);
  assert.strictEqual(app.sent.length, 0);
});

test('a full file-offer registry preserves the unsent attachment, caption and reply', async () => {
  const app = createApp();
  const { file, state } = fakeFile();
  for (let i = 0; i < 100; i++) {
    assert.strictEqual(app.api.fileTransfers.register('testserver', 'general', 'offered' + i,
      { id: 'file' + i, name: file.name, size: file.size, type: file.type }, file), true);
  }
  app.api.addMsg('testserver', app.message());
  app.api.replyToMessage('message1');
  await app.api.addAttachments([file]);
  app.node('msgInput').value = 'Caption to keep';
  app.node('msgInput').dispatch('keydown', { key: 'Enter', preventDefault() {} });
  assert.strictEqual(app.node('msgInput').value, 'Caption to keep');
  assert.strictEqual(app.api.pending.length, 1);
  assert.strictEqual(app.api.pending[0].file, file);
  assert.strictEqual(app.api.replyTarget.reply.id, 'message1');
  assert.strictEqual(app.sent.length, 0, 'Unavailable file offers must not broadcast metadata');
  assert.strictEqual(state.reads, 0);
  assert.strictEqual(app.api.getMsgs('testserver').general.length, 1);
});

test('a partially full offer registry sends only registered files and retains the remainder', async () => {
  const app = createApp();
  const first = fakeFile('first.txt'), second = fakeFile('second.txt');
  for (let i = 0; i < 99; i++) {
    assert.strictEqual(app.api.fileTransfers.register('testserver', 'general', 'offered' + i,
      { id: 'file' + i, name: first.file.name, size: first.file.size, type: first.file.type }, first.file), true);
  }
  app.api.addMsg('testserver', app.message());
  app.api.replyToMessage('message1');
  await app.api.addAttachments([first.file, second.file]);
  app.node('msgInput').value = 'Caption for second file';
  app.node('msgInput').dispatch('keydown', { key: 'Enter', preventDefault() {} });
  assert.strictEqual(app.sent.length, 1);
  assert.strictEqual(app.sent[0].packet.m.file.name, 'first.txt');
  assert.strictEqual(app.sent[0].packet.m.text, '');
  assert.strictEqual(app.node('msgInput').value, 'Caption for second file');
  assert.strictEqual(app.api.pending.length, 1);
  assert.strictEqual(app.api.pending[0].file, second.file);
  assert.strictEqual(app.api.replyTarget.reply.id, 'message1');
  assert.strictEqual(first.state.reads + second.state.reads, 0);
});

test('a file offer targets the originating browser connection when its author has multiple tabs', () => {
  const app = createApp();
  const message = app.message({ text: '', file: { id: 'file1', name: 'notes.txt', size: 17, type: 'text/plain' } });
  app.api.peers.testserver = new Map([
    ['bobothertab', { uid: 'bob', rx: 5000 }], ['boborigin', { uid: 'bob', rx: 500 }],
  ]);
  app.api.onPeerData('testserver', { t: 'msg', u: message.a, m: message }, 'boborigin');
  app.api.onPeerData('testserver', { t: 'ping', u: message.a }, 'bobothertab');
  assert.strictEqual(app.sent.length, 0);
  assert.strictEqual(app.api.fileTransfers.download('testserver', 'general', message.id), true);
  assert.strictEqual(app.sent.length, 1);
  assert.strictEqual(app.sent[0].packet.t, 'f-request');
  assert.strictEqual(app.sent[0].uuid, 'boborigin');
  const request = app.sent[0].packet;
  app.api.onPeerData('testserver', { ...request, t: 'f-chunk', u: message.a,
    index: 0, data: Buffer.alloc(17).toString('base64') }, 'bobothertab');
  assert.strictEqual(app.api.fileTransfers.status('testserver', 'general', message.id).progress, 0);
  assert.strictEqual(app.downloads.length, 0);
});

test('duplicate offers from another author tab cannot replace the original file provider', () => {
  const app = createApp();
  const message = app.message({ text: '', file: { id: 'file1', name: 'notes.txt', size: 17, type: 'text/plain' } });
  app.api.peers.testserver = new Map([
    ['bobothertab', { uid: 'bob', rx: 1000 }], ['boborigin', { uid: 'bob', rx: 1000 }],
  ]);
  app.api.onPeerData('testserver', { t: 'msg', u: message.a, m: message }, 'boborigin');
  app.api.onPeerData('testserver', { t: 'msg', u: message.a, m: message }, 'bobothertab');
  app.api.onPeerData('testserver', { t: 'msg', u: message.a,
    m: { ...message, file: { ...message.file, id: 'differentfile', name: 'replacement.txt' } } }, 'bobothertab');
  assert.strictEqual(app.api.fileProviders.get('testserver/general/' + message.id), 'boborigin');
  assert.strictEqual(app.api.getMsgs('testserver').general[0].file.id, 'file1');
  assert.strictEqual(app.api.fileTransfers.download('testserver', 'general', message.id), true);
  assert.strictEqual(app.sent.length, 1);
  assert.strictEqual(app.sent[0].uuid, 'boborigin');
  assert.strictEqual(app.sent[0].packet.fid, 'file1');
});

test('invalid peer packet types are ignored without changing chat or throwing', () => {
  const app = createApp();
  for (const t of [undefined, null, 12, {}, [], false]) {
    assert.doesNotThrow(() => app.api.onPeerData('testserver', { t, u: app.message().a }, 'bobuuid'));
  }
  assert.strictEqual(app.sent.length, 0);
  assert.deepStrictEqual(plain(app.api.getMsgs('testserver')), {});
});

test('remote deletion of the selected channel does not move its draft to another channel', async () => {
  const app = createApp();
  const { file, state } = fakeFile();
  app.api.addMsg('testserver', app.message());
  app.api.replyToMessage('message1');
  await app.api.addAttachments([file]);
  app.node('msgInput').value = 'Private draft for General';
  app.api.mergeServer('testserver', { id: 'testserver', name: 'Test server', v: 2,
    channels: [{ id: 'other', name: 'Other', type: 'text' }] });
  assert.strictEqual(app.api.cur.cid, 'other');
  assert.strictEqual(app.node('msgInput').value, '');
  assert.strictEqual(app.api.pending.length, 0);
  assert(!app.api.replyTarget);
  assert.strictEqual(app.api.sendMessage(''), false);
  assert.strictEqual(app.sent.length, 0);
  assert.strictEqual(state.reads, 0);
});

test('leaving the active server releases its attachment draft instead of saving it again', async () => {
  const app = createApp();
  const { file } = fakeFile();
  await app.api.addAttachments([file]);
  app.node('msgInput').value = 'Draft for the server I am leaving';
  app.api.leaveServer('testserver');
  assert(!app.api.cur.sid);
  assert.strictEqual(app.api.pending.length, 0);
  assert.strictEqual(app.node('msgInput').value, '');
  assert(![...app.api.composerDrafts.keys()].some((key) => key.startsWith('testserver/')));
});

test('local deletion of the selected channel clears its draft before selecting the replacement', async () => {
  const app = createApp();
  const { file, state } = fakeFile();
  app.api.addMsg('testserver', app.message());
  app.api.replyToMessage('message1');
  await app.api.addAttachments([file]);
  app.node('msgInput').value = 'Private draft for General';
  const button = { dataset: { delc: 'general' } };
  app.node('channelList').onclick({ target: { closest: (selector) => selector === '[data-delc]' ? button : null }, stopPropagation() {} });
  assert.strictEqual(app.api.cur.cid, 'other');
  assert.strictEqual(app.node('msgInput').value, '');
  assert.strictEqual(app.api.pending.length, 0);
  assert(!app.api.replyTarget);
  assert.strictEqual(app.api.sendMessage(''), false);
  assert.deepStrictEqual(app.sent.map((item) => item.packet.t), ['server']);
  assert.strictEqual(state.reads, 0);
});

for (const mode of ['local', 'remote']) {
  test(`${mode} channel deletion releases all file slots and rejects requests for removed offers`, async () => {
    const app = createApp();
    const { file, state } = fakeFile();
    const owner = { id: 'alice', name: 'Alice', color: '#5865f2' };
    for (let i = 0; i < 100; i++) {
      const meta = { id: 'file' + i, name: file.name, size: file.size, type: file.type };
      const message = app.message({ id: 'offered' + i, a: owner, text: '', file: meta });
      app.api.addMsg('testserver', message);
      assert.strictEqual(app.api.fileTransfers.register('testserver', 'general', message.id, meta, file), true);
    }
    assert.strictEqual(app.api.fileTransfers.hasLocal('testserver', 'general', 'offered0'), true);
    if (mode === 'remote') {
      app.api.mergeServer('testserver', { id: 'testserver', name: 'Test server', v: 2,
        channels: [{ id: 'other', name: 'Other', type: 'text' }] });
    } else {
      const button = { dataset: { delc: 'general' } };
      app.node('channelList').onclick({ target: { closest: (selector) => selector === '[data-delc]' ? button : null }, stopPropagation() {} });
    }
    assert.strictEqual(app.api.fileTransfers.hasLocal('testserver', 'general', 'offered0'), false);
    assert.strictEqual(app.api.fileTransfers.download('testserver', 'general', 'offered0'), false);
    for (let i = 0; i < 100; i++) {
      assert.strictEqual(app.api.fileTransfers.register('testserver', 'other', 'newoffer' + i,
        { id: 'newfile' + i, name: file.name, size: file.size, type: file.type }, file), true,
      'Removing the channel must release every file registry slot, including File references');
    }
    app.sent.splice(0);
    app.api.peers.testserver = new Map([['bobuuid', { uid: 'bob', rx: 1000 }]]);
    app.api.onPeerData('testserver', { t: 'f-request', cid: 'general', mid: 'offered0', fid: 'file0', token: 'request1',
      u: { id: 'bob', name: 'Bob', color: '#57f287' } }, 'bobuuid');
    await Promise.resolve();
    assert.strictEqual(app.sent.length, 0);
    assert.strictEqual(state.reads, 0);
    assert.strictEqual(app.downloads.length, 0);
  });
}

test('history pruning releases old local file offers and removes obsolete provider references', async () => {
  const app = createApp();
  const { file, state } = fakeFile();
  const owner = { id: 'alice', name: 'Alice', color: '#5865f2' };
  const local = app.message({ id: 'oldlocal', ts: 1, a: owner, text: '',
    file: { id: 'oldlocalfile', name: file.name, size: file.size, type: file.type } });
  app.api.addMsg('testserver', local);
  assert.strictEqual(app.api.fileTransfers.register('testserver', 'general', local.id, local.file, file), true);
  for (let i = 0; i < 99; i++) {
    assert.strictEqual(app.api.fileTransfers.register('testserver', 'other', 'offered' + i,
      { id: 'file' + i, name: file.name, size: file.size, type: file.type }, file), true);
  }
  const remote = app.message({ id: 'oldremote', ts: 2, text: '',
    file: { id: 'oldremotefile', name: 'remote.txt', size: 1, type: 'text/plain' } });
  app.api.peers.testserver = new Map([['bobuuid', { uid: 'bob', rx: 1000 }]]);
  app.api.onPeerData('testserver', { t: 'msg', u: remote.a, m: remote }, 'bobuuid');
  assert.strictEqual(app.api.fileProviders.get('testserver/general/oldremote'), 'bobuuid');
  for (let i = 0; i < 500; i++) {
    app.api.addMsg('testserver', app.message({ id: 'newmessage' + i, ts: 3 + i, a: owner }));
  }
  assert.strictEqual(app.api.getMsgs('testserver').general.length, 500);
  assert(!app.api.getMsgs('testserver').general.some((m) => m.id === local.id || m.id === remote.id));
  assert.strictEqual(app.api.fileTransfers.hasLocal('testserver', 'general', local.id), false);
  assert.strictEqual(app.api.fileProviders.has('testserver/general/oldremote'), false);
  assert.strictEqual(app.api.fileTransfers.register('testserver', 'other', 'replacement',
    { id: 'replacementfile', name: file.name, size: file.size, type: file.type }, file), true);
  app.api.onPeerData('testserver', { t: 'f-request', cid: 'general', mid: local.id, fid: local.file.id,
    token: 'request1', u: remote.a }, 'bobuuid');
  await Promise.resolve();
  assert.strictEqual(app.sent.length, 0);
  assert.strictEqual(state.reads, 0);
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log('ok - ' + name); }
    catch (error) { failed++; console.error('not ok - ' + name + '\n' + error.stack); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
  if (failed) process.exitCode = 1;
})();
