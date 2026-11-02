'use strict';

// Run through Chrome Bridge only on the isolated validation service (18090).
// The proxy rejects writes; all edits below stay in the fixture's memory.
async function runReadingModeChecks() {
  if (location.port !== '18090') throw new Error('Use the isolated reader fixture service, never a user document.');
  const results = [], writes = [], originalFetch = window.fetch, originalFrame = window.requestAnimationFrame;
  // Chrome may background the validation window while the user keeps working.
  // Keep layout checks running; all dimensions still come from the real DOM.
  if (readingLayout.frame !== null) cancelAnimationFrame(readingLayout.frame);
  readingLayout.frame = null;
  window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0);
  const wait = () => new Promise(resolve => setTimeout(resolve, 100));
  const assert = (value, label) => { if (!value) throw new Error(label); };
  window.fetch = (url, options = {}) => {
    if (['PUT', 'DELETE', 'PATCH'].includes(options.method)) { writes.push({ url, method: options.method }); return Promise.reject(new Error('Unexpected write')); }
    return originalFetch(url, options);
  };
  const baseline = content(), saved = state.saved, path = state.path;
  try {
    setReadingMode(true, false); await wait();
    const viewport = $('readerViewport');
    assert(readingLayout.pages > 1 && viewport.scrollHeight <= viewport.clientHeight + 2, 'Reader must paginate horizontally without clipped vertical content');
    assert($('editor').inert && getComputedStyle($('editor')).visibility === 'hidden', 'Editor is hidden and inert');
    assert(!$('readerContent').querySelector('[contenteditable="true"], .editor-line-numbers, .toastui-editor-toolbar'), 'Viewer must not expose editor or line numbers');
    assert(viewport.clientHeight > innerHeight * .65, 'Reader must use most of the screen');
    results.push('responsive pagination and compact chrome');

    goToReaderPage(-1); assert(readingLayout.page === 0 && $('readerPrevious').disabled, 'First page clamp');
    goToReaderPage(1); assert(readingLayout.page === 1 && Math.abs(viewport.scrollLeft - readingLayout.stride) < 2, 'Next page geometry');
    goToReaderPage(1e6); assert(readingLayout.page === readingLayout.pages - 1 && $('readerNext').disabled, 'Last page clamp');
    goToReaderPage(0);
    const touch = (type, x, y, active) => {
      const point = { clientX: x, clientY: y };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: active ? [point] : [] }, changedTouches: { value: [point] } });
      viewport.dispatchEvent(event);
    };
    touch('touchstart', 260, 180, true); touch('touchmove', 100, 185, true); touch('touchend', 100, 185, false);
    assert(readingLayout.page === 1, 'Swipe left advances');
    touch('touchstart', 100, 180, true); touch('touchend', 260, 185, false);
    assert(readingLayout.page === 0, 'Swipe right returns');
    touch('touchstart', 100, 100, true); touch('touchmove', 110, 250, true); touch('touchend', 110, 250, false);
    assert(readingLayout.page === 0, 'Vertical gesture does not turn pages');
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    assert(readingLayout.page === 1, 'Keyboard page turn');
    results.push('page boundaries, swipes and keyboard');

    const before = ['toggleReading', 'readerOutline'].map(id => $(id).getBoundingClientRect());
    const scrollBefore = [scrollX, scrollY, viewport.scrollLeft];
    setDocumentOutlineOpen(true);
    assert(documentOutlineEntries.length > 5, 'Outline headings available');
    assert(scrollX === scrollBefore[0] && scrollY === scrollBefore[1] && viewport.scrollLeft === scrollBefore[2], 'Opening outline does not scroll ancestors');
    const entry = documentOutlineEntries[Math.floor(documentOutlineEntries.length / 2)];
    const targetPage = readerPageForElement(entry.heading); entry.button.click();
    assert(readingLayout.page === targetPage && $('documentOutline').hidden, 'Outline jumps to chapter page');
    for (let i = 0; i < before.length; i++) {
      const now = $(['toggleReading', 'readerOutline'][i]).getBoundingClientRect();
      assert(Math.abs(now.x - before[i].x) < 1 && Math.abs(now.y - before[i].y) < 1, 'Outline controls stay in place');
    }
    setReadingMode(false, false); await wait();
    for (let i = 0; i < before.length; i++) {
      const now = $(['toggleReading', 'readerOutline'][i]).getBoundingClientRect();
      assert(Math.abs(now.x - before[i].x) < 1 && Math.abs(now.y - before[i].y) < 1, 'Mode controls stay in place');
    }
    results.push('chapter jumps and stable toolbar');

    state.loading = true; state.editor.setMarkdown(baseline + '\n\n草稿保留验证', false); state.loading = false;
    const draft = content();
    setReadingMode(true, false); await wait();
    assert(!await save() && !await flush() && content() === draft, 'Reading blocks save and retains draft');
    const other = state.files.find(item => item !== path);
    if (other) assert(!await navigate(other) && state.path === path && content() === draft, 'Switch cannot auto-save or discard a retained draft');
    assert(writes.length === 0, 'Reading never sends a write request');
    state.loading = true; state.editor.setMarkdown(baseline, false); state.saved = saved; state.loading = false;
    syncReadingDocument(); await wait();
    if (other) { assert(await navigate(other), 'Clean reader switches documents'); assert(await navigate(path), 'Clean reader returns'); }
    applyDocumentAccess('r'); setReadingMode(false, false);
    assert(!state.editor.getCurrentModeEditor().view.editable, 'Reader toggle cannot bypass server read-only access');
    applyDocumentAccess('rw'); setReadingMode(true, false); await wait();
    assert(content() === baseline && writes.length === 0, 'Reading preserves Markdown');
    results.push('no writes, retained drafts, document switching and permissions');
    return { passed: results.length, cases: results, size: [innerWidth, innerHeight], pages: readingLayout.pages, viewport: [viewport.clientWidth, viewport.clientHeight], writes };
  } finally {
    state.loading = true; state.editor.setMarkdown(baseline, false); state.saved = saved; state.loading = false;
    window.fetch = originalFetch;
    window.requestAnimationFrame = originalFrame;
    clearTimeout(state.saveTimer);
  }
}
