'use strict';

// Exercise the real image preview encoder with deterministic browser codecs.
// No original-file transfer, real image decoder, disk write, or browser download
// is used. Decoder/canvas fixtures expose dimensions, retries, and cleanup.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'image-preview.js'), 'utf8');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const dataURL = (bytes, type = 'webp') => 'data:image/' + type + ';base64,' + Buffer.from(bytes).toString('base64');
const smallURL = dataURL(Buffer.from('small raster preview'));
const oversizedURL = dataURL(Buffer.alloc(270000));

function fixture(options = {}) {
  const state = { bitmapCalls: 0, bitmapCloses: 0, images: [], urls: [], revoked: [], canvases: [], encodes: [], draws: [] };
  const bitmap = { width: options.width ?? 4096, height: options.height ?? 2048,
    close() { state.bitmapCloses++; } };
  class ImageMock {
    constructor() {
      this.naturalWidth = options.imageWidth ?? 320;
      this.naturalHeight = options.imageHeight ?? 160;
      this.history = [];
      state.images.push(this);
    }
    set src(value) {
      this.history.push(value);
      if (value) queueMicrotask(() => {
        const callback = options.imageFailure ? this.onerror : this.onload;
        if (callback) callback();
      });
    }
    get src() { return this.history[this.history.length - 1] || ''; }
  }
  const window = {};
  const context = vm.createContext({ window, console,
    ...(options.noBitmap ? {} : { async createImageBitmap() {
      state.bitmapCalls++;
      if (options.bitmapFailure) throw new Error('Bitmap decoder failed');
      return bitmap;
    } }),
    Image: ImageMock,
    URL: { createObjectURL(file) { state.urls.push(file); return 'blob:preview/' + state.urls.length; },
      revokeObjectURL(url) { state.revoked.push(url); } },
    btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    document: { createElement(tag) {
      assert.strictEqual(tag, 'canvas');
      const canvas = { width: 0, height: 0,
        getContext(kind) {
          assert.strictEqual(kind, '2d');
          return options.noContext ? null : { drawImage(image, x, y, w, h) { state.draws.push({ image, x, y, w, h }); } };
        },
        toDataURL(type, quality) {
          const attempt = { type, quality, w: canvas.width, h: canvas.height };
          state.encodes.push(attempt);
          if (options.encoderFailure) throw new Error('Canvas encoder failed');
          return options.encode ? options.encode(attempt, state.encodes.length) : smallURL;
        },
      };
      state.canvases.push(canvas);
      return canvas;
    } },
  });
  vm.runInContext(source, context, { filename: 'image-preview.js' });
  return { api: window.DischordImages, state, file: { name: 'image.png', type: 'image/png', size: 5 * 1024 ** 3 } };
}

test('image detection accepts MIME and supported filename hints while leaving other files private', () => {
  const { api } = fixture();
  assert(api.isImage({ name: 'photo', type: 'image/jpeg' }));
  assert(api.isImage({ name: 'PHOTO.JPEG', type: '' }));
  assert(api.isImage({ name: 'animation.gif', type: '' }));
  assert(!api.isImage({ name: 'picture.png', type: 'application/pdf' }));
  assert(!api.isImage({ name: 'report.pdf', type: 'application/pdf' }));
  assert(!api.isImage({ name: 'photo.png.exe', type: '' }));
  assert(!api.isImage(null));
});

test('preview URLs require bounded canonical raster data and reject executable or remote URLs', () => {
  const { api } = fixture();
  assert.strictEqual(api.MAX_PREVIEW, 350000);
  for (const type of ['png', 'jpeg', 'webp', 'gif']) assert(api.validURL(dataURL(Buffer.from([0, 255, 1]), type)));
  for (const url of [null, 'https://example.test/image.png', 'javascript:alert(1)',
    'data:text/html;base64,PGgxPng8L2gxPg==', 'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/png;base64,', 'data:image/png;base64,AB==', 'data:image/png;base64,A===', oversizedURL]) {
    assert.strictEqual(api.validURL(url), false, 'Reject ' + String(url).slice(0, 60));
  }
});

test('a canonical 267 KB thumbnail validates without overflowing the regular-expression stack', () => {
  const { api } = fixture();
  const url = dataURL(Buffer.alloc(200000, 0xb6));
  assert(url.length > 250000 && url.length < api.MAX_PREVIEW);
  assert.strictEqual(api.validURL(url), true);
});

test('a large original receives a bounded aspect-preserving preview and releases its bitmap/canvas', async () => {
  const { api, file, state } = fixture();
  const preview = await api.createPreview(file);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(preview)), { url: smallURL, w: 1024, h: 512, n: smallURL.length, preview: 1 });
  assert.strictEqual(state.bitmapCalls, 1);
  assert.strictEqual(state.bitmapCloses, 1);
  assert.strictEqual(state.draws[0].w / state.draws[0].h, 2);
  assert.strictEqual(state.encodes[0].type, 'image/webp');
  assert.strictEqual(state.encodes[0].quality, 0.8);
  assert.strictEqual(state.canvases[0].width, 0);
  assert.strictEqual(state.canvases[0].height, 0);
  assert.strictEqual(state.urls.length, 0);
});

test('an oversized preview lowers quality then dimensions without increasing either side', async () => {
  const { api, file, state } = fixture({ width: 9000, height: 4000,
    encode: (attempt) => attempt.w === 1024 ? oversizedURL : smallURL });
  const preview = await api.createPreview(file);
  assert(preview.n <= api.MAX_PREVIEW);
  assert.deepStrictEqual(state.encodes.slice(0, 4).map((attempt) => attempt.quality), [0.8, 0.65, 0.5, 0.35]);
  assert.strictEqual(state.encodes[4].w, 768);
  assert(Math.abs(preview.w / preview.h - 9000 / 4000) < 0.01);
  assert(state.encodes.every((attempt) => attempt.w <= 1024 && attempt.h <= 1024));
  assert.strictEqual(state.bitmapCloses, 1);
  assert.strictEqual(state.canvases[0].width, 0);
});

test('a PNG-only browser downscales directly instead of retrying ineffective quality changes', async () => {
  const largePNG = dataURL(Buffer.alloc(270000), 'png'), smallPNG = dataURL(Buffer.from('png preview'), 'png');
  const { api, file, state } = fixture({ width: 2048, height: 2048,
    encode: (attempt) => attempt.w > 576 ? largePNG : smallPNG });
  const preview = await api.createPreview(file);
  assert.deepStrictEqual(state.encodes.map((attempt) => attempt.w), [1024, 768, 576]);
  assert(state.encodes.every((attempt) => attempt.quality === 0.8));
  assert.strictEqual(preview.w, preview.h);
  assert.strictEqual(preview.url, smallPNG);
});

test('Image fallback clears handlers, revokes its object URL, and preserves small image dimensions', async () => {
  const { api, file, state } = fixture({ bitmapFailure: true, imageWidth: 320, imageHeight: 160 });
  const preview = await api.createPreview(file);
  assert.strictEqual(preview.w, 320);
  assert.strictEqual(preview.h, 160);
  assert.deepStrictEqual(state.revoked, ['blob:preview/1']);
  assert.deepStrictEqual(state.images[0].history, ['blob:preview/1', '']);
  assert.strictEqual(state.images[0].onload, null);
  assert.strictEqual(state.images[0].onerror, null);
  assert.strictEqual(state.canvases[0].width, 0);
});

test('decoder failure releases the fallback URL without creating a preview canvas', async () => {
  const { api, file, state } = fixture({ bitmapFailure: true, imageFailure: true });
  await assert.rejects(api.createPreview(file), /cannot be previewed/);
  assert.deepStrictEqual(state.revoked, ['blob:preview/1']);
  assert.strictEqual(state.images[0].src, '');
  assert.strictEqual(state.images[0].onload, null);
  assert.strictEqual(state.images[0].onerror, null);
  assert.strictEqual(state.canvases.length, 0);
});

test('invalid bitmap and fallback dimensions reject safely and close the unusable bitmap', async () => {
  const { api, file, state } = fixture({ width: 0, height: 0, imageWidth: 0, imageHeight: 0 });
  await assert.rejects(api.createPreview(file), /invalid dimensions/);
  assert.strictEqual(state.bitmapCloses, 1);
  assert.deepStrictEqual(state.revoked, ['blob:preview/1']);
  assert.strictEqual(state.images[0].src, '');
});

test('canvas setup and encoding failures still release every allocated decoder resource', async () => {
  for (const options of [{ noContext: true }, { encoderFailure: true }]) {
    const { api, file, state } = fixture(options);
    await assert.rejects(api.createPreview(file));
    assert.strictEqual(state.bitmapCloses, 1);
    assert.strictEqual(state.canvases[0].width, 0);
    assert.strictEqual(state.canvases[0].height, 0);
  }
});

test('an encoder that never produces a bounded preview terminates and frees the canvas', async () => {
  const { api, file, state } = fixture({ encode: () => oversizedURL });
  await assert.rejects(api.createPreview(file), /bounded image preview/);
  assert(state.encodes.length < 120);
  assert.strictEqual(state.bitmapCloses, 1);
  assert.strictEqual(state.canvases[0].width, 0);
});

test('a non-image is rejected before any decoder or object URL can read its contents', async () => {
  const { api, state } = fixture();
  await assert.rejects(api.createPreview({ name: 'secret.pdf', type: 'application/pdf', size: 1000 }), /not an image/);
  assert.strictEqual(state.bitmapCalls, 0);
  assert.strictEqual(state.urls.length, 0);
  assert.strictEqual(state.canvases.length, 0);
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log('ok - ' + name); }
    catch (error) { failed++; console.error('not ok - ' + name + '\n' + error.stack); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
  if (failed) process.exitCode = 1;
})();
