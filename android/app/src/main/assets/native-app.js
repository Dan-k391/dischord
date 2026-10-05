(() => {
  'use strict';
  if (location.origin !== 'https://zjj-2785.github.io' || window !== window.top) return;
  const mark = () => document.documentElement.classList.add('android-client');
  if (document.documentElement) mark();
  else document.addEventListener('DOMContentLoaded', mark, { once: true });
  // The real capture adapter lives in the VDO publisher iframe. Advertise its
  // availability to the app's feature check without starting capture here.
  if (navigator.mediaDevices && !navigator.mediaDevices.getDisplayMedia) {
    navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('Use the Screen button to share.', 'NotSupportedError'));
  }
})();
