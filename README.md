# Dischord

A Discord-style chat app built on [VDO.Ninja](https://vdo.ninja). No accounts, no backend — just static files.

## Features
- **Servers** with text and voice channels, shareable **invite links**
- **Text chat** sent peer-to-peer: Markdown-ish formatting, edit/delete, typing indicators, unread badges, desktop notifications
- **Replies**: reply from message actions or the right-click menu; click the quote to jump to the original message
- **Files and images**: attach, paste or drag & drop up to four files with no app-imposed file size limit. Only metadata is shared until the recipient clicks **Download**; contents transfer directly from the sender, with progress and cancellation
- **Reactions** on messages, plus floating emoji reactions in voice calls
- **History sync**: when you come online, peers send you recent messages you missed
- **Voice channels** with mute/deafen, **camera** and **screen share at the same time**, speaking indicators, focus view + fullscreen
- **Right-click menus**: per-user volume, stream volume, local mute, hide video, per-stream quality; quick actions for yourself
- **Quality controls**: resolution (up to 4K / native source), frame rate and bitrate (up to 40 Mbps) for camera and screen share; per-stream bitrate picker; live stats (resolution · fps · bitrate · codec) on every video
- **Presence**: member list, online/offline, who's in which voice channel

## Run it
Camera/mic need a secure origin, so serve the folder rather than double-clicking `index.html`:

- **Windows:** double-click `start.bat` (needs Python), then open http://localhost:8080
- **Anything with Node:** `npx serve .`

To use it with friends over the internet, host the folder on any static host
(GitHub Pages, Netlify, Cloudflare Pages). Invite links point at wherever it's hosted.

## How it works
- Each server has a random id and secret key; the invite link carries both (keep it private).
- For each server you've joined, a hidden VDO.Ninja iframe joins a room with no
  camera or mic (`&videodevice=0&audiodevice=0`). Messages, presence, channel changes and history travel over its WebRTC
  data channels using the VDO.Ninja IFRAME API (`sendData` / `dataReceived`).
- Each voice channel is its own VDO.Ninja room. One hidden connection sends your mic + camera and
  plays everyone's audio (`&novideo`). Screen sharing is a second, separate stream (`&screenshare`),
  so camera and screen can run at the same time. Every camera or screen on the stage is its own
  view-only connection (`&view=…&solo&noaudio&scale=100`), so Dischord controls the layout and the
  bitrate of each stream, and videos are never downscaled to the tile size.
  The call stays connected while you browse text channels.
- Your profile, settings, server definitions and recent chat history are saved in your browser's `localStorage` (last 500 messages per channel). File contents and attachment drafts are never persisted by Dischord.

## Limits (by design, since there's no server)
- File contents are never automatically transferred, previewed, or saved by Dischord. Recipients only save files after clicking **Download**. Only file names, sizes and types are included in local chat history.
- Downloads are assembled in browser memory before saving, so practical file sizes depend on available memory and the connection.
- File transfers keep up to 32 small chunks in flight, allowing newer peers to send continuously while confirmations return. An older peer falls back to one chunk at a time; both participants should refresh after an update for faster transfers.
- Keep the original sender tab open for downloads. Reloading or closing it removes its file offers; files cannot be recovered from other recipients or chat history. A recipient can cancel a transfer, and incomplete downloads are discarded from memory.
- If nobody else is online, messages you send are only delivered when someone who has them
  comes back online alongside the recipient.
- Anyone with the invite can rename the server and add/delete channels — there are no roles.
- Large rooms: voice is a WebRTC mesh, so it's best for small groups (≈ up to 8–10 people).

## Testing with two identities
Add `?as=alice` (or any name) to the URL to get a separate identity and storage in the same browser.

## Voice and screen sharing
- New profiles start at **1080p / 60 FPS**, with **Smoothness** priority and a **Low** own preview to reduce encoding load. Existing saved preferences are preserved.
- Choose 5, 15, 30 or 60 FPS freely in **User settings → Voice & Video**. Resolution, bitrate, preview and clarity/smoothness remain selectable. Stop and restart an active share after changing its capture settings.
- The selected FPS is a capture target. Delivered FPS can be lower when the source is static or the browser, encoder or network is limited. Try a browser tab as the source for smooth motion; enable stream stats to check the actual FPS. [VDO.Ninja explains capture limits here](https://docs.vdo.ninja/guides/how-to-screen-share-in-1080p).
- Microphone mute and deafen are independent. Audio settings are reapplied when media connects or reconnects; muting one person does not affect the playback volume of people joining later.

Run the dependency-free regression checks with Node.js:
```sh
node --check app.js
node --check file-transfer.js
node tests/media.test.js
node tests/files.test.js
node tests/chat.test.js
```

## Self-hosting VDO.Ninja (optional)
Add this before `app.js` in `index.html`:
```html
<script>window.DISCHORD_CONFIG = { vdoUrl: 'https://your-vdo-host/' };</script>
```

## Files
- `index.html` – layout
- `style.css` – Discord-like dark theme
- `app.js` – all app logic (servers, mesh protocol, rendering, voice)
- `file-transfer.js` – explicit-download file transfers with bounded chunks and no persistent file cache
