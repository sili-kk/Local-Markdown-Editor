'use strict';

function readBrowsingPaths(key) {
  try {
    const paths = JSON.parse(localStorage.getItem(key));
    return Array.isArray(paths) ? [...new Set(paths.filter(path => typeof path === 'string' && path.length > 0))] : [];
  } catch { return []; }
}

function writeBrowsingPaths(key, paths) {
  try { localStorage.setItem(key, JSON.stringify(paths)); } catch {}
}

let recentDocuments = readBrowsingPaths('mojian.recentDocuments').slice(0, 20);

function rememberDocument(path) {
  state.documentsClosed = false;
  writeBrowsingPaths('mojian.closedView', []);
  if (!recentDocuments.includes(path)) recentDocuments = [...recentDocuments, path].slice(-20);
  writeBrowsingPaths('mojian.recentDocuments', recentDocuments);
  writeBrowsingPaths('mojian.lastDocument', [path]);
}

function documentHistoryPaths() {
  const available = new Set(state.files);
  return [...new Set([...recentDocuments, state.path])].filter(path => path && (available.has(path) || path === state.path));
}

let historyClosing = false;
async function closeDocumentHistory(path) {
  if (historyClosing || state.navigating || state.merging) return;
  historyClosing = true;
  try {
    if (path === state.path) {
      const paths = documentHistoryPaths(), index = paths.indexOf(path);
      const next = paths[index + 1] || paths[index - 1] || '';
      if (!await navigate(next, false, { closing: true }) || state.path === path) return;
    }
    recentDocuments = recentDocuments.filter(item => item !== path);
    writeBrowsingPaths('mojian.recentDocuments', recentDocuments);
    writeBrowsingPaths('mojian.lastDocument', state.path ? [state.path] : []);
    renderDocumentHistory();
  } finally { historyClosing = false; }
}

function renderDocumentHistory(revealActive = true) {
  if (deferWorkspaceSortRender()) return;
  const list = $('documentHistoryList');
  const paths = documentHistoryPaths();
  const signature = JSON.stringify([state.path, paths.map(path => [path, displayLibraryPath(path, true)])]);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  const fragment = document.createDocumentFragment();
  for (const path of paths) {
    const tab = document.createElement('div'); tab.className = 'history-item'; tab.dataset.path = path;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'history-open';
    button.title = displayLibraryPath(path, true);
    const label = document.createElement('span');
    label.className = 'history-name';
    label.textContent = path.split('/').pop().replace(/\.(md|markdown)$/i, '');
    if (path === state.path) {
      tab.setAttribute('aria-current', 'page'); button.setAttribute('aria-current', 'page');
      label.id = 'currentPath';
      label.title = button.title;
    }
    button.append(label);
    button.onclick = () => { void navigate(path); };
    const close = document.createElement('button'); close.type = 'button'; close.className = 'history-close'; close.textContent = '×';
    close.title = '关闭文档：' + button.title; close.setAttribute('aria-label', close.title);
    close.onclick = event => { event.preventDefault(); event.stopPropagation(); void closeDocumentHistory(path); };
    tab.append(button, close);
    markWorkspaceSortItem(tab, button, path);
    fragment.append(tab);
  }
  if (!state.path) {
    const placeholder = document.createElement('span');
    placeholder.id = 'currentPath';
    placeholder.textContent = '选择一篇文档';
    fragment.prepend(placeholder);
  }
  const scrollLeft = list.scrollLeft;
  list.replaceChildren(fragment);
  list.scrollLeft = scrollLeft;
  bindWorkspaceSort(list, { axis: 'x', scope: 'history', save: order => {
    recentDocuments = mergeWorkspaceOrder([...new Set([...recentDocuments, ...documentHistoryPaths()])], order).slice(-20);
    writeBrowsingPaths('mojian.recentDocuments', recentDocuments);
  } });
  requestAnimationFrame(() => {
    updateDocumentHistoryArrows();
    if (!revealActive || workspaceSortBusy()) return;
    const active = list.querySelector('[aria-current="page"]');
    if (!active) return;
    const bounds = list.getBoundingClientRect(), target = active.getBoundingClientRect();
    if (target.left < bounds.left) list.scrollLeft -= bounds.left - target.left;
    else if (target.right > bounds.right) list.scrollLeft += target.right - bounds.right;
  });
}

let historyArrowsFrame = null;
function scheduleDocumentHistoryArrows() {
  if (historyArrowsFrame !== null) return;
  historyArrowsFrame = requestAnimationFrame(() => {
    historyArrowsFrame = null;
    updateDocumentHistoryArrows();
  });
}

function updateDocumentHistoryArrows() {
  const list = $('documentHistoryList');
  // Compare content with the full row, so the arrows cannot create their own
  // overflow. Keep them in place while scrolling to avoid clamping scrollLeft.
  const overflow = list.scrollWidth - $('documentHistory').clientWidth > 1;
  $('historyPrevious').hidden = $('historyNext').hidden = !overflow;
  $('historyPrevious').disabled = !overflow || list.scrollLeft <= 1;
  $('historyNext').disabled = !overflow || list.scrollLeft >= list.scrollWidth - list.clientWidth - 1;
}

document.addEventListener('DOMContentLoaded', () => {
  const list = $('documentHistoryList');
  for (const [id, direction] of [['historyPrevious', -1], ['historyNext', 1]]) {
    $(id).onclick = () => list.scrollBy({ left: direction * Math.max(120, list.clientWidth * 0.8), behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  }
  list.addEventListener('scroll', scheduleDocumentHistoryArrows, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(scheduleDocumentHistoryArrows).observe($('documentHistory'));
  window.addEventListener('resize', scheduleDocumentHistoryArrows);
});
