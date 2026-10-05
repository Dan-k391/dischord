'use strict';

// Run with `node tests/files.test.js`. Real protocol code runs in an isolated
// browser-like VM; a queued transport lets tests inspect every packet before it
// reaches another peer. No dependencies or actual disk downloads are needed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Blob } = require('buffer');

const source = fs.readFileSync(path.join(__dirname, '..', 'file-transfer.js'), 'utf8');
const tests = [];
const test = (name, run) => tests.push({ name, run });

function createClock() {
  let time = 1000, nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, at: time + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    count: () => timers.size,
    advance(ms) {
      const until = time + ms;
      let count = 0;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        if (++count > 10000) throw new Error('Timer loop did not settle');
        const [id, timer] = next;
        time = timer.at;
        timers.delete(id);
        timer.callback();
      }
      time = until;
    },
  };
}

const copy = (value) => JSON.parse(JSON.stringify(value));
const messageKey = (sid, cid, mid) => [sid, cid, mid].join('/');
async function flush() {
  // Blob.arrayBuffer() may use a native continuation on Node 16.
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
  await Promise.resolve();
}

function trackedFile(bytes, name = 'example.bin', type = 'application/octet-stream') {
  const content = Buffer.from(bytes);
  const reads = [];
  return { name, type, size: content.length, reads,
    slice(start, end) {
      reads.push([start, end]);
      // Real File reads are async; a deterministic promise avoids native Node
      // Blob thread scheduling while exercising the awaited read boundary.
      return { async arrayBuffer() { return Uint8Array.from(content.subarray(start, end)).buffer; } };
    },
  };
}

function createHarness() {
  const clock = createClock(), queue = [], packets = [], peers = new Map();
  const storageCalls = [], saves = [], changes = [], messages = new Map();
  let nextId = 1;
  const window = {};
  const DateMock = class extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now()])); }
    static now() { return clock.now(); }
  };
  const context = vm.createContext({
    window, console, Blob, Uint8Array, ArrayBuffer, Map, Set, Date: DateMock,
    btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    // Accessing persistent storage is a failure: receiving an offer must never
    // cache its bytes in localStorage, IndexedDB, or the filesystem.
    localStorage: { getItem(...args) { storageCalls.push(['get', ...args]); },
      setItem(...args) { storageCalls.push(['set', ...args]); } },
    indexedDB: { open(...args) { storageCalls.push(['indexedDB', ...args]); } },
  });
  vm.runInContext(source, context, { filename: 'file-transfer.js' });
  const module = window.DischordFiles;
  assert(module && typeof module.create === 'function', 'File protocol factory must be exported');
  function endpoint(uid, options = {}) {
    const uuid = 'peer-' + uid + (options.session ? '-' + options.session : '');
    const resolve = new Map();
    const connections = new Map();
    const protocolContext = {
      send(sid, payload, target) {
        const packet = { sid, payload: copy({ ...payload, u: { id: uid } }), from: uuid, to: target };
        packets.push(packet);
        queue.push(packet);
      },
      getMessage: (sid, cid, mid) => messages.get(messageKey(sid, cid, mid)) || null,
      resolvePeer: (sid, author) => resolve.has(author) ? resolve.get(author) : null,
      userId: () => uid,
      randomId: () => 'token' + nextId++,
      onChange: (sid, cid, mid) => changes.push([uid, sid, cid, mid]),
      saveDownload: (blob, name) => saves.push({ uid, blob, name }),
    };
    if (options.isPeer) protocolContext.isPeer = (sid, author, wantedUuid) =>
      !!(connections.has(author) && connections.get(author).has(wantedUuid));
    const api = module.create(protocolContext);
    const result = { api, uid, uuid, resolve, connections };
    peers.set(uuid, result);
    for (const peer of peers.values()) {
      peer.resolve.set(uid, uuid);
      resolve.set(peer.uid, peer.uuid);
      if (!peer.connections.has(uid)) peer.connections.set(uid, new Set());
      peer.connections.get(uid).add(uuid);
      if (!connections.has(peer.uid)) connections.set(peer.uid, new Set());
      connections.get(peer.uid).add(peer.uuid);
    }
    return result;
  }
  async function deliver(packet) {
    assert(packet.to, 'File packets must always target a single peer');
    const recipient = peers.get(packet.to);
    if (recipient) recipient.api.onPacket(packet.sid, packet.payload, packet.from, packet.payload.u.id);
    await flush();
  }
  async function drain(limit = 1000) {
    let steps = 0;
    while (queue.length) {
      if (++steps > limit) throw new Error('File packet loop did not settle');
      await deliver(queue.shift());
    }
    await flush();
    if (queue.length) return drain(limit - steps);
  }
  function close() {
    for (const peer of peers.values()) peer.api.close();
    assert.strictEqual(clock.count(), 0, 'Closing must clear all protocol timers');
    assert.deepStrictEqual(storageCalls, [], 'File protocol must never use persistent storage');
  }
  return { module, endpoint, clock, messages, queue, packets, saves, changes, storageCalls, deliver, drain, close };
}

const sid = 'server1', cid = 'channel1', mid = 'message1';
function offer(h, author, file, overrides = {}) {
  const meta = h.module.cleanMeta({ id: 'file1', name: file.name, size: file.size, type: file.type, ...overrides });
  assert(meta, 'Fixture attachment metadata must be valid');
  h.messages.set(messageKey(sid, cid, mid), { id: mid, cid, a: { id: author.uid }, file: meta });
  assert.strictEqual(author.api.register(sid, cid, mid, meta, file), true);
  return meta;
}
async function withHarness(run) {
  const h = createHarness();
  try { await run(h); }
  finally { h.close(); }
}
const state = (peer) => peer.api.status(sid, cid, mid);

test('offering a file and viewing its metadata never read or send its bytes', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  const file = trackedFile(Buffer.from('private content'));
  offer(h, alice, file);
  assert.strictEqual(alice.api.hasLocal(sid, cid, mid), true);
  assert.strictEqual(bob.api.hasLocal(sid, cid, mid), false);
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(state(bob).state, 'idle');
    assert.strictEqual(state(bob).progress, 0);
    JSON.stringify(h.messages.get(messageKey(sid, cid, mid)));
  }
  await flush();
  assert.deepStrictEqual(file.reads, [], 'Registration and passive viewing must not read even one slice');
  assert.strictEqual(h.packets.length, 0, 'Metadata does not initiate a file transfer');
  assert.strictEqual(h.saves.length, 0, 'Only an explicit download can save a file');
}));

test('a download requests bytes only from the original message author', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  h.endpoint('carol');
  const file = trackedFile(Buffer.from('author content'));
  offer(h, alice, file);
  assert.strictEqual(bob.api.download(sid, cid, mid), true);
  assert.strictEqual(h.queue.length, 1);
  assert.strictEqual(h.queue[0].payload.t, 'f-request');
  assert.strictEqual(h.queue[0].to, alice.uuid);
  assert.deepStrictEqual(file.reads, [], 'A request is not a file read until the author receives it');
  assert.strictEqual(h.saves.length, 0);
}));

test('an offline author cannot be replaced with a history relay', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  h.endpoint('carol');
  const file = trackedFile(Buffer.from('unavailable'));
  offer(h, alice, file);
  bob.resolve.delete('alice');
  assert.strictEqual(bob.api.download(sid, cid, mid), false);
  assert.strictEqual(state(bob).state, 'error');
  assert.strictEqual(h.packets.length, 0);
  assert.strictEqual(h.saves.length, 0);
  assert.deepStrictEqual(file.reads, []);
}));

test('unsolicited file chunks cannot create buffers, acknowledgements, or downloads', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  offer(h, alice, trackedFile(Buffer.from('secret')));
  for (const index of [0, 1, 1000000]) {
    bob.api.onPacket(sid, { t: 'f-chunk', cid, mid, fid: 'file1', token: 'unsolicited', index,
      data: Buffer.from('unsolicited').toString('base64') }, alice.uuid, alice.uid);
  }
  await flush();
  assert.strictEqual(h.packets.length, 0);
  assert.strictEqual(h.saves.length, 0);
  assert.strictEqual(state(bob).state, 'idle');
}));

test('a file request must match a live message and the requesting peer identity', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob'), eve = h.endpoint('eve');
  const file = trackedFile(Buffer.from('allowed only after validated request'));
  offer(h, alice, file);
  assert.strictEqual(bob.api.download(sid, cid, mid), true);
  const request = h.queue.shift();
  const invalid = [
    { ...request.payload, mid: 'missing' },
    { ...request.payload, fid: 'differentfile' },
    { ...request.payload, cid: 'differentchannel' },
    { ...request.payload, token: '' },
  ];
  for (const payload of invalid) alice.api.onPacket(sid, payload, bob.uuid, bob.uid);
  const beforeWrongPeer = h.packets.length;
  alice.api.onPacket(sid, request.payload, eve.uuid, bob.uid);
  await flush();
  assert.deepStrictEqual(file.reads, []);
  assert.strictEqual(h.packets.length, beforeWrongPeer, 'A mismatched requester identity must be ignored');
  assert(h.queue.every((packet) => packet.payload.t === 'f-error'), 'Unavailable offers may send only an error');
  assert.strictEqual(h.packets.filter((p) => p.payload.t === 'f-chunk').length, 0);
  h.queue.length = 0;
  await h.deliver(request);
  assert.strictEqual(file.reads.length, 1, 'The valid request starts exactly one chunk read');
}));

test('wrong peers, transfer tokens, file IDs, and out-of-order chunks are ignored', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob'), eve = h.endpoint('eve');
  const file = trackedFile(Buffer.from('only the requested bytes'));
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  await h.deliver(h.queue.shift());
  const chunk = h.queue.shift();
  assert.strictEqual(chunk.payload.t, 'f-chunk');
  const before = h.packets.length;
  bob.api.onPacket(sid, chunk.payload, eve.uuid, eve.uid);
  bob.api.onPacket(sid, chunk.payload, eve.uuid, alice.uid);
  for (const overrides of [{ token: 'wrongtoken' }, { fid: 'wrongfile' }, { index: 1 }, { mid: 'wrongmessage' }]) {
    bob.api.onPacket(sid, { ...chunk.payload, ...overrides }, alice.uuid, alice.uid);
  }
  await flush();
  assert.strictEqual(h.packets.length, before, 'Ignored packets cannot acknowledge or advance the transfer');
  assert.strictEqual(h.saves.length, 0);
  assert.strictEqual(state(bob).progress, 0);
  await h.deliver(chunk);
  await h.drain();
  assert.strictEqual(h.saves.length, 1);
  assert.deepStrictEqual(Buffer.from(await h.saves[0].blob.arrayBuffer()), Buffer.from('only the requested bytes'));
}));

test('chunk transfer preserves arbitrary binary bytes across multiple boundaries', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  const bytes = Buffer.alloc(h.module.CHUNK_BYTES * 3 + 47);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 193 + 255) % 256;
  const file = trackedFile(bytes, 'binary.dat');
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  await h.drain();
  assert.strictEqual(h.saves.length, 1);
  assert.strictEqual(h.saves[0].uid, 'bob');
  assert.strictEqual(h.saves[0].name, 'binary.dat');
  assert.deepStrictEqual(Buffer.from(await h.saves[0].blob.arrayBuffer()), bytes);
  assert.strictEqual(file.reads.length, 4);
  assert.strictEqual(state(bob).state, 'complete');
  assert.strictEqual(state(bob).progress, 100);
  assert.strictEqual(h.clock.count(), 0, 'A completed transfer must retain no inactivity timer');
  assert(h.packets.every((p) => p.to === (p.from === alice.uuid ? bob.uuid : alice.uuid)));
}));

test('an explicitly downloaded empty file completes with exactly zero bytes', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  offer(h, alice, trackedFile(Buffer.alloc(0), 'empty.txt', 'text/plain'));
  bob.api.download(sid, cid, mid);
  await h.drain();
  assert.strictEqual(h.saves.length, 1);
  assert.strictEqual(h.saves[0].blob.size, 0);
  assert.strictEqual(state(bob).state, 'complete');
  assert.strictEqual(h.packets.filter((p) => p.payload.t === 'f-chunk').length, 1);
  assert.strictEqual(h.packets.find((p) => p.payload.t === 'f-chunk').payload.data, '');
}));

test('the author reads and sends the next chunk only after the correct acknowledgement', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob'), eve = h.endpoint('eve');
  const file = trackedFile(Buffer.alloc(h.module.CHUNK_BYTES * 2 + 1, 0xab));
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  await h.deliver(h.queue.shift());
  assert.strictEqual(file.reads.length, 1);
  assert.strictEqual(h.queue.length, 1);
  const chunk = h.queue.shift();
  await flush();
  assert.strictEqual(file.reads.length, 1, 'No eager reads while waiting for the recipient');
  const ack = { ...chunk.payload, t: 'f-ack' };
  delete ack.data;
  alice.api.onPacket(sid, ack, eve.uuid, eve.uid);
  alice.api.onPacket(sid, { ...ack, index: 1 }, bob.uuid, bob.uid);
  alice.api.onPacket(sid, { ...ack, token: 'different' }, bob.uuid, bob.uid);
  await flush();
  assert.strictEqual(file.reads.length, 1);
  await h.deliver(chunk);
  assert.strictEqual(file.reads.length, 1);
  assert.strictEqual(h.queue.length, 1);
  assert.strictEqual(h.queue[0].payload.t, 'f-ack');
  await h.deliver(h.queue.shift());
  assert.strictEqual(file.reads.length, 2);
  assert.strictEqual(h.queue[0].payload.index, 1);
  await h.drain();
  assert.strictEqual(h.saves.length, 1);
}));

test('duplicate download clicks create one receiver and one request', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  offer(h, alice, trackedFile(Buffer.from('once')));
  assert.strictEqual(bob.api.download(sid, cid, mid), true);
  assert.strictEqual(bob.api.download(sid, cid, mid), false);
  assert.strictEqual(h.queue.length, 1);
  await h.drain();
  assert.strictEqual(h.saves.length, 1);
}));

test('a stalled requested download expires and rejects subsequent late bytes', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  offer(h, alice, trackedFile(Buffer.from('late bytes')));
  bob.api.download(sid, cid, mid);
  const request = h.queue.shift();
  h.clock.advance(h.module.TIMEOUT_MS + 1);
  assert.strictEqual(state(bob).state, 'error');
  assert.strictEqual(state(bob).progress, 0);
  const before = h.packets.length;
  bob.api.onPacket(sid, { ...request.payload, t: 'f-chunk', index: 0,
    data: Buffer.from('late bytes').toString('base64') }, alice.uuid, alice.uid);
  assert.strictEqual(h.packets.length, before);
  assert.strictEqual(h.saves.length, 0);
  assert.strictEqual(h.clock.count(), 0);
}));

test('cancelling mid-transfer discards partial bytes and lets a new explicit download start', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  const bytes = Buffer.alloc(h.module.CHUNK_BYTES + 5, 0x8f);
  offer(h, alice, trackedFile(bytes));
  bob.api.download(sid, cid, mid);
  await h.deliver(h.queue.shift());
  await h.deliver(h.queue.shift());
  assert(state(bob).progress > 0 && state(bob).progress < 100);
  bob.api.cancel(sid, cid, mid);
  assert.strictEqual(state(bob).state, 'error');
  assert.strictEqual(h.saves.length, 0);
  await h.drain();
  assert.strictEqual(h.saves.length, 0, 'Cancelled bytes must never be saved');
  assert.strictEqual(h.clock.count(), 0);
  assert.strictEqual(bob.api.download(sid, cid, mid), true);
  await h.drain();
  assert.strictEqual(h.saves.length, 1);
  assert.deepStrictEqual(Buffer.from(await h.saves[0].blob.arrayBuffer()), bytes);
}));

test('deleting an offered message releases its file and stops waiting sender reads', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  const file = trackedFile(Buffer.alloc(h.module.CHUNK_BYTES + 1));
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  await h.deliver(h.queue.shift());
  const firstChunk = h.queue.shift();
  assert.strictEqual(file.reads.length, 1);
  alice.api.release(sid, cid, mid);
  h.messages.get(messageKey(sid, cid, mid)).del = true;
  assert.strictEqual(alice.api.hasLocal(sid, cid, mid), false);
  alice.api.onPacket(sid, { ...firstChunk.payload, t: 'f-ack' }, bob.uuid, bob.uid);
  await flush();
  assert.strictEqual(file.reads.length, 1);
  await h.drain();
  assert.strictEqual(h.saves.length, 0);
}));

test('server disconnect clears offers, receiver buffers, and pending sender work', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  const file = trackedFile(Buffer.alloc(h.module.CHUNK_BYTES + 1));
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  await h.deliver(h.queue.shift());
  const chunk = h.queue.shift();
  alice.api.closeServer(sid);
  bob.api.closeServer(sid);
  assert.strictEqual(alice.api.hasLocal(sid, cid, mid), false);
  const before = file.reads.length;
  await h.deliver(chunk);
  await h.drain();
  assert.strictEqual(file.reads.length, before);
  assert.strictEqual(h.saves.length, 0);
  assert.strictEqual(h.clock.count(), 0);
}));

test('metadata validates numeric size, ID, safe filename, and MIME limits', () => withHarness(async (h) => {
  const { cleanMeta } = h.module;
  for (const size of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.strictEqual(cleanMeta({ id: 'file1', name: 'test.bin', size, type: '' }), null);
  }
  for (const id of ['', '../bad', 'a'.repeat(65), null]) {
    assert.strictEqual(cleanMeta({ id, name: 'test.bin', size: 1, type: '' }), null);
  }
  for (const name of ['', '   ', null]) {
    assert.strictEqual(cleanMeta({ id: 'file1', name, size: 1, type: '' }), null);
  }
  const safe = cleanMeta({ id: 'file1', name: '../folder\\name\u0000\u202E.txt', size: Number.MAX_SAFE_INTEGER, type: 'text/plain' });
  assert(safe);
  assert(!/[\/\\\u0000-\u001f\u202a-\u202e]/.test(safe.name), 'Filename must not contain path/control/bidi characters');
  assert.strictEqual(safe.size, Number.MAX_SAFE_INTEGER);
  assert.strictEqual(safe.type, 'text/plain');
  const long = cleanMeta({ id: 'file1', name: 'x'.repeat(300), size: 0, type: 'invalid\nvalue' });
  assert.strictEqual(long.name.length, 255);
  assert.strictEqual(long.type, '');
  assert.strictEqual(cleanMeta({ id: 'file1', name: 'zero', size: 0, type: '' }).size, 0);
}));

test('register rejects a file that does not match its advertised metadata', () => withHarness(async (h) => {
  const alice = h.endpoint('alice');
  const file = trackedFile(Buffer.from('abc'));
  const meta = h.module.cleanMeta({ id: 'file1', name: file.name, size: file.size + 1, type: file.type });
  assert.strictEqual(alice.api.register(sid, cid, mid, meta, file), false);
  assert.strictEqual(alice.api.hasLocal(sid, cid, mid), false);
  assert.deepStrictEqual(file.reads, []);
}));

test('an own-file download uses the explicit save callback without sending data', () => withHarness(async (h) => {
  const alice = h.endpoint('alice');
  const file = trackedFile(Buffer.from('local bytes'));
  offer(h, alice, file);
  assert.strictEqual(h.saves.length, 0);
  assert.strictEqual(alice.api.download(sid, cid, mid), true);
  assert.strictEqual(h.saves.length, 1);
  assert.strictEqual(h.saves[0].blob, file);
  assert.strictEqual(h.saves[0].name, file.name);
  assert.strictEqual(h.packets.length, 0);
  assert.deepStrictEqual(file.reads, []);
}));

test('malformed, oversized, and noncanonical base64 chunks cannot advance a download', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  offer(h, alice, trackedFile(Buffer.from([0])));
  bob.api.download(sid, cid, mid);
  await h.deliver(h.queue.shift());
  const chunk = h.queue.shift();
  const before = h.packets.length;
  for (const data of ['AB==', 'A===', 'AAA=', 'AAAA', '', 123, 'AA=='.repeat(h.module.CHUNK_BYTES)]) {
    bob.api.onPacket(sid, { ...chunk.payload, data }, alice.uuid, alice.uid);
  }
  assert.strictEqual(h.packets.length, before);
  assert.strictEqual(h.saves.length, 0);
  assert.strictEqual(state(bob).progress, 0);
  await h.deliver(chunk);
  await h.drain();
  assert.strictEqual(h.saves.length, 1);
  assert.deepStrictEqual(Buffer.from(await h.saves[0].blob.arrayBuffer()), Buffer.from([0]));
}));

test('cancelling during an unfinished File read prevents the late read from sending bytes', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  let completeRead, reads = 0;
  const file = { name: 'slow.bin', type: '', size: 3,
    slice() {
      reads++;
      return { arrayBuffer: () => new Promise((resolve) => { completeRead = resolve; }) };
    },
  };
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  await h.deliver(h.queue.shift());
  assert.strictEqual(reads, 1);
  assert.strictEqual(h.queue.length, 0);
  bob.api.cancel(sid, cid, mid);
  await h.drain();
  assert.strictEqual(h.clock.count(), 0);
  completeRead(Uint8Array.from([1, 2, 3]).buffer);
  await flush();
  assert.strictEqual(h.packets.filter((p) => p.payload.t === 'f-chunk').length, 0);
  assert.strictEqual(h.saves.length, 0);
  assert.strictEqual(h.clock.count(), 0, 'A late read cannot re-arm its retired sender');
}));

test('deleting a message while File reading prevents late data from being sent', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  let completeRead;
  const file = { name: 'deleted.bin', type: '', size: 1,
    slice: () => ({ arrayBuffer: () => new Promise((resolve) => { completeRead = resolve; }) }),
  };
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  await h.deliver(h.queue.shift());
  alice.api.release(sid, cid, mid);
  h.messages.get(messageKey(sid, cid, mid)).del = true;
  await h.drain();
  completeRead(Uint8Array.from([0xff]).buffer);
  await flush();
  assert.strictEqual(h.packets.filter((p) => p.payload.t === 'f-chunk').length, 0);
  assert.strictEqual(h.saves.length, 0);
  assert.strictEqual(h.clock.count(), 0);
}));

test('the sender stops reading after its requesting peer disconnects', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  const file = trackedFile(Buffer.alloc(h.module.CHUNK_BYTES + 1));
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  await h.deliver(h.queue.shift());
  const chunk = h.queue.shift();
  alice.resolve.delete('bob');
  alice.api.onPacket(sid, { ...chunk.payload, t: 'f-ack' }, bob.uuid, bob.uid);
  await flush();
  assert.strictEqual(file.reads.length, 1);
  assert.strictEqual(h.queue.length, 0);
  assert.strictEqual(h.saves.length, 0);
  h.clock.advance(h.module.TIMEOUT_MS + 1);
  assert.strictEqual(state(bob).state, 'error');
}));

test('an unacknowledged sender times out, frees its slot, and accepts a fresh request', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  const file = trackedFile(Buffer.alloc(h.module.CHUNK_BYTES + 1));
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  const request = h.queue.shift();
  await h.deliver(request);
  h.queue.length = 0; // Drop the first chunk and all ACKs, as on a failed connection.
  h.clock.advance(h.module.TIMEOUT_MS + 1);
  assert.strictEqual(state(bob).state, 'error');
  await h.drain();
  assert.strictEqual(h.clock.count(), 0);
  assert.strictEqual(file.reads.length, 1);
  assert.strictEqual(bob.api.download(sid, cid, mid), true);
  const nextRequest = h.queue[0];
  assert.notStrictEqual(nextRequest.payload.token, request.payload.token, 'Retry must use a new transfer identity');
  await h.drain();
  assert.strictEqual(h.saves.length, 1);
  assert.strictEqual(file.reads.length, 3, 'Fresh transfer reads both chunks after the abandoned first read');
}));

test('one active receiver bounds RAM usage across different file messages', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob');
  const file = trackedFile(Buffer.from('bounded receiver'));
  const meta = offer(h, alice, file);
  const otherMid = 'message2';
  h.messages.set(messageKey(sid, cid, otherMid), { id: otherMid, cid, a: { id: 'alice' }, file: meta });
  alice.api.register(sid, cid, otherMid, meta, file);
  assert.strictEqual(bob.api.download(sid, cid, mid), true);
  assert.strictEqual(bob.api.download(sid, cid, otherMid), false);
  assert.strictEqual(bob.api.status(sid, cid, otherMid).state, 'error');
  assert.strictEqual(h.packets.length, 1);
  bob.api.cancel(sid, cid, mid);
  await h.drain();
  assert.strictEqual(bob.api.download(sid, cid, otherMid), true, 'Cancellation frees the receiver slot');
  await h.drain();
  assert.strictEqual(h.saves.length, 1);
}));

test('three active senders bound concurrent file reads and decline a fourth peer', () => withHarness(async (h) => {
  const alice = h.endpoint('alice');
  const recipients = ['bob', 'carol', 'dave', 'eve'].map((uid) => h.endpoint(uid));
  const file = trackedFile(Buffer.alloc(h.module.CHUNK_BYTES + 1));
  offer(h, alice, file);
  for (const recipient of recipients) assert.strictEqual(recipient.api.download(sid, cid, mid), true);
  const requests = h.queue.splice(0);
  for (const request of requests) await h.deliver(request);
  assert.strictEqual(file.reads.length, 3);
  assert.strictEqual(h.queue.filter((p) => p.payload.t === 'f-chunk').length, 3);
  const declined = h.queue.find((p) => p.to === recipients[3].uuid);
  assert(declined);
  assert.strictEqual(declined.payload.t, 'f-error');
  await h.drain();
  assert.strictEqual(h.saves.length, 3);
  assert.strictEqual(state(recipients[3]).state, 'error');
  assert.strictEqual(h.clock.count(), 0);
}));

test('a second live tab for one user cannot block an older tab from requesting a file', () => withHarness(async (h) => {
  const alice = h.endpoint('alice', { isPeer: true });
  const bob = h.endpoint('bob');
  const newerBob = h.endpoint('bob', { session: 'newer' });
  assert.strictEqual(alice.resolve.get('bob'), newerBob.uuid);
  const bytes = Buffer.from('download in the older tab');
  const file = trackedFile(bytes);
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  await h.drain();
  assert.strictEqual(file.reads.length, 1);
  assert.strictEqual(h.saves.length, 1);
  assert.deepStrictEqual(Buffer.from(await h.saves[0].blob.arrayBuffer()), bytes);
  assert(h.packets.filter((p) => p.payload.t === 'f-chunk').every((p) => p.to === bob.uuid));
}));

test('a preferred peer changing during File read preserves the exact live requesting tab', () => withHarness(async (h) => {
  const alice = h.endpoint('alice', { isPeer: true }), bob = h.endpoint('bob');
  let completeRead;
  const file = { name: 'tabs.bin', type: '', size: 2,
    slice: () => ({ arrayBuffer: () => new Promise((resolve) => { completeRead = resolve; }) }),
  };
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  await h.deliver(h.queue.shift());
  const newerBob = h.endpoint('bob', { session: 'newer' });
  assert.strictEqual(alice.resolve.get('bob'), newerBob.uuid);
  completeRead(Uint8Array.from([0xa0, 0xff]).buffer);
  await flush();
  assert.strictEqual(h.queue.length, 1);
  assert.strictEqual(h.queue[0].to, bob.uuid);
  await h.drain();
  assert.strictEqual(h.saves.length, 1);
  assert.deepStrictEqual(Buffer.from(await h.saves[0].blob.arrayBuffer()), Buffer.from([0xa0, 0xff]));
}));

test('exact peer membership prevents a disconnected tab from reading the next chunk', () => withHarness(async (h) => {
  const alice = h.endpoint('alice', { isPeer: true }), bob = h.endpoint('bob');
  h.endpoint('bob', { session: 'newer' });
  const file = trackedFile(Buffer.alloc(h.module.CHUNK_BYTES + 1));
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  await h.deliver(h.queue.shift());
  const chunk = h.queue.shift();
  alice.connections.get('bob').delete(bob.uuid);
  alice.api.onPacket(sid, { ...chunk.payload, t: 'f-ack' }, bob.uuid, bob.uid);
  await flush();
  assert.strictEqual(file.reads.length, 1);
  assert.strictEqual(h.queue.length, 0);
  assert.strictEqual(h.saves.length, 0);
}));

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log('ok - ' + name); }
    catch (error) { failed++; console.error('not ok - ' + name + '\n' + error.stack); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
  if (failed) process.exitCode = 1;
})();
