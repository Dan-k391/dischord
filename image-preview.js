/* Images are shared with chat as a high-quality preview that people can view and save. Videos get a poster:
   one frame, small enough to load quickly on a phone, shown with a play button until someone downloads it. */
(() => {
  'use strict';

  const MAX_PREVIEW = 6000000; // data URL characters (~4.5 MB): generous, so shared images keep their quality
  const MAX_SIDE = 4096;
  const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,/;
  const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

  function isImage(meta) {
    if (!meta) return false;
    const type = typeof meta.type === 'string' ? meta.type.trim() : '';
    // A typed document cannot acquire automatic sharing by using an image filename.
    if (type) return /^image\//i.test(type);
    return typeof meta.name === 'string' && /\.(?:png|apng|jpe?g|jfif|gif|webp|avif|bmp|svg|ico|heic|heif|tiff?)$/i.test(meta.name);
  }

  function isVideo(meta) {
    if (!meta) return false;
    const type = typeof meta.type === 'string' ? meta.type.trim() : '';
    if (type) return /^video\//i.test(type);
    return typeof meta.name === 'string' && /\.(?:mp4|m4v|webm|mov|mkv|ogv)$/i.test(meta.name);
  }
  // attachments that share a preview with the chat
  const hasPreview = (meta) => isImage(meta) || isVideo(meta);

  function validURL(url) {
    if (typeof url !== 'string' || url.length > MAX_PREVIEW) return false;
    const match = DATA_IMAGE.exec(url);
    if (!match) return false;
    const data = url.slice(match[0].length);
    if (!data || data.length % 4 || !BASE64.test(data)) return false;
    // Require zero padding bits as well as a complete base64 shape.
    try { return btoa(atob(data)) === data; } catch { return false; }
  }

  async function createPreview(file) {
    if (!isImage(file)) throw new Error('This attachment is not an image.');
    let bitmap = null, image = null, objectURL = null, canvas = null;
    try {
      let source = null;
      if (typeof createImageBitmap === 'function') {
        try {
          bitmap = await createImageBitmap(file);
          if (bitmap && bitmap.width > 0 && bitmap.height > 0) source = bitmap;
        } catch { /* Some image formats are supported by Image but not ImageBitmap. */ }
      }
      if (!source) {
        if (bitmap && typeof bitmap.close === 'function') {
          try { bitmap.close(); } catch { }
        }
        bitmap = null;
        image = new Image();
        objectURL = URL.createObjectURL(file);
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error('This image format cannot be previewed by your browser.'));
          image.src = objectURL;
        });
        source = image;
      }
      const width = source === image ? image.naturalWidth : source.width;
      const height = source === image ? image.naturalHeight : source.height;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('This image has invalid dimensions.');
      }
      const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
      let w = Math.max(1, Math.round(width * scale));
      let h = Math.max(1, Math.round(height * scale));
      canvas = document.createElement('canvas');
      const qualities = [0.9, 0.7, 0.5];
      while (true) {
        canvas.width = w;
        canvas.height = h;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('This browser cannot create image previews.');
        context.drawImage(source, 0, 0, w, h);
        for (const quality of qualities) {
          const url = canvas.toDataURL('image/webp', quality);
          if (!/^data:image\/(?:png|jpeg|webp);base64,/.test(url)) {
            throw new Error('This browser could not encode the image preview.');
          }
          if (validURL(url)) return { url, w, h, n: url.length, preview: 1 };
          // Unsupported WebP encoders return PNG; its size does not respond to quality.
          if (url.startsWith('data:image/png;')) break;
        }
        if (w === 1 && h === 1) throw new Error('This browser could not create a bounded image preview.');
        const nextScale = Math.max(1, Math.floor(Math.max(w, h) * 0.75)) / Math.max(width, height);
        w = Math.max(1, Math.round(width * nextScale));
        h = Math.max(1, Math.round(height * nextScale));
      }
    } finally {
      if (bitmap && typeof bitmap.close === 'function') {
        try { bitmap.close(); } catch { }
      }
      if (image) {
        image.onload = null;
        image.onerror = null;
        try {
          if (typeof image.removeAttribute === 'function') image.removeAttribute('src');
          else image.src = '';
        } catch { }
      }
      if (objectURL) {
        try { URL.revokeObjectURL(objectURL); } catch { }
      }
      if (canvas) {
        try { canvas.width = 0; canvas.height = 0; } catch { }
      }
    }
  }

  const POSTER_SIDE = 1280; // a poster is a placeholder for a video, so it stays light for phones and slow links
  // One frame from early in the video (not the very first, which is often black), plus its length.
  async function createVideoPoster(file) {
    if (!isVideo(file)) throw new Error('This attachment is not a video.');
    // Browsers do not load video in a hidden page: wait until it is in front again (the person switched away
    // right after attaching) instead of timing out with no poster.
    while (typeof document !== 'undefined' && document.hidden) {
      await new Promise((resolve) => document.addEventListener('visibilitychange', resolve, { once: true }));
    }
    const url = URL.createObjectURL(file), video = document.createElement('video');
    let canvas = null;
    const once = (events, ms) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(reject, new Error('This video could not be read in time.')), ms);
      const done = (fn, value) => { clearTimeout(timer); for (const e of events) video.removeEventListener(e, ok); video.removeEventListener('error', bad); fn(value); };
      const ok = () => done(resolve), bad = () => done(reject, new Error('This video format cannot be previewed by your browser.'));
      for (const e of events) video.addEventListener(e, ok);
      video.addEventListener('error', bad);
    });
    try {
      video.muted = true; video.playsInline = true; video.preload = 'auto';
      const loaded = once(['loadeddata'], 15000);
      video.src = url;
      await loaded;
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const at = duration ? Math.min(1.5, duration / 3) : 0;
      if (at > 0) { const seeked = once(['seeked'], 10000); video.currentTime = at; await seeked; }
      const width = video.videoWidth, height = video.videoHeight;
      if (!width || !height) throw new Error('This video has no picture to preview.');
      const scale = Math.min(1, POSTER_SIDE / Math.max(width, height));
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser cannot create video previews.');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.8, 0.6, 0.4]) {
        const data = canvas.toDataURL('image/webp', quality);
        if (validURL(data)) return { url: data, w: canvas.width, h: canvas.height, n: data.length, preview: 1, d: Math.round(duration) };
      }
      throw new Error('This browser could not create a bounded video preview.');
    } finally {
      try { video.removeAttribute('src'); video.load(); } catch { }
      try { URL.revokeObjectURL(url); } catch { }
      if (canvas) { try { canvas.width = 0; canvas.height = 0; } catch { } }
    }
  }

  window.DischordImages = Object.freeze({ isImage, isVideo, hasPreview, createPreview, createVideoPoster, validURL, MAX_PREVIEW, MAX_SIDE });
})();
