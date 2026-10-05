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
 *  - Profiles, settings and chat metadata use localStorage. Image previews have a
 *    separate browser cache; original files transfer only after Download.
 *    History reaches people who join later as long as someone who has it is online.
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
  const STALE_CONNECTED = 600000; // peer with a live connection: trust the connection; this is only a safety net if a disconnect event is ever missed
  const STALE_LOOSE = 60000;      // peer with no live connection considered gone after this
  const STALE_VOICE = 180000;     // same, for someone in a call
  const PEER_GRACE = 20000;       // a dropped mesh connection may just be reconnecting: wait this long for the next ping
  const COLORS = ['#5865f2', '#7b61ff', '#9b59b6', '#eb459e', '#ed4245', '#f47b67', '#e67e22', '#faa61a',
    '#f1c40f', '#57f287', '#3ba55c', '#1abc9c', '#00a8fc', '#3498db', '#607d8b', '#99aab5'];
  const EMOJIS = ['😀', '😁', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🥰', '😘', '😋', '😛', '😜', '🤪', '🤨',
    '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '😣', '😫', '😩', '🥺', '😢', '😭',
    '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '🤗', '🤔', '🤭', '🤫',
    '😶', '😐', '😑', '😬', '🙄', '😯', '😮', '😲', '🥱', '😴', '🤤', '😵', '🤐', '🥴', '🤢', '🤮',
    '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤙', '👋', '👏', '🙌', '🙏', '💪', '👀', '🧠', '💀', '👻',
    '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '💯', '🔥', '✨', '🎉', '🎮', '🎧', '✅', '❌'];
  const REACTS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀', '💯', '😎', '🙏', '🤔', '👏', '😡', '✅', '❌'];
  const IMG_CHUNK = 14000;        // chars per image chunk over the data channel
  const IMG_MAX = 4500000;        // max data-URL length (~3.3 MB image)

  const AV_DEFAULTS = { camQ: '720', camFps: 30, camBr: 2500, ssQ: '1080', ssFps: 60, ssBr: 12000, ssHint: 'motion', recvCap: 0, codec: 'h264', selfPreview: 'low', showStats: false, micGain: 100 };
  function audioPercent(value) {
    const n = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
    return Number.isFinite(n) ? Math.max(0, Math.min(200, Math.round(n))) : 100;
  }
  const CAM_BRS = [300, 600, 1000, 1500, 2500, 4000, 6000, 8000];
  const SS_BRS = [1000, 2500, 4000, 6000, 8000, 12000, 16000, 20000, 30000, 40000];
  const VIEW_BRS = [300, 800, 1500, 2500, 4000, 6000, 8000, 12000, 20000, 30000, 40000];
  const mbps = (k) => (k >= 1000 ? (k / 1000).toFixed(k % 1000 ? 1 : 0) + ' Mbps' : k + ' kbps');
  const CAM_Q = { '360': 2, '720': 1, '1080': 0, '1440': -3, '2160': -2 };
  const SS_Q = { '720': 1, '1080': 0, '1440': -3, '2160': -2, source: -1 };

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
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
    plusCircle: '<circle cx="12" cy="12" r="9.5"/><path d="M12 8v8M8 12h8"/>',
    volume: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
    eyeOff: '<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3.2 3.8M6.6 6.6A17 17 0 0 0 3 12s4 6 9 6a9 9 0 0 0 4.2-1"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    reply: '<path d="M9 4l-6 6 6 6M3 10h9a8 8 0 0 1 8 8"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    collapse: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    winfs: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7.5 12V9h3M16.5 12v3h-3"/>',
    chevUp: '<path d="M6 15l6-6 6 6"/>',
    chevDown: '<path d="M6 9l6 6 6-6"/>',
    people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M17.5 14.5c2.5.2 4 1.8 4 4.5"/>',
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

  // Timers that keep their pace in a background tab. Browsers slow page timers there (to once a second,
  // later once a minute), which stalled image transfers and presence pings from anyone who had switched
  // to another window. A worker's timers are not slowed. Falls back to page timers without workers.
  const bgTimer = (() => {
    let worker = null, seq = 0;
    const waits = new Map(), loops = [];
    const fail = () => {
      if (!worker) return;
      try { worker.terminate(); } catch { }
      worker = null;
      waits.forEach((done) => done()); waits.clear();
      loops.forEach(([ms, fn]) => setInterval(fn, ms));
    };
    try {
      if (typeof Worker !== 'function') throw new Error('no workers');
      const src = 'onmessage=function(e){var d=e.data;if(d.every)setInterval(function(){postMessage({every:d.every})},d.every);else setTimeout(function(){postMessage({id:d.id})},d.ms)}';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      worker = new Worker(url);
      URL.revokeObjectURL(url);
      worker.onmessage = (e) => {
        const d = e.data || {};
        if (d.every) loops.forEach(([ms, fn]) => { if (ms === d.every) fn(); });
        else { const done = waits.get(d.id); waits.delete(d.id); if (done) done(); }
      };
      worker.onerror = fail;
    } catch { worker = null; }
    return {
      sleep: (ms) => new Promise((done) => { if (!worker) return setTimeout(done, ms); const id = ++seq; waits.set(id, done); worker.postMessage({ id, ms }); }),
      every(ms, fn) { loops.push([ms, fn]); if (worker) worker.postMessage({ every: ms }); else setInterval(fn, ms); },
    };
  })();

  // ---------------------------------------------------------------- state
  let me = store.get('me', null);
  let servers = store.get('servers', []);
  let reads = store.get('reads', {});
  let lastChan = store.get('lastChan', {});
  const savedAv = store.get('av', {}) || {};
  let av = { ...AV_DEFAULTS, ...savedAv };
  av.micGain = audioPercent(av.micGain);
  if (av.sendBr && !savedAv.camBr) av.camBr = av.sendBr; // migrate v4 settings
  delete av.sendBr; delete av.recvBr;
  // Keep explicit saved choices, including Auto codec. Fresh profiles use the FPS-oriented defaults.
  if (!av.v8 || !av.v9) { av.v8 = 1; av.v9 = 1; store.set('av', av); }
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
  const userVol = store.get('vol', {});      // uid -> { v: 0-200 voice, sv: 0-200 stream, m: muted }
  const hiddenVid = store.get('hidevid', {}); // uid -> true (don't receive their camera)
  const imgCache = new Map();                // image id -> data URL
  const legacyImageKeys = new Set(); // saved legacy references allowed to read the old global cache
  let replyTarget = null;
  const composerDrafts = new Map(); // channel drafts, including local file references; never persisted
  const fileProviders = new Map(); // offer -> originating connection, never saved in chat history

  const server = (sid) => servers.find((s) => s.id === sid);
  const channel = (s, cid) => s && s.channels.find((c) => c.id === cid);
  const saveServers = () => store.set('servers', servers);

  function getMsgs(sid) {
    if (!msgs[sid]) {
      msgs[sid] = store.get('msgs.' + sid, {});
      for (const cid in msgs[sid]) for (const m of msgs[sid][cid] || []) {
        if (m.img && !m.file) legacyImageKeys.add(sid + '/' + cid + '/' + m.id + '/' + m.img.id);
      }
    }
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
  const clampInt = (v, lo, hi) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : lo);
  function cleanImg(i) {
    if (!i || typeof i !== 'object' || !isStr(i.id, 64) || !/^[a-z0-9]+$/i.test(i.id)) return undefined;
    const preview = i.preview === 1;
    const maximum = preview ? window.DischordImages.MAX_PREVIEW : IMG_MAX;
    if (!Number.isInteger(i.n) || i.n < 1 || i.n > maximum) return undefined;
    const side = preview ? window.DischordImages.MAX_SIDE : 10000;
    return { id: i.id, w: clampInt(i.w, 1, side), h: clampInt(i.h, 1, side), n: i.n, ...(preview ? { preview: 1 } : {}) };
  }
  function cleanRe(re) {
    if (!re || typeof re !== 'object') return undefined;
    const out = {};
    for (const e of Object.keys(re).slice(0, 20)) {
      if (!e || e.length > 16 || !re[e] || typeof re[e] !== 'object') continue;
      const o = {};
      for (const u of Object.keys(re[e]).slice(0, 200)) if (isId(u) && Number.isFinite(+re[e][u])) o[u] = +re[e][u];
      if (Object.keys(o).length) out[e] = o;
    }
    return Object.keys(out).length ? out : undefined;
  }
  function cleanMsg(m) {
    if (!m || !isStr(m.id, 64) || !isId(m.cid) || typeof m.ts !== 'number') return null;
    const a = cleanUser(m.a);
    if (!a) return null;
    if (m.del) return { id: m.id, cid: m.cid, ts: m.ts, a, del: true, text: '' };
    const text = typeof m.text === 'string' ? m.text : '';
    const file = window.DischordFiles.cleanMeta(m.file);
    const parsedImg = cleanImg(m.img);
    const img = parsedImg && (file ? window.DischordImages.isImage(file) && parsedImg.preview === 1 : !parsedImg.preview) ? parsedImg : undefined;
    if ((!text && !img && !file) || text.length > 4000) return null;
    return { id: m.id, cid: m.cid, ts: Math.min(m.ts, now() + 60000), a, text, img, file, reply: cleanReply(m.reply), re: cleanRe(m.re), ed: m.ed ? 1 : undefined };
  }
  function cleanReply(r) {
    if (!r || !isStr(r.id, 64) || !/^[a-z0-9]+$/i.test(r.id)) return undefined;
    const a = cleanUser(r.a);
    if (!a || typeof r.text !== 'string' || r.text.length > 240) return undefined;
    return { id: r.id, a, text: r.text, attachment: isStr(r.attachment, 255) ? r.attachment : undefined };
  }
  function cleanServerDef(d) {
    if (!d || !isId(d.id) || !isStr(d.name, 64) || !Array.isArray(d.channels) || typeof d.v !== 'number') return null;
    const channels = d.channels.slice(0, 60).filter((c) => c && isId(c.id) && isStr(c.name, 40) && (c.type === 'text' || c.type === 'voice'))
      .map((c) => ({ id: c.id, name: c.name, type: c.type }));
    return { id: d.id, name: d.name, channels, v: d.v };
  }
  function cleanState(st) {
    st = st && typeof st === 'object' ? st : {};
    const br = (v) => (Number.isFinite(+v) && +v >= 100 && +v <= 50000 ? Math.round(+v) : 0);
    return { m: !!st.m, d: !!st.d, c: !!st.c, s: !!st.s, cb: br(st.cb), sb: br(st.sb) };
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
  const myState = () => ({ m: !micOn || deaf, d: deaf, c: !!(voice && voice.cam), s: !!(voice && voice.ss), cb: av.camBr, sb: voice && voice.ssSettings ? voice.ssSettings.ssBr : av.ssBr });

  // Every payload carries who I am and my voice state, so presence is never stale.
  function send(sid, payload, uuid) {
    const m = meshes[sid];
    if (!m || !m.iframe.contentWindow) return false;
    const inV = myVoiceIn(sid);
    const body = { v: PROTO, u: me, vc: inV, vs: inV ? voice.vs : null, vss: inV && voice.ss ? voice.ssVs : null, st: myState(), ...payload };
    const o = { sendData: { dischord: body } };
    if (uuid) o.UUID = uuid;
    m.iframe.contentWindow.postMessage(o, '*');
    return true;
  }
  const broadcastState = () => { for (const sid in meshes) send(sid, { t: 'ping', pt: now() }); };

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
      // Not offline at once: the connection may be reconnecting. The next ping revives it; silence expires it.
      const c = m.conns && m.conns.get(uuid);
      if (c) c.seen = Math.min(c.seen, now() - (c.vc ? STALE_VOICE : STALE_LOOSE) + PEER_GRACE);
      else if (!m.conns && !m.uuids.size) m.seen = Math.min(m.seen, now() - (m.vc ? STALE_VOICE : STALE_LOOSE) + PEER_GRACE);
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

  // A person can have several connections at once (two tabs, or the desktop window plus a browser tab).
  // Each reports its own state, so one idle tab must never overwrite or end the presence of the tab that
  // is in a call: keep state per connection and show the one that is in voice (else the most recent).
  function settle(m) {
    if (!m || !m.conns) return;
    const t = now();
    let best = null, seen = 0;
    for (const [key, c] of m.conns) {
      const limit = m.uuids.has(key) ? STALE_CONNECTED : c.vc ? STALE_VOICE : STALE_LOOSE;
      if (t - c.seen >= limit) { m.conns.delete(key); continue; }
      seen = Math.max(seen, c.seen);
      if (!best || (!!c.vc !== !!best.vc ? !!c.vc : c.seen > best.seen)) best = c;
    }
    m.seen = seen;
    if (best) { m.vc = best.vc; m.vs = best.vs; m.vss = best.vss; m.st = best.st; }
    else { m.vc = m.vs = m.vss = null; }
  }
  function isOnline(m) {
    if (!m) return false;
    if (m.conns) { settle(m); return m.conns.size > 0; }
    if (!m.seen) return false;
    return now() - m.seen < (m.uuids && m.uuids.size ? STALE_CONNECTED : m.vc ? STALE_VOICE : STALE_LOOSE);
  }

  function touch(sid, body, uuid) {
    const user = cleanUser(body.u);
    if (!user || user.id === me.id) return null;
    const ms = (members[sid] = members[sid] || {});
    const prev = ms[user.id];
    const wasOnline = isOnline(prev);
    const m = prev || { uuids: new Set() };
    m.user = user;
    const vc = isId(body.vc) ? body.vc : null;
    if (!m.conns) m.conns = new Map();
    m.conns.set(uuid || '_', { vc, vs: vc && isId(body.vs) ? body.vs : null, vss: vc && isId(body.vss) ? body.vss : null, st: cleanState(body.st), seen: now() });
    if (uuid) m.uuids.add(uuid);
    settle(m);
    ms[user.id] = m;
    const k = getKnown(sid);
    if (!k[user.id] || k[user.id].name !== user.name || k[user.id].color !== user.color) {
      k[user.id] = user;
      store.set('known.' + sid, k);
      if (sid === cur.sid) renderMessages(); // their old messages pick up the new name / colour
    }
    return { user, wasOnline };
  }

  function onPeerData(sid, p, uuid) {
    if (!p || typeof p !== 'object' || !p.u || typeof p.t !== 'string') return;
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
        if (msg && msg.a.id === t.user.id) {
          const fresh = !(getMsgs(sid)[msg.cid] || []).some((m) => m.id === msg.id);
          if (addMsg(sid, msg)) {
            if (fresh && msg.file && uuid) fileProviders.set(sid + '/' + msg.cid + '/' + msg.id, uuid);
            onNewMsg(sid, msg);
          }
        }
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
      case 'react': {
        if (!isId(p.cid) || !isStr(p.mid, 64) || !isStr(p.e, 16) || !Number.isFinite(+p.v)) break;
        const m = (getMsgs(sid)[p.cid] || []).find((x) => x.id === p.mid);
        if (m && !m.del && mergeRe(m, { [p.e]: { [t.user.id]: +p.v } })) { saveMsgs(sid); renderIfCurrent(sid, p.cid); }
        break;
      }
      case 'imgc':
        onImgChunk(sid, p, uuid);
        break;
      case 'imgreq':
        if (isStr(p.id, 64)) pushImage(sid, p.id, uuid, p.cid, p.mid);
        break;
      case 'f-request':
      case 'f-chunk':
      case 'f-ack':
      case 'f-error':
      case 'f-cancel':
        fileTransfers.onPacket(sid, p, uuid, t.user.id);
        break;
      case 'creact':
        if (isStr(p.e, 16) && voice && voice.sid === sid && p.vc === voice.cid) floatReaction(t.user.id, p.e);
        break;
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
        // only this connection is leaving; the same person may still be here in another tab
        if (m) { if (m.conns) m.conns.delete(uuid || '_'); m.uuids.delete(uuid); settle(m); if (!m.conns || !m.conns.size) m.seen = 0; }
        break;
      }
      case 'ping':
        if (Number.isFinite(p.pt) && uuid) send(sid, { t: 'pong', pt: p.pt }, uuid);
        break;
      case 'pong': {
        const m = members[sid][t.user.id], rtt = now() - p.pt;
        if (m && Number.isFinite(rtt) && rtt >= 0 && rtt < 60000) { m.rtt = m.rtt ? m.rtt * 0.6 + rtt * 0.4 : rtt; m.rttAt = now(); }
        break;
      }
    }
    if (sid === cur.sid && p.t !== 'imgc' && !p.t?.startsWith('f-')) renderPresence();
  }

  function mergeServer(sid, def) {
    const d = cleanServerDef(def);
    const s = server(sid);
    if (!d || !s || d.id !== sid || d.v <= s.v) return;
    const removed = s.channels.filter((c) => !d.channels.some((next) => next.id === c.id && next.type === c.type));
    s.name = d.name; s.channels = d.channels; s.v = d.v;
    removed.forEach((c) => releaseChannelFiles(sid, c.id));
    saveServers();
    if (voice && voice.sid === sid && !channel(s, voice.cid)) leaveVoice();
    if (cur.sid === sid && (!channel(s, cur.cid) || removed.some((c) => c.id === cur.cid))) {
      selectChannel((s.channels.find((c) => c.type === 'text') || s.channels[0] || {}).id || null);
    }
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
      if (old.a.id !== m.a.id) return false;
      if (old.del) return false;
      if (m.del) { list[i] = m; fileTransfers.release(sid, m.cid, m.id); cancelImageRequests(sid, m.cid, m.id); fileProviders.delete(sid + '/' + m.cid + '/' + m.id); saveMsgs(sid); return true; }
      let changed = false;
      if (m.ed && m.text !== old.text) { list[i] = { ...old, text: m.text, ed: 1 }; changed = true; }
      if (!old.img && m.img && (!old.file || (m.file && m.file.id === old.file.id && window.DischordImages.isImage(old.file) && m.img.preview === 1))) {
        list[i] = { ...list[i], img: m.img };
        changed = true;
      }
      if (m.re && mergeRe(list[i], m.re)) changed = true;
      if (changed) saveMsgs(sid);
      return changed;
    }
    let j = list.length;
    while (j > 0 && list[j - 1].ts > m.ts) j--;
    list.splice(j, 0, m);
    if (list.length > MAX_MSGS) list.splice(0, list.length - MAX_MSGS).forEach((old) => {
      fileTransfers.release(sid, old.cid, old.id);
      cancelImageRequests(sid, old.cid, old.id);
      fileProviders.delete(sid + '/' + old.cid + '/' + old.id);
    });
    saveMsgs(sid);
    return true;
  }

  // reactions: per (emoji, user) last-writer-wins; value = +ts (on) / -ts (off)
  function mergeRe(target, re) {
    let changed = false;
    target.re = target.re || {};
    for (const e in re) {
      for (const u in re[e]) {
        const v = re[e][u], cv = (target.re[e] || {})[u];
        if (cv === undefined || Math.abs(v) > Math.abs(cv)) { (target.re[e] = target.re[e] || {})[u] = v; changed = true; }
      }
    }
    return changed;
  }
  function toggleReaction(mid, e) {
    const list = getMsgs(cur.sid)[cur.cid] || [];
    const m = list.find((x) => x.id === mid);
    if (!m || m.del) return;
    const on = !(((m.re || {})[e] || {})[me.id] > 0);
    const v = on ? now() : -now();
    mergeRe(m, { [e]: { [me.id]: v } });
    saveMsgs(cur.sid);
    send(cur.sid, { t: 'react', cid: cur.cid, mid, e, v });
    renderMessages();
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
    const c = channel(s, cur.cid);
    if (!s || !c || c.type !== 'text') return false;
    text = text.replace(/\s+$/, '').replace(/^\n+/, '');
    if (!text && !pending.length) return false;
    if (text.length > 4000) { toast('Message is too long (4000 characters max).'); return false; }
    const attachments = [...pending];
    const reply = replyTarget && replyTarget.sid === cur.sid && replyTarget.cid === cur.cid ? replyTarget.reply : undefined;
    const parts = attachments.length ? attachments.map((att, i) => ({ att, text: i === attachments.length - 1 ? text : '' })) : [{ text }];
    let sent = 0;
    for (const part of parts) {
      const m = { id: me.id + rid(8), cid: cur.cid, ts: now(), a: me, text: part.text, reply };
      if (part.att) {
        m.file = part.att.meta;
        if (!fileTransfers.register(s.id, cur.cid, m.id, m.file, part.att.file)) {
          toast('Too many available files in this tab. Delete an older file message, then send again.');
          break;
        }
        pending.shift();
      }
      addMsg(s.id, m);
      send(s.id, { t: 'msg', m });
      if (part.att && window.DischordImages.isImage(m.file)) prepareImagePreview(s.id, m.cid, m.id, part.att);
      sent++;
    }
    if (sent === parts.length) cancelReply();
    renderAttachBar();
    markRead(s.id, cur.cid);
    lastTypingSent = 0;
    renderMessages(true);
    return sent === parts.length;
  }

  function replyToMessage(mid) {
    const m = (getMsgs(cur.sid)[cur.cid] || []).find((x) => x.id === mid);
    if (!m || m.del) return;
    replyTarget = { sid: cur.sid, cid: cur.cid, reply: {
      id: m.id, a: { ...m.a }, text: m.text.replace(/\s+/g, ' ').slice(0, 240),
      attachment: m.file ? m.file.name : m.img ? 'Image' : undefined,
    } };
    renderReplyBar();
    $('msgInput').focus();
  }
  function cancelReply() { replyTarget = null; renderReplyBar(); }
  function renderReplyBar() {
    const r = replyTarget && replyTarget.sid === cur.sid && replyTarget.cid === cur.cid ? replyTarget.reply : null;
    const bar = $('replyBar');
    bar.classList.toggle('hidden', !r);
    bar.innerHTML = r ? `<span>Replying to <b>${esc(r.a.name)}</b></span><span class="reply-excerpt">${esc(r.text || r.attachment || 'Message')}</span><button type="button" class="icon-btn" id="cancelReplyBtn" title="Cancel reply">${icon('x')}</button>` : '';
  }

  function saveComposerDraft() {
    if (channel(server(cur.sid), cur.cid)?.type !== 'text') return;
    composerDrafts.set(cur.sid + '/' + cur.cid, { text: $('msgInput').value, pending: [...pending], replyTarget });
  }
  function restoreComposerDraft() {
    const key = cur.sid + '/' + cur.cid;
    const d = composerDrafts.get(key);
    composerDrafts.delete(key); // the active composer owns these references until navigation
    $('msgInput').value = d ? d.text : '';
    syncComposer(); closeMention();
    pending.splice(0, pending.length, ...(d ? d.pending : []));
    replyTarget = d ? d.replyTarget : null;
    renderReplyBar(); renderAttachBar();
  }
  function releaseChannelFiles(sid, cid) {
    cancelImageRequests(sid, cid);
    for (const m of getMsgs(sid)[cid] || []) fileTransfers.release(sid, cid, m.id);
    const prefix = sid + '/' + cid + '/';
    for (const key of fileProviders.keys()) if (key.startsWith(prefix)) fileProviders.delete(key);
    composerDrafts.delete(sid + '/' + cid);
    if (cur.sid === sid && cur.cid === cid) {
      $('msgInput').value = '';
      pending.splice(0, pending.length);
      replyTarget = null;
    }
  }

  function deleteMessage(id) {
    const list = getMsgs(cur.sid)[cur.cid] || [];
    const m = list.find((x) => x.id === id);
    if (!m || m.a.id !== me.id) return;
    const d = { id: m.id, cid: m.cid, ts: m.ts, a: me, del: true, text: '' };
    addMsg(cur.sid, d);
    fileTransfers.release(cur.sid, cur.cid, id);
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
      const n = new Notification(`${m.a.name} (#${c.name}, ${s.name})`, { body: (m.text || (m.file ? '📎 ' + m.file.name : m.img ? '📷 Image' : '')).slice(0, 200), tag: sid + m.cid });
      n.onclick = () => { window.focus(); selectServer(sid); selectChannel(m.cid); };
    } catch { }
  }

  // ---------------------------------------------------------------- files (metadata offers; bytes move only on Download)
  function saveFileDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.hidden = true;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function openFileDownload(meta, strategy) {
    if (!strategy.stream || typeof window.showSaveFilePicker !== 'function') return null;
    // Open within the Download click, before awaiting anything, to retain user activation.
    const selection = window.showSaveFilePicker({ suggestedName: meta.name, id: 'dischord-download' });
    return selection.then(async (handle) => {
      const writer = await handle.createWritable({ keepExistingData: false });
      return {
        write: (bytes) => writer.write(bytes),
        close: () => writer.close(),
        abort: () => writer.abort(),
      };
    });
  }
  const filePaints = new Map();
  let filePaintTimer = null;
  function queueFileCardPaint(sid, cid, mid) {
    if (sid !== cur.sid || cid !== cur.cid) return;
    const key = sid + '/' + cid + '/' + mid;
    const status = fileTransfers.status(sid, cid, mid);
    if (status.state !== 'receiving' || status.progress === 0) {
      filePaints.delete(key);
      paintFileCards(mid); // start, completion and errors are shown immediately
      return;
    }
    filePaints.set(key, { sid, cid, mid });
    if (filePaintTimer !== null) return;
    filePaintTimer = setTimeout(() => {
      filePaintTimer = null;
      const updates = [...filePaints.values()];
      filePaints.clear();
      for (const update of updates) {
        if (update.sid === cur.sid && update.cid === cur.cid) paintFileCards(update.mid);
      }
    }, 100);
  }
  const fileTransfers = window.DischordFiles.create({
    send,
    getMessage: (sid, cid, mid) => channel(server(sid), cid)?.type === 'text' ? (getMsgs(sid)[cid] || []).find((m) => m.id === mid) : undefined,
    isPeer: (sid, uid, uuid) => peers[sid] && peers[sid].get(uuid)?.uid === uid,
    resolvePeer: (sid, uid, cid, mid) => {
      const origin = fileProviders.get(sid + '/' + cid + '/' + mid);
      if (origin && peers[sid]?.get(origin)?.uid === uid) return origin;
      const matches = [...(peers[sid] || new Map())].filter(([, p]) => p.uid === uid);
      return matches.length ? matches[0][0] : null;
    },
    userId: () => me && me.id,
    randomId: () => rid(20),
    onChange: queueFileCardPaint,
    saveDownload: saveFileDownload,
    openDownload: openFileDownload,
    maxWindow: () => voice ? 32 : window.DischordFiles.MAX_WINDOW,
  });

  // Only image previews use this cache; original file offers remain opt-in downloads.
  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('dischord-img' + (PROFILE ? '-' + PROFILE : ''), 1);
      r.onupgradeneeded = () => r.result.createObjectStore('i');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    return {
      async get(k) {
        try {
          const db = await open();
          return await new Promise((res) => { const q = db.transaction('i').objectStore('i').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); });
        } catch { return undefined; }
      },
      async put(k, url) {
        // Only image previews may be written here; file bytes never touch browser storage.
        if (typeof url !== 'string' || !url.startsWith('data:image/')) return false;
        try {
          const db = await open();
          return await new Promise((res) => {
            const tx = db.transaction('i', 'readwrite');
            tx.objectStore('i').put(url, k);
            tx.oncomplete = () => res(true);
            tx.onerror = tx.onabort = () => res(false);
          });
        } catch { return false; }
      },
      // Older versions (v12) stored whole files here: delete anything that is not an image.
      async purgeFiles() {
        try {
          const db = await open();
          return await new Promise((res) => {
            const tx = db.transaction('i', 'readwrite'), os = tx.objectStore('i');
            os.openCursor().onsuccess = (e) => {
              const c = e.target.result;
              if (!c) return;
              if (typeof c.value !== 'string' || !c.value.startsWith('data:image/')) c.delete();
              c.continue();
            };
            tx.oncomplete = () => res(true);
            tx.onerror = tx.onabort = () => res(false);
          });
        } catch { return false; }
      },
    };
  })();
  if (!store.get('filesPurged', false)) idb.purgeFiles().then((ok) => { if (ok) store.set('filesPurged', true); });

  const imageKey = (sid, m) => sid + '/' + m.cid + '/' + m.id + '/' + m.img.id;
  const imageMessageKey = (sid, cid, mid) => sid + '/' + cid + '/' + mid;
  const imagePreparing = new Set(), imageErrors = new Set(), imageRetryAfter = new Map();
  function cacheImage(key, url) {
    imgCache.delete(key);
    imgCache.set(key, url);
    let length = [...imgCache.values()].reduce((total, value) => total + value.length, 0);
    while (imgCache.size > 64 || length > 32000000) {
      const first = imgCache.keys().next().value;
      length -= imgCache.get(first).length;
      imgCache.delete(first);
    }
  }
  function findImageMessage(sid, id, cid, mid) {
    if (!server(sid)) return null;
    const all = getMsgs(sid);
    for (const channelId of cid ? [cid] : Object.keys(all)) {
      if (channel(server(sid), channelId)?.type !== 'text') continue;
      const m = (all[channelId] || []).find((m) => !m.del && m.img && m.img.id === id && (!mid || m.id === mid));
      if (m && (m.file ? window.DischordImages.isImage(m.file) && m.img.preview === 1 : !m.img.preview)) return m;
    }
    return null;
  }
  function validImageURL(url, descriptor) {
    if (typeof url !== 'string' || url.length !== descriptor.n) return false;
    if (descriptor.preview) return window.DischordImages.validURL(url);
    return url.length <= IMG_MAX && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(url);
  }
  function imageStillLive(sid, m) {
    const current = findImageMessage(sid, m.img.id, m.cid, m.id);
    return current && current.img.n === m.img.n && current.img.preview === m.img.preview;
  }
  async function getImg(sid, m) {
    const key = imageKey(sid, m);
    if (imgCache.has(key)) return imgCache.get(key);
    let url = await idb.get(key);
    // Older versions stored images by global ID. Only existing saved legacy
    // associations may migrate one; a fresh packet in another server cannot.
    if (!url && !m.file && legacyImageKeys.has(key)) url = await idb.get(m.img.id);
    if (validImageURL(url, m.img)) cacheImage(key, url); else url = undefined;
    return url;
  }
  async function prepareImagePreview(sid, cid, mid, attachment) {
    const key = imageMessageKey(sid, cid, mid);
    const live = () => {
      if (!server(sid) || channel(server(sid), cid)?.type !== 'text') return null;
      const m = (getMsgs(sid)[cid] || []).find((m) => m.id === mid && !m.del);
      return m && m.file && m.file.id === attachment.meta.id && fileTransfers.hasLocal(sid, cid, mid) ? m : null;
    };
    imagePreparing.add(key);
    try {
      if (!live()) return;
      const preview = await window.DischordImages.createPreview(attachment.file);
      let current = live();
      if (!current) return;
      const img = cleanImg({ ...preview, id: rid(16) });
      if (!img || !img.preview || !validImageURL(preview.url, img)) throw new Error('Could not create the image preview.');
      const cacheKey = imageKey(sid, { ...current, img });
      cacheImage(cacheKey, preview.url);
      await idb.put(cacheKey, preview.url);
      current = live();
      if (!current) { imgCache.delete(cacheKey); return; }
      // Use the current caption/reply/edited state after asynchronous decoding.
      const updated = { ...current, img };
      if (addMsg(sid, updated)) {
        imageErrors.delete(key);
        send(sid, { t: 'edit', m: updated });
        renderIfCurrent(sid, cid);
      }
    } catch {
      if (live()) { imageErrors.add(key); renderIfCurrent(sid, cid); }
    } finally {
      imagePreparing.delete(key);
      if (live()) renderIfCurrent(sid, cid);
    }
  }

  const sleep = (ms) => bgTimer.sleep(ms);
  const pushing = new Map();   // id/uuid -> ts (avoid duplicate sends)
  async function pushImage(sid, id, uuid, cid, mid) {
    if (!uuid) return;
    const m = findImageMessage(sid, id, cid, mid);
    if (!m) return;
    const k = imageKey(sid, m) + '/' + uuid;
    if (pushing.has(k) && now() - pushing.get(k) < 20000) return;
    const url = await getImg(sid, m);
    if (!url || !imageStillLive(sid, m)) return;
    pushing.set(k, now());
    const n = Math.ceil(url.length / IMG_CHUNK);
    for (let i = 0; i < n; i++) {
      if (!imageStillLive(sid, m)) return;
      if (!send(sid, { t: 'imgc', id, cid: m.cid, mid: m.id, i, n, d: url.slice(i * IMG_CHUNK, (i + 1) * IMG_CHUNK) }, uuid)) return;
      if (i % 6 === 5) await sleep(15); // don't flood the data channel
    }
  }

  const incoming = {};         // scoped image key -> { n, parts, got }
  const requested = {};        // scoped image key -> preview request + optional download intent
  function onImgChunk(sid, p, uuid) {
    if (!isStr(p.id, 64) || !uuid) return;
    const candidates = Object.values(requested).filter((r) => r.sid === sid && r.id === p.id && (!p.cid || r.cid === p.cid) && (!p.mid || r.mid === p.mid));
    if (candidates.length !== 1) return;
    const request = candidates[0];
    const m = findImageMessage(sid, p.id, request.cid, request.mid);
    if (!m || m.img.n !== request.length || (request.uuid && request.uuid !== uuid)) return;
    if (m.img.preview && (p.cid !== request.cid || p.mid !== request.mid)) return;
    const count = Math.ceil(m.img.n / IMG_CHUNK);
    if (!Number.isInteger(p.i) || p.n !== count || p.i < 0 || p.i >= count || typeof p.d !== 'string' || p.d.length !== Math.min(IMG_CHUNK, m.img.n - p.i * IMG_CHUNK)) return;
    request.uuid = uuid;
    const b = (incoming[request.key] = incoming[request.key] || { n: p.n, parts: new Array(p.n), got: 0 });
    if (b.n !== p.n || b.parts[p.i] !== undefined) return;
    b.parts[p.i] = p.d; b.got++;
    armImageRequest(request, 20000); // data is flowing: only a stall ends the request, not the total time
    if (b.got < b.n) {
      if (b.got % 8 === 0) imageProgress(request, Math.round(b.got / b.n * 100));
      return;
    }
    const url = b.parts.join('');
    delete incoming[request.key];
    clearTimeout(request.timer); delete requested[request.key];
    if (!validImageURL(url, m.img)) return;
    cacheImage(request.key, url);
    idb.put(request.key, url);
    imageErrors.delete(imageMessageKey(sid, m.cid, m.id));
    imageRetryAfter.delete(imageMessageKey(sid, m.cid, m.id));
    paintImages();
  }
  function requestImg(sid, id, cid, mid, force = false) {
    const m = findImageMessage(sid, id, cid, mid);
    if (!m) return;
    const key = imageKey(sid, m);
    if (requested[key]) return;
    if (Object.keys(requested).length >= 4) return; // bound preview buffers and mesh traffic
    const messageKey = imageMessageKey(sid, m.cid, m.id);
    if (!force && (imageRetryAfter.get(messageKey) || 0) > now()) return;
    requested[key] = { key, sid, id, cid: m.cid, mid: m.id, length: m.img.n, messageKey, timer: null };
    armImageRequest(requested[key], 10000); // nobody who has it is online: free the slot quickly for other images
    send(sid, { t: 'imgreq', id, cid: m.cid, mid: m.id });
  }
  function armImageRequest(request, ms) {
    clearTimeout(request.timer);
    request.timer = setTimeout(() => {
      if (requested[request.key] !== request) return;
      delete requested[request.key]; delete incoming[request.key];
      imageErrors.add(request.messageKey);
      imageRetryAfter.set(request.messageKey, now() + 15000);
      renderIfCurrent(request.sid, request.cid);
    }, ms);
  }
  function imageProgress(request, pct) {
    if (request.sid !== cur.sid || request.cid !== cur.cid) return;
    document.querySelectorAll('img[data-img]:not([src])').forEach((el) => {
      if (el.dataset.imgMid !== request.mid) return;
      const status = el.parentElement.querySelector('.image-preview-status');
      if (status) status.textContent = `Loading image… ${pct}%`;
    });
  }
  function cancelImageRequests(sid, cid, mid) {
    for (const [key, request] of Object.entries(requested)) {
      if ((sid && request.sid !== sid) || (cid && request.cid !== cid) || (mid && request.mid !== mid)) continue;
      clearTimeout(request.timer);
      delete requested[key]; delete incoming[key];
    }
    const prefix = sid ? sid + '/' + (cid ? cid + '/' + (mid ? mid + '/' : '') : '') : '';
    for (const key of imgCache.keys()) if (key.startsWith(prefix)) imgCache.delete(key);
    for (const key of imageErrors) if ((key + '/').startsWith(prefix)) imageErrors.delete(key);
    for (const key of imageRetryAfter.keys()) if ((key + '/').startsWith(prefix)) imageRetryAfter.delete(key);
  }
  function paintImages() {
    // newest first: the picture someone just sent must not wait behind old ones nobody online still has
    [...document.querySelectorAll('img[data-img]:not([src])')].reverse().forEach(async (el) => {
      const sid = el.dataset.imgSid, cid = el.dataset.imgCid, mid = el.dataset.imgMid;
      const m = findImageMessage(sid, el.dataset.img, cid, mid);
      if (!m) return;
      const url = await getImg(sid, m);
      if (!imageStillLive(sid, m)) return;
      if (url) {
        const status = el.parentElement.querySelector('.image-preview-status');
        el.onload = () => {
          // size the box from the real picture, so a wrong or outdated descriptor can never letterbox or crop it
          if (el.naturalWidth && el.naturalHeight && el.parentElement.style) {
            const k = Math.min(1, 550 / el.naturalWidth, 350 / el.naturalHeight);
            el.parentElement.style.aspectRatio = el.naturalWidth + ' / ' + el.naturalHeight;
            el.parentElement.style.width = `min(100%, ${Math.max(48, Math.round(el.naturalWidth * k))}px)`;
          }
          el.parentElement.classList.remove('loading');
          imageErrors.delete(imageMessageKey(sid, cid, mid));
          if (status) status.hidden = true;
        };
        el.onerror = () => {
          imageErrors.add(imageMessageKey(sid, cid, mid));
          el.hidden = true;
          el.parentElement.classList.remove('loading');
          if (status) { status.hidden = false; status.textContent = 'Image preview unavailable.'; }
        };
        el.src = url;
        // the load event can be held back while the page is hidden; decoding is not
        if (typeof el.decode === 'function') el.decode().then(() => { if (el.onload) el.onload(); }, () => {});
      } else requestImg(sid, m.img.id, cid, mid);
    });
  }

  const pending = [];          // selected File references; no reading, encoding or persistence
  function addAttachments(files) {
    const s = server(cur.sid), c = channel(s, cur.cid);
    if (!c || c.type !== 'text') return;
    for (const f of [...files].slice(0, 4)) {
      if (pending.length >= 4) { toast('Up to 4 files per message.'); break; }
      const meta = window.DischordFiles.cleanMeta({ id: rid(16), name: f.name, size: f.size, type: f.type });
      if (!meta) { toast('Could not attach that file. Its name or size is invalid.'); continue; }
      pending.push({ meta, file: f });
    }
    renderAttachBar();
    $('msgInput').focus();
  }
  function renderAttachBar() {
    const bar = $('attachBar');
    bar.classList.toggle('hidden', !pending.length);
    bar.innerHTML = pending.map((att, i) => `<div class="att file">${icon('file')}<span class="att-name" title="${esc(att.meta.name)}">${esc(att.meta.name)}</span><span class="att-size">${esc(window.DischordFiles.formatSize(att.meta.size))}</span><button type="button" class="att-x" data-rm="${i}" title="Remove">${icon('x')}</button></div>`).join('') +
      (pending.length ? '<span class="attachment-note">Images show previews automatically.<br>Files are shared on Download. Keep this tab open.</span>' : '');
  }
  // Images are shared as the preview itself (full quality, up to the preview cap): saving writes that data.
  async function saveImage(sid, cid, mid) {
    const m = (getMsgs(sid)[cid] || []).find((x) => x.id === mid && !x.del && x.img);
    if (!m) return;
    const url = await getImg(sid, m);
    if (!url) { requestImg(sid, m.img.id, cid, mid, true); toast('Image is still loading. Try again in a moment.'); return; }
    const ext = (url.match(/^data:image\/(\w+)/) || [, 'png'])[1].replace('jpeg', 'jpg');
    const base = m.file ? m.file.name.replace(/\.[^.]*$/, '') : 'image';
    try {
      const bin = atob(url.slice(url.indexOf(',') + 1)), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      saveFileDownload(new Blob([bytes], { type: 'image/' + ext }), (base || 'image') + '.' + ext);
    } catch { toast('Could not save that image.'); }
  }
  async function copyImage(sid, cid, mid) {
    const m = (getMsgs(sid)[cid] || []).find((x) => x.id === mid && !x.del && x.img);
    const url = m && await getImg(sid, m);
    if (!url) return toast('Image is still loading. Try again in a moment.');
    try {
      // the clipboard only takes PNG, so redraw the shared image
      const im = new Image();
      im.src = url;
      await im.decode();
      const c = document.createElement('canvas');
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Image copied');
    } catch { toast('Could not copy the image. Your browser may not allow it.'); }
  }
  async function openImage(sid, cid, mid) {
    const m = (getMsgs(sid)[cid] || []).find((m) => m.id === mid && !m.del && m.img);
    if (!m) return;
    const url = await getImg(sid, m);
    if (!imageStillLive(sid, m)) return;
    if (!url) { requestImg(sid, m.img.id, cid, mid, true); return; }
    modal(`<div class="lightbox"><img src="${esc(url)}" alt="${esc(m.file ? m.file.name : 'Shared image')}"></div>
      <div class="actions"><button class="btn" id="saveOpenImage">Download</button><button class="btn primary" data-close>Close</button></div>`, () => {
      $('saveOpenImage').onclick = () => saveImage(sid, cid, mid);
    }, true, true);
    $('modal').classList.add('lb');
  }

  function fileCardContent(sid, m) {
    const status = fileTransfers.status(sid, m.cid, m.id);
    const active = status.state === 'receiving' || status.state === 'preparing';
    const saving = status.state === 'saving';
    const unavailable = m.a.id === me.id && !fileTransfers.hasLocal(sid, m.cid, m.id);
    const large = window.DischordFiles.strategyFor(m.file.size).stream && m.a.id !== me.id;
    const size = window.DischordFiles.formatSize(m.file.size) + (large ? (typeof window.showSaveFilePicker === 'function'
      ? ' · you choose a save location when downloading' : ' · large file: uses browser memory here') : '');
    const sub = status.state === 'preparing' ? 'Choose where to save this file…' : saving ? 'Saving file…'
      : active ? `Downloading ${Math.round(status.progress)}%` : status.state === 'error' ? status.message
      : status.state === 'complete' ? status.message || 'Saved'
      : unavailable ? 'Unavailable after reload. Attach it again.' : size;
    const btn = active ? `<button type="button" class="icon-btn" data-file-cancel="${esc(m.id)}" title="Cancel">${icon('x')}</button>`
      : `<button type="button" class="icon-btn" data-file-download="${esc(m.id)}" title="${status.state === 'error' ? 'Retry download' : 'Download'}" ${unavailable || saving ? 'disabled' : ''}>${icon('download')}</button>`;
    return `${icon('file')}<div class="mf-text"><div class="mf-name" title="${esc(m.file.name)}">${esc(m.file.name)}</div><div class="mf-sub" role="status">${esc(sub)}</div></div>${btn}`;
  }
  function paintFileCards(mid) {
    document.querySelectorAll('[data-file-card]').forEach((el) => {
      if (el.dataset.fileCard !== mid) return;
      const m = (getMsgs(cur.sid)[cur.cid] || []).find((x) => x.id === el.dataset.fileCard);
      if (m && !m.del && m.file) {
        const html = fileCardContent(cur.sid, m);
        if (el.innerHTML !== html) el.innerHTML = html;
      }
    });
  }

  // ---------------------------------------------------------------- voice
  // The publisher sends my mic/camera/screen and plays everyone's audio (&novideo: no video in).
  function voiceUrl(s, c, withCam, vs, ssVs = vs + 's') {
    const p = new URLSearchParams({ room: roomFor(s, 'v' + c.id), password: s.key, label: me.name, push: vs });
    let u = VDO + '?' + p.toString();
    u += '&autostart&webcam&novideo&nocontrolbar&hideheader&chatbutton=false&nohangupbutton';
    u += `&audiogain=${audioPercent(av.micGain)}`;
    if (store.get('micLabel', '')) u += '&audiodevice=' + encodeURIComponent(store.get('micLabel', '')); // remembered microphone; falls back to default if unplugged
    if (store.get('outLabel', '')) u += '&outputdevice=' + encodeURIComponent(store.get('outLabel', '')); // remembered speakers / headphones
    u += withCam ? `&quality=${CAM_Q[av.camQ] ?? 1}&maxframerate=${av.camFps}` + (store.get('camLabel', '') ? '&videodevice=' + encodeURIComponent(store.get('camLabel', '')) : '') : '&videodevice=0';
    u += `&screensharequality=${SS_Q[av.ssQ] ?? 0}&screensharefps=${av.ssFps}`;
    u += `&maxvideobitrate=${av.camBr}&exclude=${ssVs}`; // preserve exclusion when camera reconnects during a share
    if (!micOn || deaf) u += '&mute';
    if (deaf) u += '&mutespeaker';
    return u;
  }

  // Screen share is its own stream (so it never replaces the camera). It only sends; it plays nothing.
  function screenUrl(ssVs) {
    const s = server(voice.sid);
    const p = new URLSearchParams({ room: roomFor(s, 'v' + voice.cid), password: s.key, label: me.name + ' (screen)', push: ssVs });
    const q = SS_Q[av.ssQ] ?? 0, hint = av.ssHint === 'detail' ? 'detail' : 'motion';
    // Both primary and secondary capture parameters support older self-hosted VDO.Ninja versions.
    // The target bitrate is separate from the publisher cap; motion lets encoding favor the selected FPS.
    return VDO + '?' + p.toString() + `&screenshare&autostart&noaudio&novideo&nopreview&nocontrolbar&hideheader&chatbutton=false&nohangupbutton` +
      `&quality=${q}&screensharequality=${q}&maxframerate=${av.ssFps}&screensharefps=${av.ssFps}` +
      `&outboundvideobitrate=${av.ssBr}&maxvideobitrate=${av.ssBr}&screensharecontenthint=${hint}&contenthint=${hint}`;
  }

  // Each video/screen on the stage is its own view-only connection, so we control layout + bitrate.
  function viewUrl(vs, br, scale) {
    const p = new URLSearchParams({ view: vs, room: roomFor(server(voice.sid), 'v' + voice.cid), password: server(voice.sid).key });
    // &scale=100: don't let VDO.Ninja downscale to the tile size (that was the blur)
    // a scale below 100 asks the sender to encode a smaller copy for this viewer (cheap self preview)
    return VDO + '?' + p.toString() + '&solo&noaudio&cleanoutput&nocontrolbar&hideheader' + (scale && scale < 100 ? `&scale=${scale}` : '&scale=100&sharperscreen') +
      (br ? `&bitrate=${br}` : '') + (av.codec ? `&codec=${av.codec}` : '');
  }

  function joinVoice(sid, cid, withCam) {
    const s = server(sid), c = channel(s, cid);
    if (!s || !c || c.type !== 'voice') return;
    const rejoin = voice && voice.sid === sid && voice.cid === cid;
    const keepShare = rejoin ? { ssFrame: voice.ssFrame, ss: voice.ss, ssVs: voice.ssVs, ssTimer: voice.ssTimer, ssSettings: voice.ssSettings } : null;
    if (voice) { dropVoiceFrame(); if (!rejoin) stopShare(true); }
    const vs = 'dc' + me.id.slice(0, 10) + rid(5);
    const f = document.createElement('iframe');
    f.allow = 'autoplay; camera; microphone; display-capture; fullscreen; picture-in-picture; clipboard-write';
    f.title = 'Voice connection';
    const call = { sid, cid, iframe: f, cam: !!withCam, ss: false, vs, ssFrame: null, ssVs: vs + 's', timers: new Set(), ...(keepShare || {}) };
    voice = call;
    for (const k in sentVol) delete sentVol[k];
    f.addEventListener('load', () => {
      if (voice !== call) return;
      // load can precede media setup; also replay on VDO.Ninja's media-ready events.
      for (const delay of [0, 1000, 2500, 5000]) scheduleVoice(call, () => {
        if (!call.loudnessReady) call.loudnessRequested = false;
        syncVoiceState(call);
      }, delay);
    });
    const load = () => { f.src = voiceUrl(s, c, withCam, vs, call.ssVs); };
    // Keep the first navigation in the join gesture. Rejoins let the old device close first.
    if (rejoin) scheduleVoice(call, load, 500); else load();
    $('pubHost').appendChild(f);
    broadcastState();
    if (!rejoin) playTone(true);
    render();
  }

  function dropVoiceFrame() {
    if (!voice) return;
    voice.timers.forEach(clearTimeout);
    voice.timers.clear();
    const f = voice.iframe;
    try { f.contentWindow.postMessage({ function: 'eval', value: 'if (window.__dischordAudioGainV1) window.__dischordAudioGainV1.close();' }, '*'); } catch { }
    try { f.contentWindow.postMessage({ close: true }, '*'); } catch { }
    setTimeout(() => f.remove(), 300);
  }

  function leaveVoice() {
    if (!voice) return;
    dropVoiceFrame();
    stopShare(true);
    voice = null;
    focusUid = null;
    for (const k in speaking) delete speaking[k];
    broadcastState();
    playTone(false);
    render();
  }

  function voicePost(o) { if (voice && voice.iframe.contentWindow) voice.iframe.contentWindow.postMessage(o, '*'); }

  // Executed through VDO.Ninja's documented iframe eval API. Only this fixed function
  // and a JSON object of clamped numeric preferences cross the iframe boundary.
  function vdoAudioGainBridge(config) {
    if (typeof session === 'undefined' || !session) return;
    const s = session;
    const limit = (n, maximum, fallback) => typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(maximum, n)) : fallback;
    s.audioGain = limit(config.micGain, 200, 100);
    if (typeof changeMainGain === 'function') changeMainGain(s.audioGain);
    let bridge = window.__dischordAudioGainV1;
    if (!bridge) {
      if (typeof addAudioPipeline !== 'function') return;
      const original = addAudioPipeline;
      bridge = { streams: {}, deaf: false, records: new Map() };
      bridge.volume = (peer) => bridge.deaf ? 0 : limit(bridge.streams[peer.streamID], 2, 1);
      bridge.dispose = (record) => {
        if (!record) return;
        try { if (record.source) record.source.disconnect(); } catch { }
        try { if (record.gain) record.gain.disconnect(); } catch { }
        // These are our destination tracks, never VDO's original or processed inputs.
        try { if (record.track) record.track.stop(); } catch { }
      };
      const wrapped = function (uuid, track) {
        const processed = original.apply(this, arguments);
        const peer = s.rpcs && s.rpcs[uuid];
        if (!peer || !processed || processed.kind !== 'audio') return processed;
        bridge.dispose(bridge.records.get(uuid));
        bridge.records.delete(uuid);
        const volume = bridge.volume(peer);
        if (volume <= 1) return processed;
        const context = s.audioCtx;
        if (!context || typeof context.createMediaStreamSource !== 'function') return processed;
        const record = { peer, input: processed, source: null, gain: null, track: null };
        try {
          record.source = context.createMediaStreamSource(new MediaStream([processed]));
          record.gain = context.createGain();
          const destination = context.createMediaStreamDestination();
          record.track = destination.stream.getAudioTracks()[0];
          if (!record.track) throw new Error('No destination audio track');
          record.gain.gain.setValueAtTime(volume, context.currentTime);
          record.source.connect(record.gain);
          record.gain.connect(destination);
          bridge.records.set(uuid, record);
          if (context.state === 'suspended') Promise.resolve(context.resume()).catch(() => {});
          // VDO attaches this to its existing media element, retaining mute and sinkId.
          return record.track;
        } catch {
          bridge.dispose(record);
          return processed;
        }
      };
      addAudioPipeline = wrapped;
      bridge.close = () => {
        if (addAudioPipeline === wrapped) addAudioPipeline = original;
        bridge.records.forEach(bridge.dispose);
        bridge.records.clear();
        delete window.__dischordAudioGainV1;
      };
      window.__dischordAudioGainV1 = bridge;
      window.addEventListener('pagehide', bridge.close, { once: true });
    }
    bridge.streams = config.streams || {};
    bridge.deaf = !!config.deaf;
    for (const [uuid, record] of bridge.records) {
      const peer = s.rpcs && s.rpcs[uuid];
      const tracks = peer && peer.videoElement && peer.videoElement.srcObject && peer.videoElement.srcObject.getAudioTracks();
      if (peer !== record.peer || record.input.readyState === 'ended' || !tracks || !tracks.some((track) => track.id === record.track.id)) {
        bridge.dispose(record);
        bridge.records.delete(uuid);
      }
    }
    for (const uuid in s.rpcs || {}) {
      const peer = s.rpcs[uuid];
      if (!peer || !peer.videoElement) continue;
      const volume = bridge.volume(peer);
      let record = bridge.records.get(uuid);
      if (!record && volume > 1 && typeof updateIncomingAudioElement === 'function') {
        // Some hosts install loudness later. Activate their native pipeline for this
        // synchronous rebuild, then restore the host's processing preference.
        const effects = s.audioEffects;
        try { s.audioEffects = true; updateIncomingAudioElement(uuid); } catch { }
        finally { s.audioEffects = effects; }
        record = bridge.records.get(uuid);
      }
      if (record) {
        try { record.gain.gain.setValueAtTime(volume === 0 ? 0 : Math.max(1, volume), s.audioCtx.currentTime); } catch { }
      }
      try { peer.videoElement.volume = Math.min(1, volume); } catch { }
    }
  }

  function scheduleVoice(call, fn, delay) {
    const timer = setTimeout(() => {
      call.timers.delete(timer);
      if (voice === call) fn();
    }, delay);
    call.timers.add(timer);
  }

  function syncVoiceState(call = voice) {
    if (!call || voice !== call) return;
    voicePost({ mic: micOn && !deaf });
    voicePost({ mute: deaf }); // speaker state is independent of the microphone
    applyVolumes(true); // install the audio hook before subscribing to native loudness
    if (!call.loudnessRequested) {
      call.loudnessRequested = true; // set before sending: older hosts can emit a media-ready event here
      voicePost({ getLoudness: true });
    }
  }

  function setMicGain(value) {
    av.micGain = audioPercent(value);
    store.set('av', av);
    applyVolumes(true);
  }

  function toggleMic() {
    if (deaf) { deaf = false; micOn = true; }
    else micOn = !micOn;
    syncVoiceState();
    store.set('micOn', micOn); store.set('deaf', deaf);
    broadcastState();
    renderControls(); renderPresence();
  }
  function toggleDeaf() {
    deaf = !deaf;
    syncVoiceState();
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
    if (voice.ssFrame) return stopShare();
    const ssVs = voice.ssVs;
    const f = document.createElement('iframe');
    f.allow = 'autoplay; display-capture; fullscreen';
    f.src = screenUrl(ssVs);
    $('pubHost').appendChild(f);
    voice.ssFrame = f; voice.ssVs = ssVs; voice.ss = false; voice.ssSettings = { ...av };
    clearTimeout(voice.ssTimer);
    voice.ssTimer = setTimeout(() => { if (voice && voice.ssFrame === f && !voice.ss) stopShare(true); }, 120000);
    renderControls();
    showVoice();
  }
  function stopShare(silent) {
    if (!voice || !voice.ssFrame) return;
    const f = voice.ssFrame;
    clearTimeout(voice.ssTimer);
    voice.ssTimer = null;
    try { f.contentWindow.postMessage({ close: true }, '*'); } catch { }
    setTimeout(() => f.remove(), 300);
    voice.ssFrame = null; voice.ss = false; voice.ssSettings = null;
    if (!silent) { broadcastState(); renderControls(); renderPresence(); }
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

  // loudness from VDO.Ninja is keyed by stream id (including our own); map it back to users.
  // A slow-moving noise floor per stream keeps background hum from lighting people up.
  const floor = {};
  function onLoudness(obj) {
    if (!obj || typeof obj !== 'object' || !voice) return;
    const ms = members[voice.sid] || {};
    const byVs = { [voice.vs]: me.id };
    for (const id in ms) if (ms[id].vs) byVs[ms[id].vs] = id;
    let changed = false;
    for (const key in obj) {
      const uid = byVs[key];
      const level = +obj[key];
      if (!uid || !isFinite(level)) continue;
      const f = floor[key] == null ? level : floor[key];
      floor[key] = level < f ? f * 0.7 + level * 0.3 : f * 0.98 + level * 0.02;
      if (uid === me.id && (!micOn || deaf)) continue;
      if (level > Math.max(18, floor[key] + 10)) {
        if (!(speaking[uid] > now())) changed = true;
        speaking[uid] = now() + 450;
      }
    }
    if (changed) paintSpeaking();
  }
  function paintSpeaking() {
    document.querySelectorAll('[data-uid]:not([data-ctx])').forEach((el) => el.classList.toggle('speaking', speaking[el.dataset.uid] > now()));
  }

  // ---------------------------------------------------------------- iframe API listener
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;

    if (voice && e.source === voice.iframe.contentWindow) {
      if (['joined-room-complete', 'local-microphone-event', 'local-camera-event', 'video-element-created',
        'new-stream-added', 'new-audio-track-added', 'view-connection', 'push-connection'].includes(d.action) && d.value !== false) {
        const call = voice;
        syncVoiceState(call);
        scheduleVoice(call, () => syncVoiceState(call), 250);
      }
      if (d.loudness) { voice.loudnessReady = true; onLoudness(d.loudness); }
      if (Array.isArray(d.deviceList) && d.cib === 'dischord-devs' && devWait) devWait.show(d.deviceList);
      if (d.stats) onSendStats(false, d.stats);
      return;
    }
    if (voice && voice.ssFrame && e.source === voice.ssFrame.contentWindow) {
      if (d.action === 'screen-share-state') {
        if (d.value) {
          clearTimeout(voice.ssTimer); voice.ssTimer = null;
          voice.ss = true; broadcastState(); renderControls(); renderPresence();
        }
        else stopShare(); // cancelled the picker, or hit Chrome's "Stop sharing"
      }
      if (d.stats) onSendStats(true, d.stats);
      return;
    }

    if (d.stats) {
      for (const el of tileEls.values()) {
        const f = el.querySelector('.tile-media iframe');
        if (f && f.contentWindow === e.source) { onTileStats(el, d.stats); return; }
      }
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
    saveComposerDraft();
    cur.sid = sid;
    store.set('lastSid', sid);
    const s = server(sid);
    if (s) {
      const want = lastChan[sid];
      const firstText = s.channels.find((c) => c.type === 'text');
      cur.cid = channel(s, want) ? want : (firstText || s.channels[0] || {}).id || null;
    } else cur.cid = null;
    restoreComposerDraft();
    render();
    if (cur.cid) afterChannelSelect();
  }
  function selectChannel(cid) {
    saveComposerDraft();
    cur.cid = cid;
    restoreComposerDraft();
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
    fileTransfers.closeServer(sid);
    cancelImageRequests(sid);
    for (const key of fileProviders.keys()) if (key.startsWith(sid + '/')) fileProviders.delete(key);
    for (const key of composerDrafts.keys()) if (key.startsWith(sid + '/')) composerDrafts.delete(key);
    servers = servers.filter((s) => s.id !== sid);
    saveServers();
    store.del('msgs.' + sid); store.del('known.' + sid);
    delete msgs[sid]; delete members[sid];
    selectServer(servers[0] ? servers[0].id : null);
  }

  // ---------------------------------------------------------------- rendering
  const initials = (n) => (n.match(/\b\p{L}|\p{N}/gu) || [n[0] || '?']).slice(0, 2).join('').toUpperCase();
  function shade(hex, pct) {
    const n = parseInt(hex.slice(1), 16);
    const f = (c) => Math.max(0, Math.min(255, Math.round(c + (pct < 0 ? c : 255 - c) * pct)));
    return '#' + [f(n >> 16), f((n >> 8) & 255), f(n & 255)].map((c) => c.toString(16).padStart(2, '0')).join('');
  }
  const avBg = (color) => `linear-gradient(135deg, ${shade(color, 0.18)}, ${shade(color, -0.22)})`;
  const avatar = (u, dot, cls = '') => `<div class="avatar ${cls}" style="background:${avBg(u.color)}">${esc((u.name[0] || '?').toUpperCase())}${dot ? '<span class="dot"></span>' : ''}</div>`;
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
    renderStage();
  }
  function renderPresence() { renderChannels(); renderMembers(); renderUserPanel(); renderVoiceIdle(); renderStage(); }

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
    if (voice && voice.sid === sid && voice.cid === cid) out.push({ user: me, st: myState(), vs: voice.vs, vss: voice.ss ? voice.ssVs : null, self: true });
    const ms = members[sid] || {};
    for (const id in ms) if (isOnline(ms[id]) && ms[id].vc === cid) out.push({ user: ms[id].user, st: ms[id].st, vs: ms[id].vs, vss: ms[id].vss, rtt: now() - (ms[id].rttAt || 0) < 30000 ? Math.round(ms[id].rtt) : null });
    return out;
  }

  // round-trip time of my chat connection to that person (answered pings); blank for me and for old versions
  function pingTag(o) {
    if (o.self) return '';
    if (o.rtt == null) return `<span class="vu-ping" title="No ping reply from ${esc(o.user.name)} yet">···</span>`;
    return `<span class="vu-ping ${o.rtt < 120 ? 'good' : o.rtt < 300 ? 'ok' : 'bad'}" title="Ping to ${esc(o.user.name)}: ${o.rtt} ms">${o.rtt}ms</span>`;
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
        h += `<div class="voice-users">${who.map((o) => `<div class="voice-user" data-uid="${esc(o.self ? me.id : o.user.id)}">${avatar(o.user)}<span class="vu-name">${esc(o.user.name)}</span>${pingTag(o)}<span class="vu-icons">${stateIcons(o.st)}</span></div>`).join('')}</div>`;
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
    const stageWas = stageShape();
    $('voiceStage').classList.toggle('offstage', !inThisVoice);
    $('voiceStage').classList.toggle('hidden', !voice);
    updateMini();
    morphStage(stageWas);
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

  // ---------------------------------------------------------------- call stage
  // One tile per person. Tiles are never moved in the DOM (moving an iframe reloads it);
  // focus / strip layout is pure CSS driven by classes and custom properties.
  const tileEls = new Map();   // uid -> tile element
  const streamBr = {};         // vs -> chosen kbps (0 = auto)
  const autoFocused = new Set();
  const unwatched = new Set();  // screen share stream ids I chose not to watch (no video is received for them)
  function setWatching(vss, on) {
    if (!vss) return;
    if (on) unwatched.delete(vss); else unwatched.add(vss);
    renderStage();
  }
  let focusUid = null;
  let winFs = null;            // tile key filling the whole app window, or null
  let hideStrip = store.get('hideStrip', false); // focus mode: hide the row of other people under the big tile

  function wantedBr(t) {
    // Preview choices are independent of remote viewers. Keep the active share's cap until it restarts.
    if (t.self) {
      const br = t.screen ? ((voice && voice.ssSettings && voice.ssSettings.ssBr) || av.ssBr) : av.camBr;
      return av.selfPreview === 'low' ? Math.min(br, t.screen ? 1500 : 800) : br;
    }
    const pick = streamBr[t.vs];
    if (pick) return pick;
    const st = t.st || {};
    let br = (t.screen ? st.sb : st.cb) || (t.screen ? 6000 : 2500);
    if (av.recvCap) br = Math.min(br, av.recvCap);
    return br;
  }

  // what should be on stage: a tile per person (camera or avatar) + a tile per screen share
  function stageSpecs() {
    const out = [];
    for (const o of voiceOccupants(voice.sid, voice.cid)) {
      const st = o.st || {};
      const hideSelf = o.self && av.selfPreview === 'off';
      const hideCam = !o.self && hiddenVid[o.user.id];
      out.push({ key: o.user.id, uid: o.user.id, user: o.user, st, self: !!o.self, screen: false, vs: st.c && o.vs && !hideSelf && !hideCam ? o.vs : '' });
      const off = !o.self && unwatched.has(o.vss);
      if (st.s && o.vss) out.push({ key: o.user.id + ':s', uid: o.user.id, user: o.user, st, self: !!o.self, screen: true, vs: hideSelf || off ? '' : o.vss, vss: o.vss, unwatched: off });
    }
    return out;
  }

  // Going between the full call view and the small preview animates from one box to the other, so the
  // call visibly grows out of (or shrinks into) wherever the preview sits.
  function stageShape() {
    const stage = $('voiceStage');
    const shown = !stage.classList.contains('hidden');
    return {
      mini: shown && stage.classList.contains('mini'),
      full: shown && !stage.classList.contains('offstage'),
      rect: typeof stage.getBoundingClientRect === 'function' ? stage.getBoundingClientRect() : null,
    };
  }
  function morphStage(was) {
    const stage = $('voiceStage');
    if (!was.rect || typeof stage.animate !== 'function') return;
    const now = stageShape();
    if (!((was.mini && now.full) || (was.full && now.mini)) || !now.rect.width || !now.rect.height || !was.rect.width) return;
    if (morphStage.running) morphStage.running.cancel(); // never stack two
    stage.classList.add('morph'); // replaces the slide-in from the edge
    const from = `translate(${was.rect.left - now.rect.left}px, ${was.rect.top - now.rect.top}px) scale(${was.rect.width / now.rect.width}, ${was.rect.height / now.rect.height})`;
    const a = stage.animate([{ transformOrigin: '0 0', transform: from }, { transformOrigin: '0 0', transform: 'none' }],
      { duration: 380, easing: 'cubic-bezier(.2, .85, .25, 1.06)' });
    morphStage.running = a;
    a.onfinish = a.oncancel = () => { if (morphStage.running === a) { morphStage.running = null; stage.classList.remove('morph'); } };
  }

  // While I'm in a call but looking elsewhere, keep one stream visible as a small click-to-return preview.
  function updateMini() {
    const stage = $('voiceStage');
    let key = null;
    if (voice && stage.classList.contains('offstage')) {
      const vids = [...tileEls].filter(([, el]) => el.classList.contains('video'));
      const pick = vids.find(([k]) => k === focusUid) || vids.find(([, el]) => el.classList.contains('screen') && !el.classList.contains('self')) ||
        vids.find(([, el]) => !el.classList.contains('self')) || vids[0];
      if (pick) key = pick[0];
    }
    if (key && !stage.classList.contains('mini')) {
      // appearing: come in from the edge it is docked to
      const pos = store.get('miniPos', null), main = $('main');
      const left = !!(pos && main && main.clientWidth && pos.r > (main.clientWidth - (+store.get('miniW', 320) || 320)) / 2);
      stage.style.setProperty('--mini-from', left ? '-130%' : '130%');
    }
    stage.classList.toggle('mini', !!key);
    tileEls.forEach((el, k) => el.classList.toggle('mini-main', k === key));
  }

  function renderStage() {
    const host = $('tiles');
    if (!voice) {
      tileEls.forEach((el) => el.remove()); tileEls.clear();
      return;
    }
    $('devDone').classList.toggle('hidden', !voice.devices);
    $('pubHost').classList.toggle('devices', !!voice.devices);
    const seen = new Set();
    for (const t of stageSpecs()) {
      seen.add(t.key);
      const hasVid = !!t.vs;
      let el = tileEls.get(t.key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'tile';
        el.dataset.key = t.key;
        if (!t.screen) el.dataset.uid = t.uid; // speaking ring is for people, not screens
        el.innerHTML = '<div class="tile-media"></div><div class="tile-name"></div><div class="tile-tools"></div><div class="tile-stats"></div><div class="tile-fx"></div>';
        host.appendChild(el);
        tileEls.set(t.key, el);
      }
      el.style.setProperty('--c', t.user.color);
      const media = el.querySelector('.tile-media');
      const br = hasVid ? wantedBr(t) : 0;
      const vsKey = t.vs || (t.unwatched ? 'unwatched' : '');
      if (el.dataset.vs !== vsKey) {
        el.dataset.vs = vsKey;
        el.dataset.br = br;
        if (hasVid) {
          const f = document.createElement('iframe');
          f.allow = 'autoplay; fullscreen; picture-in-picture';
          f.src = viewUrl(t.vs, br, t.self && av.selfPreview === 'low' ? 35 : 100);
          media.innerHTML = '';
          media.appendChild(f);
        } else if (t.unwatched) media.innerHTML = `<div class="share-ph">${icon('eyeOff')}<span>${esc(t.user.name)} is sharing their screen</span><button type="button" class="btn primary" data-watch="${esc(t.vss)}">Watch stream</button></div>`;
        else if (t.screen) media.innerHTML = `<div class="share-ph">${icon('screen')}<span>You're sharing your screen</span></div>`;
        else media.innerHTML = avatar(t.user, false, 'big');
      } else if (hasVid && +el.dataset.br !== br) {
        el.dataset.br = br; // live bitrate change, no reconnect
        const f = media.querySelector('iframe');
        if (f && f.contentWindow) f.contentWindow.postMessage({ bitrate: br }, '*');
      }
      el.classList.toggle('video', hasVid);
      if (!hasVid) el.querySelector('.tile-stats').textContent = sendNote[t.key] || '';
      el.classList.toggle('screen', t.screen);
      el.classList.toggle('self', t.self);
      const st = t.st;
      const label = t.screen ? `${esc(t.user.name)}${t.self ? ' (you)' : ''}'s screen` : `${esc(t.user.name)}${t.self ? ' (you)' : ''}`;
      const name = (t.screen ? '<span class="live-tag">LIVE</span>' : (st.d ? icon('deaf', 'mini off') : st.m ? icon('micOff', 'mini off') : '')) + `<span>${label}</span>`;
      const nameEl = el.querySelector('.tile-name');
      if (nameEl.innerHTML !== name) nameEl.innerHTML = name;
      const tools = hasVid
        ? (t.screen && !t.self ? `<button class="tool-btn" data-unwatch="${esc(t.vss)}" title="Stop watching">${icon('eyeOff')}</button>` : '') +
          (t.self ? '' : `<button class="tool-btn q-btn" data-q="${esc(t.key)}" title="Stream quality">${esc(streamBr[t.vs] ? mbps(br) : 'Auto · ' + mbps(br))}</button>`) +
          `<button class="tool-btn" data-wfs="${esc(t.key)}" title="${winFs === t.key ? 'Exit window fullscreen' : 'Fill the window'}">${icon(winFs === t.key ? 'collapse' : 'winfs')}</button>` +
          `<button class="tool-btn fs-btn" data-fs="${esc(t.key)}" title="${document.fullscreenElement === el ? 'Exit fullscreen' : 'Fullscreen'}">${icon(document.fullscreenElement === el ? 'collapse' : 'expand')}</button>`
        : '';
      const toolsEl = el.querySelector('.tile-tools');
      if (toolsEl.innerHTML !== tools) toolsEl.innerHTML = tools;

      // someone else's new screen share takes the stage once (click away any time)
      if (t.screen && !t.self && hasVid && !autoFocused.has(t.vs)) { autoFocused.add(t.vs); focusUid = t.key; }
    }
    for (const [key, el] of tileEls) if (!seen.has(key)) { el.remove(); tileEls.delete(key); }
    if (focusUid && !(tileEls.get(focusUid) && tileEls.get(focusUid).classList.contains('video'))) focusUid = null;
    if (winFs && !(tileEls.get(winFs) && tileEls.get(winFs).classList.contains('video'))) winFs = null;
    $('voiceStage').classList.toggle('winfs', !!winFs);
    tileEls.forEach((el, key) => el.classList.toggle('winfull', key === winFs));

    // layout
    const n = tileEls.size;
    host.classList.toggle('focus-mode', !!focusUid);
    if (focusUid) {
      let i = 0;
      const others = n - 1;
      host.style.setProperty('--sn', others);
      tileEls.forEach((el, key) => {
        el.classList.toggle('focused', key === focusUid);
        if (key !== focusUid) el.style.setProperty('--i', i++);
      });
      host.classList.toggle('no-strip', others === 0 || hideStrip);
      host.classList.toggle('strip-off', hideStrip);
    } else {
      const cols = Math.ceil(Math.sqrt(n || 1));
      host.style.setProperty('--cols', cols);
      host.style.setProperty('--rows', Math.ceil((n || 1) / cols));
      tileEls.forEach((el) => el.classList.remove('focused'));
    }
    const st = $('stripToggle'), canStrip = !!focusUid && n > 1 && !winFs;
    st.classList.toggle('hidden', !canStrip);
    st.classList.toggle('off', hideStrip);
    st.title = hideStrip ? 'Show members' : 'Hide members';
    setIcon(st, hideStrip ? 'chevUp' : 'chevDown');
    $('tiles').classList.toggle('show-stats', !!av.showStats);
    paintSpeaking();
    applyVolumes();
    updateMini();
  }

  // ---- per-user volume / mute (applied inside the publisher, which plays everyone's audio)
  const volOf = (uid, stream) => {
    const c = userVol[uid] || {};
    if (deaf || c.m) return 0;
    return audioPercent(stream ? c.sv : c.v) / 100;
  };
  const sentVol = {};
  function applyVolumes(force) {
    if (!voice) return;
    const streams = {};
    for (const o of voiceOccupants(voice.sid, voice.cid)) {
      if (o.self) continue;
      for (const [vs, stream] of [[o.vs, false], [o.vss, true]]) {
        if (!vs) continue;
        const v = volOf(o.user.id, stream);
        streams[vs] = v;
        if (!force && sentVol[vs] === v) continue;
        sentVol[vs] = v;
        // The top-level volume API also changes the default for future peers.
        // Set only this stream's media element, keeping later joiners audible.
        voicePost({ target: vs, settings: { volume: Math.min(1, v) } });
      }
    }
    voicePost({ function: 'eval', value: '(' + vdoAudioGainBridge.toString() + ')(' + JSON.stringify({ micGain: audioPercent(av.micGain), deaf, streams }) + ');' });
  }
  function setVol(uid, patch) {
    const clean = {};
    if ('v' in patch) clean.v = audioPercent(patch.v);
    if ('sv' in patch) clean.sv = audioPercent(patch.sv);
    if ('m' in patch) clean.m = !!patch.m;
    userVol[uid] = { ...(userVol[uid] || {}), ...clean };
    store.set('vol', userVol);
    applyVolumes();
    renderPresence();
  }

  // ---- live stream stats (resolution / fps / bitrate / codec) for every video tile
  function pollStats() {
    tileEls.forEach((el) => {
      const f = el.classList.contains('video') && el.querySelector('.tile-media iframe');
      if (f && f.contentWindow) f.contentWindow.postMessage({ getStats: true }, '*');
    });
    if (voice && voice.cam) voicePost({ getStats: true }); else setSendNote(false, '');
    if (voice && voice.ss && voice.ssFrame.contentWindow) voice.ssFrame.contentWindow.postMessage({ getStats: true }, '*'); else setSendNote(true, '');
  }

  // ---- what is throttling my own stream: the browser lowers fps / resolution / bitrate by itself
  // when the encoder runs out of CPU or the uplink can't carry the bitrate. Shown on my own tiles.
  const sendNote = {};         // tile key -> text
  const limitRuns = {};        // 'cam' | 'ss' -> { why, n, told }
  function setSendNote(screen, text) {
    if (!me) return;
    const key = me.id + (screen ? ':s' : '');
    if ((sendNote[key] || '') === text) return;
    sendNote[key] = text;
    const el = tileEls.get(key);
    if (el && !el.classList.contains('video')) el.querySelector('.tile-stats').textContent = text;
  }
  function onSendStats(screen, stats) {
    const pcs = Object.values((stats && stats.outbound) || {}).filter((o) => o && typeof o === 'object' && (o.quality_limitation_reason !== undefined || o.video_encoder || o.resolution || o.video_bitrate_kbps));
    if (!pcs.length) return setSendNote(screen, '');
    const reasons = pcs.map((o) => o.quality_limitation_reason).filter((r) => r && r !== 'none');
    const why = reasons.includes('cpu') ? 'cpu' : reasons.includes('bandwidth') ? 'bandwidth' : '';
    const up = Math.min(...pcs.map((o) => +o.available_outgoing_bitrate_kbps || Infinity));
    const enc = pcs.map((o) => o.video_encoder).find(Boolean) || '';
    const hw = /MediaFoundation|VideoToolbox|Vaapi|V4L2|D3D|Nv|Amf|Qsv|External/i.test(enc);
    const parts = [];
    const frameRates = pcs.map((o) => {
      const match = String(o.resolution || '').match(/@\s*([\d.]+)/);
      const fps = o.FPS ?? o.fps ?? o._FPS ?? (match ? match[1] : undefined);
      return fps !== undefined && fps !== null && fps !== '' && Number.isFinite(+fps) ? +fps : null;
    }).filter((fps) => fps !== null);
    if (frameRates.length) parts.push(Math.round(Math.min(...frameRates)) + ' fps');
    if (why) parts.push(why === 'cpu' ? 'CPU-limited' : 'uplink-limited');
    parts.push(pcs.length + (pcs.length === 1 ? ' encode' : ' encodes'));
    if (enc) parts.push(hw ? 'hardware' : 'software');
    if (isFinite(up)) parts.push('uplink ' + mbps(Math.round(up)));
    setSendNote(screen, 'sending: ' + parts.join(' · '));

    const run = limitRuns[screen ? 'ss' : 'cam'] || (limitRuns[screen ? 'ss' : 'cam'] = { why: '', n: 0, told: {} });
    if (why !== run.why) { run.why = why; run.n = 0; }
    if (why && ++run.n === 4 && !run.told[why]) { // ~8s in a row, once per reason
      run.told[why] = 1;
      const what = screen ? 'screen share' : 'camera';
      toast(why === 'cpu'
        ? `Your ${what} is being throttled: this PC can't encode it fast enough (${pcs.length} ${hw ? 'hardware' : 'software'} encode${pcs.length === 1 ? '' : 's'}). Try a lower resolution, the H.264 codec, or a Low / Hidden own preview.`
        : `Your ${what} is being throttled: your upload can't carry the bitrate${isFinite(up) ? ' (about ' + mbps(Math.round(up)) + ' available)' : ''}. Pick a bitrate below that for a steady stream.`, 12000);
    }
  }
  function onTileStats(el, stats) {
    const inbound = stats && stats.inbound;
    if (!inbound) return;
    const st = Object.values(inbound).find((x) => x && typeof x === 'object');
    if (!st) return;
    // VDO.Ninja nests per-track stats: { <trackId>: { _type:'video', Resolution, FPS, Bitrate_in_kbps, codec }, 'Peer-to-Peer': {...} }
    const vid = Object.values(st).find((o) => o && typeof o === 'object' && (o._type === 'video' || /video/i.test(o.type || ''))) || st;
    const p2p = st['Peer-to-Peer'] || {};
    const res = vid.Resolution || vid.resolution || (vid._frameWidth ? vid._frameWidth + 'x' + vid._frameHeight : '');
    const fps = vid.FPS ?? vid.fps;
    const br = +(vid.Bitrate_in_kbps ?? vid.video_bitrate_kbps ?? 0);
    const codec = vid.codec || vid.video_codec || '';
    const loss = +(vid.packetLoss_in_percentage || 0);
    const parts = [];
    if (res) parts.push(String(res).replace(/\s+/g, ''));
    if (fps !== undefined && fps !== null && fps !== '' && Number.isFinite(+fps)) parts.push(Math.round(+fps) + ' fps');
    if (br) parts.push(mbps(Math.round(br)));
    if (codec) parts.push(String(codec).replace(/^video\//i, '').toUpperCase());
    if (loss >= 1) parts.push(loss.toFixed(1) + '% loss');
    if (p2p.candidateType_remote === 'relay') parts.push('relayed');
    if (sendNote[el.dataset.key]) parts.push(sendNote[el.dataset.key]);
    el.querySelector('.tile-stats').textContent = parts.join(' · ');
  }

  // ---- in-call reactions
  function floatReaction(uid, e) {
    const el = tileEls.get(uid);
    if (!el) return;
    const fx = el.querySelector('.tile-fx');
    const span = document.createElement('span');
    span.className = 'float-emoji';
    span.textContent = e;
    span.style.left = (20 + Math.random() * 60) + '%';
    fx.appendChild(span);
    setTimeout(() => span.remove(), 2600);
  }
  function sendCallReaction(e) {
    if (!voice) return;
    floatReaction(me.id, e);
    send(voice.sid, { t: 'creact', e });
  }

  // ---------------------------------------------------------------- right-click menus
  function openCtx(x, y, html, wire) {
    const m = $('ctxMenu');
    m.innerHTML = html;
    paintIcons(m);
    m.classList.remove('hidden');
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 6)) + 'px';
    m.style.top = Math.max(6, Math.min(y, window.innerHeight - h - 6)) + 'px';
    if (wire) wire(m);
  }
  let ctxAnchor = null, ctxToggled = null; // the button a menu hangs from; and the one whose click just closed it
  const closeCtx = () => { $('ctxMenu').classList.add('hidden'); ctxAnchor = null; };
  // open a menu above (or below) a button; clicking the same button again closes it
  function openAnchored(anchor, html, wire) {
    const rect = anchor.getBoundingClientRect();
    openCtx(rect.left, rect.top, html, (menu) => {
      menu.style.top = (rect.top > window.innerHeight / 2 ? Math.max(6, rect.top - menu.offsetHeight - 8) : Math.min(window.innerHeight - menu.offsetHeight - 6, rect.bottom + 8)) + 'px';
      if (wire) wire(menu);
    });
    ctxAnchor = anchor;
  }
  const ctxItem = (act, ico, label, extra = '') => `<button class="ctx-item ${extra}" data-act="${act}">${ico ? icon(ico) : ''}<span>${label}</span></button>`;
  const ctxCheck = (act, label, on) => `<button class="ctx-item check ${on ? 'on' : ''}" data-act="${act}"><span>${label}</span><i class="box">${on ? icon('check') : ''}</i></button>`;
  const ctxSlider = (act, label, val) => `<div class="ctx-slider"><div class="cs-head"><span>${label}</span><b data-out="${act}">${audioPercent(val)}%</b></div><input type="range" min="0" max="200" step="1" value="${audioPercent(val)}" data-slide="${act}" aria-label="${esc(label)}"></div>`;
  const ctxSelect = (act, label, val, opts) => `<div class="ctx-select"><span>${label}</span><select data-sel="${act}">${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(val) ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
  const qOpts = (auto) => [[0, 'Auto' + (auto ? ' · ' + mbps(auto) : '')], ...VIEW_BRS.map((k) => [k, mbps(k)])];

  // ---- device menus (the arrow beside, or a right-click on, the call buttons); all inside Dischord
  let devWait = null;
  const sameLabel = (a, b) => !!a && !!b && String(a).replace(/\W+/g, '_').toLowerCase() === String(b).replace(/\W+/g, '_').toLowerCase();
  const DEV = {
    audioinput: { key: 'micLabel', head: 'Input device', none: 'No microphone found.' },
    audiooutput: { key: 'outLabel', head: 'Output device', none: 'This browser does not list output devices.' },
    videoinput: { key: 'camLabel', head: 'Camera', none: 'No camera found.' },
  };
  const CAM_RES = [['360', '360p'], ['720', '720p'], ['1080', '1080p'], ['1440', '1440p'], ['2160', '4K']];
  const SS_RES = [['source', 'Source (native)'], ['2160', '4K'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p']];
  const fpsOpts = (list) => list.map((f) => [f, f + ' fps']);
  function saveAv(patch) { av = { ...av, ...patch }; store.set('av', av); broadcastState(); }
  function deviceMenu(anchor, kind) { // kind: 'audioinput' | 'audiooutput' | 'videoinput'
    closeCtx();
    const info = DEV[kind];
    const token = {};
    clearTimeout(devWait && devWait.timer);
    const show = (list) => {
      if (!devWait || devWait.token !== token) return;
      clearTimeout(devWait.timer); devWait = null;
      const devs = (list || []).filter((d) => d.kind === kind && d.deviceId !== 'communications');
      const named = devs.some((d) => d.label);
      const saved = store.get(info.key, '');
      let h = `<div class="ctx-head"><span>${info.head}</span></div>`;
      if (!devs.length) h += `<div class="ctx-note">${info.none}</div>`;
      else if (!named) h += `<div class="ctx-note">Join a voice channel and allow ${kind === 'videoinput' ? 'camera' : 'microphone'} access to see device names.</div>`;
      else h += devs.map((d, i) => {
        const on = saved ? sameLabel(saved, d.label) : (d.deviceId === 'default' || (kind === 'videoinput' && i === 0));
        return `<button class="ctx-item check ${on ? 'on' : ''}" data-act="dev" data-i="${i}"><span>${esc(d.label)}</span><i class="box">${on ? icon('check') : ''}</i></button>`;
      }).join('');
      h += '<div class="ctx-sep"></div>';
      if (kind === 'audioinput') h += ctxSlider('micgain', 'Input volume', av.micGain) + ctxCheck('mic', 'Mute', !micOn || deaf);
      else if (kind === 'audiooutput') h += ctxCheck('deaf', 'Deafen', deaf);
      else {
        h += ctxSelect('camQ', 'Resolution', av.camQ, CAM_RES) + ctxSelect('camFps', 'Frame rate', av.camFps, fpsOpts([15, 30, 60]));
        if (voice) h += ctxCheck('cam', 'Camera on', !!voice.cam);
      }
      h += ctxItem('avset', 'gear', 'Voice & video settings');
      openAnchored(anchor, h, (menu) => {
        menu.querySelectorAll('[data-slide]').forEach((r) => {
          r.oninput = () => {
            menu.querySelector(`[data-out="${r.dataset.slide}"]`).textContent = audioPercent(r.value) + '%';
            setMicGain(r.value);
          };
        });
        menu.querySelectorAll('[data-sel]').forEach((sel) => {
          sel.onchange = () => {
            saveAv({ [sel.dataset.sel]: sel.dataset.sel === 'camFps' ? +sel.value : sel.value });
            if (voice && voice.cam) { closeCtx(); joinVoice(voice.sid, voice.cid, true); } // camera settings apply on reconnect
          };
        });
        menu.onclick = (e) => {
          const b = e.target.closest('[data-act]');
          if (!b) return;
          closeCtx();
          switch (b.dataset.act) {
            case 'dev': return pickDevice(kind, devs[+b.dataset.i]);
            case 'mic': return toggleMic();
            case 'deaf': return toggleDeaf();
            case 'cam': return toggleCam();
            case 'avset': return settingsModal('av');
          }
        };
      });
    };
    devWait = { token, show, timer: null };
    const ownList = () => (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices ? navigator.mediaDevices.enumerateDevices() : Promise.resolve([]))
      .then((l) => show(l.map((d) => ({ kind: d.kind, deviceId: d.deviceId, label: d.label })))).catch(() => show([]));
    if (voice && voice.iframe && voice.iframe.contentWindow) {
      voicePost({ getDeviceList: true, cib: 'dischord-devs' });
      devWait.timer = setTimeout(ownList, 2500); // the call frame did not answer
    } else ownList();
  }
  function pickDevice(kind, d) {
    if (!d) return;
    store.set(DEV[kind].key, d.label || '');
    if (voice) {
      // device ids are per-origin, so they come from the call frame's own list and are applied inside it
      const id = JSON.stringify(String(d.deviceId));
      if (kind === 'audioinput') voicePost({ function: 'eval', value: `if (typeof changeAudioDeviceById === 'function') changeAudioDeviceById(${id});` });
      else if (kind === 'audiooutput') voicePost({ changeAudioOutputDevice: String(d.deviceId) });
      else if (voice.cam) voicePost({ function: 'eval', value: `if (typeof changeVideoDeviceById === 'function') changeVideoDeviceById(${id});` });
      const call = voice;
      scheduleVoice(call, () => syncVoiceState(call), 1500); // re-apply mute / gain after the device swap
    }
    toast(({ audioinput: 'Microphone: ', audiooutput: 'Output: ', videoinput: 'Camera: ' })[kind] + (d.label || 'selected'));
  }
  function shareMenu(anchor) {
    closeCtx();
    const sharing = !!(voice && voice.ssFrame);
    let h = '<div class="ctx-head"><span>Screen share</span></div>';
    if (voice) h += ctxItem('share', 'screen', sharing ? 'Stop sharing' : 'Share your screen', sharing ? 'danger' : '');
    else h += '<div class="ctx-note">Join a voice channel to share your screen.</div>';
    h += '<div class="ctx-sep"></div>' + ctxSelect('ssQ', 'Resolution', av.ssQ, SS_RES) + ctxSelect('ssFps', 'Frame rate', av.ssFps, fpsOpts([5, 15, 30, 60])) +
      ctxSelect('ssHint', 'Optimize for', av.ssHint, [['motion', 'Smoothness'], ['detail', 'Clarity']]);
    if (sharing) h += '<div class="ctx-note">Changes apply the next time you share.</div>';
    h += ctxItem('avset', 'gear', 'Voice & video settings');
    openAnchored(anchor, h, (menu) => {
      menu.querySelectorAll('[data-sel]').forEach((sel) => {
        sel.onchange = () => saveAv({ [sel.dataset.sel]: sel.dataset.sel === 'ssFps' ? +sel.value : sel.value });
      });
      menu.onclick = (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        closeCtx();
        if (b.dataset.act === 'share') return toggleShare();
        if (b.dataset.act === 'avset') return settingsModal('av');
      };
    });
  }
  // an arrow button: first click opens its menu, the next click closes it
  function caret(id, open) {
    $(id).onclick = (e) => {
      e.stopPropagation();
      if (ctxToggled === $(id)) { ctxToggled = null; return; }
      open($(id));
    };
  }

  // ---- channel list menus
  function renameChannelModal(cid) {
    const s = server(cur.sid), c = channel(s, cid);
    if (!c) return;
    modal(`<h2>Rename channel</h2><label>Channel name</label><input type="text" id="mName" maxlength="40" value="${esc(c.name)}">
      <div class="actions"><button class="btn link" data-close>Cancel</button><button class="btn primary" id="mOk">Save</button></div>`, () => {
      const inp = $('mName');
      inp.select();
      const ok = () => {
        let n = inp.value.trim();
        if (c.type === 'text') n = n.toLowerCase().replace(/\s+/g, '-');
        if (!n) return;
        c.name = n.slice(0, 40);
        bumpServer(s);
        closeModal();
      };
      $('mOk').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    });
  }
  function deleteChannelConfirm(cid) {
    const s = server(cur.sid), c = channel(s, cid);
    if (!c) return;
    confirmModal('Delete channel', `Delete ${c.type === 'text' ? '#' : ''}${c.name} for everyone?`, 'Delete channel', () => {
      s.channels = s.channels.filter((x) => x.id !== c.id);
      releaseChannelFiles(s.id, c.id);
      if (voice && voice.sid === s.id && voice.cid === c.id) leaveVoice();
      if (cur.cid === c.id) selectChannel((s.channels.find((x) => x.type === 'text') || s.channels[0] || {}).id || null);
      bumpServer(s);
    });
  }
  function copyInvite(s) {
    const link = inviteLink(s);
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Invite link copied'), () => { if (s.id === cur.sid) inviteModal(); });
  }
  function markServerRead(sid) {
    const s = server(sid);
    if (!s) return;
    s.channels.forEach((c) => { if (c.type === 'text') markRead(sid, c.id); });
    renderRail(); renderChannels();
  }
  function channelMenu(cid, x, y) {
    const s = server(cur.sid), c = channel(s, cid);
    if (!c) return;
    const inIt = !!(voice && voice.sid === s.id && voice.cid === c.id);
    let h = `<div class="ctx-head"><span>${c.type === 'text' ? '# ' : ''}${esc(c.name)}</span></div>`;
    if (c.type === 'text') h += ctxItem('read', 'check', 'Mark as read');
    else h += inIt ? ctxItem('leave', 'hangup', 'Disconnect', 'danger') : ctxItem('join', 'speaker', 'Join voice') + ctxItem('joincam', 'camera', 'Join with camera');
    h += ctxItem('invite', 'userPlus', 'Invite people') + '<div class="ctx-sep"></div>';
    h += ctxItem('rename', 'edit', 'Rename channel') + ctxItem('del', 'trash', 'Delete channel', 'danger');
    openCtx(x, y, h, (menu) => {
      menu.onclick = (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        closeCtx();
        switch (b.dataset.act) {
          case 'read': markRead(s.id, c.id); renderRail(); return renderChannels();
          case 'join': selectChannel(c.id); return joinVoice(s.id, c.id, false);
          case 'joincam': selectChannel(c.id); return joinVoice(s.id, c.id, true);
          case 'leave': return leaveVoice();
          case 'invite': return inviteModal();
          case 'rename': return renameChannelModal(c.id);
          case 'del': return deleteChannelConfirm(c.id);
        }
      };
    });
  }
  // empty space in the channel list, a category header, or the server header
  function serverAreaMenu(x, y) {
    const s = server(cur.sid);
    if (!s) return;
    const h = `<div class="ctx-head"><span>${esc(s.name)}</span></div>` +
      ctxItem('addText', 'hash', 'Create text channel') + ctxItem('addVoice', 'speaker', 'Create voice channel') +
      ctxItem('invite', 'userPlus', 'Invite people') + ctxItem('read', 'check', 'Mark server as read') + '<div class="ctx-sep"></div>' +
      ctxItem('rename', 'edit', 'Rename server') + ctxItem('leave', 'logout', 'Leave server', 'danger');
    openCtx(x, y, h, (menu) => {
      menu.onclick = (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        closeCtx();
        switch (b.dataset.act) {
          case 'addText': return channelModal('text');
          case 'addVoice': return channelModal('voice');
          case 'invite': return inviteModal();
          case 'read': return markServerRead(s.id);
          case 'rename': return renameModal();
          case 'leave': return confirmLeave(s);
        }
      };
    });
  }
  const confirmLeave = (s) => confirmModal(`Leave '${s.name}'`, 'You can rejoin later with an invite link. Your local message history for this server will be removed.', 'Leave server', () => leaveServer(s.id));
  function railMenu(sid, x, y) {
    const s = server(sid);
    if (!s) return;
    const h = `<div class="ctx-head"><span>${esc(s.name)}</span></div>` +
      ctxItem('read', 'check', 'Mark as read') + ctxItem('invite', 'userPlus', 'Copy invite link') + '<div class="ctx-sep"></div>' +
      ctxItem('leave', 'logout', 'Leave server', 'danger');
    openCtx(x, y, h, (menu) => {
      menu.onclick = (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        closeCtx();
        switch (b.dataset.act) {
          case 'read': return markServerRead(s.id);
          case 'invite': return copyInvite(s);
          case 'leave': return confirmLeave(s);
        }
      };
    });
  }

  function userMenu(uid, x, y) {
    const self = uid === me.id;
    const sid = cur.sid;
    const ms = (members[sid] || {})[uid];
    const user = self ? me : (ms && ms.user) || getKnown(sid)[uid];
    if (!user) return;
    const occ = voice ? voiceOccupants(voice.sid, voice.cid).find((o) => o.user.id === uid) : null;
    const st = (occ && occ.st) || {};
    let h = `<div class="ctx-head">${avatar(user)}<span>${esc(user.name)}</span></div>`;
    if (self) {
      h += ctxCheck('mic', 'Mute microphone', !micOn || deaf) + ctxCheck('deaf', 'Deafen', deaf);
      h += ctxSlider('micgain', 'Microphone volume', av.micGain);
      if (voice) {
        h += '<div class="ctx-sep"></div>' + ctxCheck('cam', 'Camera', !!voice.cam) + ctxCheck('share', 'Share screen', !!voice.ssFrame);
        h += ctxSelect('selfprev', 'My preview', av.selfPreview, [['full', 'Full quality'], ['low', 'Low'], ['off', 'Hidden']]);
      }
      h += '<div class="ctx-sep"></div>' + ctxCheck('stats', 'Show stream stats', !!av.showStats) + ctxItem('avset', 'gear', 'Voice & video settings') + ctxItem('profile', 'edit', 'Edit profile');
    } else {
      const c = userVol[uid] || {};
      if (occ) {
        h += ctxSlider('vol', 'User volume', c.v ?? 100);
        if (st.s) h += ctxSlider('svol', 'Stream volume', c.sv ?? 100);
        h += ctxCheck('mute', 'Mute', !!c.m);
        if (st.c) h += ctxCheck('hidevid', 'Hide video', !!hiddenVid[uid]);
        if (st.c && occ.vs && !hiddenVid[uid]) h += ctxSelect('qcam', 'Video quality', streamBr[occ.vs] || 0, qOpts(st.cb));
        if (st.s && occ.vss) h += ctxSelect('qss', 'Stream quality', streamBr[occ.vss] || 0, qOpts(st.sb));
        if (st.s && occ.vss) h += ctxCheck('watching', 'Watch stream', !unwatched.has(occ.vss));
        if (st.s && occ.vss && !unwatched.has(occ.vss)) h += ctxItem('watch', 'expand', 'Focus stream') + ctxItem('fs', 'expand', 'Fullscreen stream');
        h += ctxCheck('stats', 'Show stream stats', !!av.showStats);
        h += '<div class="ctx-sep"></div>';
      } else if (c.m || (c.v ?? 100) !== 100) {
        h += ctxSlider('vol', 'User volume', c.v ?? 100) + ctxCheck('mute', 'Mute', !!c.m) + '<div class="ctx-sep"></div>';
      }
      h += ctxItem('mention', 'at', 'Mention') + ctxItem('copyname', 'copy', 'Copy username');
    }
    openCtx(x, y, h, (m) => {
      m.querySelectorAll('[data-slide]').forEach((r) => {
        r.oninput = () => {
          m.querySelector(`[data-out="${r.dataset.slide}"]`).textContent = r.value + '%';
          if (r.dataset.slide === 'micgain') setMicGain(+r.value);
          else setVol(uid, r.dataset.slide === 'vol' ? { v: +r.value } : { sv: +r.value });
        };
      });
      m.querySelectorAll('[data-sel]').forEach((sel) => {
        sel.onchange = () => {
          const a = sel.dataset.sel;
          if (a === 'selfprev') { av.selfPreview = sel.value; store.set('av', av); tileEls.forEach((el) => { if (el.classList.contains('self')) el.dataset.vs = '__reload'; }); renderStage(); return; }
          const vs = a === 'qcam' ? occ.vs : occ.vss;
          streamBr[vs] = +sel.value;
          renderStage();
        };
      });
      m.onclick = (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const a = b.dataset.act;
        const reopen = () => userMenu(uid, x, y);
        switch (a) {
          case 'mic': toggleMic(); return reopen();
          case 'deaf': toggleDeaf(); return reopen();
          case 'cam': closeCtx(); return toggleCam();
          case 'share': closeCtx(); return toggleShare();
          case 'stats': av.showStats = !av.showStats; store.set('av', av); renderStage(); return reopen();
          case 'avset': closeCtx(); return settingsModal('av');
          case 'profile': closeCtx(); return settingsModal('profile');
          case 'mute': setVol(uid, { m: !(userVol[uid] || {}).m }); return reopen();
          case 'hidevid': hiddenVid[uid] = !hiddenVid[uid]; if (!hiddenVid[uid]) delete hiddenVid[uid]; store.set('hidevid', hiddenVid); renderStage(); return reopen();
          case 'watching': { const o = voice && voiceOccupants(voice.sid, voice.cid).find((x) => x.user.id === uid); if (o && o.vss) setWatching(o.vss, unwatched.has(o.vss)); return reopen(); }
          case 'watch': closeCtx(); showVoice(); focusUid = uid + ':s'; return renderStage();
          case 'fs': { closeCtx(); showVoice(); const el = tileEls.get(uid + ':s'); if (el && el.requestFullscreen) el.requestFullscreen(); return; }
          case 'mention': {
            closeCtx();
            const inp = $('msgInput');
            if (!$('textView').classList.contains('hidden')) { inp.value += (inp.value && !/\s$/.test(inp.value) ? ' ' : '') + '@' + mentionTag(user.name) + ' '; inp.focus(); syncComposer(); }
            else toast('Open a text channel to mention someone.');
            return;
          }
          case 'copyname': closeCtx(); navigator.clipboard && navigator.clipboard.writeText(user.name); return toast('Copied');
        }
      };
    });
  }

  function messageMenu(mid, x, y) {
    const m = (getMsgs(cur.sid)[cur.cid] || []).find((z) => z.id === mid);
    if (!m) return;
    const mine = m.a.id === me.id;
    let h = `<div class="ctx-emojis">${REACTS.slice(0, 6).map((e) => `<button data-emo="${e}">${e}</button>`).join('')}</div>`;
    h += ctxItem('react', 'smile', 'Add reaction') + ctxItem('reply', 'reply', 'Reply');
    if (m.text) h += ctxItem('copy', 'copy', 'Copy text');
    if (m.img) h += ctxItem('openimg', 'image', 'Open image') + ctxItem('copyimg', 'copy', 'Copy image') + ctxItem('saveimg', 'download', 'Download image');
    if (!mine) h += ctxItem('mention', 'at', 'Mention ' + esc(m.a.name));
    if (mine && m.text) h += ctxItem('edit', 'edit', 'Edit message');
    if (mine) h += ctxItem('del', 'trash', 'Delete message', 'danger');
    openCtx(x, y, h, (menu) => {
      menu.onclick = (e) => {
        const emo = e.target.closest('[data-emo]');
        if (emo) { closeCtx(); return toggleReaction(mid, emo.dataset.emo); }
        const b = e.target.closest('[data-act]');
        if (!b) return;
        closeCtx();
        switch (b.dataset.act) {
          case 'react': return emojiPicker({ getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }) }, (emo) => toggleReaction(mid, emo));
          case 'reply': return replyToMessage(mid);
          case 'copy': navigator.clipboard && navigator.clipboard.writeText(m.text); return toast('Copied');
          case 'openimg': return openImage(cur.sid, m.cid, m.id);
          case 'copyimg': return copyImage(cur.sid, m.cid, m.id);
          case 'saveimg': return saveImage(cur.sid, m.cid, m.id);
          case 'mention': { const inp = $('msgInput'); inp.value += (inp.value && !/\s$/.test(inp.value) ? ' ' : '') + '@' + mentionTag(liveUser(m.a).name) + ' '; syncComposer(); return inp.focus(); }
          case 'edit': return editMessage(mid);
          case 'del': return deleteMessage(mid);
        }
      };
    });
  }

  function qualityMenu(key, btn) {
    const el = tileEls.get(key);
    if (!el || !el.dataset.vs) return;
    const vs = el.dataset.vs;
    const cur = streamBr[vs] || 0;
    const m = $('qMenu');
    m.innerHTML = `<div class="qm-title">Stream quality</div>` +
      [0, ...VIEW_BRS].map((k) => `<button data-qv="${k}" class="${k === cur ? 'sel' : ''}">${k ? mbps(k) : 'Auto (sender\'s setting)'}</button>`).join('');
    const r = btn.getBoundingClientRect(), sr = $('voiceStage').getBoundingClientRect();
    m.style.top = (r.bottom - sr.top + 6) + 'px';
    m.style.right = (sr.right - r.right) + 'px';
    m.classList.remove('hidden');
    m.onclick = (e) => {
      const b = e.target.closest('[data-qv]');
      if (!b) return;
      streamBr[vs] = +b.dataset.qv;
      m.classList.add('hidden');
      renderStage();
    };
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

  // a mention is "@" + the name without spaces or punctuation; resolve it back to a person in this server
  const mentionTag = (name) => String(name || '').replace(/[^\p{L}\p{N}_.-]+/gu, '').slice(0, 32);
  function serverPeople(sid) {
    const k = getKnown(sid), ms = members[sid] || {};
    const out = [];
    for (const id of new Set([...Object.keys(k), ...Object.keys(ms)])) {
      if (id === me.id) continue;
      const user = (ms[id] && ms[id].user) || k[id];
      if (user && user.name) out.push({ user, on: isOnline(ms[id]) });
    }
    return out;
  }
  function mentionTarget(tag) {
    const want = tag.replace(/^@/, '').toLowerCase();
    if (!want) return null;
    if (mentionTag(me.name).toLowerCase() === want) return me;
    const hit = serverPeople(cur.sid).find((p) => mentionTag(p.user.name).toLowerCase() === want);
    return hit ? hit.user : null;
  }
  const mentionsMe = (text) => !!text && (text.match(/(^|\s)@[\p{L}\p{N}_.-]{1,32}/gu) || []).some((t) => { const u = mentionTarget(t.trim()); return u && u.id === me.id; });

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
      .replace(/(^|\s)(@[\p{L}\p{N}_.-]{1,32})/gu, (all, pre, tag) => {
        const u = mentionTarget(tag);
        return pre + (u ? `<span class="mention ${u.id === me.id ? 'me' : ''}" data-mention="${esc(u.id)}">@${esc(u.name)}</span>` : `<span class="mention">${tag}</span>`);
      });
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  }

  // messages keep a snapshot of their author; show the current profile when we know it
  function liveUser(a) {
    if (a.id === me.id) return { ...a, name: me.name, color: me.color };
    const k = getKnown(cur.sid)[a.id];
    return k ? { ...a, name: k.name, color: k.color } : a;
  }

  function renderReply(m) {
    if (!m.reply) return '';
    const r = m.reply;
    const original = (getMsgs(cur.sid)[m.cid] || []).find((x) => x.id === r.id);
    const excerpt = original && original.del ? 'Original message deleted' : original
      ? original.text || (original.file && original.file.name) || (original.img ? 'Image' : 'Message')
      : r.text || r.attachment || 'Message';
    const a = liveUser(original ? original.a : r.a);
    return `<button type="button" class="msg-reply" data-reply-jump="${esc(r.id)}" title="Jump to original message">${icon('reply')}<b>${esc(a.name)}</b><span>${esc(excerpt.replace(/\s+/g, ' ').slice(0, 240))}</span></button>`;
  }
  function jumpToMessage(mid) {
    const el = [...$('messages').querySelectorAll('[data-mid]')].find((x) => x.dataset.mid === mid);
    if (!el) return toast('Original message is no longer in local history.');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('reply-highlight');
    setTimeout(() => el.classList.remove('reply-highlight'), 2000);
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
      const head = newDay || !prev || !!m.reply || prev.a.id !== m.a.id || m.ts - prev.ts > 7 * 60000;
      const mine = m.a.id === me.id;
      const a = liveUser(m.a);
      const acts = `<div class="actions"><button class="icon-btn" data-reply="${esc(m.id)}" title="Reply">${icon('reply')}</button><button class="icon-btn" data-react="${esc(m.id)}" title="Add reaction">${icon('smile')}</button>` +
        (mine ? `${m.text ? `<button class="icon-btn" data-edit="${esc(m.id)}" title="Edit">${icon('edit')}</button>` : ''}<button class="icon-btn danger" data-del="${esc(m.id)}" title="Delete">${icon('trash')}</button>` : '') + '</div>';
      const edited = m.ed ? ' <span class="time">(edited)</span>' : '';
      const imageStateKey = imageMessageKey(s.id, m.cid, m.id);
      const failedPreview = imageErrors.has(imageStateKey);
      const imgW = m.img ? Math.max(48, Math.round(m.img.w * Math.min(1, 550 / m.img.w, 350 / m.img.h))) : 0;
      const img = m.img ? `<button type="button" class="msg-img ${failedPreview ? '' : 'loading'}" style="aspect-ratio:${m.img.w}/${m.img.h};width:min(100%, ${imgW}px)" data-image-open="${esc(m.id)}" aria-label="Open image preview">
        <img data-img="${esc(m.img.id)}" data-img-sid="${esc(s.id)}" data-img-cid="${esc(m.cid)}" data-img-mid="${esc(m.id)}" decoding="async" alt="${esc(m.file ? m.file.name : 'Shared image')}"><span class="image-preview-status" role="status">${failedPreview ? 'Preview unavailable. Someone with it must be online.' : 'Loading image preview…'}</span><span class="img-save" data-image-save="${esc(m.id)}" role="button" tabindex="0" title="Download image">${icon('download')}</span></button>` : m.file && window.DischordImages.isImage(m.file)
        ? `<div class="image-preview-placeholder" role="status">${icon('image')}<span>${imagePreparing.has(imageStateKey) && !failedPreview ? 'Preparing image preview…' : 'Image preview unavailable.'}</span></div>` : '';
      // images are preview-only; every other file is a card that transfers on Download
      const file = m.file && !window.DischordImages.isImage(m.file) ? `<div class="msg-file" data-file-card="${esc(m.id)}">${fileCardContent(s.id, m)}</div>` : '';
      const reply = renderReply(m);
      const text = m.text ? `<div class="text">${formatText(m.text)}${edited}</div>` : '';
      const re = renderRe(m);
      if (head) {
        h += `<div class="msg head ${mentionsMe(m.text) ? 'mentions-me' : ''}" data-mid="${esc(m.id)}"><div class="gutter" data-uid="${esc(m.a.id)}" data-ctx="user">${avatar(a)}</div><div class="body">
          <div class="meta"><span class="author" data-uid="${esc(m.a.id)}" data-ctx="user" style="color:${esc(a.color)}">${esc(a.name)}</span><span class="time" title="${esc(new Date(m.ts).toLocaleString())}">${esc(fmtStamp(m.ts))}</span></div>
          ${reply}${text}${file}${img}${re}</div>${acts}</div>`;
      } else {
        h += `<div class="msg ${mentionsMe(m.text) ? 'mentions-me' : ''}" data-mid="${esc(m.id)}"><div class="gutter time-side">${esc(fmtTime(m.ts))}</div><div class="body">${reply}${text}${file}${img}${re}</div>${acts}</div>`;
      }
      prev = m;
    }
    box.innerHTML = h;
    if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
    paintImages();
    renderReplyBar();
  }

  function renderRe(m) {
    if (!m.re) return '';
    const pills = [];
    for (const e in m.re) {
      const who = Object.keys(m.re[e]).filter((u) => m.re[e][u] > 0);
      if (!who.length) continue;
      const k = getKnown(cur.sid);
      const names = who.map((u) => (u === me.id ? 'You' : (k[u] && k[u].name) || 'someone')).join(', ');
      pills.push(`<button class="re-pill ${who.includes(me.id) ? 'mine' : ''}" data-rtoggle="${esc(m.id)}" data-e="${esc(e)}" title="${esc(names)}">${esc(e)}<span>${who.length}</span></button>`);
    }
    return pills.length ? `<div class="reacts">${pills.join('')}<button class="re-pill add" data-react="${esc(m.id)}" title="Add reaction">${icon('smile')}</button></div>` : '';
  }

  // tiny emoji picker anchored to an element
  function emojiPicker(anchor, onPick, list = REACTS) {
    const m = $('emojiMenu');
    m.innerHTML = list.map((e) => `<button data-emo="${e}">${e}</button>`).join('');
    const r = anchor.getBoundingClientRect();
    m.classList.remove('hidden');
    const mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.max(8, r.left + mw <= window.innerWidth - 8 ? r.left : r.right - mw) + 'px';
    m.style.top = Math.max(8, Math.min(window.innerHeight - mh - 8, r.top - mh - 6 > 8 ? r.top - mh - 6 : r.bottom + 6)) + 'px';
    m.onclick = (e) => { const b = e.target.closest('[data-emo]'); if (!b) return; m.classList.add('hidden'); onPick(b.dataset.emo); };
  }

  // show a person: open the member list at them, flash their row, and open their menu
  function jumpToPerson(uid, x, y) {
    if (!membersOpen) { membersOpen = true; store.set('membersOpen', true); }
    renderMembers();
    const row = [...document.querySelectorAll('#members .mem')].find((el) => el.dataset.uid === uid);
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
    }
    userMenu(uid, x, y);
  }

  // ---- message box: coloured copy of the text under the (transparent) textarea, and the @ picker
  function composerHtml(text) {
    let t = esc(text)
      .replace(/`[^`\n]+`/g, (m) => `<span class="hl-code">${m}</span>`)
      .replace(/\bhttps?:\/\/[^\s<]+/g, (m) => `<span class="hl-link">${m}</span>`)
      .replace(/\*\*[^*\n]+\*\*|~~[^~\n]+~~|__[^_\n]+__/g, (m) => `<span class="hl-mark">${m}</span>`)
      .replace(/(^|\s)(@[\p{L}\p{N}_.-]{1,32})/gu, (all, pre, tag) => pre + `<span class="${mentionTarget(tag) ? 'hl-mention' : 'hl-at'}">${tag}</span>`);
    return t + (text.endsWith('\n') ? ' ' : ''); // a trailing newline needs something on its line to take height
  }
  function syncComposer() {
    const inp = $('msgInput'), mirror = $('msgMirror');
    if (!inp || !mirror) return;
    const html = composerHtml(inp.value || '');
    if (mirror.innerHTML !== html) mirror.innerHTML = html;
    mirror.scrollTop = inp.scrollTop;
  }
  let mention = null; // { start, items, sel } while the @ picker is open
  function closeMention() { mention = null; $('mentionMenu').classList.add('hidden'); }
  function updateMention() {
    const inp = $('msgInput');
    const caret = inp.selectionStart ?? (inp.value || '').length;
    const m = /(^|\s)@([\p{L}\p{N}_.-]{0,32})$/u.exec((inp.value || '').slice(0, caret));
    if (!m || !server(cur.sid)) return closeMention();
    const q = m[2].toLowerCase();
    const items = serverPeople(cur.sid).map((p) => ({ ...p, tag: mentionTag(p.user.name) }))
      .filter((p) => p.tag && p.tag.toLowerCase().includes(q))
      .sort((a, b) => (b.tag.toLowerCase().startsWith(q) - a.tag.toLowerCase().startsWith(q)) || (b.on - a.on) || a.user.name.localeCompare(b.user.name))
      .slice(0, 8);
    if (!items.length) return closeMention();
    mention = { start: caret - m[2].length - 1, items, sel: mention && mention.sel < items.length ? mention.sel : 0 };
    paintMention();
  }
  function paintMention() {
    const el = $('mentionMenu');
    el.innerHTML = '<div class="mm-head">Members</div>' + mention.items.map((p, i) =>
      `<button type="button" class="mm-item ${i === mention.sel ? 'sel' : ''}" data-i="${i}" role="option">${avatar(p.user)}<span class="mm-name" style="color:${esc(p.user.color)}">${esc(p.user.name)}</span><span class="mm-sub">${p.on ? 'online' : 'offline'}</span></button>`).join('');
    el.classList.remove('hidden');
  }
  function acceptMention(i) {
    const inp = $('msgInput'), p = mention && mention.items[i];
    if (!p) return closeMention();
    const caret = inp.selectionStart ?? inp.value.length, ins = '@' + p.tag + ' ';
    inp.value = inp.value.slice(0, mention.start) + ins + inp.value.slice(caret);
    inp.selectionStart = inp.selectionEnd = mention.start + ins.length;
    closeMention();
    inp.focus();
    inp.dispatchEvent(new Event('input'));
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
    $('meAvatar').outerHTML = `<div class="avatar" id="meAvatar" style="background:${avBg(me.color)}">${esc(me.name[0].toUpperCase())}<span class="dot"></span></div>`;
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
    const pending = !!(voice && voice.ssFrame && !voice.ss);
    $('cbShare').classList.toggle('on', ss); $('cbShare').classList.toggle('pending', pending);
    $('cbShare').title = ss ? 'Stop sharing' : pending ? 'Waiting for you to pick a screen… (click to cancel)' : 'Share your screen';
    $('vsCam').classList.toggle('on', cam); $('vsShare').classList.toggle('on', ss); $('vsShare').classList.toggle('pending', pending);
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

  function toast(text, ms) {
    const t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toast.tm);
    toast.tm = setTimeout(() => t.classList.add('hidden'), ms || 3000);
    return false;
  }

  // profile editor: live preview card + colour swatches (+ custom colour)
  function profileEditor(name, color) {
    const custom = !COLORS.includes(color);
    return `<div class="pedit">
      <div class="pcard" id="pCard">
        <div class="pcard-banner" style="background:${avBg(color)}"></div>
        <div class="pcard-av" style="background:${avBg(color)}">${esc((name[0] || '?').toUpperCase())}<span class="dot"></span></div>
        <div class="pcard-body"><div class="pcard-name">${esc(name || 'Your name')}</div><div class="pcard-sub">Online</div></div>
      </div>
      <div class="pedit-fields">
        <label>Display name</label><input type="text" id="mName" maxlength="32" value="${esc(name)}" placeholder="e.g. daniel">
        <label>Profile colour</label>
        <div class="swatches" id="mColors">${COLORS.map((c) => `<button type="button" class="swatch ${c === color ? 'sel' : ''}" data-color="${c}" style="--sw:${c}" title="${c}">${icon('check')}</button>`).join('')}
          <label class="swatch custom ${custom ? 'sel' : ''}" title="Custom colour" style="--sw:${custom ? color : '#2b2d31'}">${icon('plus')}<input type="color" id="mCustom" value="${color}"></label>
        </div>
      </div>
    </div>`;
  }
  function wireProfileEditor(state) {
    const paint = () => {
      const card = $('pCard');
      card.querySelector('.pcard-banner').style.background = avBg(state.color);
      const pav = card.querySelector('.pcard-av');
      pav.style.background = avBg(state.color);
      pav.firstChild.nodeValue = ($('mName').value.trim()[0] || '?').toUpperCase();
      card.querySelector('.pcard-name').textContent = $('mName').value.trim() || 'Your name';
      card.querySelector('.pcard-name').style.color = state.color;
      $('mColors').querySelectorAll('.swatch').forEach((x) => x.classList.toggle('sel', x.dataset.color === state.color || (x.classList.contains('custom') && !COLORS.includes(state.color))));
      const cu = $('mColors').querySelector('.custom');
      if (!COLORS.includes(state.color)) cu.style.setProperty('--sw', state.color);
    };
    $('mColors').onclick = (e) => { const b = e.target.closest('[data-color]'); if (!b) return; state.color = b.dataset.color; paint(); };
    $('mCustom').oninput = () => { state.color = $('mCustom').value; paint(); };
    $('mName').addEventListener('input', paint);
    paint();
  }

  function profileModal(first) {
    const state = { color: (me && me.color) || COLORS[Math.floor(Math.random() * COLORS.length)] };
    modal(`<h2>Welcome to Dischord</h2>
      <p>Pick a name and a colour. It's stored only in this browser.</p>
      ${profileEditor('', state.color)}
      <div class="actions"><button class="btn primary" id="mOk">Continue</button></div>`, () => {
      wireProfileEditor(state);
      const inp = $('mName');
      inp.focus();
      const ok = () => {
        const name = inp.value.trim().slice(0, 32);
        if (!name) return inp.focus();
        const color = state.color;
        me = { id: rid(12), name, color };
        store.set('me', me);
        closeModal();
        start();
      };
      $('mOk').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    }, !first, true);
  }

  const opt = (val, cur, label) => `<option value="${val}" ${String(val) === String(cur) ? 'selected' : ''}>${label}</option>`;

  function settingsModal(tab = 'profile') {
    const state = { color: me.color };
    modal(`<div class="tabs"><button data-tab="profile">My profile</button><button data-tab="av">Voice &amp; Video</button></div>
      <div class="tab-body" data-body="profile">
        ${profileEditor(me.name, me.color)}
        ${'Notification' in window && Notification.permission !== 'granted' ? '<label>Notifications</label><button class="btn" id="mNotif">Enable desktop notifications</button>' : ''}
      </div>
      <div class="tab-body" data-body="av">
        <h3>Microphone</h3>
        <label for="aMicGain">Microphone volume · <output id="aMicGainValue">${audioPercent(av.micGain)}%</output></label>
        <input type="range" id="aMicGain" min="0" max="200" step="1" value="${audioPercent(av.micGain)}" aria-label="Microphone volume">
        <p class="hint">100% is the normal level. Boost a quiet microphone up to 200%; lower it if your voice sounds distorted.</p>
        <h3>Camera</h3>
        <div class="grid3">
          <div><label>Resolution</label><select id="aCamQ">${opt('360', av.camQ, '360p')}${opt('720', av.camQ, '720p')}${opt('1080', av.camQ, '1080p')}${opt('1440', av.camQ, '1440p')}${opt('2160', av.camQ, '4K')}</select></div>
          <div><label>Frame rate</label><select id="aCamFps">${opt(15, av.camFps, '15 fps')}${opt(30, av.camFps, '30 fps')}${opt(60, av.camFps, '60 fps')}</select></div>
          <div><label>Bitrate</label><select id="aCamBr">${CAM_BRS.map((k) => opt(k, av.camBr, mbps(k))).join('')}</select></div>
        </div>
        <h3>Screen share</h3>
        <div class="grid3">
          <div><label>Resolution</label><select id="aSsQ">${opt('source', av.ssQ, 'Source (native)')}${opt('2160', av.ssQ, '4K')}${opt('1440', av.ssQ, '1440p')}${opt('1080', av.ssQ, '1080p')}${opt('720', av.ssQ, '720p')}</select></div>
          <div><label>Frame rate</label><select id="aSsFps">${opt(5, av.ssFps, '5 fps (slides)')}${opt(15, av.ssFps, '15 fps')}${opt(30, av.ssFps, '30 fps')}${opt(60, av.ssFps, '60 fps (games)')}</select></div>
          <div><label>Bitrate</label><select id="aSsBr">${SS_BRS.map((k) => opt(k, av.ssBr, mbps(k))).join('')}</select></div>
          <div style="grid-column: span 3"><label>Optimize screen share for</label><select id="aSsHint">${opt('motion', av.ssHint, 'Smoothness: prioritize frame rate (recommended)')}${opt('detail', av.ssHint, 'Clarity: prioritize sharp text and detail')}</select></div>
        </div>
        <p class="hint">Smoothness prioritizes the selected FPS under load. 1080p and a Low own preview reduce the processing needed for steady motion. Clarity may reduce FPS to keep text sharp.</p>
        <h3>Watching others</h3>
        <div class="grid3">
          <div><label>Video codec</label><select id="aCodec">${opt('h264', av.codec, 'H.264 (recommended)')}${opt('', av.codec, 'Auto')}${opt('vp9', av.codec, 'VP9')}${opt('av1', av.codec, 'AV1')}</select></div>
          <div><label>Your own preview</label><select id="aSelf">${opt('full', av.selfPreview, 'Full quality')}${opt('low', av.selfPreview, 'Low (saves CPU)')}${opt('off', av.selfPreview, 'Hidden')}</select></div>
          <div style="grid-column: span 3"><label>Max download per stream</label><select id="aRecv">${opt(0, av.recvCap, 'No limit (use each sender\'s setting)')}${VIEW_BRS.map((k) => opt(k, av.recvCap, 'Up to ' + mbps(k))).join('')}</select></div>
        </div>
        <label class="inline-check"><input type="checkbox" id="aStats" ${av.showStats ? 'checked' : ''}> Always show stream stats (resolution · fps · bitrate · codec) on video tiles</label>
        <p class="hint">Higher bitrate improves detail, and every viewer needs that much upload bandwidth. Change any stream's quality from its tile. ${voice ? 'Camera changes reconnect your call. Screen share changes apply after you stop and share again.' : ''}</p>
        ${voice ? '<button class="btn" id="aDevices">Choose camera…</button><p class="hint">Use the small arrows beside the microphone and headphones buttons to choose your input and output devices.</p>' : '<p class="hint">Join a voice channel to pick your camera. Use the small arrows beside the microphone and headphones buttons to choose your input and output devices.</p>'}
      </div>
      <div class="actions"><button class="btn link" data-close>Cancel</button><button class="btn primary" id="mOk">Save</button></div>`, () => {
      const show = (t) => {
        $('modal').querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('sel', b.dataset.tab === t));
        $('modal').querySelectorAll('[data-body]').forEach((b) => b.classList.toggle('hidden', b.dataset.body !== t));
      };
      $('modal').querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => show(b.dataset.tab)));
      show(tab);
      wireProfileEditor(state);
      $('aMicGain').oninput = () => { $('aMicGainValue').textContent = audioPercent($('aMicGain').value) + '%'; };
      if ($('mNotif')) $('mNotif').onclick = () => Notification.requestPermission().then(() => toast('Notifications: ' + Notification.permission));
      if ($('aDevices')) $('aDevices').onclick = () => { closeModal(); showVoice(); voice.devices = true; voicePost({ toggleSettings: true }); renderStage(); };
      $('mOk').onclick = () => {
        const name = $('mName').value.trim().slice(0, 32);
        if (!name) { show('profile'); return $('mName').focus(); }
        const nameChanged = name !== me.name;
        const color = state.color;
        me = { ...me, name, color };
        store.set('me', me);
        const next = {
          micGain: audioPercent($('aMicGain').value),
          camQ: $('aCamQ').value, camFps: +$('aCamFps').value, camBr: +$('aCamBr').value,
          ssQ: $('aSsQ').value, ssFps: +$('aSsFps').value, ssBr: +$('aSsBr').value, ssHint: $('aSsHint').value, recvCap: +$('aRecv').value, codec: $('aCodec').value, selfPreview: $('aSelf').value, showStats: $('aStats').checked, v8: 1, v9: 1,
        };
        const sendKeys = ['camQ', 'camFps', 'camBr'];
        const shareKeys = ['ssQ', 'ssFps', 'ssBr', 'ssHint'];
        const viewKeys = ['codec', 'selfPreview'];
        const shareChanged = shareKeys.some((k) => String(next[k]) !== String(av[k]));
        const viewChanged = viewKeys.some((k) => String(next[k]) !== String(av[k]));
        const avChanged = sendKeys.some((k) => String(next[k]) !== String(av[k]));
        av = next;
        store.set('av', av);
        closeModal();
        broadcastState();
        if (nameChanged) { // VDO.Ninja labels come from the URL; reconnect so labels update
          for (const sid in meshes) disconnectMesh(sid);
          setTimeout(() => servers.forEach(connectMesh), 400);
        }
        if (voice && (avChanged || nameChanged)) joinVoice(voice.sid, voice.cid, voice.cam);
        else if (voice) applyVolumes(true);
        if (voice && shareChanged && voice.ssFrame) toast('Stop sharing, then share again to apply the new resolution, FPS, bitrate and smoothness settings.', 8000);
        if (viewChanged) { tileEls.forEach((el) => { el.dataset.vs = '__reload'; }); } // reconnect viewers with the new codec
        render();
        renderStage();
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
      case 'leave': confirmLeave(s); break;
    }
  };

  $('channelList').onclick = (e) => {
    const add = e.target.closest('[data-add]');
    if (add) return channelModal(add.dataset.add);
    const del = e.target.closest('[data-delc]');
    if (del) { e.stopPropagation(); return deleteChannelConfirm(del.dataset.delc); }
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
    const save = e.target.closest('[data-image-save]');
    if (save) { e.stopPropagation(); return saveImage(cur.sid, cur.cid, save.dataset.imageSave); }
    const at = e.target.closest('[data-mention]');
    if (at) { e.stopPropagation(); return jumpToPerson(at.dataset.mention, e.clientX, e.clientY); }
    const image = e.target.closest('[data-image-open]');
    if (image) return openImage(cur.sid, cur.cid, image.dataset.imageOpen);
    const rp = e.target.closest('[data-reply]');
    if (rp) return replyToMessage(rp.dataset.reply);
    const jump = e.target.closest('[data-reply-jump]');
    if (jump) return jumpToMessage(jump.dataset.replyJump);
    const download = e.target.closest('[data-file-download]');
    if (download) return fileTransfers.download(cur.sid, cur.cid, download.dataset.fileDownload);
    const cancel = e.target.closest('[data-file-cancel]');
    if (cancel) return fileTransfers.cancel(cur.sid, cur.cid, cancel.dataset.fileCancel);
    const rt = e.target.closest('[data-rtoggle]');
    if (rt) return toggleReaction(rt.dataset.rtoggle, rt.dataset.e);
    const ra = e.target.closest('[data-react]');
    if (ra) { e.stopPropagation(); return emojiPicker(ra, (emo) => toggleReaction(ra.dataset.react, emo)); }
    const d = e.target.closest('[data-del]');
    if (d) return deleteMessage(d.dataset.del);
    const ed = e.target.closest('[data-edit]');
    if (ed) return editMessage(ed.dataset.edit);
  };

  const input = $('msgInput');
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px'; syncComposer(); };
  input.addEventListener('input', () => { autosize(); updateMention(); if (input.value.trim()) sendTyping(); });
  input.addEventListener('scroll', () => { $('msgMirror').scrollTop = input.scrollTop; });
  input.addEventListener('click', updateMention);
  input.addEventListener('blur', () => setTimeout(closeMention, 150)); // let a click on the list land first
  // while the @ picker is open the arrow keys, Enter, Tab and Escape belong to it
  input.addEventListener('keydown', (e) => {
    if (!mention) return;
    const n = mention.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { mention.sel = (mention.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; paintMention(); }
    else if ((e.key === 'Enter' && !e.isComposing) || e.key === 'Tab') acceptMention(mention.sel);
    else if (e.key === 'Escape') closeMention();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  });
  $('mentionMenu').addEventListener('mousedown', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    e.preventDefault(); // keep the caret in the message box
    acceptMention(+b.dataset.i);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (sendMessage(input.value)) input.value = '';
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
  // the call bar and the member-strip pill fade out after a few seconds without mouse movement
  (function idleControls() {
    const stage = $('voiceStage');
    let timer = null, overBar = false;
    const menuOpen = () => ['ctxMenu', 'emojiMenu', 'qMenu'].some((id) => !$(id).classList.contains('hidden'));
    const wake = () => {
      stage.classList.remove('idle');
      clearTimeout(timer);
      timer = setTimeout(() => { if (overBar || menuOpen()) wake(); else stage.classList.add('idle'); }, 1500);
    };
    stage.addEventListener('mousemove', wake);
    stage.addEventListener('mousedown', wake);
    document.addEventListener('keydown', wake);
    $('callBar').addEventListener('mouseenter', () => { overBar = true; wake(); });
    $('callBar').addEventListener('mouseleave', () => { overBar = false; wake(); });
    wake();
  })();

  // the call preview: drag it anywhere inside the chat area; a plain click returns to the call
  (function miniPreview() {
    const stage = $('voiceStage');
    let drag = null, moved = false;
    const at = { r: 16, b: 84 }; // where the preview is, as offsets from the right / bottom of the chat area
    const place = (r, b) => { at.r = r; at.b = b; stage.style.setProperty('--mini-r', r + 'px'); stage.style.setProperty('--mini-b', b + 'px'); };
    const saved = store.get('miniPos', null);
    if (saved && Number.isFinite(saved.r) && Number.isFinite(saved.b)) place(saved.r, saved.b);
    let width = Math.max(200, Math.min(720, +store.get('miniW', 320) || 320));
    stage.style.setProperty('--mini-w', width + 'px');
    stage.addEventListener('wheel', (e) => {
      if (!stage.classList.contains('mini')) return;
      e.preventDefault();
      const main = $('main').getBoundingClientRect();
      const next = Math.max(200, Math.min(720, main.width - 32, Math.round(width * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
      if (next === width) return;
      // keep it docked to the same corner while it grows or shrinks
      const maxR = main.width - width, maxB = main.height - width * 9 / 16;
      const leftSide = at.r > maxR / 2, topSide = at.b > maxB / 2;
      width = next;
      stage.style.setProperty('--mini-w', width + 'px');
      store.set('miniW', width);
      place(leftSide ? Math.max(16, main.width - width - 16) : 16, topSide ? Math.max(84, main.height - width * 9 / 16 - 64) : 84);
      store.set('miniPos', { r: at.r, b: at.b });
    }, { passive: false });
    let spring = 0;
    stage.addEventListener('pointerdown', (e) => {
      if (!stage.classList.contains('mini') || e.button) return;
      cancelAnimationFrame(spring); // catch it mid-flight
      const main = $('main').getBoundingClientRect();
      // start from the tracked position, not the drawn box: the box may be mid-animation or scaled
      drag = { x: e.clientX, y: e.clientY, r: at.r, b: at.b, maxR: main.width - stage.offsetWidth, maxB: main.height - stage.offsetHeight, trail: [] };
      moved = false;
      try { stage.setPointerCapture(e.pointerId); } catch { }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      stage.classList.add('dragging');
      drag.pos = { r: drag.r - dx, b: drag.b - dy };
      drag.trail.push({ t: performance.now(), r: drag.pos.r, b: drag.pos.b });
      if (drag.trail.length > 6) drag.trail.shift();
      place(drag.pos.r, drag.pos.b);
    });
    // Released: keep the speed it was thrown with, aim for the corner it is heading to, and settle there
    // on a slightly under-damped spring so it overshoots and bounces back.
    const fling = (pos, v, maxR, maxB) => {
      const rs = [16, Math.max(16, maxR - 16)], bs = [84, Math.max(84, maxB - 64)];
      const near = (x, list) => list.reduce((a, c) => (Math.abs(c - x) < Math.abs(a - x) ? c : a));
      const target = { r: near(pos.r + v.r * 0.3, rs), b: near(pos.b + v.b * 0.3, bs) }; // where it would coast to in ~1/3 s
      store.set('miniPos', target);
      if (document.hidden || typeof requestAnimationFrame !== 'function') return place(target.r, target.b);
      const K = 150, C = 13; // stiffness and damping (critical damping would be ~24.5, so this bounces)
      let last = performance.now();
      const step = (now) => {
        const dt = Math.min(0.032, (now - last) / 1000); last = now;
        for (const k of ['r', 'b']) {
          v[k] += (-K * (pos[k] - target[k]) - C * v[k]) * dt;
          pos[k] += v[k] * dt;
        }
        if (Math.abs(pos.r - target.r) < 0.5 && Math.abs(pos.b - target.b) < 0.5 && Math.hypot(v.r, v.b) < 8) return place(target.r, target.b);
        place(Math.round(pos.r * 10) / 10, Math.round(pos.b * 10) / 10);
        spring = requestAnimationFrame(step);
      };
      spring = requestAnimationFrame(step);
    };
    const end = () => {
      if (drag && drag.pos) {
        const a = drag.trail[0], z = drag.trail[drag.trail.length - 1];
        const dt = a && z && z.t > a.t && performance.now() - z.t < 120 ? (z.t - a.t) / 1000 : 0; // a pause before letting go means no throw
        const cap = (x) => Math.max(-6000, Math.min(6000, x));
        const v = dt ? { r: cap((z.r - a.r) / dt), b: cap((z.b - a.b) / dt) } : { r: 0, b: 0 };
        fling({ ...drag.pos }, v, drag.maxR, drag.maxB);
      }
      drag = null;
      stage.classList.remove('dragging');
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('click', () => {
      if (!stage.classList.contains('mini')) return;
      if (moved) { moved = false; return; } // that was a drag, not a click
      showVoice();
    });
  })();
  $('tiles').addEventListener('click', (e) => {
    if ($('voiceStage').classList.contains('mini')) return; // the preview only jumps back to the call
    const q = e.target.closest('[data-q]');
    if (q) { e.stopPropagation(); return qualityMenu(q.dataset.q, q); }
    const wf = e.target.closest('[data-wfs]');
    if (wf) { winFs = winFs === wf.dataset.wfs ? null : wf.dataset.wfs; if (document.fullscreenElement) document.exitFullscreen(); return renderStage(); }
    const fs = e.target.closest('[data-fs]');
    if (fs) { const el = tileEls.get(fs.dataset.fs); if (document.fullscreenElement) document.exitFullscreen(); else if (el && el.requestFullscreen) el.requestFullscreen(); return; }
    const un = e.target.closest('[data-unwatch]');
    if (un) { if (winFs) winFs = null; return setWatching(un.dataset.unwatch, false); }
    const wa = e.target.closest('[data-watch]');
    if (wa) return setWatching(wa.dataset.watch, true);
    if (winFs) return; // a click on the picture shouldn't change the layout underneath
    const t = e.target.closest('.tile.video');
    if (t) { focusUid = focusUid === t.dataset.key ? null : t.dataset.key; renderStage(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#qMenu')) $('qMenu').classList.add('hidden'); });
  document.addEventListener('fullscreenchange', () => {
    if (voice) renderStage(); // swaps the button between expand / exit
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && focusUid && $('modalBack').classList.contains('hidden')) { focusUid = null; renderStage(); } });
  $('devDone').onclick = () => { if (!voice) return; voice.devices = false; voicePost({ toggleSettings: false }); renderStage(); };
  for (const [id, kind] of [['micCaret', 'audioinput'], ['cbMicCaret', 'audioinput'], ['deafCaret', 'audiooutput'], ['cbDeafCaret', 'audiooutput'], ['cbCamCaret', 'videoinput']]) {
    caret(id, (el) => deviceMenu(el, kind));
  }
  caret('cbShareCaret', shareMenu);
  $('userPanel').addEventListener('click', (e) => { if (!e.target.closest('button')) settingsModal('profile'); });
  $('micBtn').onclick = toggleMic;
  $('cbMic').onclick = toggleMic;
  $('deafBtn').onclick = toggleDeaf;
  $('cbDeaf').onclick = toggleDeaf;
  $('settingsBtn').onclick = () => settingsModal('profile');
  $('cbSettings').onclick = () => settingsModal('av');
  $('membersToggle').onclick = () => { membersOpen = !membersOpen; store.set('membersOpen', membersOpen); renderMembers(); };

  // right-click menus
  document.addEventListener('contextmenu', (e) => {
    const btn = e.target.closest('#cbMic, #micBtn, #micCaret, #cbMicCaret, #cbDeaf, #deafBtn, #deafCaret, #cbDeafCaret, #cbCam, #vsCam, #cbCamCaret, #cbShare, #vsShare, #cbShareCaret');
    if (btn && ctxToggled === btn) { e.preventDefault(); ctxToggled = null; return; } // its menu was open: this right-click just closed it
    const mic = e.target.closest('#cbMic, #micBtn, #micCaret, #cbMicCaret');
    if (mic) { e.preventDefault(); return deviceMenu(mic, 'audioinput'); }
    const out = e.target.closest('#cbDeaf, #deafBtn, #deafCaret, #cbDeafCaret');
    if (out) { e.preventDefault(); return deviceMenu(out, 'audiooutput'); }
    const cam = e.target.closest('#cbCam, #vsCam, #cbCamCaret');
    if (cam) { e.preventDefault(); return deviceMenu(cam, 'videoinput'); }
    const shr = e.target.closest('#cbShare, #vsShare, #cbShareCaret');
    if (shr) { e.preventDefault(); return shareMenu(shr); }
    const u = e.target.closest('#channelList .voice-user[data-uid], #members .mem[data-uid], #tiles .tile[data-key], [data-ctx="user"][data-uid], #userPanel');
    const msg = !u && e.target.closest('#messages .msg[data-mid]');
    // never show the browser's own menu, except in text fields where it provides paste / spellcheck
    if (!e.target.closest('input, textarea, [contenteditable="true"]')) e.preventDefault();
    if (!u && !msg) {
      const chan = e.target.closest('#channelList .chan[data-cid]');
      if (chan) return channelMenu(chan.dataset.cid, e.clientX, e.clientY);
      const rail = e.target.closest('#serverList [data-sid]');
      if (rail) return railMenu(rail.dataset.sid, e.clientX, e.clientY);
      if (e.target.closest('#channelList, #serverHeader') && server(cur.sid)) return serverAreaMenu(e.clientX, e.clientY);
      return closeCtx();
    }
    e.preventDefault();
    if (msg) return messageMenu(msg.dataset.mid, e.clientX, e.clientY);
    const uid = u.id === 'userPanel' ? me.id : (u.dataset.uid || (u.dataset.key || '').split(':')[0]);
    if (uid) userMenu(uid, e.clientX, e.clientY);
  });
  document.addEventListener('mousedown', (e) => {
    // pressing the button that owns the open menu closes it; remember that so its click does not reopen it
    ctxToggled = ctxAnchor && ctxAnchor.contains(e.target) ? ctxAnchor : null;
    if (!e.target.closest('#ctxMenu')) closeCtx();
    if (!e.target.closest('#emojiMenu') && !e.target.closest('[data-react]') && !e.target.closest('#cbReact') && !e.target.closest('#cbReactCaret') && !e.target.closest('#emojiBtn')) $('emojiMenu').classList.add('hidden');
  });
  window.addEventListener('blur', closeCtx);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeCtx(); $('emojiMenu').classList.add('hidden'); if (winFs) { winFs = null; renderStage(); } } });

  $('replyBar').onclick = (e) => { if (e.target.closest('#cancelReplyBtn')) cancelReply(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && replyTarget) cancelReply(); });

  // Files, including images: offer metadata via button, paste, or drag & drop.
  $('emojiBtn').onclick = (e) => {
    e.stopPropagation();
    if (!$('emojiMenu').classList.contains('hidden')) return $('emojiMenu').classList.add('hidden');
    emojiPicker($('emojiBtn'), (emo) => {
      const at = input.selectionStart ?? input.value.length, to = input.selectionEnd ?? at;
      input.value = input.value.slice(0, at) + emo + input.value.slice(to);
      input.focus();
      input.selectionStart = input.selectionEnd = at + emo.length;
      input.dispatchEvent(new Event('input'));
    }, EMOJIS);
  };
  $('attachBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = () => { addAttachments($('fileInput').files); $('fileInput').value = ''; };
  $('msgInput').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.length) { e.preventDefault(); addAttachments(files); }
  });
  $('textView').addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $('textView').classList.add('drop'); } });
  $('textView').addEventListener('dragleave', (e) => { if (!e.relatedTarget || !$('textView').contains(e.relatedTarget)) $('textView').classList.remove('drop'); });
  $('textView').addEventListener('drop', (e) => { e.preventDefault(); $('textView').classList.remove('drop'); addAttachments(e.dataTransfer.files); });
  $('attachBar').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { pending.splice(+b.dataset.rm, 1); renderAttachBar(); } };

  // drag the inner edge of the channel sidebar / member list to resize; double-click resets
  const PANEL_MIN = 180, PANEL_MAX = 420;
  function applyPanelWidths() {
    for (const [key, prop] of [['sideW', '--side-w'], ['memW', '--mem-w']]) {
      const w = +store.get(key, 0);
      $('app').style.setProperty(prop, w ? Math.max(PANEL_MIN, Math.min(PANEL_MAX, w)) + 'px' : ''); // '' falls back to the stylesheet default
    }
  }
  applyPanelWidths();
  for (const [id, key, panel, fromLeft] of [['sideResizer', 'sideW', 'sidebar', true], ['memResizer', 'memW', 'members', false]]) {
    const handle = $(id);
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch { }
      handle.classList.add('dragging'); document.body.classList.add('resizing');
      const move = (ev) => {
        const r = $(panel).getBoundingClientRect();
        const w = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.round(fromLeft ? ev.clientX - r.left : r.right - ev.clientX)));
        store.set(key, w);
        applyPanelWidths();
      };
      const up = () => {
        handle.classList.remove('dragging'); document.body.classList.remove('resizing');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('dblclick', () => { store.del(key); applyPanelWidths(); });
  }

  // in-call reactions
  $('stripToggle').onclick = () => { hideStrip = !hideStrip; store.set('hideStrip', hideStrip); renderStage(); };
  let emojiOwner = null;
  for (const [id, list] of [['cbReact', REACTS], ['cbReactCaret', EMOJIS]]) {
    $(id).onclick = (e) => {
      e.stopPropagation();
      const open = !$('emojiMenu').classList.contains('hidden');
      $('emojiMenu').classList.add('hidden');
      if (open && emojiOwner === id) { emojiOwner = null; return; }
      emojiOwner = id;
      emojiPicker($(id), sendCallReaction, list);
    };
  }

  window.addEventListener('hashchange', checkInviteHash);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    syncVoiceState();
    broadcastState();
    if (cur.sid && cur.cid) { markRead(cur.sid, cur.cid); renderRail(); renderChannels(); }
  });
  window.addEventListener('pagehide', () => { clearTimeout(filePaintTimer); filePaints.clear(); fileTransfers.close(); cancelImageRequests(); for (const sid in meshes) send(sid, { t: 'bye' }); });

  function checkInviteHash() {
    const m = location.hash.match(/invite=([A-Za-z0-9_-]+)/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    if (!me) { pendingInvite = m[1]; return; }
    joinFromInvite(m[1]);
  }
  let pendingInvite = null;

  // ---------------------------------------------------------------- timers
  bgTimer.every(PING_MS, broadcastState); // presence heartbeat, unaffected by background-tab throttling
  setInterval(() => {
    renderTyping();
    if (cur.sid) renderPresence();
  }, 3000);
  setInterval(paintSpeaking, 250);
  setInterval(pollStats, 2000);
  setInterval(() => applyVolumes(true), 4000);
  setInterval(paintImages, 15000); // retry visible uncached previews when a provider returns

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
