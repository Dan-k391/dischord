'use strict';

// Native window controls stay in Electron's title-bar overlay. The hosted app
// only needs a CSS marker to reserve space for its matching draggable bar.
function markDesktop() {
  document.documentElement.classList.add('desktop-client', 'desktop-' + process.platform);
  window.dispatchEvent(new Event('dischord-desktop-ready'));
}
window.addEventListener('DOMContentLoaded', markDesktop, { once: true });
