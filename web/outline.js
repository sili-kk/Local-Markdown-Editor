'use strict';

// Read semantic headings from the rendered document: code blocks are excluded,
// and repeated titles retain their own DOM targets without changing Markdown.
let documentOutlineEntries = [];
let documentOutlineFrame = null;

function setDocumentOutlineOpen(open, restoreFocus = false) {
  if (open && $('toggleOutline').disabled) return;
  $('documentOutline').hidden = !open;
  $('toggleOutline').setAttribute('aria-expanded', String(open));
  $('toggleOutline').setAttribute('aria-label', open ? '收起文档目录' : '显示文档目录');
  if (open) {
    renderDocumentOutline();
    $('outlineList').querySelector('[aria-current="location"]')?.scrollIntoView({ block: 'nearest' });
  }
  if (restoreFocus) $('toggleOutline').focus({ preventScroll: true });
}

function renderDocumentOutline() {
  const headings = $('editor').querySelectorAll('.toastui-editor-ww-container .ProseMirror :is(h1, h2, h3, h4, h5, h6)');
  const list = $('outlineList'), fragment = document.createDocumentFragment();
  documentOutlineEntries = [];
  const baseLevel = Array.from(headings).reduce((level, heading) => Math.min(level, Number(heading.tagName[1])), 6);
  for (const heading of headings) {
    const button = document.createElement('button');
    const level = Number(heading.tagName[1]);
    button.type = 'button';
    button.className = 'outline-item';
    button.textContent = heading.textContent.trim() || Array.from(heading.querySelectorAll('img'), image => image.alt).join(' ').trim() || '（空标题）';
    button.title = 'H' + level + ' · ' + button.textContent;
    button.style.setProperty('--outline-depth', level - baseLevel);
    button.onclick = () => {
      if (!heading.isConnected || state.navigating || state.merging || $('document').inert) return;
      const viewport = $('editor').querySelector('.toastui-editor-ww-container > .toastui-editor');
      // Rectangles include CSS zoom; scrollTop uses the editor's local pixels.
      const scale = viewport.getBoundingClientRect().height / viewport.offsetHeight || 1;
      const offset = (heading.getBoundingClientRect().top - viewport.getBoundingClientRect().top) / scale;
      viewport.scrollTo({ top: Math.max(0, viewport.scrollTop + offset - 16), behavior: reducedMotion.matches ? 'instant' : 'smooth' });
      setDocumentOutlineOpen(false, true);
    };
    documentOutlineEntries.push({ heading, button });
    fragment.append(button);
  }
  if (!headings.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '暂无章节标题，添加一级至六级标题后会显示在这里。';
    fragment.append(empty);
  }
  list.replaceChildren(fragment);
  updateDocumentOutlinePosition();
}

function updateDocumentOutlinePosition() {
  if ($('documentOutline').hidden) return;
  const viewport = $('editor').querySelector('.toastui-editor-ww-container > .toastui-editor');
  if (!viewport) return;
  const bounds = viewport.getBoundingClientRect();
  $('documentOutline').style.setProperty('--outline-top', Math.max(0, bounds.top - $('document').getBoundingClientRect().top + 8) + 'px');
  const scale = bounds.height / viewport.offsetHeight || 1;
  let active = documentOutlineEntries[0];
  for (const entry of documentOutlineEntries) {
    if (entry.heading.getBoundingClientRect().top <= bounds.top + 20 * scale) active = entry;
    else break;
  }
  for (const entry of documentOutlineEntries) {
    if (entry === active) entry.button.setAttribute('aria-current', 'location');
    else entry.button.removeAttribute('aria-current');
  }
}

function installDocumentOutline(root) {
  const body = root.querySelector('.toastui-editor-ww-container .ProseMirror');
  new MutationObserver(() => {
    if ($('documentOutline').hidden || documentOutlineFrame !== null) return;
    documentOutlineFrame = requestAnimationFrame(() => {
      documentOutlineFrame = null;
      if (!$('documentOutline').hidden) renderDocumentOutline();
    });
  }).observe(body, { childList: true, characterData: true, subtree: true });
}

document.addEventListener('pointerdown', event => {
  if (!$('documentOutline').hidden && !$('documentOutline').contains(event.target) && !$('toggleOutline').contains(event.target)) {
    setDocumentOutlineOpen(false);
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('documentOutline').hidden) {
    event.preventDefault();
    setDocumentOutlineOpen(false, true);
  }
});
