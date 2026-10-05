/* Dischord — a Discord-style app on top of VDO.Ninja.
 *
 * How it works (no backend):
 *  - Each server has a random id + secret key. Everyone who has the invite has both.
 *  - For every server you're in, a hidden VDO.Ninja iframe joins a data-only room
 *    (&datamode). That peer-to-peer mesh carries text messages, presence, typing,
 *    channel changes and history sync, via the VDO.Ninja IFRAME API (sendData/dataReceived).
 *  - Voice channels are separate, visible VDO.Ninja rooms (audio, camera, screen share).
 *  - Everything is stored in your browser's localStorage. History reaches people who
 *    join later as long as someone who has it is online.
 */
(() => {
  'use strict';

  // Point this at a self-hosted VDO.Ninja if you like (see README).
  const VDO = (window.DISCHORD_CONFIG && window.DISCHORD_CONFIG.vdoUrl) || 'https://vdo.ninja/';
  const PROTO = 1;
  const MAX_MSGS = 500;
  const HIST_SEND = 60;          // messages per channel sent during history sync
  const ONLINE_MS = 45000;       // considered offline after this long without a ping
  const PING_MS = 15000;
  const COLORS = ['#7b61ff', '#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#00a8fc', '#1abc9c', '#e67e22', '#9b59b6'];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => Date.now();

  const store = {
    get(k, d) { try { const v = localStorage.getItem('dischord.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('dischord.' + k, JSON.stringify(v)); } catch { } },
    del(k) { try { localStorage.removeItem('dischord.' + k); } catch { } },
  };

  function rid(n = 10) {
    const a = 'abcdefghijkmnpqrstuvwxyz23456789';
    let s = '';
    for (const x of crypto.getRandomValues(new Uint8Array(n))) s += a[x % a.length];
    return s;
  }

  const b64e = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64d = (str) => JSON.parse(decodeURIComponent(escape(atob(str.replace(/-/g, '+').replace(/_/g, '/')))));

  // ---------------------------------------------------------------- state
  let me = store.get('me', null);
  let servers = store.get('servers', []);
  let reads = store.get('reads', {});
  let lastChan = store.get('lastChan', {});
  const cur = { sid: store.get('lastSid', null), cid: null };
  const msgs = {};       // sid -> { cid: [msg] }
  const known = {};      // sid -> { userId: user }   (persisted)
  const members = {};    // sid -> { userId: { user, voice, seen, uuid } }
  const typing = {};     // sid/cid -> { userId: { name, until } }
  const meshes = {};     // sid -> { iframe, peers:Set }
  const histSent = {};   // sid/uuid -> ts
  let voice = null;      // { sid, cid, iframe, cam }
  let micOn = true, deaf = false;
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

  // ---------------------------------------------------------------- mesh (data-only VDO.Ninja rooms)
  const roomFor = (s, suffix = '') => 'dischord' + s.id + suffix;

  function meshUrl(s) {
    const p = new URLSearchParams({ room: roomFor(s), password: s.key, label: me.name });
    return VDO + '?' + p.toString() + '&datamode&cleanoutput';
  }

  function connectMesh(s) {
    if (meshes[s.id] || !me) return;
    const f = document.createElement('iframe');
    f.src = meshUrl(s);
    f.title = 'mesh-' + s.id;
    $('meshHost').appendChild(f);
    meshes[s.id] = { iframe: f, peers: new Set() };
  }
  function disconnectMesh(sid) {
    const m = meshes[sid];
    if (!m) return;
    try { send(sid, { t: 'bye' }); } catch { }
    setTimeout(() => m.iframe.remove(), 200);
    delete meshes[sid];
  }

  function send(sid, payload, uuid) {
    const m = meshes[sid];
    if (!m || !m.iframe.contentWindow) return;
    const body = { v: PROTO, u: me, ...payload };
    const o = { sendData: { dischord: body } };
    if (uuid) o.UUID = uuid;
    m.iframe.contentWindow.postMessage(o, '*');
  }

  const myVoiceIn = (sid) => (voice && voice.sid === sid ? voice.cid : null);

  function hello(sid, uuid, want) {
    const s = server(sid);
    if (!s) return;
    send(sid, { t: 'hello', want: !!want, voice: myVoiceIn(sid), s: { id: s.id, name: s.name, channels: s.channels, v: s.v } }, uuid);
  }

  function sendHistory(sid, uuid) {
    const key = sid + '/' + uuid;
    if (histSent[key] && now() - histSent[key] < 10000) return;
    histSent[key] = now();
    const all = getMsgs(sid);
    for (const cid in all) {
      const list = all[cid].slice(-HIST_SEND);
      for (let i = 0; i < list.length; i += 15) {
        send(sid, { t: 'hist', ms: list.slice(i, i + 15) }, uuid);
      }
    }
  }

  function touch(sid, u, uuid, v) {
    const user = cleanUser(u);
    if (!user || user.id === me.id) return null;
    members[sid] = members[sid] || {};
    const wasOnline = isOnline(members[sid][user.id]);
    members[sid][user.id] = { user, voice: isId(v) ? v : null, seen: now(), uuid };
    const k = getKnown(sid);
    if (!k[user.id] || k[user.id].name !== user.name || k[user.id].color !== user.color) {
      k[user.id] = user;
      store.set('known.' + sid, k);
    }
    return { user, wasOnline };
  }
  const isOnline = (m) => !!m && now() - m.seen < ONLINE_MS;

  function onPeerData(sid, p, uuid) {
    if (!p || typeof p !== 'object' || !p.u) return;
    const s = server(sid);
    if (!s) return;
    const t = touch(sid, p.u, uuid, p.voice);
    if (!t) return;
    const m = meshes[sid];
    if (m && uuid) m.peers.add(uuid);

    switch (p.t) {
      case 'hello':
        mergeServer(sid, p.s);
        if (p.want) hello(sid, uuid, false);
        sendHistory(sid, uuid);
        break;
      case 'ping':
        if (!t.wasOnline) hello(sid, uuid, true);
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
        if (changed) render();
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
      case 'server':
        mergeServer(sid, p.s);
        break;
      case 'bye':
        if (members[sid][t.user.id]) members[sid][t.user.id].seen = 0;
        break;
    }
    if (sid === cur.sid) { renderMembers(); renderChannels(); }
  }

  function mergeServer(sid, def) {
    const d = cleanServerDef(def);
    const s = server(sid);
    if (!d || !s || d.id !== sid || d.v <= s.v) return;
    s.name = d.name; s.channels = d.channels; s.v = d.v;
    saveServers();
    if (voice && voice.sid === sid && !channel(s, voice.cid)) leaveVoice();
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
    // insert sorted by ts
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
    if (sid === cur.sid && m.cid === cur.cid && document.hasFocus()) markRead(sid, m.cid);
    else if (document.hidden || sid !== cur.sid || m.cid !== cur.cid) notify(sid, m);
    render();
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
    for (let i = list.length - 1; i >= 0 && list[i].ts > r; i--) if (!list[i].del && list[i].a.id !== me.id) n++;
    return n;
  }
  const serverUnread = (s) => s.channels.some((c) => c.type === 'text' && unreadCount(s.id, c.id) > 0);

  let lastTypingSent = 0;
  function sendTyping() {
    if (now() - lastTypingSent < 3000) return;
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
  function voiceUrl(s, c, withCam) {
    const p = new URLSearchParams({ room: roomFor(s, 'v' + c.id), password: s.key, label: me.name });
    let u = VDO + '?' + p.toString() + '&autostart&ssb&showlabels&darkmode&chatbutton=false&nohangupbutton&nmb&nospeakerbutton';
    if (withCam) u += '&webcam';
    else u += '&videodevice=0&webcam';
    if (!micOn || deaf) u += '&mute';
    return u;
  }

  function joinVoice(sid, cid, withCam) {
    const s = server(sid), c = channel(s, cid);
    if (!s || !c) return;
    if (voice) leaveVoice(true);
    const f = document.createElement('iframe');
    f.allow = 'autoplay; camera; microphone; display-capture; fullscreen; picture-in-picture; clipboard-write';
    f.src = voiceUrl(s, c, withCam);
    $('voiceStage').innerHTML = '';
    $('voiceStage').appendChild(f);
    voice = { sid, cid, iframe: f, cam: withCam };
    f.addEventListener('load', () => { if (deaf) setTimeout(() => voicePost({ mute: true }), 2500); });
    send(sid, { t: 'ping', voice: cid });
    playTone(true);
    render();
  }

  function leaveVoice(silent) {
    if (!voice) return;
    const sid = voice.sid;
    try { voice.iframe.contentWindow.postMessage({ close: true }, '*'); } catch { }
    const f = voice.iframe;
    setTimeout(() => f.remove(), 300);
    voice = null;
    send(sid, { t: 'ping', voice: null });
    if (!silent) playTone(false);
    render();
  }

  function voicePost(o) { if (voice && voice.iframe.contentWindow) voice.iframe.contentWindow.postMessage(o, '*'); }

  function toggleMic() {
    if (deaf) { deaf = false; voicePost({ mute: false }); }
    micOn = !micOn;
    voicePost({ mic: micOn });
    renderUserPanel();
  }
  function toggleDeaf() {
    deaf = !deaf;
    voicePost({ mute: deaf });
    voicePost({ mic: deaf ? false : micOn });
    renderUserPanel();
  }

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

  // ---------------------------------------------------------------- iframe API listener
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    let sid = null;
    for (const id in meshes) if (meshes[id].iframe.contentWindow === e.source) { sid = id; break; }
    if (!sid) return; // voice iframe events are not needed

    if (d.dataReceived && d.dataReceived.dischord) {
      onPeerData(sid, d.dataReceived.dischord, d.UUID);
      return;
    }
    if (d.action && d.UUID) {
      const a = d.action;
      const up = ['push-connection', 'view-connection', 'guest-connected', 'new-view-connection'].includes(a) && d.value !== false;
      const down = a === 'end-view-connection' || ((a === 'push-connection' || a === 'view-connection') && d.value === false);
      if (up) {
        // data channel may need a moment to open
        setTimeout(() => hello(sid, d.UUID, true), 600);
        setTimeout(() => hello(sid, d.UUID, true), 3500);
      } else if (down) {
        const ms = members[sid] || {};
        for (const uid in ms) if (ms[uid].uuid === d.UUID) ms[uid].seen = 0;
        if (meshes[sid]) meshes[sid].peers.delete(d.UUID);
        if (sid === cur.sid) { renderMembers(); renderChannels(); }
      }
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
  function inviteLink(s) { return location.href.split('#')[0] + '#invite=' + inviteCode(s); }

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
  const avatar = (u, dot) => `<div class="avatar" style="background:${esc(u.color)}">${esc((u.name[0] || '?').toUpperCase())}${dot ? '<span class="dot"></span>' : ''}</div>`;

  function render() {
    if (!me) return;
    renderRail();
    renderHeader();
    renderChannels();
    renderMain();
    renderMembers();
    renderUserPanel();
  }

  function renderRail() {
    $('serverList').innerHTML = servers.map((s) =>
      `<button class="rail-btn ${s.id === cur.sid ? 'active' : ''} ${serverUnread(s) && s.id !== cur.sid ? 'unread' : ''}" data-sid="${esc(s.id)}" title="${esc(s.name)}">${esc(initials(s.name))}</button>`).join('');
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
    if (voice && voice.sid === sid && voice.cid === cid) out.push(me);
    const ms = members[sid] || {};
    for (const id in ms) if (isOnline(ms[id]) && ms[id].voice === cid) out.push(ms[id].user);
    return out;
  }

  function renderChannels() {
    const s = server(cur.sid);
    const el = $('channelList');
    if (!s) {
      el.innerHTML = `<div class="cat"><span>Your servers</span></div>` + (servers.length
        ? servers.map((x) => `<div class="chan" data-sid="${esc(x.id)}"><span class="ico">◆</span><span class="name">${esc(x.name)}</span></div>`).join('')
        : `<div class="chan" style="cursor:default">No servers yet</div>`);
      return;
    }
    const text = s.channels.filter((c) => c.type === 'text');
    const vc = s.channels.filter((c) => c.type === 'voice');
    let h = `<div class="cat"><span>Text channels</span><button class="icon-btn" data-add="text" title="Create channel">+</button></div>`;
    for (const c of text) {
      const n = c.id === cur.cid ? 0 : unreadCount(s.id, c.id);
      h += `<div class="chan ${c.id === cur.cid ? 'active' : ''} ${n ? 'unread' : ''}" data-cid="${esc(c.id)}">
        <span class="ico">#</span><span class="name">${esc(c.name)}</span>
        ${n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : ''}
        <button class="icon-btn del" data-delc="${esc(c.id)}" title="Delete channel">✕</button></div>`;
    }
    h += `<div class="cat"><span>Voice channels</span><button class="icon-btn" data-add="voice" title="Create channel">+</button></div>`;
    for (const c of vc) {
      const who = voiceOccupants(s.id, c.id);
      h += `<div class="chan ${c.id === cur.cid ? 'active' : ''}" data-cid="${esc(c.id)}">
        <span class="ico">🔊</span><span class="name">${esc(c.name)}</span>
        <button class="icon-btn del" data-delc="${esc(c.id)}" title="Delete channel">✕</button></div>`;
      if (who.length) h += `<div class="voice-users">${who.map((u) => `<div class="voice-user">${avatar(u)}<span>${esc(u.name)}</span></div>`).join('')}</div>`;
    }
    el.innerHTML = h;
  }

  function renderMain() {
    const s = server(cur.sid);
    const c = channel(s, cur.cid);
    $('welcome').classList.toggle('hidden', !!c);
    $('textView').classList.toggle('hidden', !c || c.type !== 'text');
    $('voiceView').classList.toggle('hidden', !c || c.type !== 'voice');
    const inThisVoice = voice && c && voice.sid === cur.sid && voice.cid === c.id;
    $('voiceStage').classList.toggle('offstage', !inThisVoice);
    $('voiceStage').classList.toggle('hidden', !voice);
    $('mainHeader').classList.toggle('hidden', !c);
    $('membersToggle').classList.toggle('hidden', !c);

    if (!c) return;
    $('chanIcon').textContent = c.type === 'text' ? '#' : '🔊';
    $('chanName').textContent = c.name;
    $('chanTopic').textContent = c.type === 'voice' ? 'Voice & video powered by VDO.Ninja' : '';
    if (c.type === 'text') {
      $('msgInput').placeholder = `Message #${c.name}`;
      renderMessages();
      renderTyping();
    } else if (!inThisVoice) {
      const who = voiceOccupants(s.id, c.id);
      $('voiceIdleTitle').textContent = '🔊 ' + c.name;
      $('voiceIdleWho').textContent = who.length ? `${who.map((u) => u.name).join(', ')} ${who.length === 1 ? 'is' : 'are'} in here.` : 'No one is here yet.';
    }
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
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const list = (getMsgs(s.id)[c.id] || []).filter((m) => !m.del);
    let h = `<div class="chan-intro"><div class="big">#</div><h2>Welcome to #${esc(c.name)}!</h2><p>This is the start of the #${esc(c.name)} channel. Messages travel peer-to-peer; people who join later get recent history from whoever is online.</p></div>`;
    let prev = null;
    for (const m of list) {
      const newDay = !prev || new Date(prev.ts).toDateString() !== new Date(m.ts).toDateString();
      if (newDay) h += `<div class="day-sep"><span>${new Date(m.ts).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })}</span></div>`;
      const head = newDay || !prev || prev.a.id !== m.a.id || m.ts - prev.ts > 7 * 60000;
      const mine = m.a.id === me.id;
      const acts = mine ? `<div class="actions"><button class="icon-btn" data-edit="${esc(m.id)}" title="Edit">✎</button><button class="icon-btn danger" data-del="${esc(m.id)}" title="Delete">🗑</button></div>` : '';
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
      `<b>${names.slice(0, 3).map(esc).join(', ')}</b> ${names.length === 1 ? 'is' : 'are'} typing…`;
  }

  function renderMembers() {
    const el = $('members');
    const s = server(cur.sid);
    el.classList.toggle('collapsed', !s || !membersOpen);
    if (!s) return;
    const ms = members[s.id] || {};
    const k = getKnown(s.id);
    const online = [{ user: me, voice: myVoiceIn(s.id) }];
    const offline = [];
    for (const id in k) {
      if (id === me.id) continue;
      const m = ms[id];
      if (isOnline(m)) online.push(m); else offline.push({ user: k[id] });
    }
    const vname = (cid) => { const c = channel(s, cid); return c ? '🔊 ' + c.name : ''; };
    const row = (m, on) => `<div class="mem ${on ? '' : 'offline'}">${avatar(m.user, true)}<div style="min-width:0"><div class="nm" style="color:${on ? esc(m.user.color) : 'inherit'}">${esc(m.user.name)}${m.user.id === me.id ? ' <span class="sub">(you)</span>' : ''}</div>${on && m.voice ? `<div class="sub">${esc(vname(m.voice))}</div>` : ''}</div></div>`;
    el.innerHTML = `<div class="mem-cat">Online — ${online.length}</div>${online.map((m) => row(m, true)).join('')}` +
      (offline.length ? `<div class="mem-cat" style="margin-top:20px">Offline — ${offline.length}</div>${offline.map((m) => row(m, false)).join('')}` : '');
  }

  function renderUserPanel() {
    if (!me) return;
    $('meAvatar').outerHTML = `<div class="avatar" id="meAvatar" style="background:${esc(me.color)}">${esc(me.name[0].toUpperCase())}<span class="dot"></span></div>`;
    $('meName').textContent = me.name;
    const peers = cur.sid && meshes[cur.sid] ? Object.values(members[cur.sid] || {}).filter(isOnline).length : 0;
    $('meStatus').textContent = cur.sid ? (peers ? `${peers} peer${peers === 1 ? '' : 's'} connected` : 'Waiting for peers…') : 'Online';
    $('micBtn').classList.toggle('off', !micOn || deaf);
    $('micBtn').title = micOn && !deaf ? 'Mute' : 'Unmute';
    $('deafBtn').classList.toggle('off', deaf);
    $('deafBtn').title = deaf ? 'Undeafen' : 'Deafen';
    $('voiceStatus').classList.toggle('hidden', !voice);
    if (voice) {
      const s = server(voice.sid), c = channel(s, voice.cid);
      $('voiceWhere').textContent = c ? `${c.name} / ${s.name}` : '';
      $('voiceWhere').style.cursor = 'pointer';
      $('vsCam').classList.toggle('on', !!voice.cam);
    }
  }

  // ---------------------------------------------------------------- modals
  function modal(html, mount, dismissable = true) {
    $('modal').innerHTML = html;
    $('modalBack').classList.remove('hidden');
    $('modalBack').dataset.dismiss = dismissable ? '1' : '';
    $('modal').querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeModal));
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
    modal(`<h2>${first ? 'Welcome to Dischord' : 'User settings'}</h2>
      <p>${first ? 'Pick a display name. It\'s stored only in this browser.' : 'Changes are shared with everyone online.'}</p>
      <label>Display name</label><input type="text" id="mName" maxlength="32" value="${esc(me ? me.name : '')}" placeholder="e.g. daniel">
      <label>Color</label>${colorPicker(color)}
      ${!first && 'Notification' in window && Notification.permission !== 'granted' ? '<div class="actions" style="justify-content:flex-start"><button class="btn" id="mNotif">Enable desktop notifications</button></div>' : ''}
      <div class="actions">${first ? '' : '<button class="btn link" data-close>Cancel</button>'}<button class="btn primary" id="mOk">${first ? 'Continue' : 'Save'}</button></div>`, () => {
      wireColors((c) => (color = c));
      const inp = $('mName');
      inp.focus();
      if ($('mNotif')) $('mNotif').onclick = () => Notification.requestPermission().then(() => toast('Notifications: ' + Notification.permission));
      const ok = () => {
        const name = inp.value.trim().slice(0, 32);
        if (!name) return inp.focus();
        const firstTime = !me;
        const nameChanged = me && me.name !== name;
        me = { id: me ? me.id : rid(12), name, color };
        store.set('me', me);
        closeModal();
        if (firstTime) start();
        else {
          for (const sid in meshes) send(sid, { t: 'ping', voice: myVoiceIn(sid) });
          if (nameChanged) {
            // VDO.Ninja labels come from the URL; reconnect so labels update
            for (const sid in meshes) { disconnectMesh(sid); }
            setTimeout(() => servers.forEach(connectMesh), 400);
          }
          render();
        }
      };
      $('mOk').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    }, !first);
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
    const link = inviteLink(s);
    const local = location.protocol === 'file:';
    modal(`<h2>Invite friends to ${esc(s.name)}</h2>
      <p>Anyone with this link can join, chat and hop into voice.${local ? '<br><br><b>Heads up:</b> you\'re opening Dischord from a file on your computer, so this link only works on this PC. Host the folder (e.g. GitHub Pages or Netlify) to share it — friends can also paste it into <i>Join a server</i> in their own copy.' : ''}</p>
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
        <label class="opt"><input type="radio" name="ct" value="text" ${type !== 'voice' ? 'checked' : ''}> # Text</label>
        <label class="opt"><input type="radio" name="ct" value="voice" ${type === 'voice' ? 'checked' : ''}> 🔊 Voice</label>
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
  $('serverList').onclick = (e) => { const b = e.target.closest('[data-sid]'); if (b) selectServer(b.dataset.sid); };
  $('homeBtn').onclick = () => selectServer(null);
  $('addServerBtn').onclick = createServerModal;
  $('wCreate').onclick = createServerModal;
  $('wJoin').onclick = joinModal;

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
    if (ch) selectChannel(ch.dataset.cid);
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
  $('joinVoiceBtn').insertAdjacentHTML('afterend', ' <button class="btn" id="joinVideoBtn">Join with Camera</button>');
  $('joinVideoBtn').onclick = () => joinVoice(cur.sid, cur.cid, true);
  $('vsLeave').onclick = () => leaveVoice();
  $('vsCam').onclick = () => {
    if (!voice) return;
    if (!voice.cam) { // audio-only session: rejoin with camera
      const { sid, cid } = voice;
      joinVoice(sid, cid, true);
      return;
    }
    voicePost({ camera: 'toggle' });
  };
  $('vsShare').onclick = () => { voicePost({ function: 'publishScreen' }); if (voice) selectServerAndChannel(voice.sid, voice.cid); };
  $('voiceWhere').onclick = () => { if (voice) selectServerAndChannel(voice.sid, voice.cid); };
  function selectServerAndChannel(sid, cid) { if (cur.sid !== sid) selectServer(sid); selectChannel(cid); }

  $('micBtn').onclick = toggleMic;
  $('deafBtn').onclick = toggleDeaf;
  $('settingsBtn').onclick = () => profileModal(false);
  $('membersToggle').onclick = () => { membersOpen = !membersOpen; store.set('membersOpen', membersOpen); renderMembers(); };

  window.addEventListener('hashchange', checkInviteHash);
  window.addEventListener('focus', () => { if (cur.sid && cur.cid) { markRead(cur.sid, cur.cid); renderRail(); renderChannels(); } });
  window.addEventListener('beforeunload', () => { for (const sid in meshes) send(sid, { t: 'bye' }); });

  function checkInviteHash() {
    const m = location.hash.match(/invite=([A-Za-z0-9_-]+)/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    if (!me) { pendingInvite = m[1]; return; }
    joinFromInvite(m[1]);
  }
  let pendingInvite = null;

  // ---------------------------------------------------------------- timers
  setInterval(() => {
    for (const sid in meshes) send(sid, { t: 'ping', voice: myVoiceIn(sid) });
  }, PING_MS);
  setInterval(() => {
    renderTyping();
    if (cur.sid) { renderMembers(); renderUserPanel(); }
  }, 2000);
  setInterval(() => { if (cur.sid) renderChannels(); }, 10000);

  // ---------------------------------------------------------------- boot
  function start() {
    servers.forEach(connectMesh);
    if (pendingInvite) { const p = pendingInvite; pendingInvite = null; joinFromInvite(p); }
    else selectServer(server(cur.sid) ? cur.sid : (servers[0] ? servers[0].id : null));
  }

  checkInviteHash();
  if (!me) { render(); profileModal(true); } else start();

  // handy for debugging in the console
  window.dischord = { get me() { return me; }, servers: () => servers, members: () => members, meshes };
})();
