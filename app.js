/* Dischord — a Discord-style app on top of VDO.Ninja. Fully peer-to-peer.
 *
 * How it works (no backend):
 *  - Each server has a random id + secret key. Everyone who has the invite has both.
 *  - For every server you're in, a hidden VDO.Ninja iframe joins a room as a guest with
 *    no camera or mic. That peer-to-peer mesh carries text messages, presence, typing,
 *    voice-channel occupancy, channel changes and history sync, via the VDO.Ninja
 *    IFRAME API (sendData / dataReceived).
 *  - Voice channels are separate, visible VDO.Ninja rooms (audio, camera, screen share).
 *    Dischord draws its own controls and drives VDO.Ninja through postMessage.
 *  - Everything is stored in your browser's localStorage. History reaches people who
 *    join later as long as someone who has it is online.
 *
 * Testing tip: add ?as=alice to the URL to use a separate identity in the same browser.
 */
(() => {
  'use strict';

  // Point this at a self-hosted VDO.Ninja if you like (see README).
  const VDO = (window.DISCHORD_CONFIG && window.DISCHORD_CONFIG.vdoUrl) || 'https://vdo.ninja/';
  const PROTO = 2;
  const MAX_MSGS = 500;
  const HIST_SEND = 80;           // messages per channel sent during history sync
  const PING_MS = 8000;           // presence heartbeat
  const STALE_CONNECTED = 90000;  // connected peer considered gone after this long silent
  const STALE_LOOSE = 25000;      // peer with no live connection considered gone after this
  const COLORS = ['#7b61ff', '#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#00a8fc', '#1abc9c', '#e67e22', '#9b59b6'];

  const AV_DEFAULTS = { camQ: '720', camFps: 30, ssQ: '1080', ssFps: 30, sendBr: 2500, recvBr: 0 };
  const CAM_Q = { '360': 2, '720': 1, '1080': 0 };
  const SS_Q = { '720': 1, '1080': 0, '1440': -3 };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => Date.now();

  // Optional ?as=name gives a separate identity/storage in the same browser (handy for testing).
  const PROFILE = (new URLSearchParams(location.search).get('as') || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 20);
  const PREFIX = 'dischord.' + (PROFILE ? 'p_' + PROFILE + '.' : '');
  const store = {
    get(k, d) { try { const v = localStorage.getItem(PREFIX + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { } },
    del(k) { try { localStorage.removeItem(PREFIX + k); } catch { } },
  };

  function rid(n = 10) {
    const a = 'abcdefghijkmnpqrstuvwxyz23456789';
    let s = '';
    for (const x of crypto.getRandomValues(new Uint8Array(n))) s += a[x % a.length];
    return s;
  }

  const b64e = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64d = (str) => JSON.parse(decodeURIComponent(escape(atob(str.replace(/-/g, '+').replace(/_/g, '/')))));

  // ---------------------------------------------------------------- icons (inline SVG)
  const P = {
    mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/>',
    micOff: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/><path class="slash" d="M4 4l16 16"/>',
    headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="7" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="7" rx="1.5"/>',
    deaf: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="7" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="7" rx="1.5"/><path class="slash" d="M4 4l16 16"/>',
    camera: '<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="M15.5 10.5l6-3.5v10l-6-3.5z"/>',
    cameraOff: '<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="M15.5 10.5l6-3.5v10l-6-3.5z"/><path class="slash" d="M3 3l18 18"/>',
    screen: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    hangup: '<path fill="currentColor" stroke="none" d="M12 9c-2.4 0-4.7.5-6.8 1.4-.7.3-1.2 1-1.2 1.8v2.3c0 .8.8 1.4 1.6 1.2l2.8-.7c.6-.2 1-.7 1-1.3v-1.6a11 11 0 0 1 5.2 0v1.6c0 .6.4 1.1 1 1.3l2.8.7c.8.2 1.6-.4 1.6-1.2v-2.3c0-.8-.5-1.5-1.2-1.8C16.7 9.5 14.4 9 12 9z"/>',
    speaker: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
    hash: '<path d="M5 9h15M4 15h15M10 3L8 21M16 3l-2 18"/>',
    users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4.2a4 4 0 0 1 0 7.6M22 21a7 7 0 0 0-4-6.3"/>',
    userPlus: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
    signal: '<path d="M4 20v-3M9 20v-7M14 20V9M19 20V4"/>',
    live: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><circle cx="12" cy="10.5" r="2" fill="currentColor"/>',
  };
  const icon = (name, cls = '') => `<svg class="ico-svg ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  function paintIcons(root = document) {
    root.querySelectorAll('i[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });
  }
  function setIcon(btn, name) {
    const svg = btn.querySelector('svg');
    if (svg) svg.innerHTML = P[name] || '';
  }

  // ---------------------------------------------------------------- state
  let me = store.get('me', null);
  let servers = store.get('servers', []);
  let reads = store.get('reads', {});
  let lastChan = store.get('lastChan', {});
  let av = { ...AV_DEFAULTS, ...store.get('av', {}) };
  const cur = { sid: store.get('lastSid', null), cid: null };
  const msgs = {};       // sid -> { cid: [msg] }
  const known = {};      // sid -> { userId: user }   (persisted)
  const members = {};    // sid -> { userId: { user, vc, vs, st, seen, uuids:Set } }
  const peers = {};      // sid -> Map(uuid -> { uid, rx, helloAt })
  const typing = {};     // sid/cid -> { userId: { name, until } }
  const meshes = {};     // sid -> { iframe }
  const speaking = {};   // userId -> until ts
  let voice = null;      // { sid, cid, iframe, cam, ss, vs }
  let micOn = store.get('micOn', true), deaf = store.get('deaf', false);
  let membersOpen = store.get('membersOpen', true);

  const server = (sid) => servers.find((s) => s.id === sid);
  const channel = (s, cid) => s && s.channels.find((c) => c.id === cid);
  const saveServers = () => store.set('servers', servers);

  function getMsgs(sid) {
    if (!msgs[sid]) msgs[sid] = store.get('msgs.' + sid, {});
    return msgs[sid];
  }
  const saveTimers = {};
  function saveMsgs(sid) {
    clearTimeout(saveTimers[sid]);
    saveTimers[sid] = setTimeout(() => store.set('msgs.' + sid, msgs[sid] || {}), 400);
  }
  function getKnown(sid) {
    if (!known[sid]) known[sid] = store.get('known.' + sid, {});
    return known[sid];
  }

  // ---------------------------------------------------------------- validation
  const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
  const isId = (v) => typeof v === 'string' && /^[a-z0-9]{1,24}$/i.test(v);

  function cleanUser(u) {
    if (!u || !isId(u.id) || !isStr(u.name, 32)) return null;
    const color = typeof u.color === 'string' && /^#[0-9a-f]{6}$/i.test(u.color) ? u.color : COLORS[0];
    return { id: u.id, name: u.name.trim().slice(0, 32) || 'anon', color };
  }
  function cleanMsg(m) {
    if (!m || !isStr(m.id, 64) || !isId(m.cid) || typeof m.ts !== 'number') return null;
    const a = cleanUser(m.a);
    if (!a) return null;
    if (m.del) return { id: m.id, cid: m.cid, ts: m.ts, a, del: true, text: '' };
    if (typeof m.text !== 'string' || !m.text.length || m.text.length > 4000) return null;
    return { id: m.id, cid: m.cid, ts: Math.min(m.ts, now() + 60000), a, text: m.text, ed: m.ed ? 1 : undefined };
  }
  function cleanServerDef(d) {
    if (!d || !isId(d.id) || !isStr(d.name, 64) || !Array.isArray(d.channels) || typeof d.v !== 'number') return null;
    const channels = d.channels.slice(0, 60).filter((c) => c && isId(c.id) && isStr(c.name, 40) && (c.type === 'text' || c.type === 'voice'))
      .map((c) => ({ id: c.id, name: c.name, type: c.type }));
    return { id: d.id, name: d.name, channels, v: d.v };
  }
  function cleanState(st) {
    st = st && typeof st === 'object' ? st : {};
    return { m: !!st.m, d: !!st.d, c: !!st.c, s: !!st.s };
  }

  // ---------------------------------------------------------------- mesh (hidden VDO.Ninja rooms)
  const roomFor = (s, suffix = '') => 'dischord' + s.id + suffix;

  function meshUrl(s) {
    const p = new URLSearchParams({ room: roomFor(s), password: s.key, label: me.name });
    // &datamode discovers peers but never connects them in rooms; a no-camera/no-mic guest does.
    return VDO + '?' + p.toString() + '&videodevice=0&audiodevice=0&webcam&autostart&cleanoutput';
  }

  function connectMesh(s) {
    if (meshes[s.id] || !me) return;
    const f = document.createElement('iframe');
    f.src = meshUrl(s);
    f.title = 'mesh-' + s.id;
    $('meshHost').appendChild(f);
    meshes[s.id] = { iframe: f };
    peers[s.id] = peers[s.id] || new Map();
  }
  function disconnectMesh(sid) {
    const m = meshes[sid];
    if (!m) return;
    try { send(sid, { t: 'bye' }); } catch { }
    setTimeout(() => m.iframe.remove(), 200);
    delete meshes[sid];
    peers[sid] = new Map();
  }

  const myVoiceIn = (sid) => (voice && voice.sid === sid ? voice.cid : null);
  const myState = () => ({ m: !micOn || deaf, d: deaf, c: !!(voice && voice.cam), s: !!(voice && voice.ss) });

  // Every payload carries who I am and my voice state, so presence is never stale.
  function send(sid, payload, uuid) {
    const m = meshes[sid];
    if (!m || !m.iframe.contentWindow) return;
    const body = { v: PROTO, u: me, vc: myVoiceIn(sid), vs: myVoiceIn(sid) ? voice.vs : null, st: myState(), ...payload };
    const o = { sendData: { dischord: body } };
    if (uuid) o.UUID = uuid;
    m.iframe.contentWindow.postMessage(o, '*');
  }
  const broadcastState = () => { for (const sid in meshes) send(sid, { t: 'ping' }); };

  function hello(sid, uuid, want) {
    const s = server(sid);
    if (!s) return;
    send(sid, { t: 'hello', want: !!want, s: { id: s.id, name: s.name, channels: s.channels, v: s.v } }, uuid);
  }

  // Greet a newly connected peer, retrying until we hear back (the data channel can lag the event).
  function greet(sid, uuid) {
    const map = peers[sid];
    if (!map) return;
    const p = map.get(uuid) || { uid: null, rx: 0, helloAt: 0 };
    map.set(uuid, p);
    const delays = [0, 700, 1800, 4000, 8000, 15000];
    delays.forEach((d) => setTimeout(() => {
      const q = peers[sid] && peers[sid].get(uuid);
      if (q && !q.rx) hello(sid, uuid, true);
    }, d));
  }

  function peerGone(sid, uuid) {
    const map = peers[sid];
    if (!map) return;
    const p = map.get(uuid);
    map.delete(uuid);
    const m = p && p.uid && members[sid] && members[sid][p.uid];
    if (m) {
      m.uuids.delete(uuid);
      if (!m.uuids.size) m.seen = 0;
    }
    if (sid === cur.sid) renderPresence();
  }

  function sendHistory(sid, uuid) {
    const all = getMsgs(sid);
    for (const cid in all) {
      const list = all[cid].slice(-HIST_SEND);
      for (let i = 0; i < list.length; i += 15) send(sid, { t: 'hist', ms: list.slice(i, i + 15) }, uuid);
    }
  }

  function isOnline(m) {
    if (!m || !m.seen) return false;
    return now() - m.seen < (m.uuids && m.uuids.size ? STALE_CONNECTED : STALE_LOOSE);
  }

  function touch(sid, body, uuid) {
    const user = cleanUser(body.u);
    if (!user || user.id === me.id) return null;
    const ms = (members[sid] = members[sid] || {});
    const prev = ms[user.id];
    const wasOnline = isOnline(prev);
    const m = prev || { uuids: new Set() };
    m.user = user;
    m.vc = isId(body.vc) ? body.vc : null;
    m.vs = m.vc && isId(body.vs) ? body.vs : null;
    m.st = cleanState(body.st);
    m.seen = now();
    if (uuid) m.uuids.add(uuid);
    ms[user.id] = m;
    const k = getKnown(sid);
    if (!k[user.id] || k[user.id].name !== user.name || k[user.id].color !== user.color) {
      k[user.id] = user;
      store.set('known.' + sid, k);
    }
    return { user, wasOnline };
  }

  function onPeerData(sid, p, uuid) {
    if (!p || typeof p !== 'object' || !p.u) return;
    const s = server(sid);
    if (!s) return;
    const t = touch(sid, p, uuid);
    if (!t) return;

    // first packet from this connection: make sure both sides know each other + have history
    if (uuid && peers[sid]) {
      const map = peers[sid];
      const pr = map.get(uuid) || { uid: null, rx: 0, helloAt: 0 };
      const first = !pr.rx;
      pr.rx = now(); pr.uid = t.user.id;
      map.set(uuid, pr);
      if (first) {
        sendHistory(sid, uuid);
        if (p.t !== 'hello' || p.want) { hello(sid, uuid, false); pr.helloAt = now(); }
      } else if (p.t === 'hello' && p.want && now() - pr.helloAt > 1500) {
        hello(sid, uuid, false); pr.helloAt = now();
      }
    }

    switch (p.t) {
      case 'hello':
      case 'server':
        mergeServer(sid, p.s);
        break;
      case 'msg': {
        const msg = cleanMsg(p.m);
        if (msg && msg.a.id === t.user.id && addMsg(sid, msg)) onNewMsg(sid, msg);
        break;
      }
      case 'hist': {
        if (!Array.isArray(p.ms)) break;
        let changed = false;
        for (const raw of p.ms.slice(0, 50)) {
          const msg = cleanMsg(raw);
          if (msg && addMsg(sid, msg)) changed = true;
        }
        if (changed) { if (sid === cur.sid) renderMessages(); renderRail(); if (sid === cur.sid) renderChannels(); }
        break;
      }
      case 'del':
      case 'edit': {
        const msg = cleanMsg(p.m);
        if (msg && msg.a.id === t.user.id && addMsg(sid, msg)) renderIfCurrent(sid, msg.cid);
        break;
      }
      case 'typing':
        if (isId(p.cid)) {
          const k = sid + '/' + p.cid;
          typing[k] = typing[k] || {};
          typing[k][t.user.id] = { name: t.user.name, until: now() + 6000 };
          renderTyping();
        }
        break;
      case 'bye': {
        const m = members[sid][t.user.id];
        if (m) { m.seen = 0; m.uuids.clear(); }
        break;
      }
    }
    if (sid === cur.sid) renderPresence();
  }

  function mergeServer(sid, def) {
    const d = cleanServerDef(def);
    const s = server(sid);
    if (!d || !s || d.id !== sid || d.v <= s.v) return;
    s.name = d.name; s.channels = d.channels; s.v = d.v;
    saveServers();
    if (voice && voice.sid === sid && !channel(s, voice.cid)) leaveVoice();
    if (cur.sid === sid && !channel(s, cur.cid)) cur.cid = (s.channels.find((c) => c.type === 'text') || s.channels[0] || {}).id || null;
    render();
  }

  function bumpServer(s) {
    s.v = now();
    saveServers();
    send(s.id, { t: 'server', s: { id: s.id, name: s.name, channels: s.channels, v: s.v } });
    render();
  }

  // ---------------------------------------------------------------- messages
  function addMsg(sid, m) {
    const all = getMsgs(sid);
    const list = (all[m.cid] = all[m.cid] || []);
    const i = list.findIndex((x) => x.id === m.id);
    if (i >= 0) {
      const old = list[i];
      if (old.del) return false;
      if (m.del) { list[i] = m; saveMsgs(sid); return true; }
      if (m.ed && m.text !== old.text) { list[i] = m; saveMsgs(sid); return true; }
      return false;
    }
    let j = list.length;
    while (j > 0 && list[j - 1].ts > m.ts) j--;
    list.splice(j, 0, m);
    if (list.length > MAX_MSGS) list.splice(0, list.length - MAX_MSGS);
    saveMsgs(sid);
    return true;
  }

  function onNewMsg(sid, m) {
    const k = sid + '/' + m.cid;
    if (typing[k]) delete typing[k][m.a.id];
    const viewing = sid === cur.sid && m.cid === cur.cid;
    if (viewing && !document.hidden) markRead(sid, m.cid);
    if (!viewing || document.hidden) notify(sid, m);
    if (viewing) { renderMessages(); renderTyping(); }
    renderRail();
    if (sid === cur.sid) renderChannels();
  }

  function sendMessage(text) {
    const s = server(cur.sid);
    if (!s || !cur.cid) return;
    text = text.replace(/\s+$/, '').replace(/^\n+/, '');
    if (!text) return;
    if (text.length > 4000) { toast('Message is too long (4000 characters max).'); return; }
    const m = { id: me.id + rid(8), cid: cur.cid, ts: now(), a: me, text };
    addMsg(s.id, m);
    markRead(s.id, cur.cid);
    send(s.id, { t: 'msg', m });
    lastTypingSent = 0;
    renderMessages(true);
  }

  function deleteMessage(id) {
    const list = getMsgs(cur.sid)[cur.cid] || [];
    const m = list.find((x) => x.id === id);
    if (!m || m.a.id !== me.id) return;
    const d = { id: m.id, cid: m.cid, ts: m.ts, a: me, del: true, text: '' };
    addMsg(cur.sid, d);
    send(cur.sid, { t: 'del', m: d });
    renderMessages();
  }

  function editMessage(id) {
    const list = getMsgs(cur.sid)[cur.cid] || [];
    const m = list.find((x) => x.id === id);
    if (!m || m.a.id !== me.id) return;
    modal(`<h2>Edit message</h2>
      <textarea id="mEdit" rows="4" maxlength="4000">${esc(m.text)}</textarea>
      <div class="actions"><button class="btn link" data-close>Cancel</button><button class="btn primary" id="mOk">Save</button></div>`, () => {
      const ta = $('mEdit');
      ta.focus();
      $('mOk').onclick = () => {
        const text = ta.value.trim();
        if (!text) return;
        const e = { ...m, text, ed: 1 };
        addMsg(cur.sid, e);
        send(cur.sid, { t: 'edit', m: e });
        closeModal();
        renderMessages();
      };
    });
  }

  function markRead(sid, cid) {
    const list = getMsgs(sid)[cid] || [];
    const last = list.length ? list[list.length - 1].ts : 0;
    const k = sid + '/' + cid;
    if ((reads[k] || 0) < last) { reads[k] = last; store.set('reads', reads); }
  }
  function unreadCount(sid, cid) {
    const r = reads[sid + '/' + cid] || 0;
    const list = getMsgs(sid)[cid] || [];
    let n = 0;
    for (let i = list.length - 1; i >= 0 && list[i].ts > r; i--) if (!list[i].del && me && list[i].a.id !== me.id) n++;
    return n;
  }
  const serverUnread = (s) => s.channels.some((c) => c.type === 'text' && unreadCount(s.id, c.id) > 0);

  let lastTypingSent = 0;
  function sendTyping() {
    if (now() - lastTypingSent < 2500) return;
    lastTypingSent = now();
    send(cur.sid, { t: 'typing', cid: cur.cid });
  }

  function notify(sid, m) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    const s = server(sid), c = channel(s, m.cid);
    if (!s || !c) return;
    try {
      const n = new Notification(`${m.a.name} (#${c.name}, ${s.name})`, { body: m.text.slice(0, 200), tag: sid + m.cid });
      n.onclick = () => { window.focus(); selectServer(sid); selectChannel(m.cid); };
    } catch { }
  }

  // ---------------------------------------------------------------- voice
  function voiceUrl(s, c, withCam, vs) {
    const p = new URLSearchParams({ room: roomFor(s, 'v' + c.id), password: s.key, label: me.name, push: vs });
    let u = VDO + '?' + p.toString();
    u += '&autostart&webcam&nocontrolbar&hideheader&showlabels&chatbutton=false&nohangupbutton';
    u += withCam ? `&quality=${CAM_Q[av.camQ] ?? 1}&maxframerate=${av.camFps}` : '&videodevice=0';
    u += `&screensharequality=${SS_Q[av.ssQ] ?? 0}&screensharefps=${av.ssFps}`;
    u += `&maxvideobitrate=${av.sendBr}&roombitrate=${av.sendBr}`;
    if (av.recvBr) u += `&bitrate=${av.recvBr}`;
    if (!micOn || deaf) u += '&mute';
    return u;
  }

  function joinVoice(sid, cid, withCam) {
    const s = server(sid), c = channel(s, cid);
    if (!s || !c) return;
    const rejoin = voice && voice.sid === sid && voice.cid === cid;
    if (voice) dropVoiceFrame();
    const vs = 'dc' + me.id.slice(0, 10) + rid(5);
    const f = document.createElement('iframe');
    f.allow = 'autoplay; camera; microphone; display-capture; fullscreen; picture-in-picture; clipboard-write';
    // give the old connection a moment to release the camera / stream id
    setTimeout(() => { f.src = voiceUrl(s, c, withCam, vs); }, rejoin ? 500 : 0);
    $('stageFrame').appendChild(f);
    voice = { sid, cid, iframe: f, cam: !!withCam, ss: false, vs };
    f.addEventListener('load', () => {
      setTimeout(() => {
        voicePost({ getLoudness: true });
        if (deaf) voicePost({ mute: true });
      }, 2500);
    });
    broadcastState();
    if (!rejoin) playTone(true);
    render();
  }

  function dropVoiceFrame() {
    if (!voice) return;
    const f = voice.iframe;
    try { f.contentWindow.postMessage({ close: true }, '*'); } catch { }
    setTimeout(() => f.remove(), 300);
  }

  function leaveVoice() {
    if (!voice) return;
    dropVoiceFrame();
    voice = null;
    for (const k in speaking) delete speaking[k];
    broadcastState();
    playTone(false);
    render();
  }

  function voicePost(o) { if (voice && voice.iframe.contentWindow) voice.iframe.contentWindow.postMessage(o, '*'); }

  function toggleMic() {
    if (deaf) { deaf = false; voicePost({ mute: false }); micOn = true; }
    else micOn = !micOn;
    voicePost({ mic: micOn });
    store.set('micOn', micOn); store.set('deaf', deaf);
    broadcastState();
    renderControls(); renderPresence();
  }
  function toggleDeaf() {
    deaf = !deaf;
    voicePost({ mute: deaf });
    voicePost({ mic: deaf ? false : micOn });
    store.set('deaf', deaf);
    broadcastState();
    renderControls(); renderPresence();
  }
  function toggleCam() {
    if (!voice) return;
    joinVoice(voice.sid, voice.cid, !voice.cam); // rejoin so the camera is truly released when off
  }
  function toggleShare() {
    if (!voice) return;
    voicePost({ function: 'commands', action: 'togglescreenshare' });
    showVoice();
  }
  function showVoice() { if (voice) { if (cur.sid !== voice.sid) selectServer(voice.sid); selectChannel(voice.cid); } }

  let audioCtx;
  function playTone(up) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine';
      const t = audioCtx.currentTime;
      o.frequency.setValueAtTime(up ? 520 : 780, t);
      o.frequency.linearRampToValueAtTime(up ? 780 : 520, t + 0.15);
      g.gain.setValueAtTime(0.08, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(); o.stop(t + 0.26);
    } catch { }
  }

  // loudness from VDO.Ninja is keyed by stream id; map it back to users
  function onLoudness(obj) {
    if (!obj || typeof obj !== 'object' || !voice) return;
    const ms = members[voice.sid] || {};
    const byVs = {};
    for (const id in ms) if (ms[id].vs) byVs[ms[id].vs] = id;
    let changed = false;
    for (const key in obj) {
      const uid = byVs[key];
      const level = +obj[key];
      if (uid && level > 5) { if (!(speaking[uid] > now())) changed = true; speaking[uid] = now() + 500; }
    }
    if (changed) paintSpeaking();
  }
  function paintSpeaking() {
    document.querySelectorAll('[data-uid]').forEach((el) => el.classList.toggle('speaking', speaking[el.dataset.uid] > now()));
  }

  // ---------------------------------------------------------------- iframe API listener
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;

    if (voice && e.source === voice.iframe.contentWindow) {
      if (d.action === 'screen-share-state') { voice.ss = !!d.value; broadcastState(); renderControls(); renderPresence(); }
      if (d.loudness) onLoudness(d.loudness);
      return;
    }

    let sid = null;
    for (const id in meshes) if (meshes[id].iframe.contentWindow === e.source) { sid = id; break; }
    if (!sid) return;

    if (d.dataReceived && d.dataReceived.dischord) {
      onPeerData(sid, d.dataReceived.dischord, d.UUID);
      return;
    }
    if (d.action && d.UUID) {
      const a = d.action;
      const up = ['push-connection', 'view-connection', 'new-push-connection', 'new-view-connection', 'guest-connected'].includes(a) && d.value !== false;
      const down = a === 'end-view-connection' || ((a === 'push-connection' || a === 'view-connection') && d.value === false);
      if (up) greet(sid, d.UUID);
      else if (down) peerGone(sid, d.UUID);
    }
  });

  // ---------------------------------------------------------------- navigation
  function selectServer(sid) {
    cur.sid = sid;
    store.set('lastSid', sid);
    const s = server(sid);
    if (s) {
      const want = lastChan[sid];
      const firstText = s.channels.find((c) => c.type === 'text');
      cur.cid = channel(s, want) ? want : (firstText || s.channels[0] || {}).id || null;
    } else cur.cid = null;
    render();
    if (cur.cid) afterChannelSelect();
  }
  function selectChannel(cid) {
    cur.cid = cid;
    lastChan[cur.sid] = cid;
    store.set('lastChan', lastChan);
    render();
    afterChannelSelect();
  }
  function afterChannelSelect() {
    const c = channel(server(cur.sid), cur.cid);
    if (c && c.type === 'text') {
      markRead(cur.sid, cur.cid);
      renderRail(); renderChannels();
      renderMessages(true);
      if (matchMedia('(pointer:fine)').matches) $('msgInput').focus();
    }
  }

  // ---------------------------------------------------------------- servers
  function createServer(name) {
    const s = {
      id: rid(10), key: rid(16), name: name.slice(0, 64), v: now(),
      channels: [
        { id: rid(6), name: 'general', type: 'text' },
        { id: rid(6), name: 'off-topic', type: 'text' },
        { id: rid(6), name: 'General', type: 'voice' },
        { id: rid(6), name: 'Gaming', type: 'voice' },
      ],
    };
    servers.push(s);
    saveServers();
    connectMesh(s);
    selectServer(s.id);
    return s;
  }

  function inviteCode(s) { return b64e({ i: s.id, k: s.key, n: s.name, c: s.channels, v: s.v }); }
  function inviteLink(s) { return location.origin + location.pathname + '#invite=' + inviteCode(s); }

  function joinFromInvite(input) {
    let code = String(input || '').trim();
    const m = code.match(/invite=([A-Za-z0-9_-]+)/);
    if (m) code = m[1];
    let d;
    try { d = b64d(code); } catch { return toast('That invite link doesn\'t look right.'); }
    const def = cleanServerDef({ id: d.i, name: d.n, channels: d.c, v: d.v });
    if (!def || !isStr(d.k, 64)) return toast('That invite link doesn\'t look right.');
    let s = server(def.id);
    if (!s) {
      s = { ...def, key: d.k };
      servers.push(s);
      saveServers();
      toast(`Joined ${s.name}`);
    }
    if (me) connectMesh(s);
    selectServer(s.id);
    return true;
  }

  function leaveServer(sid) {
    if (voice && voice.sid === sid) leaveVoice();
    disconnectMesh(sid);
    servers = servers.filter((s) => s.id !== sid);
    saveServers();
    store.del('msgs.' + sid); store.del('known.' + sid);
    delete msgs[sid]; delete members[sid];
    selectServer(servers[0] ? servers[0].id : null);
  }

  // ---------------------------------------------------------------- rendering
  const initials = (n) => (n.match(/\b\p{L}|\p{N}/gu) || [n[0] || '?']).slice(0, 2).join('').toUpperCase();
  const avatar = (u, dot, cls = '') => `<div class="avatar ${cls}" style="background:${esc(u.color)}">${esc((u.name[0] || '?').toUpperCase())}${dot ? '<span class="dot"></span>' : ''}</div>`;
  const stateIcons = (st) => (st ? (st.s ? '<span class="live-tag">LIVE</span>' : '') + (st.c ? icon('camera', 'mini') : '') + (st.d ? icon('deaf', 'mini off') : st.m ? icon('micOff', 'mini off') : '') : '');

  function render() {
    if (!me) return;
    renderRail();
    renderHeader();
    renderChannels();
    renderMain();
    renderMembers();
    renderUserPanel();
    renderControls();
  }
  function renderPresence() { renderChannels(); renderMembers(); renderUserPanel(); renderVoiceIdle(); }

  function renderRail() {
    if (!me) return;
    $('serverList').innerHTML = servers.map((s) =>
      `<button class="rail-btn ${s.id === cur.sid ? 'active' : ''} ${serverUnread(s) && s.id !== cur.sid ? 'unread' : ''} ${voice && voice.sid === s.id ? 'in-voice' : ''}" data-sid="${esc(s.id)}" title="${esc(s.name)}">${esc(initials(s.name))}</button>`).join('');
    $('homeBtn').classList.toggle('active', !cur.sid);
    let total = 0;
    for (const s of servers) for (const c of s.channels) if (c.type === 'text') total += unreadCount(s.id, c.id);
    document.title = (total ? `(${total}) ` : '') + 'Dischord';
  }

  function renderHeader() {
    const s = server(cur.sid);
    $('serverName').textContent = s ? s.name : 'Dischord';
    $('serverMenuBtn').classList.toggle('hidden', !s);
  }

  function voiceOccupants(sid, cid) {
    const out = [];
    if (voice && voice.sid === sid && voice.cid === cid) out.push({ user: me, st: myState(), self: true });
    const ms = members[sid] || {};
    for (const id in ms) if (isOnline(ms[id]) && ms[id].vc === cid) out.push({ user: ms[id].user, st: ms[id].st });
    return out;
  }

  function renderChannels() {
    if (!me) return;
    const s = server(cur.sid);
    const el = $('channelList');
    if (!s) {
      el.innerHTML = `<div class="cat"><span>Your servers</span></div>` + (servers.length
        ? servers.map((x) => `<div class="chan" data-sid="${esc(x.id)}"><span class="ico">${icon('hash')}</span><span class="name">${esc(x.name)}</span></div>`).join('')
        : `<div class="chan" style="cursor:default">No servers yet</div>`);
      return;
    }
    const text = s.channels.filter((c) => c.type === 'text');
    const vc = s.channels.filter((c) => c.type === 'voice');
    let h = `<div class="cat"><span>Text channels</span><button class="icon-btn" data-add="text" title="Create channel">${icon('plus')}</button></div>`;
    for (const c of text) {
      const n = c.id === cur.cid ? 0 : unreadCount(s.id, c.id);
      h += `<div class="chan ${c.id === cur.cid ? 'active' : ''} ${n ? 'unread' : ''}" data-cid="${esc(c.id)}">
        <span class="ico">${icon('hash')}</span><span class="name">${esc(c.name)}</span>
        ${n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : ''}
        <button class="icon-btn del" data-delc="${esc(c.id)}" title="Delete channel">${icon('trash')}</button></div>`;
    }
    h += `<div class="cat"><span>Voice channels</span><button class="icon-btn" data-add="voice" title="Create channel">${icon('plus')}</button></div>`;
    for (const c of vc) {
      const who = voiceOccupants(s.id, c.id);
      const mine = voice && voice.sid === s.id && voice.cid === c.id;
      h += `<div class="chan ${c.id === cur.cid ? 'active' : ''} ${mine ? 'connected' : ''}" data-cid="${esc(c.id)}">
        <span class="ico">${icon('speaker')}</span><span class="name">${esc(c.name)}</span>
        ${who.length ? `<span class="count">${who.length}</span>` : ''}
        <button class="icon-btn del" data-delc="${esc(c.id)}" title="Delete channel">${icon('trash')}</button></div>`;
      if (who.length) {
        h += `<div class="voice-users">${who.map((o) => `<div class="voice-user" data-uid="${esc(o.self ? me.id : o.user.id)}">${avatar(o.user)}<span class="vu-name">${esc(o.user.name)}</span><span class="vu-icons">${stateIcons(o.st)}</span></div>`).join('')}</div>`;
      }
    }
    el.innerHTML = h;
    paintSpeaking();
  }

  function renderMain() {
    const s = server(cur.sid);
    const c = channel(s, cur.cid);
    $('welcome').classList.toggle('hidden', !!c);
    $('textView').classList.toggle('hidden', !c || c.type !== 'text');
    $('voiceView').classList.toggle('hidden', !c || c.type !== 'voice');
    const inThisVoice = !!(voice && c && voice.sid === cur.sid && voice.cid === c.id);
    $('voiceStage').classList.toggle('offstage', !inThisVoice);
    $('voiceStage').classList.toggle('hidden', !voice);
    $('mainHeader').classList.toggle('hidden', !c);
    $('voiceView').classList.toggle('behind', inThisVoice);

    if (!c) return;
    $('chanIcon').innerHTML = icon(c.type === 'text' ? 'hash' : 'speaker');
    $('chanName').textContent = c.name;
    $('chanTopic').textContent = c.type === 'voice' ? 'Voice & video, peer-to-peer' : '';
    if (c.type === 'text') {
      $('msgInput').placeholder = `Message #${c.name}`;
      renderMessages();
      renderTyping();
    } else renderVoiceIdle();
  }

  function renderVoiceIdle() {
    const s = server(cur.sid), c = channel(s, cur.cid);
    if (!c || c.type !== 'voice') return;
    const who = voiceOccupants(s.id, c.id);
    $('voiceIdleTitle').textContent = c.name;
    $('voiceIdleWho').innerHTML = who.length
      ? `<div class="vi-people">${who.map((o) => `<div class="vi-person" data-uid="${esc(o.user.id)}">${avatar(o.user, false, 'big')}<span>${esc(o.user.name)}</span></div>`).join('')}</div>`
      : '<p>No one is here yet. Jump in and others will see you in the channel list.</p>';
  }

  function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function fmtStamp(ts) {
    const d = new Date(ts), t = new Date();
    const y = new Date(t); y.setDate(t.getDate() - 1);
    if (d.toDateString() === t.toDateString()) return 'Today at ' + fmtTime(ts);
    if (d.toDateString() === y.toDateString()) return 'Yesterday at ' + fmtTime(ts);
    return d.toLocaleDateString() + ' ' + fmtTime(ts);
  }

  function formatText(raw) {
    const blocks = [];
    let t = esc(raw).replace(/```(?:[a-z0-9]+\n)?([\s\S]*?)```/gi, (_, code) => { blocks.push(`<pre>${code}</pre>`); return `\u0000${blocks.length - 1}\u0000`; });
    t = t.replace(/`([^`\n]+)`/g, (_, code) => { blocks.push(`<code>${code}</code>`); return `\u0000${blocks.length - 1}\u0000`; });
    t = t
      .replace(/\b(https?:\/\/[^\s<]+[^\s<.,:;!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/__([^_\n]+)__/g, '<u>$1</u>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
      .replace(/(^|\s)(@[\p{L}\p{N}_.-]{1,32})/gu, '$1<span class="mention">$2</span>');
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  }

  function renderMessages(forceBottom) {
    const box = $('messages');
    const s = server(cur.sid), c = channel(s, cur.cid);
    if (!c || c.type !== 'text') return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const list = (getMsgs(s.id)[c.id] || []).filter((m) => !m.del);
    let h = `<div class="chan-intro"><div class="big">${icon('hash')}</div><h2>Welcome to #${esc(c.name)}!</h2><p>This is the start of the #${esc(c.name)} channel. Messages travel peer-to-peer; people who join later get recent history from whoever is online.</p></div>`;
    let prev = null;
    for (const m of list) {
      const newDay = !prev || new Date(prev.ts).toDateString() !== new Date(m.ts).toDateString();
      if (newDay) h += `<div class="day-sep"><span>${new Date(m.ts).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })}</span></div>`;
      const head = newDay || !prev || prev.a.id !== m.a.id || m.ts - prev.ts > 7 * 60000;
      const mine = m.a.id === me.id;
      const acts = mine ? `<div class="actions"><button class="icon-btn" data-edit="${esc(m.id)}" title="Edit">${icon('edit')}</button><button class="icon-btn danger" data-del="${esc(m.id)}" title="Delete">${icon('trash')}</button></div>` : '';
      const edited = m.ed ? ' <span class="time">(edited)</span>' : '';
      if (head) {
        h += `<div class="msg head"><div class="gutter">${avatar(m.a)}</div><div class="body">
          <div class="meta"><span class="author" style="color:${esc(m.a.color)}">${esc(m.a.name)}</span><span class="time" title="${esc(new Date(m.ts).toLocaleString())}">${esc(fmtStamp(m.ts))}</span></div>
          <div class="text">${formatText(m.text)}${edited}</div></div>${acts}</div>`;
      } else {
        h += `<div class="msg"><div class="gutter time-side">${esc(fmtTime(m.ts))}</div><div class="body"><div class="text">${formatText(m.text)}${edited}</div></div>${acts}</div>`;
      }
      prev = m;
    }
    box.innerHTML = h;
    if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
  }

  function renderIfCurrent(sid, cid) { if (sid === cur.sid && cid === cur.cid) renderMessages(); }

  function renderTyping() {
    const k = cur.sid + '/' + cur.cid;
    const t = typing[k] || {};
    const names = Object.values(t).filter((x) => x.until > now()).map((x) => x.name);
    $('typing').innerHTML = !names.length ? '' :
      `<span class="dots"><i></i><i></i><i></i></span><b>${names.slice(0, 3).map(esc).join(', ')}</b> ${names.length === 1 ? 'is' : 'are'} typing…`;
  }

  function renderMembers() {
    if (!me) return;
    const el = $('members');
    const s = server(cur.sid);
    el.classList.toggle('collapsed', !s || !membersOpen);
    if (!s) return;
    const ms = members[s.id] || {};
    const k = getKnown(s.id);
    const ids = new Set([...Object.keys(k), ...Object.keys(ms)]);
    const online = [{ user: me, vc: myVoiceIn(s.id), st: myState(), self: true }];
    const offline = [];
    for (const id of ids) {
      if (id === me.id) continue;
      const m = ms[id];
      if (isOnline(m)) online.push(m); else offline.push({ user: (m && m.user) || k[id] });
    }
    online.sort((a, b) => (a.self ? -1 : b.self ? 1 : a.user.name.localeCompare(b.user.name)));
    offline.sort((a, b) => a.user.name.localeCompare(b.user.name));
    const vname = (cid) => { const c = channel(s, cid); return c ? c.name : ''; };
    const row = (m, on) => `<div class="mem ${on ? '' : 'offline'}" data-uid="${esc(m.user.id)}">${avatar(m.user, true)}<div class="mem-text"><div class="nm" style="color:${on ? esc(m.user.color) : 'inherit'}">${esc(m.user.name)}${m.self ? ' <span class="sub">(you)</span>' : ''}</div>${on && m.vc ? `<div class="sub">${icon('speaker', 'mini')} ${esc(vname(m.vc))}</div>` : ''}</div><span class="vu-icons">${on && m.vc ? stateIcons(m.st) : ''}</span></div>`;
    el.innerHTML = `<div class="mem-cat">Online — ${online.length}</div>${online.map((m) => row(m, true)).join('')}` +
      (offline.length ? `<div class="mem-cat" style="margin-top:20px">Offline — ${offline.length}</div>${offline.map((m) => row(m, false)).join('')}` : '');
    paintSpeaking();
  }

  function renderUserPanel() {
    if (!me) return;
    $('meAvatar').outerHTML = `<div class="avatar" id="meAvatar" style="background:${esc(me.color)}">${esc(me.name[0].toUpperCase())}<span class="dot"></span></div>`;
    $('meName').textContent = me.name;
    let peersN = 0;
    if (cur.sid) for (const id in members[cur.sid] || {}) if (isOnline(members[cur.sid][id])) peersN++;
    $('meStatus').textContent = cur.sid ? (peersN ? `${peersN} other${peersN === 1 ? '' : 's'} online` : 'Waiting for others…') : 'Online';
    $('voiceStatus').classList.toggle('hidden', !voice);
    if (voice) {
      const s = server(voice.sid), c = channel(s, voice.cid);
      $('voiceWhere').textContent = c ? `${c.name} / ${s.name}` : '';
    }
  }

  function renderControls() {
    const muted = !micOn || deaf;
    for (const id of ['micBtn', 'cbMic']) { const b = $(id); setIcon(b, muted ? 'micOff' : 'mic'); b.classList.toggle('off', muted); b.title = muted ? 'Unmute' : 'Mute'; }
    for (const id of ['deafBtn', 'cbDeaf']) { const b = $(id); setIcon(b, deaf ? 'deaf' : 'headphones'); b.classList.toggle('off', deaf); b.title = deaf ? 'Undeafen' : 'Deafen'; }
    const cam = !!(voice && voice.cam), ss = !!(voice && voice.ss);
    setIcon($('cbCam'), cam ? 'camera' : 'cameraOff');
    $('cbCam').classList.toggle('on', cam); $('cbCam').title = cam ? 'Turn off camera' : 'Turn on camera';
    $('cbShare').classList.toggle('on', ss); $('cbShare').title = ss ? 'Stop sharing' : 'Share your screen';
    $('vsCam').classList.toggle('on', cam); $('vsShare').classList.toggle('on', ss);
  }

  // ---------------------------------------------------------------- modals
  function modal(html, mount, dismissable = true, wide = false) {
    $('modal').innerHTML = html;
    $('modal').classList.toggle('wide', wide);
    $('modalBack').classList.remove('hidden');
    $('modalBack').dataset.dismiss = dismissable ? '1' : '';
    $('modal').querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeModal));
    paintIcons($('modal'));
    if (mount) mount();
  }
  function closeModal() { $('modalBack').classList.add('hidden'); $('modal').innerHTML = ''; }
  $('modalBack').addEventListener('mousedown', (e) => { if (e.target === $('modalBack') && $('modalBack').dataset.dismiss) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('modalBack').dataset.dismiss) closeModal(); });

  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toast.tm);
    toast.tm = setTimeout(() => t.classList.add('hidden'), 3000);
    return false;
  }

  function colorPicker(sel) {
    return `<div class="colors" id="mColors">${COLORS.map((c) => `<button type="button" data-color="${c}" class="${c === sel ? 'sel' : ''}" style="background:${c}"></button>`).join('')}</div>`;
  }
  function wireColors(onPick) {
    $('mColors').onclick = (e) => {
      const b = e.target.closest('[data-color]');
      if (!b) return;
      $('mColors').querySelectorAll('button').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      onPick(b.dataset.color);
    };
  }

  function profileModal(first) {
    let color = (me && me.color) || COLORS[Math.floor(Math.random() * COLORS.length)];
    modal(`<h2>Welcome to Dischord</h2>
      <p>Pick a display name. It's stored only in this browser.</p>
      <label>Display name</label><input type="text" id="mName" maxlength="32" placeholder="e.g. daniel">
      <label>Color</label>${colorPicker(color)}
      <div class="actions"><button class="btn primary" id="mOk">Continue</button></div>`, () => {
      wireColors((c) => (color = c));
      const inp = $('mName');
      inp.focus();
      const ok = () => {
        const name = inp.value.trim().slice(0, 32);
        if (!name) return inp.focus();
        me = { id: rid(12), name, color };
        store.set('me', me);
        closeModal();
        start();
      };
      $('mOk').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    }, !first);
  }

  const opt = (val, cur, label) => `<option value="${val}" ${String(val) === String(cur) ? 'selected' : ''}>${label}</option>`;

  function settingsModal(tab = 'profile') {
    let color = me.color;
    modal(`<div class="tabs"><button data-tab="profile">My profile</button><button data-tab="av">Voice &amp; Video</button></div>
      <div class="tab-body" data-body="profile">
        <label>Display name</label><input type="text" id="mName" maxlength="32" value="${esc(me.name)}">
        <label>Color</label>${colorPicker(color)}
        ${'Notification' in window && Notification.permission !== 'granted' ? '<label>Notifications</label><button class="btn" id="mNotif">Enable desktop notifications</button>' : ''}
      </div>
      <div class="tab-body" data-body="av">
        <div class="grid2">
          <div><label>Camera resolution</label><select id="aCamQ">${opt('360', av.camQ, '360p')}${opt('720', av.camQ, '720p (HD)')}${opt('1080', av.camQ, '1080p (Full HD)')}</select></div>
          <div><label>Camera frame rate</label><select id="aCamFps">${opt(15, av.camFps, '15 fps')}${opt(30, av.camFps, '30 fps')}${opt(60, av.camFps, '60 fps')}</select></div>
          <div><label>Screen share resolution</label><select id="aSsQ">${opt('720', av.ssQ, '720p')}${opt('1080', av.ssQ, '1080p')}${opt('1440', av.ssQ, '1440p')}</select></div>
          <div><label>Screen share frame rate</label><select id="aSsFps">${opt(5, av.ssFps, '5 fps (text/slides)')}${opt(15, av.ssFps, '15 fps')}${opt(30, av.ssFps, '30 fps')}${opt(60, av.ssFps, '60 fps (games)')}</select></div>
          <div><label>Upload quality (what others get)</label><select id="aSend">${opt(500, av.sendBr, 'Data saver · 0.5 Mbps')}${opt(1500, av.sendBr, 'Balanced · 1.5 Mbps')}${opt(2500, av.sendBr, 'High · 2.5 Mbps')}${opt(6000, av.sendBr, 'Ultra · 6 Mbps')}</select></div>
          <div><label>Download quality (what you get)</label><select id="aRecv">${opt(0, av.recvBr, 'Auto')}${opt(300, av.recvBr, 'Data saver')}${opt(1500, av.recvBr, 'Balanced')}${opt(4000, av.recvBr, 'High')}${opt(8000, av.recvBr, 'Maximum')}</select></div>
        </div>
        <p class="hint">Each person sends a stream to everyone else in the call, so high upload settings need a good connection when many people are in a channel. ${voice ? 'Saving reconnects your call to apply the changes.' : ''}</p>
        ${voice ? '<button class="btn" id="aDevices">Choose microphone / camera…</button>' : '<p class="hint">Join a voice channel to pick your microphone and camera.</p>'}
      </div>
      <div class="actions"><button class="btn link" data-close>Cancel</button><button class="btn primary" id="mOk">Save</button></div>`, () => {
      const show = (t) => {
        $('modal').querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('sel', b.dataset.tab === t));
        $('modal').querySelectorAll('[data-body]').forEach((b) => b.classList.toggle('hidden', b.dataset.body !== t));
      };
      $('modal').querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => show(b.dataset.tab)));
      show(tab);
      wireColors((c) => (color = c));
      if ($('mNotif')) $('mNotif').onclick = () => Notification.requestPermission().then(() => toast('Notifications: ' + Notification.permission));
      if ($('aDevices')) $('aDevices').onclick = () => { closeModal(); showVoice(); voicePost({ toggleSettings: 'toggle' }); };
      $('mOk').onclick = () => {
        const name = $('mName').value.trim().slice(0, 32);
        if (!name) { show('profile'); return $('mName').focus(); }
        const nameChanged = name !== me.name;
        me = { ...me, name, color };
        store.set('me', me);
        const next = {
          camQ: $('aCamQ').value, camFps: +$('aCamFps').value, ssQ: $('aSsQ').value, ssFps: +$('aSsFps').value,
          sendBr: +$('aSend').value, recvBr: +$('aRecv').value,
        };
        const avChanged = JSON.stringify(next) !== JSON.stringify(av);
        av = next;
        store.set('av', av);
        closeModal();
        broadcastState();
        if (nameChanged) { // VDO.Ninja labels come from the URL; reconnect so labels update
          for (const sid in meshes) disconnectMesh(sid);
          setTimeout(() => servers.forEach(connectMesh), 400);
        }
        if (voice && (avChanged || nameChanged)) joinVoice(voice.sid, voice.cid, voice.cam);
        render();
      };
    }, true, true);
  }

  function createServerModal() {
    modal(`<h2>Create a server</h2><p>Your server is a private peer-to-peer space. Share the invite link with friends.</p>
      <label>Server name</label><input type="text" id="mName" maxlength="64" value="${esc(me.name)}'s server">
      <div class="actions"><button class="btn link" id="mJoin">Have an invite?</button><button class="btn link" data-close>Cancel</button><button class="btn primary" id="mOk">Create</button></div>`, () => {
      const inp = $('mName');
      inp.select();
      const ok = () => { const n = inp.value.trim(); if (!n) return; closeModal(); createServer(n); };
      $('mOk').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
      $('mJoin').onclick = joinModal;
    });
  }

  function joinModal() {
    modal(`<h2>Join a server</h2><p>Paste an invite link or code.</p>
      <label>Invite link</label><input type="text" id="mCode" placeholder="https://…#invite=…">
      <div class="actions"><button class="btn link" data-close>Cancel</button><button class="btn primary" id="mOk">Join</button></div>`, () => {
      const inp = $('mCode');
      inp.focus();
      const ok = () => { if (joinFromInvite(inp.value)) closeModal(); };
      $('mOk').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    });
  }

  function inviteModal() {
    const s = server(cur.sid);
    if (!s) return;
    const link = inviteLink(s);
    const local = location.protocol === 'file:' || /^(localhost|127\.)/.test(location.hostname);
    modal(`<h2>Invite friends to ${esc(s.name)}</h2>
      <p>Anyone with this link can join, chat and hop into voice. Keep it private.${local ? '<br><br><b>Heads up:</b> this copy is running on your own computer, so the link only works here. Use the hosted site to invite people.' : ''}</p>
      <label>Invite link</label><input type="text" id="mLink" readonly value="${esc(link)}">
      <div class="actions"><button class="btn link" data-close>Done</button><button class="btn primary" id="mCopy">Copy</button></div>`, () => {
      $('mLink').select();
      $('mCopy').onclick = () => {
        (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Invite link copied'), () => { $('mLink').select(); document.execCommand('copy'); toast('Invite link copied'); });
      };
    });
  }

  function channelModal(type) {
    const s = server(cur.sid);
    modal(`<h2>Create channel</h2>
      <label>Channel type</label>
      <div class="radio-row">
        <label class="opt"><input type="radio" name="ct" value="text" ${type !== 'voice' ? 'checked' : ''}> <i data-icon="hash"></i> Text</label>
        <label class="opt"><input type="radio" name="ct" value="voice" ${type === 'voice' ? 'checked' : ''}> <i data-icon="speaker"></i> Voice</label>
      </div>
      <label>Channel name</label><input type="text" id="mName" maxlength="40" placeholder="new-channel">
      <div class="actions"><button class="btn link" data-close>Cancel</button><button class="btn primary" id="mOk">Create channel</button></div>`, () => {
      const inp = $('mName');
      inp.focus();
      const ok = () => {
        const t = document.querySelector('input[name=ct]:checked').value;
        let n = inp.value.trim();
        if (t === 'text') n = n.toLowerCase().replace(/\s+/g, '-');
        if (!n) return;
        const c = { id: rid(6), name: n.slice(0, 40), type: t };
        s.channels.push(c);
        bumpServer(s);
        closeModal();
        selectChannel(c.id);
      };
      $('mOk').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    });
  }

  function confirmModal(title, text, label, fn) {
    modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="actions"><button class="btn link" data-close>Cancel</button><button class="btn danger" id="mOk">${esc(label)}</button></div>`, () => {
      $('mOk').onclick = () => { closeModal(); fn(); };
    });
  }

  function renameModal() {
    const s = server(cur.sid);
    modal(`<h2>Rename server</h2><label>Server name</label><input type="text" id="mName" maxlength="64" value="${esc(s.name)}">
      <div class="actions"><button class="btn link" data-close>Cancel</button><button class="btn primary" id="mOk">Save</button></div>`, () => {
      const inp = $('mName');
      inp.select();
      const ok = () => { const n = inp.value.trim(); if (!n) return; s.name = n; bumpServer(s); closeModal(); };
      $('mOk').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    });
  }

  // ---------------------------------------------------------------- events
  paintIcons();
  $('serverList').onclick = (e) => { const b = e.target.closest('[data-sid]'); if (b) selectServer(b.dataset.sid); };
  $('homeBtn').onclick = () => selectServer(null);
  $('addServerBtn').onclick = createServerModal;
  $('wCreate').onclick = createServerModal;
  $('wJoin').onclick = joinModal;
  $('inviteTop').onclick = inviteModal;

  $('serverMenuBtn').onclick = (e) => { e.stopPropagation(); $('serverMenu').classList.toggle('hidden'); };
  document.addEventListener('click', () => $('serverMenu').classList.add('hidden'));
  $('serverMenu').onclick = (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const s = server(cur.sid);
    switch (a.dataset.act) {
      case 'invite': inviteModal(); break;
      case 'addText': channelModal('text'); break;
      case 'addVoice': channelModal('voice'); break;
      case 'rename': renameModal(); break;
      case 'leave': confirmModal(`Leave '${s.name}'`, 'You can rejoin later with an invite link. Your local message history for this server will be removed.', 'Leave server', () => leaveServer(s.id)); break;
    }
  };

  $('channelList').onclick = (e) => {
    const add = e.target.closest('[data-add]');
    if (add) return channelModal(add.dataset.add);
    const del = e.target.closest('[data-delc]');
    if (del) {
      e.stopPropagation();
      const s = server(cur.sid), c = channel(s, del.dataset.delc);
      return confirmModal('Delete channel', `Delete ${c.type === 'text' ? '#' : ''}${c.name} for everyone?`, 'Delete channel', () => {
        s.channels = s.channels.filter((x) => x.id !== c.id);
        if (voice && voice.sid === s.id && voice.cid === c.id) leaveVoice();
        if (cur.cid === c.id) cur.cid = (s.channels.find((x) => x.type === 'text') || s.channels[0] || {}).id || null;
        bumpServer(s);
      });
    }
    const sv = e.target.closest('[data-sid]');
    if (sv) return selectServer(sv.dataset.sid);
    const ch = e.target.closest('[data-cid]');
    if (ch) {
      const c = channel(server(cur.sid), ch.dataset.cid);
      selectChannel(ch.dataset.cid);
      // Discord-style: clicking a voice channel joins it
      if (c && c.type === 'voice' && !(voice && voice.sid === cur.sid && voice.cid === c.id)) joinVoice(cur.sid, c.id, false);
    }
  };

  $('messages').onclick = (e) => {
    const d = e.target.closest('[data-del]');
    if (d) return deleteMessage(d.dataset.del);
    const ed = e.target.closest('[data-edit]');
    if (ed) return editMessage(ed.dataset.edit);
  };

  const input = $('msgInput');
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px'; };
  input.addEventListener('input', () => { autosize(); if (input.value.trim()) sendTyping(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage(input.value);
      input.value = '';
      autosize();
    }
  });
  $('composer').onsubmit = (e) => e.preventDefault();

  $('joinVoiceBtn').onclick = () => joinVoice(cur.sid, cur.cid, false);
  $('joinVideoBtn').onclick = () => joinVoice(cur.sid, cur.cid, true);
  $('vsLeave').onclick = leaveVoice;
  $('cbLeave').onclick = leaveVoice;
  $('vsCam').onclick = toggleCam;
  $('cbCam').onclick = toggleCam;
  $('vsShare').onclick = toggleShare;
  $('cbShare').onclick = toggleShare;
  $('voiceWhere').onclick = showVoice;
  $('micBtn').onclick = toggleMic;
  $('cbMic').onclick = toggleMic;
  $('deafBtn').onclick = toggleDeaf;
  $('cbDeaf').onclick = toggleDeaf;
  $('settingsBtn').onclick = () => settingsModal('profile');
  $('cbSettings').onclick = () => settingsModal('av');
  $('membersToggle').onclick = () => { membersOpen = !membersOpen; store.set('membersOpen', membersOpen); renderMembers(); };

  window.addEventListener('hashchange', checkInviteHash);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    broadcastState();
    if (cur.sid && cur.cid) { markRead(cur.sid, cur.cid); renderRail(); renderChannels(); }
  });
  window.addEventListener('pagehide', () => { for (const sid in meshes) send(sid, { t: 'bye' }); });

  function checkInviteHash() {
    const m = location.hash.match(/invite=([A-Za-z0-9_-]+)/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    if (!me) { pendingInvite = m[1]; return; }
    joinFromInvite(m[1]);
  }
  let pendingInvite = null;

  // ---------------------------------------------------------------- timers
  setInterval(broadcastState, PING_MS);
  setInterval(() => {
    renderTyping();
    if (cur.sid) renderPresence();
  }, 3000);
  setInterval(paintSpeaking, 250);

  // ---------------------------------------------------------------- boot
  function start() {
    servers.forEach(connectMesh);
    if (pendingInvite) { const p = pendingInvite; pendingInvite = null; joinFromInvite(p); }
    else selectServer(server(cur.sid) ? cur.sid : (servers[0] ? servers[0].id : null));
  }

  checkInviteHash();
  if (!me) { profileModal(true); } else start();

  // handy for debugging in the console
  window.dischord = { get me() { return me; }, servers: () => servers, members: () => members, peers: () => peers, get voice() { return voice; }, speaking };
})();
