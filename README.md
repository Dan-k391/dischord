# Dischord

A Discord-style chat app built on [VDO.Ninja](https://vdo.ninja). No accounts, no backend — just static files.

## Features
- **Servers** with text and voice channels, shareable **invite links**
- **Text chat** sent peer-to-peer: Markdown-ish formatting, edit/delete, typing indicators, unread badges, desktop notifications
- **Replies**: reply from message actions or the right-click menu; click the quote to jump to the original message
- **Files**: attach, paste or drag & drop up to four files with no app-imposed file size limit. Non-image contents transfer directly from the sender only after **Download**, with progress and cancellation
- **Image previews**: images automatically display a raster preview in chat. Previews are cached in the browser and available through chat history. Images are shared as a high-quality preview (up to 4096 pixels on the longer side) with a download button that saves it
- **Reactions** on messages, plus floating emoji reactions in voice calls
- **History sync**: when you come online, peers send you recent messages you missed
- **Voice channels** with mute/deafen, **camera** and **screen share at the same time**, speaking indicators, focus view + fullscreen
- **Audio levels up to 200%**: microphone input gain, per-user voice volume and stream volume, with saved preferences
- **Right-click menus**: per-user volume, stream volume, local mute, hide video, per-stream quality; quick actions for yourself
- **Quality controls**: resolution (up to 4K / native source), frame rate and bitrate (up to 40 Mbps) for camera and screen share; per-stream bitrate picker; live stats (resolution · fps · bitrate · codec) on every video
- **Presence**: member list, online/offline, who's in which voice channel

## Windows app
Download the [portable Dischord.exe](https://github.com/ZJJ-2785/dischord/releases/latest/download/Dischord.exe), [Windows installer](https://github.com/ZJJ-2785/dischord/releases/latest/download/Dischord-Setup.exe), or [Windows ZIP](https://github.com/ZJJ-2785/dischord/releases/latest/download/Dischord-Windows.zip). The app requires **Windows 10/11, 64-bit** and includes its Chromium runtime. For the ZIP, extract the whole folder before running `Dischord.exe`.

It loads [the live Dischord website](https://zjj-2785.github.io/dischord/) in a native desktop window. Chat, voice, camera, screen sharing, configurable FPS, audio boosts, replies, previews and explicit file downloads use the same web app and VDO.Ninja rooms. Website updates arrive when you open or refresh it. Join the same server invite as your web friends to share channels and communicate.

The desktop app keeps its own persistent profile, settings and image-preview cache. Set your profile and join your existing server invites on first use; browser identities and saved local history are not automatically imported. Original files remain unpersisted offers, so keep the sending window open while recipients download them. An internet connection is required.

Screen sharing uses an explicit screen/window thumbnail picker inside the desktop app. Chrome/Edge's floating sharing banner is not part of this client. Sharing remains visible in Dischord and stops through its Screen button or when you close the app. The web version's browser sharing banner is controlled by the browser.

You can open a quoted invite directly:
```powershell
.\Dischord.exe "https://zjj-2785.github.io/dischord/#invite=..."
```

To build the desktop app with Node.js 24 or newer:
```powershell
cd desktop
npm ci
npm run build:win
```

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
- Your profile, settings, server definitions and recent chat history are saved in your browser's `localStorage` (last 500 messages per channel). Image previews are cached separately in IndexedDB. Original file contents and attachment drafts are never persisted by Dischord.

## Limits (by design, since there's no server)
- Non-image file contents are never automatically transferred, previewed, or saved by Dischord. Recipients save originals only after clicking **Download**. File names, sizes, types and image-preview descriptors are included in local chat history; raster preview bytes are cached separately.
- Shared images preserve aspect ratio and are re-encoded in the browser as WebP up to 4096 pixels on the longer edge, within about 4.5 MB. Formats the browser cannot decode show an "Image preview unavailable" message.
- Downloads below 100 MiB are assembled in browser memory. For larger remote files, browsers supporting the save-file picker let you choose a destination after clicking Download and write received batches directly there. Other browsers use memory, which can limit large downloads. No destination is opened and no file bytes are requested before Download.
- Transfer strategy follows file size: below 1 MiB, use up to 8 chunks; from 1 MiB to below 100 MiB, use 32; at 100 MiB and above, start with 32 and adapt up to 128 as confirmations arrive. Each chunk holds 12 KiB. Active voice/video calls cap the window at 32 to reduce competing traffic. Older peers retain compatible pacing; both participants should refresh after an update for faster transfers.
- Cancelling a direct-to-disk transfer aborts further writes. An empty destination created by the browser may remain. Completion is reported only after the writer finishes saving.
- Keep the original sender tab open for original-file downloads. Reloading or closing it removes its file offers; originals cannot be recovered from other recipients or chat history. Cached image previews remain viewable and can be relayed by other online members. A recipient can cancel a transfer, and incomplete downloads are discarded from memory.
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
- Set microphone volume from 0–200% in **User settings → Voice & Video**, or right-click yourself for a live adjustment. Right-click another person to set their voice or stream volume from 0–200%. All levels default to 100%; playback preferences affect only what you hear and persist in this browser.

Run the dependency-free regression checks with Node.js:
```sh
node --check app.js
node --check file-transfer.js
node --check image-preview.js
node tests/media.test.js
node tests/files.test.js
node tests/chat.test.js
node tests/image-preview.test.js
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
- `image-preview.js` – automatic bounded raster previews without a limit on original image sizes
- `desktop/main.js` – native Windows client loading the live website, permissions and screen capture
- `desktop/capture-picker.*` – explicit desktop screen/window chooser
- `desktop/package.json` – portable EXE, installer and ZIP packaging
