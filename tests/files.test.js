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

function createHarness(options = {}) {
  const harnessOptions = options;
  const clock = createClock(), queue = [], packets = [], peers = new Map();
  const storageCalls = [], saves = [], changes = [], messages = new Map(), blobCalls = [];
  let nextId = 1;
  const window = {};
  const DateMock = class extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now()])); }
    static now() { return clock.now(); }
  };
  const context = vm.createContext({
    window, console, Blob: class extends Blob {
      constructor(parts, settings) {
        blobCalls.push(parts.length);
        if (options.forbidBlob) throw new Error('Streaming must not assemble a whole-file Blob');
        super(parts, settings);
      }
    }, Uint8Array, ArrayBuffer, Map, Set, Date: DateMock,
    btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    // Accessing persistent storage is a failure: receiving an offer must never
    // cache its bytes in localStorage, IndexedDB, or the filesystem.
    localStorage: { getItem(...args) { storageCalls.push(['get', ...args]); },
      setItem(...args) { storageCalls.push(['set', ...args]); } },
    indexedDB: { open(...args) { storageCalls.push(['indexedDB', ...args]); } },
  });
  let protocolSource = source;
  if (options.shortStreamFixture) {
    // The actual classifier boundaries and multi-GB streaming prefix are
    // tested unchanged below. Scale only this full commit fixture so its
    // write/close/abort checks do not encode 300 MB every time CI runs.
    const threshold = 'if (size < 100 * 1024 * 1024)';
    assert(source.includes(threshold), 'The fixture classifier seam must match exactly');
    protocolSource = source.replace(threshold, 'if (size < 2 * 1024 * 1024)');
  }
  vm.runInContext(protocolSource, context, { filename: 'file-transfer.js' });
  const module = window.DischordFiles;
  assert(module && typeof module.create === 'function', 'File protocol factory must be exported');
  function endpoint(uid, options = {}) {
    const uuid = 'peer-' + uid + (options.session ? '-' + options.session : '');
    const resolve = new Map();
    const connections = new Map();
    const protocolContext = {
      send(sid, payload, target) {
        // Earlier consent and lifecycle tests deliberately use the legacy
        // one-chunk receiver. Throughput tests opt into the native/new window.
        if (payload.t === 'f-request' && options.requestWindow !== 'native') {
          payload = { ...payload };
          if (options.requestWindow === 'legacy') {
            for (const field of ['window', 'initialWindow', 'adaptive', 'ackEvery']) delete payload[field];
          }
          else payload.window = options.requestWindow === undefined ? 1 : options.requestWindow;
        }
        const packet = { sid, payload: copy({ ...payload, u: { id: uid } }), from: uuid, to: target, sentAt: clock.now() };
        if (harnessOptions.recordPackets !== false) packets.push(packet);
        if (options.synchronous) {
          const recipient = peers.get(target);
          if (recipient) recipient.api.onPacket(sid, packet.payload, uuid, uid);
        } else queue.push(packet);
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
    if (options.openDownload) protocolContext.openDownload = options.openDownload;
    if (options.maxWindow) protocolContext.maxWindow = options.maxWindow;
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
  return { module, endpoint, clock, messages, queue, packets, saves, changes, blobCalls, storageCalls, deliver, drain, close };
}

const sid = 'server1', cid = 'channel1', mid = 'message1';
function offer(h, author, file, overrides = {}) {
  const meta = h.module.cleanMeta({ id: 'file1', name: file.name, size: file.size, type: file.type, ...overrides });
  assert(meta, 'Fixture attachment metadata must be valid');
  h.messages.set(messageKey(sid, cid, mid), { id: mid, cid, a: { id: author.uid }, file: meta });
  assert.strictEqual(author.api.register(sid, cid, mid, meta, file), true);
  return meta;
}
function logicalFile(size, name = 'logical.bin') {
  const reads = [];
  return { name, type: 'application/octet-stream', size, reads,
    slice(start, end) {
      reads.push([start, end]);
      return { async arrayBuffer() {
        const bytes = new Uint8Array(end - start);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (start + i) % 251;
        return bytes.buffer;
      } };
    },
  };
}
async function withHarness(run, options) {
  const h = createHarness(options);
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

test('one active receiver prevents concurrent download buffers for different file messages', () => withHarness(async (h) => {
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

test('native receivers request a bounded pipeline and cumulative ACKs release only sent chunks', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob', { requestWindow: 'native' }), eve = h.endpoint('eve');
  const limit = 32;
  assert.strictEqual(h.module.MAX_WINDOW, 128);
  const file = trackedFile(Buffer.alloc(h.module.CHUNK_BYTES * 100, 0xb7));
  offer(h, alice, file);
  assert.strictEqual(bob.api.download(sid, cid, mid), true);
  const request = h.queue.shift();
  assert.strictEqual(request.payload.window, limit);
  assert.deepStrictEqual(file.reads, [], 'Only an offer/request remains unread until the sender receives consent');
  await h.deliver(request);
  const initial = h.queue.splice(0);
  assert.strictEqual(initial.length, limit, 'Fill the window before waiting for a network round trip');
  assert.strictEqual(file.reads.length, limit);
  assert.deepStrictEqual(initial.map((p) => p.payload.index), Array.from({ length: limit }, (_, i) => i));
  await flush();
  assert.strictEqual(file.reads.length, limit, 'The sender must never read beyond its outstanding capacity');
  for (const chunk of initial) await h.deliver(chunk);
  const earlyAcks = h.queue.splice(0);
  assert.strictEqual(earlyAcks.length, limit / 4);
  assert(earlyAcks.every((p) => p.payload.t === 'f-ack'));
  const cumulative = earlyAcks[1];
  assert.strictEqual(cumulative.payload.index, 7);
  for (const index of [-1, limit, limit + 100, 1.5, Number.MAX_SAFE_INTEGER]) {
    alice.api.onPacket(sid, { ...cumulative.payload, index }, bob.uuid, bob.uid);
  }
  alice.api.onPacket(sid, cumulative.payload, eve.uuid, eve.uid);
  alice.api.onPacket(sid, { ...cumulative.payload, token: 'wrongtoken' }, bob.uuid, bob.uid);
  await flush();
  assert.strictEqual(file.reads.length, limit, 'Future, malformed, wrong-peer, and wrong-token ACKs release no capacity');
  await h.deliver(cumulative);
  assert.strictEqual(file.reads.length, limit + 8, 'ACK 7 acknowledges the contiguous first eight chunks');
  assert.deepStrictEqual(h.queue.map((p) => p.payload.index), Array.from({ length: 8 }, (_, i) => limit + i));
  for (const index of [7, 6, 0]) alice.api.onPacket(sid, { ...cumulative.payload, index }, bob.uuid, bob.uid);
  await flush();
  assert.strictEqual(file.reads.length, limit + 8, 'Duplicate and older ACKs cannot free the same slots twice');
  // ACK 31 follows receipt of that prefix, even if ACK 0..30 were lost/delayed.
  await h.deliver(earlyAcks[earlyAcks.length - 1]);
  assert.strictEqual(file.reads.length, limit * 2);
  assert.strictEqual(h.queue.length, limit, 'Unacknowledged chunks remain capped at the window size');
  await h.drain();
  assert.strictEqual(h.saves.length, 1);
  assert.strictEqual(state(bob).state, 'complete');
  assert.deepStrictEqual(Buffer.from(await h.saves[0].blob.arrayBuffer()), Buffer.alloc(file.size, 0xb7));
}));

test('legacy or invalid requested windows use one chunk, and oversized valid windows are capped', async () => {
  const requests = [
    { value: 'legacy', expected: 1 }, { value: 0, expected: 1 }, { value: -1, expected: 1 },
    { value: 1.5, expected: 1 }, { value: null, expected: 1 }, { value: '32', expected: 1 },
    { value: Number.MAX_SAFE_INTEGER + 1, expected: 1 }, { value: 4, expected: 4 },
    { value: 999, expected: 8 },
  ];
  for (const { value, expected } of requests) await withHarness(async (h) => {
    const alice = h.endpoint('alice'), bob = h.endpoint('bob', { requestWindow: value });
    const file = trackedFile(Buffer.alloc(h.module.CHUNK_BYTES * 40));
    offer(h, alice, file);
    bob.api.download(sid, cid, mid);
    await h.deliver(h.queue.shift());
    assert.strictEqual(file.reads.length, expected, 'Requested window ' + value + ' must negotiate ' + expected);
    assert.strictEqual(h.queue.length, expected);
  });
});

test('an ACK for a chunk still being read cannot advance or duplicate the read pump', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob', { requestWindow: 'native' });
  const limit = 8, bytes = Buffer.alloc(h.module.CHUNK_BYTES * (limit + 2), 0x4e);
  const reads = [], pending = [];
  const file = { name: 'slow-window.bin', type: '', size: bytes.length,
    slice(start, end) {
      reads.push([start, end]);
      return { arrayBuffer: () => new Promise((resolve) => pending.push(() =>
        resolve(Uint8Array.from(bytes.subarray(start, end)).buffer))) };
    },
  };
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  const request = h.queue.shift();
  await h.deliver(request);
  assert.strictEqual(reads.length, 1);
  alice.api.onPacket(sid, { ...request.payload, t: 'f-ack', index: 0 }, bob.uuid, bob.uid);
  await flush();
  assert.strictEqual(reads.length, 1, 'A pending read has not yet sent chunk zero');
  pending.shift()();
  await flush();
  assert.strictEqual(reads.length, 2);
  assert.strictEqual(h.queue.length, 1);
  alice.api.onPacket(sid, { ...request.payload, t: 'f-ack', index: 1 }, bob.uuid, bob.uid);
  await flush();
  assert.strictEqual(reads.length, 2, 'A future/read-pending ACK must not create another read');
  for (let index = 1; index < limit; index++) { pending.shift()(); await flush(); }
  assert.strictEqual(reads.length, limit, 'Each read is sequential and only the bounded initial window is sent');
  assert.strictEqual(pending.length, 0);
  assert.strictEqual(h.queue.length, limit);
  await h.deliver(h.queue.shift());
  // Delivering one valid ACK starts exactly one new read, rather than the two
  // slots a forged/read-pending acknowledgement would have incorrectly freed.
  const ack = h.queue.pop();
  assert.strictEqual(ack.payload.t, 'f-ack');
  await h.deliver(ack);
  assert.strictEqual(reads.length, limit + 1);
  assert.strictEqual(pending.length, 1);
  bob.api.cancel(sid, cid, mid);
  const cancel = h.queue.pop();
  assert.strictEqual(cancel.payload.t, 'f-cancel');
  await h.deliver(cancel);
  pending.shift()();
  await flush();
  assert.strictEqual(reads.length, limit + 1);
  assert.strictEqual(h.queue.length, limit - 1, 'The late read after cancellation adds no chunk');
  assert.strictEqual(h.saves.length, 0);
}));

test('pumping unacknowledged slow reads does not extend the sender inactivity timeout', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob', { requestWindow: 'native' });
  const pending = [], file = { name: 'stalled-acks.bin', type: '', size: 100 * 1024 * 1024,
    slice(start, end) { return { arrayBuffer: () => new Promise((resolve) =>
      pending.push(() => resolve(new Uint8Array(end - start).buffer))) }; },
  };
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  await h.deliver(h.queue.shift());
  for (let elapsed = 1000; elapsed < h.module.TIMEOUT_MS; elapsed += 1000) {
    h.clock.advance(1000);
    pending.shift()();
    await flush();
  }
  const chunkCount = h.packets.filter((p) => p.payload.t === 'f-chunk').length;
  assert(chunkCount > 1);
  h.clock.advance(1001);
  assert(h.packets.some((p) => p.payload.t === 'f-error' && p.from === alice.uuid),
    'Sending without ACK progress must expire at the original inactivity deadline');
  pending.shift()();
  await flush();
  assert.strictEqual(h.packets.filter((p) => p.payload.t === 'f-chunk').length, chunkCount,
    'A read that finishes after timeout cannot send another chunk');
  assert.strictEqual(h.saves.length, 0);
  assert.strictEqual(h.clock.count(), 0);
}));

test('a synchronous transport ACK can complete while the guarded read pump is running', () => withHarness(async (h) => {
  const alice = h.endpoint('alice', { synchronous: true });
  const bob = h.endpoint('bob', { requestWindow: 'native', synchronous: true });
  const bytes = Buffer.alloc(h.module.CHUNK_BYTES * 2 + 3, 0x96), file = trackedFile(bytes);
  offer(h, alice, file);
  assert.strictEqual(bob.api.download(sid, cid, mid), true);
  await flush();
  assert.strictEqual(file.reads.length, 3);
  assert.strictEqual(h.saves.length, 1);
  assert.strictEqual(state(bob).state, 'complete');
  assert.deepStrictEqual(Buffer.from(await h.saves[0].blob.arrayBuffer()), bytes);
  assert.strictEqual(h.queue.length, 0);
  assert.strictEqual(h.clock.count(), 0);
}));

test('a 100 ms RTT simulation pipelines downloads faster while preserving every byte', async () => {
  async function transfer(requestWindow) {
    let result;
    await withHarness(async (h) => {
      const alice = h.endpoint('alice'), bob = h.endpoint('bob', { requestWindow });
      const bytes = Buffer.alloc(h.module.CHUNK_BYTES * 129 + 7);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 167 + 83) % 256;
      offer(h, alice, trackedFile(bytes));
      const started = h.clock.now();
      bob.api.download(sid, cid, mid);
      let steps = 0;
      while (h.queue.length) {
        assert(++steps < 400, 'The simulated transport must settle');
        h.queue.sort((a, b) => a.sentAt - b.sentAt);
        const packet = h.queue.shift();
        // Each direction costs 50 ms, producing a 100 ms chunk/ACK RTT.
        h.clock.advance(Math.max(0, packet.sentAt + 50 - h.clock.now()));
        await h.deliver(packet);
      }
      assert.strictEqual(h.saves.length, 1);
      assert.strictEqual(state(bob).state, 'complete');
      assert.deepStrictEqual(Buffer.from(await h.saves[0].blob.arrayBuffer()), bytes);
      assert.strictEqual(h.clock.count(), 0);
      result = { elapsed: h.clock.now() - started, bytes: bytes.length };
    });
    return result;
  }
  const legacy = await transfer('legacy'), pipelined = await transfer('native');
  assert.strictEqual(pipelined.bytes, legacy.bytes);
  assert(pipelined.elapsed * 10 <= legacy.elapsed,
    `Pipelining should improve latency-bound throughput: ${legacy.elapsed} ms legacy versus ${pipelined.elapsed} ms windowed`);
});

test('file strategy boundaries select small, medium, and large transfer plans', () => withHarness(async (h) => {
  const mib = 1024 * 1024;
  const expected = [
    [0, 'small', 8, 8, false, 1], [mib - 1, 'small', 8, 8, false, 1],
    [mib, 'medium', 32, 32, false, 4], [100 * mib - 1, 'medium', 32, 32, false, 4],
    [100 * mib, 'large', 32, 128, true, 8], [5 * 1024 * mib, 'large', 32, 128, true, 8],
  ];
  for (const [size, name, initialWindow, maxWindow, stream, ackEvery] of expected) {
    assert.deepStrictEqual(copy(h.module.strategyFor(size)), { name, initialWindow, maxWindow, stream, ackEvery });
  }
}));

test('a five GB offer shares metadata without reading or allocating the logical file', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob', { requestWindow: 'native' });
  const file = logicalFile(5 * 1024 * 1024 * 1024);
  const meta = offer(h, alice, file);
  assert.strictEqual(meta.size, file.size);
  assert.strictEqual(file.reads.length, 0);
  assert.strictEqual(h.packets.length, 0);
  assert.strictEqual(h.blobCalls.length, 0);
  assert.deepStrictEqual(Object.keys(copy(h.messages.get(messageKey(sid, cid, mid)).file)).sort(), ['id', 'name', 'size', 'type']);
  bob.api.download(sid, cid, mid);
  const request = h.queue.shift();
  assert.strictEqual(request.payload.window, 128);
  assert.strictEqual(request.payload.initialWindow, 32);
  assert.strictEqual(request.payload.adaptive, true);
  assert.strictEqual(request.payload.ackEvery, 8);
  assert.strictEqual(file.reads.length, 0, 'The explicit request itself does not read the sender File');
  await h.deliver(request);
  assert.strictEqual(file.reads.length, 32);
  assert.strictEqual(h.queue.length, 32);
  assert.strictEqual(h.blobCalls.length, 0);
  assert.strictEqual(h.saves.length, 0);
}));

test('large adaptive windows grow with healthy ACKs, shrink for congestion, and obey media caps', () => withHarness(async (h) => {
  let mediaCap = 128;
  const alice = h.endpoint('alice', { maxWindow: () => mediaCap });
  const bob = h.endpoint('bob', { requestWindow: 'native' });
  const file = logicalFile(5 * 1024 * 1024 * 1024);
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  await h.deliver(h.queue.shift());
  let outstanding = h.queue.splice(0);
  assert.strictEqual(outstanding.length, 32);
  async function acknowledge(delay) {
    const last = outstanding[outstanding.length - 1];
    h.clock.advance(delay);
    await h.deliver({ ...last, from: bob.uuid, to: alice.uuid,
      payload: { ...last.payload, t: 'f-ack', u: { id: bob.uid } } });
    outstanding = h.queue.splice(0);
    return outstanding.length;
  }
  assert.strictEqual(await acknowledge(100), 40);
  assert.strictEqual(await acknowledge(100), 48);
  assert.strictEqual(await acknowledge(500), 24, 'A delayed RTT halves the live window');
  mediaCap = 16;
  assert.strictEqual(await acknowledge(100), 16, 'Voice/screen activity can lower the next pump capacity');
  mediaCap = 128;
  let peak = 0;
  for (let round = 0; round < 20; round++) {
    const count = await acknowledge(100);
    assert(count > 0 && count <= 128, 'Adaptive growth remains within the strategy ceiling');
    peak = Math.max(peak, count);
  }
  assert.strictEqual(peak, 128);
  assert.strictEqual(h.blobCalls.length, 0);
  assert.strictEqual(h.saves.length, 0);
}, { recordPackets: false }));

test('a one-chunk initial media cap also negotiates individual ACKs without a deadlock', () => withHarness(async (h) => {
  const alice = h.endpoint('alice', { maxWindow: () => 1 }), bob = h.endpoint('bob', { requestWindow: 'native' });
  offer(h, alice, logicalFile(5 * 1024 * 1024 * 1024));
  bob.api.download(sid, cid, mid);
  await h.deliver(h.queue.shift());
  assert.strictEqual(h.queue.length, 1);
  const chunk = h.queue.shift();
  assert.strictEqual(chunk.payload.ackEvery, 1);
  await h.deliver(chunk);
  assert.strictEqual(h.queue.length, 1);
  assert.strictEqual(h.queue[0].payload.t, 'f-ack');
  await h.deliver(h.queue.shift());
  assert.strictEqual(h.queue.length, 1);
  assert.strictEqual(h.queue[0].payload.index, 1);
}));

test('a recipient already in voice requests a 32-chunk cap and advertises it in ACKs', () => withHarness(async (h) => {
  const alice = h.endpoint('alice');
  const bob = h.endpoint('bob', { requestWindow: 'native', maxWindow: () => 32 });
  const file = logicalFile(5 * 1024 * 1024 * 1024);
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  const request = h.queue.shift();
  assert.strictEqual(request.payload.window, 32);
  assert.strictEqual(request.payload.initialWindow, 32);
  await h.deliver(request);
  const chunks = h.queue.splice(0);
  assert.strictEqual(chunks.length, 32, 'The sender must respect the recipient cap, even outside its own voice call');
  for (const chunk of chunks.slice(0, 8)) await h.deliver(chunk);
  assert.strictEqual(h.queue.length, 1);
  assert.strictEqual(h.queue[0].payload.t, 'f-ack');
  assert.strictEqual(h.queue[0].payload.window, 32);
  assert.strictEqual(h.saves.length, 0);
}));

test('joining and leaving voice mid-transfer changes the recipient cap without losing in-flight bytes', () => withHarness(async (h) => {
  let recipientCap = 128, written = 0;
  const alice = h.endpoint('alice');
  const bob = h.endpoint('bob', { requestWindow: 'native', maxWindow: () => recipientCap,
    openDownload: async () => ({ async write(bytes) { written += bytes.length; }, async close() {}, async abort() {} }) });
  const file = logicalFile(5 * 1024 * 1024 * 1024);
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  await flush();
  await h.deliver(h.queue.shift());
  async function healthyRound() {
    const chunks = h.queue.splice(0);
    h.clock.advance(100);
    for (const chunk of chunks) await h.deliver(chunk);
    const acknowledgements = h.queue.splice(0);
    assert(acknowledgements.every((packet) => packet.payload.t === 'f-ack'));
    const last = acknowledgements[acknowledgements.length - 1];
    assert.strictEqual(last.payload.window, recipientCap);
    await h.deliver(last);
  }
  for (let round = 0; h.queue.length < 128 && round < 20; round++) await healthyRound();
  assert.strictEqual(h.queue.length, 128, 'A healthy large transfer reaches its original negotiated ceiling');
  const outstanding = h.queue.splice(0), readBeforeJoin = file.reads.length;
  recipientCap = 32;
  h.clock.advance(100);
  for (let offset = 0; offset < outstanding.length; offset += 8) {
    for (const chunk of outstanding.slice(offset, offset + 8)) await h.deliver(chunk);
    const ack = h.queue.find((packet) => packet.payload.t === 'f-ack');
    h.queue.splice(h.queue.indexOf(ack), 1);
    assert(ack && ack.payload.window === 32);
    await h.deliver(ack);
    if (offset < 96) {
      assert.strictEqual(file.reads.length, readBeforeJoin,
        'A lower cap drains existing outstanding bytes before reading replacements');
    }
    assert(h.queue.length <= 32, 'Future sends must fit within the recipient voice cap');
  }
  assert.strictEqual(h.queue.length, 32);
  assert.strictEqual(file.reads.length, readBeforeJoin + 32);
  recipientCap = 128;
  const capped = h.queue.splice(0);
  h.clock.advance(100);
  for (const chunk of capped.slice(0, 8)) await h.deliver(chunk);
  const resumeAck = h.queue.shift();
  assert.strictEqual(resumeAck.payload.window, 128);
  await h.deliver(resumeAck);
  assert.strictEqual(h.queue.length + capped.length - 8, 128,
    'Leaving voice restores capacity up to the original negotiated ceiling');
  assert(written > 0);
  assert.strictEqual(h.blobCalls.length, 0);
  assert.strictEqual(h.saves.length, 0);
}, { recordPackets: false, forbidBlob: true }));

test('wrong-peer, wrong-token, and malformed ACKs cannot change recipient flow control', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob', { requestWindow: 'native' }), eve = h.endpoint('eve');
  const file = logicalFile(5 * 1024 * 1024 * 1024);
  offer(h, alice, file);
  bob.api.download(sid, cid, mid);
  await h.deliver(h.queue.shift());
  let chunks = h.queue.splice(0);
  const original = { ...chunks[chunks.length - 1].payload, t: 'f-ack', window: 1 };
  alice.api.onPacket(sid, original, eve.uuid, eve.uid);
  alice.api.onPacket(sid, { ...original, token: 'wrongtoken' }, bob.uuid, bob.uid);
  alice.api.onPacket(sid, { ...original, index: chunks.length }, bob.uuid, bob.uid);
  alice.api.onPacket(sid, { ...original, index: -1 }, bob.uuid, bob.uid);
  await flush();
  assert.strictEqual(file.reads.length, 32);
  const invalidCaps = [0, -1, 1.5, '32', Number.MAX_SAFE_INTEGER + 1, null, undefined];
  for (let round = 0; round < invalidCaps.length; round++) {
    const payload = { ...chunks[chunks.length - 1].payload, t: 'f-ack', window: invalidCaps[round] };
    if (invalidCaps[round] === undefined) delete payload.window;
    h.clock.advance(100);
    alice.api.onPacket(sid, payload, bob.uuid, bob.uid);
    await flush();
    chunks = h.queue.splice(0);
    assert.strictEqual(chunks.length, 40 + round * 8,
      'Malformed or missing cap values must preserve the negotiated legacy/default capacity');
  }
}, { recordPackets: false }));

test('modern medium transfers batch ACKs while unflagged legacy chunks receive individual ACKs', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), bob = h.endpoint('bob', { requestWindow: 'native' });
  offer(h, alice, logicalFile(2 * 1024 * 1024));
  bob.api.download(sid, cid, mid);
  await h.deliver(h.queue.shift());
  const chunks = h.queue.splice(0);
  for (const chunk of chunks.slice(0, 12)) {
    assert.strictEqual(chunk.payload.ackEvery, 4);
    await h.deliver(chunk);
  }
  assert.deepStrictEqual(h.queue.map((p) => p.payload.index), [3, 7, 11]);
  h.queue.length = 0;
  for (const chunk of chunks.slice(12, 16)) {
    const legacy = { ...chunk, payload: { ...chunk.payload } };
    delete legacy.payload.ackEvery;
    await h.deliver(legacy);
  }
  assert.deepStrictEqual(h.queue.map((p) => p.payload.index), [12, 13, 14, 15]);
  assert.strictEqual(h.saves.length, 0);
}));

test('large downloads wait for the user-selected sink and ACK only committed bounded writes', () => withHarness(async (h) => {
  let resolvePicker;
  const writes = [], pendingWrites = [];
  let pickerCalls = 0, aborts = 0;
  const sink = {
    write(bytes) { writes.push(bytes.length); return new Promise((resolve) => pendingWrites.push(resolve)); },
    async close() { throw new Error('This prefix-only test must not close a five GB file'); },
    async abort() { aborts++; },
  };
  const alice = h.endpoint('alice');
  const bob = h.endpoint('bob', { requestWindow: 'native', openDownload(meta, strategy) {
    pickerCalls++;
    assert.strictEqual(meta.size, 5 * 1024 * 1024 * 1024);
    assert.strictEqual(strategy.name, 'large');
    return new Promise((resolve) => { resolvePicker = resolve; });
  } });
  const file = logicalFile(5 * 1024 * 1024 * 1024);
  offer(h, alice, file);
  assert.strictEqual(pickerCalls, 0);
  assert.strictEqual(bob.api.download(sid, cid, mid), true);
  assert.strictEqual(pickerCalls, 1, 'Open the browser picker synchronously within the Download gesture');
  assert.strictEqual(state(bob).state, 'preparing');
  assert.strictEqual(h.packets.length, 0);
  assert.strictEqual(file.reads.length, 0);
  assert.strictEqual(bob.api.download(sid, cid, mid), false, 'Preparing reserves the receiver slot');
  resolvePicker(sink);
  await flush();
  assert.strictEqual(h.queue.length, 1);
  await h.deliver(h.queue.shift());
  const chunks = h.queue.splice(0);
  assert.strictEqual(chunks.length, 32);
  for (const chunk of chunks) await h.deliver(chunk);
  assert.deepStrictEqual(writes, [8 * h.module.CHUNK_BYTES], 'Write one bounded batch while later chunks queue');
  assert.strictEqual(h.queue.length, 0, 'Nothing is acknowledged before the disk write succeeds');
  pendingWrites.shift()();
  await flush();
  assert.deepStrictEqual(writes, [8 * h.module.CHUNK_BYTES, 8 * h.module.CHUNK_BYTES]);
  assert.strictEqual(h.queue.length, 1);
  assert.strictEqual(h.queue[0].payload.t, 'f-ack');
  assert.strictEqual(h.queue[0].payload.index, 7);
  assert.strictEqual(h.blobCalls.length, 0);
  assert.strictEqual(h.saves.length, 0);
  bob.api.cancel(sid, cid, mid);
  await flush();
  assert.strictEqual(aborts, 1);
  const ackCount = h.packets.filter((p) => p.payload.t === 'f-ack').length;
  pendingWrites.shift()();
  await flush();
  assert.strictEqual(h.packets.filter((p) => p.payload.t === 'f-ack').length, ackCount, 'A late write after cancellation must not acknowledge');
  assert.strictEqual(writes.length, 2, 'Cancellation discards the remaining queued batches');
  assert.strictEqual(state(bob).state, 'error');
}, { forbidBlob: true }));

test('cancelled, deleted, or disconnected downloads abort a picker that resolves late', async () => {
  for (const action of ['cancel', 'release', 'disconnect']) await withHarness(async (h) => {
    let resolvePicker, aborts = 0;
    const alice = h.endpoint('alice');
    const bob = h.endpoint('bob', { requestWindow: 'native', openDownload: () =>
      new Promise((resolve) => { resolvePicker = resolve; }) });
    const file = logicalFile(5 * 1024 * 1024 * 1024);
    offer(h, alice, file);
    bob.api.download(sid, cid, mid);
    if (action === 'cancel') bob.api.cancel(sid, cid, mid);
    if (action === 'release') { h.messages.get(messageKey(sid, cid, mid)).del = true; bob.api.release(sid, cid, mid); }
    if (action === 'disconnect') bob.api.closeServer(sid);
    resolvePicker({ async write() {}, async close() {}, async abort() { aborts++; } });
    await flush();
    assert.strictEqual(aborts, 1, action + ' must release the late file handle');
    assert(!h.packets.some((p) => p.payload.t === 'f-request'), action + ' cannot request bytes after consent ended');
    assert.strictEqual(file.reads.length, 0);
    assert.strictEqual(h.blobCalls.length, 0);
  });
});

test('picker cancellation and sink write failure stop consent without saving or acknowledging bytes', async () => {
  for (const failure of ['picker', 'write']) await withHarness(async (h) => {
    let aborts = 0, writes = 0;
    const alice = h.endpoint('alice');
    const bob = h.endpoint('bob', { requestWindow: 'native', openDownload: async () => {
      if (failure === 'picker') throw new Error('User cancelled picker');
      return { async write() { writes++; throw new Error('Disk write failed'); }, async close() {}, async abort() { aborts++; } };
    } });
    offer(h, alice, logicalFile(5 * 1024 * 1024 * 1024));
    bob.api.download(sid, cid, mid);
    await flush();
    if (failure === 'write') {
      await h.deliver(h.queue.shift());
      const chunks = h.queue.splice(0);
      for (const chunk of chunks) await h.deliver(chunk);
      assert.strictEqual(writes, 1);
      assert.strictEqual(aborts, 1);
    } else assert(!h.packets.some((p) => p.payload.t === 'f-request'));
    assert.strictEqual(state(bob).state, 'error');
    assert(!h.packets.some((p) => p.payload.t === 'f-ack'));
    assert.strictEqual(h.blobCalls.length, 0);
    assert.strictEqual(h.saves.length, 0);
  });
});

test('streaming fixtures commit after sender departure, report close failure, and respect close cancellation', () => withHarness(async (h) => {
  const alice = h.endpoint('alice'), size = 2 * 1024 * 1024 + 3;
  const stats = {}, recipients = [];
  let resolveCompleteClose, resolveLateClose;
  for (const mode of ['complete', 'failure', 'cancel']) {
    const counts = stats[mode] = { bytes: 0, writes: 0, closes: 0, aborts: 0 };
    const sink = {
      async write(bytes) {
        assert(bytes.length > 0 && bytes.length <= 8 * h.module.CHUNK_BYTES, 'Disk writes stay bounded to one ACK batch');
        assert.strictEqual(bytes[0], counts.bytes % 251);
        assert.strictEqual(bytes[bytes.length - 1], (counts.bytes + bytes.length - 1) % 251);
        counts.bytes += bytes.length;
        counts.writes++;
      },
      close() {
        counts.closes++;
        if (mode === 'failure') return Promise.reject(new Error('Final disk commit failed'));
        if (mode === 'cancel') return new Promise((resolve) => { resolveLateClose = resolve; });
        return new Promise((resolve) => { resolveCompleteClose = resolve; });
      },
      async abort() { counts.aborts++; },
    };
    recipients.push(h.endpoint(mode, { requestWindow: 'native', openDownload: async () => sink }));
  }
  offer(h, alice, logicalFile(size));
  for (const peer of recipients) assert.strictEqual(peer.api.download(sid, cid, mid), true);
  await flush();
  await h.drain(40000);
  for (const counts of Object.values(stats)) {
    assert.strictEqual(counts.bytes, size, 'The counting sink receives the complete logical file without retaining it');
    assert.strictEqual(counts.closes, 1);
  }
  assert.strictEqual(state(recipients[0]).state, 'saving');
  recipients[0].resolve.delete(alice.uid);
  resolveCompleteClose();
  await flush();
  assert.strictEqual(state(recipients[0]).state, 'complete', 'The sender can leave after all bytes were committed');
  assert.strictEqual(stats.complete.aborts, 0);
  assert.strictEqual(state(recipients[1]).state, 'error');
  assert.strictEqual(stats.failure.aborts, 1);
  assert.strictEqual(state(recipients[2]).state, 'saving');
  assert.strictEqual(recipients[2].api.cancel(sid, cid, mid), true);
  await flush();
  assert.strictEqual(stats.cancel.aborts, 1);
  resolveLateClose();
  await flush();
  assert.strictEqual(state(recipients[2]).state, 'error', 'Closing after cancellation must never report success');
  assert.strictEqual(h.blobCalls.length, 0);
  assert.strictEqual(h.saves.length, 0, 'Streaming never creates a second browser Blob download');
  assert.strictEqual(h.clock.count(), 0);
}, { recordPackets: false, forbidBlob: true, shortStreamFixture: true }));

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log('ok - ' + name); }
    catch (error) { failed++; console.error('not ok - ' + name + '\n' + error.stack); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
  if (failed) process.exitCode = 1;
})();
