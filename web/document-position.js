'use strict';

// Positions belong to individual documents and survive page reloads. Keep the
// latest values in memory too, so blocked/full browser storage cannot break tabs.
function createDocumentPositionTracker(viewport, body, canSave, inputRoot = viewport) {
  const storageKey = 'mojian.documentPositions';
  const positions = new Map();
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(stored)) {
      for (const entry of stored.slice(-200)) {
        if (!Array.isArray(entry)) continue;
        const [path, position] = entry;
        if (typeof path === 'string' && path && position &&
            Number.isFinite(position.top) && position.top >= 0 &&
            Number.isFinite(position.left) && position.left >= 0) positions.set(path, position);
      }
    }
  } catch {}
  let path = '', restoring = false, saveTimer = null, restoreTimer = null, frame = null;
  let target = null;
  const persist = () => {
    try { localStorage.setItem(storageKey, JSON.stringify([...positions])); } catch {}
  };
  const save = () => {
    clearTimeout(saveTimer); saveTimer = null;
    if (!path || restoring || !canSave(path)) return;
    const top = viewport.scrollTop, left = viewport.scrollLeft;
    if (!Number.isFinite(top) || !Number.isFinite(left)) return;
    positions.delete(path);
    positions.set(path, { top: Math.max(0, top), left: Math.max(0, left) });
    while (positions.size > 200) positions.delete(positions.keys().next().value);
    persist();
  };
  const stopRestoring = () => {
    restoring = false;
    clearTimeout(restoreTimer); restoreTimer = null;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const apply = () => {
    if (!restoring) return;
    viewport.scrollTop = target.top;
    viewport.scrollLeft = target.left;
  };
  const scheduleRestore = () => {
    if (!restoring || frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; apply(); });
  };
  const restore = nextPath => {
    clearTimeout(saveTimer); saveTimer = null;
    stopRestoring();
    path = nextPath;
    target = positions.get(path) || { top: 0, left: 0 };
    restoring = true;
    apply();
    // Editor layout, fonts and lazy images can settle after setMarkdown().
    // Retry briefly, but release control as soon as the reader interacts.
    scheduleRestore();
    restoreTimer = setTimeout(() => { apply(); stopRestoring(); save(); }, 2000);
  };
  const onScroll = () => {
    if (restoring || !canSave(path)) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 150);
  };
  const onInput = () => { stopRestoring(); };
  const onVisibility = () => { if (document.hidden) save(); };
  viewport.addEventListener('scroll', onScroll, { passive: true });
  const inputEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
  for (const event of inputEvents) inputRoot.addEventListener(event, onInput, { passive: true, capture: true });
  body.addEventListener('load', scheduleRestore, true);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleRestore) : null;
  observer?.observe(body);
  observer?.observe(viewport);
  document.fonts?.ready.then(scheduleRestore);
  document.fonts?.addEventListener('loadingdone', scheduleRestore);
  window.addEventListener('beforeunload', save);
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', onVisibility);
  return {
    save, restore,
    destroy() {
      save(); stopRestoring();
      observer?.disconnect();
      viewport.removeEventListener('scroll', onScroll);
      for (const event of inputEvents) inputRoot.removeEventListener(event, onInput, true);
      body.removeEventListener('load', scheduleRestore, true);
      document.fonts?.removeEventListener('loadingdone', scheduleRestore);
      window.removeEventListener('beforeunload', save);
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
