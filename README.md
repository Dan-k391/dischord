# Dischord

A Discord-style chat app built on [VDO.Ninja](https://vdo.ninja). No accounts, no backend — just static files.

## Features
- **Servers** with text and voice channels, shareable **invite links**
- **Text chat** sent peer-to-peer (Markdown-ish formatting, edit/delete, typing indicators, unread badges, desktop notifications)
- **History sync**: when you come online, peers send you recent messages you missed
- **Voice channels** with mute/deafen, **camera**, **screen share**, speaking indicators, focus view + fullscreen for streams, and **quality settings** (resolution, frame rate and bitrate for camera and screen share, plus a per-stream bitrate picker on every video tile)
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
- Everything is saved in your browser's `localStorage` (last 500 messages per channel).

## Limits (by design, since there's no server)
- If nobody else is online, messages you send are only delivered when someone who has them
  comes back online alongside the recipient.
- Anyone with the invite can rename the server and add/delete channels — there are no roles.
- Large rooms: voice is a WebRTC mesh, so it's best for small groups (≈ up to 8–10 people).

## Testing with two identities
Add `?as=alice` (or any name) to the URL to get a separate identity and storage in the same browser.

## Self-hosting VDO.Ninja (optional)
Add this before `app.js` in `index.html`:
```html
<script>window.DISCHORD_CONFIG = { vdoUrl: 'https://your-vdo-host/' };</script>
```

## Files
- `index.html` – layout
- `style.css` – Discord-like dark theme
- `app.js` – all app logic (servers, mesh protocol, rendering, voice)
