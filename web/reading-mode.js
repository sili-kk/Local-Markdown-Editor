'use strict';

// A separate TOAST UI Viewer: no editable surface, line-number plugin or save path.
const readingLayout = { viewer: null, path: '', markdown: null, page: 0, pages: 1, stride: 0, anchor: null, frame: null };
const readerColumnGap = 40;

function readerPageCount(width, viewportWidth, gap = readerColumnGap) {
  return Math.max(1, Math.ceil((width + gap - 1) / (viewportWidth + gap)));
}

function readerPageForElement(element) {
  const viewport = $('readerViewport');
  // The first fragment locates a heading correctly even when it spans columns.
  const rect = element.getClientRects()[0] || element.getBoundingClientRect();
  return Math.max(0, Math.floor((rect.left - viewport.getBoundingClientRect().left + viewport.scrollLeft + 1) / (readingLayout.stride || 1)));
}

function rememberReaderAnchor() {
  const viewport = $('readerViewport'), bounds = viewport.getBoundingClientRect();
  const blocks = $('readerContent').querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, pre, tr, img');
  for (const element of blocks) {
    const rects = [...element.getClientRects()];
    const fragment = rects.findIndex(rect => rect.right > bounds.left + 1 && rect.left < bounds.right - 1);
    if (fragment >= 0) return { element, fraction: fragment / rects.length };
  }
  return null;
}

function readerPageForAnchor(anchor) {
  const rects = [...anchor.element.getClientRects()];
  const rect = rects[Math.min(rects.length - 1, Math.floor(anchor.fraction * rects.length))];
  if (!rect) return readerPageForElement(anchor.element);
  const viewport = $('readerViewport');
  return Math.max(0, Math.floor((rect.left - viewport.getBoundingClientRect().left + viewport.scrollLeft + 1) / (readingLayout.stride || 1)));
}

function goToReaderPage(page) {
  if (!state.reading || !state.path || state.navigating || state.merging) return;
  readingLayout.page = Math.min(readingLayout.pages - 1, Math.max(0, Math.round(page)));
  const viewport = $('readerViewport');
  viewport.scrollLeft = readingLayout.page * readingLayout.stride;
  $('readerPrevious').disabled = readingLayout.page === 0;
  $('readerNext').disabled = readingLayout.page >= readingLayout.pages - 1;
  $('readerProgress').textContent = '第 ' + (readingLayout.page + 1) + ' / ' + readingLayout.pages + ' 页';
  readingLayout.anchor = rememberReaderAnchor();
  updateDocumentOutlinePosition();
}

function scheduleReaderLayout() {
  if (!state.reading || $('reader').hidden || readingLayout.frame !== null) return;
  readingLayout.frame = requestAnimationFrame(() => {
    readingLayout.frame = null;
    if (!state.reading || $('reader').hidden || state.navigating) return;
    const viewport = $('readerViewport'), width = viewport.getBoundingClientRect().width;
    if (!width || !viewport.clientHeight) return;
    const anchor = readingLayout.anchor;
    readingLayout.stride = width + readerColumnGap;
    viewport.style.setProperty('--reader-column-width', width + 'px');
    viewport.style.setProperty('--reader-page-height', viewport.clientHeight + 'px');
    readingLayout.pages = readerPageCount(viewport.scrollWidth, width);
    goToReaderPage(anchor?.element.isConnected ? readerPageForAnchor(anchor) : readingLayout.page);
  });
}

function clearReadingDocument() {
  readingLayout.viewer?.destroy();
  readingLayout.viewer = null;
  readingLayout.path = ''; readingLayout.markdown = null;
  readingLayout.page = 0; readingLayout.pages = 1; readingLayout.anchor = null;
  $('readerContent').replaceChildren();
}

function syncReadingDocument() {
  const available = !!state.path && !$('editor').hidden;
  const busy = state.navigating || state.merging;
  $('toggleReading').disabled = busy || !available || state.composing;
  $('readerOutline').disabled = busy || !available;
  $('readerOutline').hidden = false;
  $('readerPrevious').disabled = busy || !available || readingLayout.page === 0;
  $('readerNext').disabled = busy || !available || readingLayout.page >= readingLayout.pages - 1;
  $('reader').hidden = !state.reading || !available;
  if (!available || !state.reading) {
    if (readingLayout.viewer) clearReadingDocument();
    return;
  }
  if (busy) return;
  const markdown = content();
  if (readingLayout.path !== state.path || readingLayout.markdown !== markdown) {
    clearReadingDocument();
    readingLayout.viewer = toastui.Editor.factory({
      el: $('readerContent'), viewer: true, initialValue: markdown,
      usageStatistics: false, frontMatter: true, plugins: tableEditorPlugins(),
      linkAttributes: { target: '_blank', rel: 'noopener noreferrer' },
    });
    readingLayout.path = state.path; readingLayout.markdown = markdown;
    // Only the viewer DOM uses resolved resource URLs; Markdown stays untouched.
    for (const image of $('readerContent').querySelectorAll('img[src]')) {
      const reference = image.getAttribute('src');
      try { image.src = resourceAddress(reference).url; } catch { /* Keep the renderer's URL. */ }
      image.decoding = 'async';
    }
    for (const input of $('readerContent').querySelectorAll('input, button, select, textarea')) input.disabled = true;
    setDocumentOutlineOpen(false);
  }
  scheduleReaderLayout();
}

function setReadingMode(enabled, persist = true) {
  if (state.navigating || state.merging || state.composing) return;
  if (state.saving) { notice('正在完成保存，请稍后切换阅读模式。'); return; }
  state.reading = !!enabled;
  clearTimeout(state.saveTimer);
  setDocumentOutlineOpen(false);
  $('editor').dispatchEvent(new Event('resourcehide'));
  document.activeElement?.blur();
  $('app').classList.toggle('reading-mode', state.reading);
  $('editor').inert = state.reading;
  const view = state.editor?.getCurrentModeEditor().view;
  if (view) view.setProps({ editable: () => !state.readOnly && !state.reading });
  $('toggleReading').textContent = state.reading ? '切回编辑' : '阅读';
  $('toggleReading').setAttribute('aria-pressed', String(state.reading));
  $('save').disabled = state.reading || state.readOnly || !state.path;
  if (persist) {
    try { localStorage.setItem(mobileSidebar.matches ? 'mojian.mobileReadingMode' : 'mojian.desktopReadingMode', String(state.reading)); } catch {}
  }
  syncReadingDocument();
  scheduleScrollNavigation();
  if (state.path) status(state.reading ? (dirty() ? '只读阅读 · 未保存草稿已保留' : '只读阅读 · 左右滑动翻页') : state.readOnly ? '只读文档 · 可查看和复制' : dirty() ? '草稿已保留 · 请点击保存' : '已切回编辑模式');
}

async function followReaderLink(event) {
  const link = event.target.closest('a[href]');
  if (!link) return;
  const reference = link.getAttribute('href');
  if (!reference) return;
  if (reference.startsWith('#')) {
    event.preventDefault();
    let id; try { id = decodeURIComponent(reference.slice(1)); } catch { return; }
    const target = [...$('readerContent').querySelectorAll('[id]')].find(element => element.id === id);
    if (target) goToReaderPage(readerPageForElement(target));
    return;
  }
  let resource;
  try { resource = resourceAddress(reference); } catch { event.preventDefault(); return; }
  if (!resource.local || !isMarkdownResourceReference(reference)) return;
  event.preventDefault();
  const path = state.path;
  try {
    const data = await api('/api/resource', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, reference }),
    });
    if (state.path !== path || !state.reading) return;
    if (!data.exists || !data.document_path?.startsWith('@')) throw new Error('文档不存在或不可访问');
    await navigate(data.document_path);
  } catch { if (state.path === path) notice('文档不存在或不可访问，请检查读取权限。'); }
}

function initReadingMode() {
  const viewport = $('readerViewport');
  $('toggleReading').onclick = () => setReadingMode(!state.reading);
  $('readerOutline').onclick = () => setDocumentOutlineOpen($('documentOutline').hidden);
  $('readerPrevious').onclick = () => goToReaderPage(readingLayout.page - 1);
  $('readerNext').onclick = () => goToReaderPage(readingLayout.page + 1);
  viewport.addEventListener('click', followReaderLink);
  viewport.addEventListener('load', scheduleReaderLayout, true);
  viewport.addEventListener('error', scheduleReaderLayout, true);
  viewport.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest('a, input, button, select, textarea')) return;
    const destinations = { ArrowLeft: readingLayout.page - 1, ArrowRight: readingLayout.page + 1, PageUp: readingLayout.page - 1, PageDown: readingLayout.page + 1, Home: 0, End: readingLayout.pages - 1 };
    if (!(event.key in destinations)) return;
    event.preventDefault(); goToReaderPage(destinations[event.key]);
  });
  let swipe = null;
  viewport.addEventListener('touchstart', event => {
    swipe = null;
    if (event.touches.length !== 1 || event.target.closest('a, input, button, select, textarea') || window.getSelection()?.toString()) return;
    const touch = event.touches[0];
    swipe = { x: touch.clientX, y: touch.clientY, at: Date.now() };
  }, { passive: true });
  viewport.addEventListener('touchmove', event => {
    if (!swipe) return;
    if (event.touches.length !== 1) { swipe = null; return; }
    const touch = event.touches[0], dx = touch.clientX - swipe.x, dy = touch.clientY - swipe.y;
    if (Math.abs(dy) > 24 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }
    if (Math.abs(dx) > 16 && Math.abs(dx) > Math.abs(dy) * 1.5 && event.cancelable) event.preventDefault();
  }, { passive: false });
  viewport.addEventListener('touchend', event => {
    const start = swipe; swipe = null;
    if (!start || event.touches.length || event.changedTouches.length !== 1 || Date.now() - start.at > 800 || window.getSelection()?.toString()) return;
    const touch = event.changedTouches[0], dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (event.cancelable) event.preventDefault();
    goToReaderPage(readingLayout.page + (dx < 0 ? 1 : -1));
  }, { passive: false });
  viewport.addEventListener('touchcancel', () => { swipe = null; }, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(scheduleReaderLayout).observe(viewport);
  window.addEventListener('resize', scheduleReaderLayout);
  document.fonts?.ready.then(scheduleReaderLayout);
  let preference = null;
  try { preference = localStorage.getItem(mobileSidebar.matches ? 'mojian.mobileReadingMode' : 'mojian.desktopReadingMode'); } catch {}
  setReadingMode(preference === null ? mobileSidebar.matches : preference === 'true', false);
}
