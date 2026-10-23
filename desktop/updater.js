'use strict';

// Update check for the Windows app. Looks at this repository's GitHub releases for a newer desktop-v*
// release. An installed copy downloads the new installer, checks it against the release's SHA256SUMS.txt
// and installs it quietly, then starts again; a portable or ZIP copy opens the release page instead.

const { app, dialog, net, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RELEASES = 'https://api.github.com/repos/Dan-k391/dischord/releases?per_page=30';
const INSTALLER = 'Dischord-Setup.exe';
const EVERY = 12 * 60 * 60 * 1000;
// DISCHORD_UPDATE_DRY_RUN (testing only): act as an installed copy, but stop before running the installer.
const dryRun = !!process.env.DISCHORD_UPDATE_DRY_RUN;

const parse = (v) => (/^(\d+)\.(\d+)\.(\d+)$/.exec(v) || []).slice(1).map(Number);
function newer(a, b) {
  const x = parse(a), y = parse(b);
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
async function latest() {
  const res = await net.fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Dischord-Desktop' } });
  if (!res.ok) throw new Error('GitHub answered ' + res.status);
  let best = null;
  for (const r of await res.json()) {
    const m = /^desktop-v(\d+\.\d+\.\d+)$/.exec(r && r.tag_name || '');
    if (!m || r.draft || r.prerelease) continue;
    if (!best || newer(m[1], best.version)) best = { version: m[1], page: r.html_url, assets: r.assets || [] };
  }
  return best;
}
// Installed with the setup program (it leaves its uninstaller next to the app), not a portable or ZIP copy.
const installed = () => dryRun || (!process.env.PORTABLE_EXECUTABLE_FILE &&
  fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall Dischord.exe')));

function create({ getWindow, showWindow, beforeInstall }) {
  let busy = false, offered = '';
  const owner = () => { const w = getWindow(); return w && !w.isDestroyed() ? w : null; };
  const say = (message, detail = '', type = 'info') => { const w = owner(); const o = { type, title: 'Dischord', message, detail, buttons: ['OK'], noLink: true }; return w ? dialog.showMessageBox(w, o) : dialog.showMessageBox(o); };

  async function download(release, progress) {
    const asset = release.assets.find((a) => a.name === INSTALLER), sums = release.assets.find((a) => a.name === 'SHA256SUMS.txt');
    if (!asset || !sums) throw new Error('The release has no installer.');
    const list = await (await net.fetch(sums.browser_download_url)).text();
    const line = list.split(/\r?\n/).find((l) => l.trim().endsWith(' ' + INSTALLER) || l.trim().endsWith('*' + INSTALLER));
    const want = line && line.trim().split(/\s+/)[0].toLowerCase();
    if (!want || !/^[0-9a-f]{64}$/.test(want)) throw new Error('The release has no checksum for the installer.');
    const res = await net.fetch(asset.browser_download_url);
    if (!res.ok || !res.body) throw new Error('The download failed (' + res.status + ').');
    const file = path.join(os.tmpdir(), `Dischord-Setup-${release.version}.exe`);
    const out = fs.createWriteStream(file), hash = crypto.createHash('sha256'), total = asset.size || 0;
    let got = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value); got += value.length;
        if (!out.write(value)) await new Promise((r) => out.once('drain', r));
        if (total) progress(got / total);
      }
    } finally { await new Promise((r) => out.end(r)); }
    if (hash.digest('hex') !== want) { fs.rmSync(file, { force: true }); throw new Error('The downloaded installer did not match its checksum.'); }
    return file;
  }

  async function update(release) {
    const w = owner();
    if (!installed()) { await shell.openExternal(release.page); return; }
    let file;
    try {
      file = await download(release, (p) => { if (w) w.setProgressBar(p); });
    } catch (error) {
      if (w) w.setProgressBar(-1);
      await say('The update could not be downloaded.', String(error && error.message || error), 'warning');
      return;
    } finally { if (w) w.setProgressBar(-1); }
    if (dryRun) { console.log('UPDATE-DRY-RUN would run: ' + file + ' --updated /S --force-run'); return; }
    // The setup program installs over this copy without questions and starts the new version.
    spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    beforeInstall();
    app.quit();
  }

  // manual: from the tray or the settings button; it always answers. Otherwise it speaks only about a new version.
  async function check(manual) {
    if (busy) return;
    busy = true;
    try {
      let release;
      try { release = await latest(); } catch (error) {
        if (manual) await say('Could not check for updates.', 'Check your internet connection and try again.', 'warning');
        return;
      }
      if (!release || !newer(release.version, app.getVersion())) {
        if (manual) await say('Dischord is up to date.', 'You have version ' + app.getVersion() + '.');
        return;
      }
      if (!manual && offered === release.version) return; // asked once this run already
      offered = release.version;
      // a background check waits until the window is on screen rather than popping up from the tray
      const w = owner();
      if (!manual && w && !w.isVisible()) { w.once('show', () => { busy = false; check(true); }); return; }
      if (manual) showWindow();
      const options = { type: 'info', title: 'Dischord', noLink: true, defaultId: 0, cancelId: 1,
        buttons: [installed() ? 'Update now' : 'Open download page', 'Later'],
        message: 'Dischord ' + release.version + ' is available.',
        detail: 'You have version ' + app.getVersion() + '.' + (installed() ? ' Dischord restarts once the update is installed.' : '') };
      const { response } = owner() ? await dialog.showMessageBox(owner(), options) : await dialog.showMessageBox(options);
      if (response === 0) await update(release);
    } finally { busy = false; }
  }

  function start() {
    setTimeout(() => check(false), 20000);
    setInterval(() => check(false), EVERY);
  }
  return { check, start };
}

module.exports = { create, newer };
