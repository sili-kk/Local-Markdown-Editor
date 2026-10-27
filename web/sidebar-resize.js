'use strict';

function sidebarWidthBounds(viewport = innerWidth) {
  return { min: 220, max: Math.max(220, Math.min(600, viewport - 600)) };
}

let syncSidebarResizer = () => {};
document.addEventListener('DOMContentLoaded', () => {
  const app = $('app'), handle = $('sidebarResize');
  let preferred = innerWidth <= 1200 ? 238 : 272, drag = null;
  try { const stored = Number(localStorage.getItem('mojian.sidebarWidth')); if (Number.isFinite(stored) && stored >= 220) preferred = Math.min(600, stored); } catch {}
  function applyWidth(value = preferred, persist = false) {
    const bounds = sidebarWidthBounds();
    const width = Math.round(Math.max(bounds.min, Math.min(bounds.max, value)));
    if (persist) { preferred = width; try { localStorage.setItem('mojian.sidebarWidth', String(width)); } catch {} }
    app.style.setProperty('--sidebar-width', width + 'px');
    handle.setAttribute('aria-valuemin', bounds.min); handle.setAttribute('aria-valuemax', bounds.max);
    handle.setAttribute('aria-valuenow', width); handle.setAttribute('aria-valuetext', width + ' 像素');
  }
  function finish() {
    if (!drag) return;
    const pointer = drag.id; drag = null;
    if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
    delete app.dataset.resizing; document.body.classList.remove('sidebar-resizing');
  }
  syncSidebarResizer = () => {
    handle.hidden = mobileSidebar.matches || !sidebarOpen();
    if (handle.hidden) finish();
    applyWidth();
  };
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || handle.hidden) return;
    event.preventDefault();
    drag = { id: event.pointerId, offset: event.clientX - $('sidebar').getBoundingClientRect().right };
    handle.setPointerCapture(event.pointerId);
    app.dataset.resizing = 'true'; document.body.classList.add('sidebar-resizing');
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    applyWidth(event.clientX - app.getBoundingClientRect().left - drag.offset, true);
  });
  handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish); handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('keydown', event => {
    const bounds = sidebarWidthBounds(), step = event.shiftKey ? 40 : 16, current = Number(handle.getAttribute('aria-valuenow'));
    const values = { ArrowLeft: current - step, ArrowRight: current + step, Home: bounds.min, End: bounds.max };
    if (!(event.key in values)) return;
    event.preventDefault(); applyWidth(values[event.key], true);
  });
  handle.addEventListener('dblclick', () => applyWidth(innerWidth <= 1200 ? 238 : 272, true));
  window.addEventListener('resize', syncSidebarResizer); window.addEventListener('blur', finish);
  syncSidebarResizer();
});
