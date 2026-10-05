/* Dischord file offers: metadata travels with chat; bytes travel only after Download.
 * No file contents are persisted, previewed, broadcast, or fetched for history sync.
 * The sender retains the selected File reference until its message/server is removed
 * or the tab closes. Receivers keep one explicitly requested transfer in RAM and
 * release its buffers on completion, cancellation, timeout, or an error.
 */
(() => {
  'use strict';

  const MAX_BYTES = 100 * 1024 * 1024;
  const CHUNK_BYTES = 12 * 1024;
  const TIMEOUT_MS = 15000;
  const MAX_SENDERS = 3;
  const MAX_RECEIVERS = 1;
  const MAX_OFFERS = 100;
  const MAX_STATES = 500;
  const ID = /^[a-z0-9]{1,64}$/i;
  const TOKEN = /^[a-z0-9_-]{1,96}$/i;
  const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

  function cleanMeta(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID.test(raw.id) ||
        !Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > MAX_BYTES ||
        typeof raw.name !== 'string' || !raw.name.trim()) return null;
    let name = raw.name.replace(/[\/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069:*?"<>|]/g, '_')
      .trim().slice(0, 255).replace(/[ .]+$/, '');
    if (!name || name === '.' || name === '..') return null;
    // Windows reserves these names even when they have extensions.
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name.slice(0, 254);
    const type = typeof raw.type === 'string' && raw.type.length <= 127 && MIME.test(raw.type) ? raw.type : '';
    return { id: raw.id, name, size: raw.size, type };
  }

  function formatSize(n) {
    if (!Number.isFinite(n) || n < 0) return 'Unknown size';
    if (n < 1024) return n + (n === 1 ? ' byte' : ' bytes');
    const units = ['KB', 'MB', 'GB'];
    let value = n / 1024, index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return value.toFixed(value < 10 ? 1 : 0) + ' ' + units[index];
  }

  /**
   * Context: send(sid, payload, uuid), getMessage(sid, cid, mid),
   * resolvePeer(sid, userId, cid, mid) -> connected UUID or null, userId(), randomId(),
   * optional isPeer(sid, userId, uuid) -> true for that exact live connection,
   * onChange(sid, cid, mid), saveDownload(blob, safeName).
   * register(sid,cid,mid,meta,file) retains a File/Blob without reading it.
   * download/cancel/status/release/hasLocal use (sid,cid,mid).
   * onPacket(sid,payload,uuid,senderUid) requires the app's validated sender identity.
   * status returns {state:'idle'|'receiving'|'complete'|'error', progress:0..100, message}.
   */
  function create(context) {
    const offers = new Map(), receivers = new Map(), senders = new Map(), states = new Map();
    let closed = false, sequence = 0;
    const keyOf = (sid, cid, mid) => JSON.stringify([sid, cid, mid]);
    const senderKey = (sid, p, uuid) => JSON.stringify([sid, p.cid, p.mid, p.fid, p.token, uuid]);
    const validPeer = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f]/.test(v);
    const validLocation = (sid, cid, mid) => typeof sid === 'string' && ID.test(sid) &&
      typeof cid === 'string' && ID.test(cid) && typeof mid === 'string' && mid.length > 0 && mid.length <= 64;
    const validPacket = (sid, p, uuid, uid) => p && typeof p === 'object' &&
      validLocation(sid, p.cid, p.mid) && typeof p.fid === 'string' && ID.test(p.fid) &&
      typeof p.token === 'string' && TOKEN.test(p.token) && validPeer(uuid) && typeof uid === 'string' && ID.test(uid);
    const sameMeta = (a, b) => a && b && a.id === b.id && a.size === b.size && a.name === b.name && a.type === b.type;

    function messageFor(sid, cid, mid) {
      const m = context.getMessage(sid, cid, mid);
      if (!m || m.del || !m.a || typeof m.a.id !== 'string') return null;
      const meta = cleanMeta(m.file);
      return meta ? { author: m.a.id, meta } : null;
    }

    function change(sid, cid, mid, state, progress = 0, message = '') {
      const k = keyOf(sid, cid, mid);
      states.delete(k);
      states.set(k, { state, progress, message });
      // Status is disposable UI state; it must not grow with indefinite chat history.
      if (states.size > MAX_STATES) {
        for (const old of states.keys()) {
          if (!receivers.has(old)) { states.delete(old); break; }
        }
      }
      if (typeof context.onChange === 'function') context.onChange(sid, cid, mid);
    }

    function sendPacket(sid, p, uuid) {
      if (closed || !validPeer(uuid)) return false;
      try { return context.send(sid, p, uuid) !== false; } catch { return false; }
    }

    const envelope = (t, type, extra = {}) => ({ t: type, cid: t.cid, mid: t.mid, fid: t.meta.id, token: t.token, ...extra });
    function stopSender(t) {
      clearTimeout(t.timer);
      if (senders.get(t.key) === t) senders.delete(t.key);
      t.file = null;
    }

    function stopReceiver(t, state, message, tellPeer) {
      if (receivers.get(t.key) !== t) return;
      clearTimeout(t.timer);
      receivers.delete(t.key);
      t.parts.length = 0;
      if (tellPeer) sendPacket(t.sid, envelope(t, 'f-cancel'), t.uuid);
      change(t.sid, t.cid, t.mid, state, state === 'complete' ? 100 : 0, message);
    }

    function aliveSender(t) {
      if (closed || senders.get(t.key) !== t || !t.file) return false;
      const message = messageFor(t.sid, t.cid, t.mid);
      const offer = offers.get(t.offerKey);
      const connected = typeof context.isPeer === 'function' ? context.isPeer(t.sid, t.uid, t.uuid) :
        validPeer(context.resolvePeer(t.sid, t.uid));
      return message && message.author === context.userId() && sameMeta(message.meta, t.meta) &&
        offer && offer.file === t.file && sameMeta(offer.meta, t.meta) && connected;
    }

    function armSender(t) {
      clearTimeout(t.timer);
      t.timer = setTimeout(() => {
        if (senders.get(t.key) !== t) return;
        sendPacket(t.sid, envelope(t, 'f-error', { message: 'File transfer timed out. Try Download again.' }), t.uuid);
        stopSender(t);
      }, TIMEOUT_MS);
    }

    function armReceiver(t) {
      clearTimeout(t.timer);
      t.timer = setTimeout(() => stopReceiver(t, 'error', 'Download timed out. The sender may have disconnected.', true), TIMEOUT_MS);
    }

    function encode(bytes) {
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }

    async function pump(t) {
      if (!aliveSender(t)) { stopSender(t); return; }
      // A single chunk is read at a time. Even slow/unresolved reads expire.
      const index = t.index;
      armSender(t);
      try {
        const start = index * CHUNK_BYTES;
        const end = Math.min(start + CHUNK_BYTES, t.meta.size);
        const buffer = await t.file.slice(start, end).arrayBuffer();
        // Deletion, cancellation and disconnect can all happen while reading.
        if (!aliveSender(t) || t.index !== index) { stopSender(t); return; }
        const bytes = new Uint8Array(buffer);
        if (bytes.length !== end - start) throw new Error('Invalid file read.');
        const data = encode(bytes);
        t.waiting = index;
        armSender(t);
        if (!sendPacket(t.sid, envelope(t, 'f-chunk', { index, data }), t.uuid)) {
          stopSender(t);
        }
      } catch {
        if (senders.get(t.key) !== t) return;
        sendPacket(t.sid, envelope(t, 'f-error', { message: 'The sender could not read this file.' }), t.uuid);
        stopSender(t);
      }
    }

    function register(sid, cid, mid, rawMeta, file) {
      const meta = cleanMeta(rawMeta);
      if (closed || !validLocation(sid, cid, mid) || !meta || !file ||
          file.size !== meta.size || typeof file.slice !== 'function') return false;
      const k = keyOf(sid, cid, mid);
      if (!offers.has(k) && offers.size >= MAX_OFFERS) return false;
      // Changing an existing offer invalidates any pending requests for it.
      if (offers.has(k)) release(sid, cid, mid);
      offers.set(k, { sid, cid, mid, meta, file });
      return true;
    }

    function download(sid, cid, mid) {
      if (closed || !validLocation(sid, cid, mid)) return false;
      const k = keyOf(sid, cid, mid), message = messageFor(sid, cid, mid);
      if (!message) { change(sid, cid, mid, 'error', 0, 'This file is no longer available.'); return false; }
      if (receivers.has(k)) return false;
      if (message.author === context.userId()) {
        const offer = offers.get(k);
        if (!offer || !sameMeta(offer.meta, message.meta)) {
          change(sid, cid, mid, 'error', 0, 'This file is no longer available. Select and send it again.');
          return false;
        }
        try {
          // The owner also explicitly chooses Download; no file read is needed.
          context.saveDownload(offer.file, offer.meta.name);
          change(sid, cid, mid, 'complete', 100);
          return true;
        } catch {
          change(sid, cid, mid, 'error', 0, 'The browser could not save this file.');
          return false;
        }
      }
      if (receivers.size >= MAX_RECEIVERS) {
        change(sid, cid, mid, 'error', 0, 'Another download is in progress. Finish or cancel it first.');
        return false;
      }
      const uuid = context.resolvePeer(sid, message.author, cid, mid);
      if (!validPeer(uuid)) {
        change(sid, cid, mid, 'error', 0, 'The sender is offline. They need to keep this tab open.');
        return false;
      }
      const random = context.randomId();
      const token = String(random) + '_' + (++sequence).toString(36);
      if (!TOKEN.test(token)) { change(sid, cid, mid, 'error', 0, 'Unable to start this download.'); return false; }
      const t = { sid, cid, mid, key: k, meta: message.meta, token, uuid, uid: message.author,
        index: 0, bytes: 0, parts: [], timer: null };
      receivers.set(k, t);
      armReceiver(t);
      change(sid, cid, mid, 'receiving', 0);
      if (!sendPacket(sid, envelope(t, 'f-request'), uuid)) {
        stopReceiver(t, 'error', 'Unable to contact the sender.', false);
        return false;
      }
      return true;
    }

    function onRequest(sid, p, uuid, uid) {
      const connected = typeof context.isPeer === 'function' ? context.isPeer(sid, uid, uuid) :
        context.resolvePeer(sid, uid) === uuid;
      if (uid === context.userId() || !connected) return;
      const key = senderKey(sid, p, uuid);
      if (senders.has(key)) return; // A repeated request cannot bypass ACK backpressure.
      const k = keyOf(sid, p.cid, p.mid), offer = offers.get(k), message = messageFor(sid, p.cid, p.mid);
      if (!message || message.author !== context.userId() || p.fid !== message.meta.id) return;
      const error = (text) => sendPacket(sid, {
        t: 'f-error', cid: p.cid, mid: p.mid, fid: p.fid, token: p.token, message: text,
      }, uuid);
      if (!offer || p.fid !== offer.meta.id || !sameMeta(offer.meta, message.meta)) {
        error('File unavailable. The sender needs to keep the original tab open.');
        return;
      }
      if (senders.size >= MAX_SENDERS) { error('The sender is busy. Try Download again shortly.'); return; }
      const t = { sid, cid: p.cid, mid: p.mid, key, offerKey: k, meta: offer.meta, file: offer.file,
        token: p.token, uuid, uid, index: 0, waiting: -1, count: Math.max(1, Math.ceil(offer.meta.size / CHUNK_BYTES)), timer: null };
      senders.set(key, t);
      void pump(t);
    }

    function onChunk(sid, p, uuid, uid) {
      const t = receivers.get(keyOf(sid, p.cid, p.mid));
      if (!t || t.uuid !== uuid || t.uid !== uid || t.token !== p.token || t.meta.id !== p.fid ||
          !Number.isSafeInteger(p.index) || p.index !== t.index || typeof p.data !== 'string') return;
      const message = messageFor(sid, p.cid, p.mid);
      if (!message || message.author !== t.uid || !sameMeta(message.meta, t.meta)) {
        stopReceiver(t, 'error', 'This file was removed or changed.', true);
        return;
      }
      const expected = Math.min(CHUNK_BYTES, t.meta.size - t.bytes);
      const length = Math.ceil(expected / 3) * 4;
      if (p.data.length !== length || (length && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.data))) return;
      let bytes;
      try {
        const binary = atob(p.data);
        // Canonical base64 and the exact expected size prevent ambiguous chunks.
        if (binary.length !== expected || btoa(binary) !== p.data) return;
        bytes = new Uint8Array(expected);
        for (let i = 0; i < expected; i++) bytes[i] = binary.charCodeAt(i);
      } catch { return; }
      t.parts.push(bytes);
      t.bytes += bytes.length;
      t.index++;
      armReceiver(t);
      sendPacket(sid, envelope(t, 'f-ack', { index: p.index }), uuid);
      // A synchronous transport callback can cancel this consent while acknowledging.
      if (receivers.get(t.key) !== t) return;
      if (t.bytes === t.meta.size) {
        try {
          const blob = new Blob(t.parts, { type: t.meta.type || 'application/octet-stream' });
          if (blob.size !== t.meta.size) throw new Error('Incomplete file.');
          // Only this explicit, authenticated download reaches the browser saver.
          stopReceiver(t, 'complete', '', false);
          context.saveDownload(blob, t.meta.name);
        } catch {
          // stopReceiver may already have released the transfer before the saver throws.
          stopReceiver(t, 'error', 'The browser could not save this file.', true);
          change(t.sid, t.cid, t.mid, 'error', 0, 'The browser could not save this file.');
        }
      } else {
        change(sid, t.cid, t.mid, 'receiving', Math.floor(t.bytes / t.meta.size * 100));
      }
    }

    function onPacket(sid, p, uuid, senderUid) {
      if (!p || !['f-request', 'f-chunk', 'f-ack', 'f-error', 'f-cancel'].includes(p.t)) return false;
      if (closed || !validPacket(sid, p, uuid, senderUid)) return true;
      if (p.t === 'f-request') { onRequest(sid, p, uuid, senderUid); return true; }
      if (p.t === 'f-chunk') { onChunk(sid, p, uuid, senderUid); return true; }
      const t = senders.get(senderKey(sid, p, uuid));
      if (t && t.uid === senderUid) {
        if (p.t === 'f-cancel' || p.t === 'f-error') stopSender(t);
        else if (p.t === 'f-ack' && Number.isSafeInteger(p.index) && p.index === t.waiting && p.index === t.index) {
          clearTimeout(t.timer);
          t.waiting = -1;
          t.index++;
          if (t.index >= t.count) stopSender(t);
          else void pump(t);
        }
      }
      if (p.t === 'f-error' || p.t === 'f-cancel') {
        const r = receivers.get(keyOf(sid, p.cid, p.mid));
        if (r && r.uid === senderUid && r.uuid === uuid && r.token === p.token && r.meta.id === p.fid) {
          const text = p.t === 'f-cancel' ? 'The sender cancelled this transfer.' :
            (typeof p.message === 'string' && p.message.length <= 200 ? p.message : 'File transfer failed.');
          stopReceiver(r, 'error', text, false);
        }
      }
      return true;
    }

    function cancel(sid, cid, mid) {
      const t = receivers.get(keyOf(sid, cid, mid));
      if (!t) return false;
      stopReceiver(t, 'error', 'Download cancelled.', true);
      return true;
    }

    function release(sid, cid, mid) {
      const k = keyOf(sid, cid, mid);
      cancel(sid, cid, mid);
      for (const t of [...senders.values()]) if (t.offerKey === k) {
        sendPacket(t.sid, envelope(t, 'f-error', { message: 'This file is no longer available.' }), t.uuid);
        stopSender(t);
      }
      offers.delete(k);
      states.delete(k);
    }

    function closeServer(sid) {
      for (const r of [...receivers.values()]) if (r.sid === sid) stopReceiver(r, 'error', 'Disconnected from the server.', true);
      for (const t of [...senders.values()]) if (t.sid === sid) {
        sendPacket(t.sid, envelope(t, 'f-error', { message: 'The sender disconnected.' }), t.uuid);
        stopSender(t);
      }
      for (const [k, o] of offers) if (o.sid === sid) offers.delete(k);
      for (const k of states.keys()) if (JSON.parse(k)[0] === sid) states.delete(k);
    }

    function close() {
      if (closed) return;
      for (const r of [...receivers.values()]) stopReceiver(r, 'error', 'Download stopped.', true);
      for (const t of [...senders.values()]) {
        sendPacket(t.sid, envelope(t, 'f-error', { message: 'The sender disconnected.' }), t.uuid);
        stopSender(t);
      }
      closed = true;
      offers.clear();
      states.clear();
    }

    return {
      register, download, cancel, onPacket, release, closeServer, close,
      status(sid, cid, mid) { return { ...(states.get(keyOf(sid, cid, mid)) || { state: 'idle', progress: 0, message: '' }) }; },
      hasLocal(sid, cid, mid) {
        const o = offers.get(keyOf(sid, cid, mid)), m = messageFor(sid, cid, mid);
        return !!(o && m && m.author === context.userId() && sameMeta(o.meta, m.meta));
      },
    };
  }

  window.DischordFiles = Object.freeze({ cleanMeta, formatSize, create, MAX_BYTES, CHUNK_BYTES, TIMEOUT_MS });
})();
