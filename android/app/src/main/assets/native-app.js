(() => {
  'use strict';
  if (location.origin !== 'https://dan-k391.github.io' || window !== window.top) return;
  const mark = () => {
    if (!document.documentElement) return false;
    // Native layout consumes status/navigation bars, display cutouts and IME.
    // Set the marker before page styles paint so CSS does not add them again.
    document.documentElement.classList.add('android-client');
    return true;
  };
  if (!mark()) {
    const observer = new MutationObserver(() => { if (mark()) observer.disconnect(); });
    observer.observe(document, { childList: true });
    document.addEventListener('DOMContentLoaded', () => { mark(); observer.disconnect(); }, { once: true });
  }
  // The real capture adapter lives in the VDO publisher iframe. Advertise its
  // availability to the app's feature check without starting capture here.
  if (navigator.mediaDevices && !navigator.mediaDevices.getDisplayMedia) {
    navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('Use the Screen button to share.', 'NotSupportedError'));
  }
  // The call service lasts from join to leave. Android only lets it start while Dischord is on screen, so
  // it must not stop when the call frame briefly has no capture (a rebuilt frame, a re-acquired device).
  if (window.DischordNative) window.addEventListener('dischord-call-state', (event) => {
    DischordNative.postMessage(JSON.stringify({ type: 'call-state', active: !!(event.detail && event.detail.active) }));
  });
  // A download or upload keeps going behind other apps: the app runs a transfer service while one is moving.
  if (window.DischordNative) window.addEventListener('dischord-transfer-state', (event) => {
    const d = event.detail || {};
    DischordNative.postMessage(JSON.stringify({ type: 'transfer-state', active: !!d.active,
      text: typeof d.text === 'string' ? d.text.slice(0, 200) : '', progress: Number.isInteger(d.progress) ? d.progress : -1 }));
  });
})();
