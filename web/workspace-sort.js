'use strict';

// Only display order is stored. These keys are never sent to file APIs.
function workspaceOrderKey(scope) { return 'mojian.order.' + scope; }

function orderedWorkspaceEntries(scope, entries) {
  const positions = new Map(readBrowsingPaths(workspaceOrderKey(scope)).map((key, index) => [key, index]));
  return entries.map((entry, index) => ({ entry, index })).sort((a, b) =>
    (positions.get(a.entry.key) ?? Infinity) - (positions.get(b.entry.key) ?? Infinity) || a.index - b.index
  ).map(item => item.entry);
}

// Search/permission filters may hide siblings: replace visible slots only.
function mergeWorkspaceOrder(previous, visible) {
  const unique = [...new Set(visible)], selected = new Set(unique);
  let index = 0;
  const result = previous.map(key => selected.has(key) ? unique[index++] : key);
  return [...new Set([...result, ...unique.slice(index)])];
}

let workspaceDrag = null;
let workspaceClickBlockedUntil = 0;
let workspaceSortRefreshPending = false;
let workspaceDropGhost = null;
const workspaceShiftDuration = 360;
const workspaceDropDuration = 280;
function workspaceSortBusy() { return workspaceDrag !== null; }
function deferWorkspaceSortRender() {
  if (!workspaceDrag) return false;
  workspaceSortRefreshPending = true;
  return true;
}

function markWorkspaceSortItem(row, handle, key) {
  row.dataset.sortKey = key;
  handle.dataset.sortHandle = '';
  handle.title += ' · 按住拖动排序；Alt + 方向键调整顺序';
  const grip = document.createElement('span');
  grip.className = 'sort-grip'; grip.textContent = '⠿';
  grip.setAttribute('aria-hidden', 'true');
  handle.prepend(grip);
}

function workspaceSortRows(container) {
  return [...container.children].filter(node => node.dataset.sortKey !== undefined);
}

function animateWorkspaceShift(rows, before) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const row of rows) {
    const old = before.get(row), next = row.getBoundingClientRect();
    if (!old || !row.animate || (old.left === next.left && old.top === next.top)) continue;
    row._sortAnimation?.cancel();
    row._sortAnimation = row.animate([
      { transform: 'translate(' + (old.left - next.left) + 'px,' + (old.top - next.top) + 'px)' },
      { transform: 'translate(0,0)' }
    ], { duration: workspaceShiftDuration, easing: 'cubic-bezier(.25,.65,.3,1)' });
  }
}

function workspaceSortHandle(row) {
  return row.dataset.sortHandle !== undefined ? row : row.querySelector('[data-sort-handle]');
}

function findWorkspaceSortRow(scope, key) {
  return [...document.querySelectorAll('[data-sort-key]')].find(row =>
    row.dataset.sortKey === key && row.parentElement?._workspaceSortOptions?.scope === scope);
}

function captureWorkspaceSortPointer(drag) {
  // Reordering detaches/reinserts the row. Capture on a stable scrolling
  // container instead, so the browser cannot cancel capture during a swap.
  try { drag.captureTarget.setPointerCapture(drag.pointerId); } catch {
    // Window listeners still handle move/up if the platform declines capture.
  }
}

function recoverWorkspaceSortCapture(event) {
  const drag = workspaceDrag;
  if (!drag?.active || event.pointerId !== drag.pointerId || event.target !== drag.captureTarget) return;
  captureWorkspaceSortPointer(drag);
}

function measureWorkspaceSort(drag) {
  drag.geometry = workspaceSortRows(drag.container).map(row => ({ row, bounds: row.getBoundingClientRect() }));
  drag.geometryTop = drag.geometry.reduce((top, item) => Math.min(top, item.bounds.top), Infinity);
  drag.geometryBottom = drag.geometry.reduce((bottom, item) => Math.max(bottom, item.bounds.bottom), -Infinity);
  drag.geometryScrollLeft = drag.scroller.scrollLeft;
  drag.geometryScrollTop = drag.scroller.scrollTop;
}

function reorderWorkspaceSort(drag) {
  const horizontal = drag.options.axis === 'x', bounds = drag.scroller.getBoundingClientRect();
  const cross = horizontal ? drag.y : drag.x, margin = horizontal ? 48 : 24;
  if (cross < (horizontal ? bounds.top : bounds.left) - margin ||
      cross > (horizontal ? bounds.bottom : bounds.right) + margin) return;
  const dx = drag.geometryScrollLeft - drag.scroller.scrollLeft;
  const dy = drag.geometryScrollTop - drag.scroller.scrollTop;
  const items = drag.geometry;
  if (!horizontal) {
    // Keep a nested group within its own extent, including expanded folders.
    const top = Math.max(bounds.top, drag.geometryTop + dy);
    const bottom = Math.min(bounds.bottom, drag.geometryBottom + dy);
    if (drag.y < top - 20 || drag.y > bottom + 20) return;
  } else if (drag.x < bounds.left - 48 || drag.x > bounds.right + 48) return;
  const pointer = horizontal ? drag.x : drag.y;
  // Use layout snapshots, not elementFromPoint or animated rectangles. Gaps,
  // close buttons and a small diagonal movement still select the intended slot.
  const reference = items.find(item => item.row !== drag.row && pointer < (horizontal
    ? item.bounds.left + dx + item.bounds.width / 2 : item.bounds.top + dy + item.bounds.height / 2))?.row || null;
  if (reference === drag.row || drag.row.nextSibling === reference) return;
  const rows = workspaceSortRows(drag.container);
  const before = new Map(rows.map(row => [row, row.getBoundingClientRect()]));
  rows.forEach(row => row._sortAnimation?.cancel());
  drag.container.insertBefore(drag.row, reference);
  measureWorkspaceSort(drag);
  animateWorkspaceShift(rows.filter(row => row !== drag.row), before);
}

function bindWorkspaceSort(container, options) {
  container._workspaceSortOptions = options;
  if (container._workspaceSortBound) return;
  container._workspaceSortBound = true;
  container.addEventListener('pointerdown', event => {
    if (workspaceDrag || event.button !== 0 || event.isPrimary === false) return;
    const handle = event.target.closest('[data-sort-handle]');
    const row = handle?.closest('[data-sort-key]');
    if (!row || row.parentElement !== container || event.target.closest('.history-close')) return;
    // Touch users can scroll the labels; the grip explicitly starts a drag.
    if (event.pointerType === 'touch' && !event.target.closest('.sort-grip')) return;
    event.stopPropagation();
    workspaceDrag = { container, handle, row, options: container._workspaceSortOptions,
      pointerType: event.pointerType, scroller: container._workspaceSortOptions.axis === 'x' ? container : $('fileList'),
      pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX,
      startY: event.clientY, active: false, original: [...container.children], frame: null };
    workspaceDrag.captureTarget = workspaceDrag.scroller;
    window.addEventListener('pointermove', moveWorkspaceSort, { passive: false });
    window.addEventListener('pointerup', finishWorkspaceSort);
    window.addEventListener('pointercancel', cancelWorkspaceSort);
    window.addEventListener('lostpointercapture', recoverWorkspaceSortCapture);
    window.addEventListener('blur', cancelWorkspaceSort);
    window.addEventListener('keydown', workspaceSortEscape);
  });
  container.addEventListener('keydown', event => {
    if (!event.altKey || workspaceDrag) return;
    const options = container._workspaceSortOptions;
    const directions = options.axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    if (!directions.includes(event.key)) return;
    const handle = event.target.closest('[data-sort-handle]'), row = handle?.closest('[data-sort-key]');
    if (!row || row.parentElement !== container || event.target !== handle) return;
    event.preventDefault(); event.stopPropagation();
    const rows = workspaceSortRows(container), index = rows.indexOf(row);
    const next = index + (event.key === directions[0] ? -1 : 1);
    if (next < 0 || next >= rows.length) return;
    const before = new Map(rows.map(item => [item, item.getBoundingClientRect()]));
    rows.forEach(item => item._sortAnimation?.cancel());
    container.insertBefore(row, next < index ? rows[next] : rows[next].nextSibling);
    animateWorkspaceShift(rows, before);
    options.save(workspaceSortRows(container).map(item => item.dataset.sortKey));
    drawFiles(false);
    // Saving can rebuild the list. Restore focus by key, without scrolling.
    const replacement = findWorkspaceSortRow(options.scope, row.dataset.sortKey);
    const replacementHandle = replacement && workspaceSortHandle(replacement);
    replacementHandle?.focus({ preventScroll: true });
  });
  container.addEventListener('dragstart', event => {
    if (event.target.closest('[data-sort-handle]')) event.preventDefault();
  });
}

function moveWorkspaceSort(event) {
  const drag = workspaceDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.row.isConnected || !drag.handle.isConnected) { cancelWorkspaceSort(); return; }
  if (drag.pointerType !== 'touch' && event.buttons !== undefined && !(event.buttons & 1)) {
    finishWorkspaceSort(event); return;
  }
  drag.x = event.clientX; drag.y = event.clientY;
  if (!drag.active) {
    if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
    drag.active = true;
    workspaceDropGhost?.remove(); workspaceDropGhost = null;
    workspaceSortRows(drag.container).forEach(row => row._sortAnimation?.cancel());
    measureWorkspaceSort(drag);
    const bounds = drag.handle.getBoundingClientRect();
    drag.offsetX = drag.startX - bounds.left; drag.offsetY = drag.startY - bounds.top;
    drag.ghost = drag.row.cloneNode(true);
    drag.ghost.removeAttribute('id');
    drag.ghost.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    drag.ghost.classList.add('sort-ghost');
    drag.ghost.setAttribute('aria-hidden', 'true'); drag.ghost.inert = true;
    drag.ghost.style.width = drag.row.getBoundingClientRect().width + 'px';
    drag.ghost.style.height = bounds.height + 'px';
    document.body.append(drag.ghost);
    drag.row.classList.add('sort-source');
    drag.container.classList.add('sort-active');
    drag.scroller.classList.add('sort-scrolling');
    document.body.classList.add('workspace-sorting');
    captureWorkspaceSortPointer(drag);
    drag.frame = requestAnimationFrame(updateWorkspaceSort);
  }
  event.preventDefault();
}

function updateWorkspaceSort(time, scheduleNext = true) {
  const drag = workspaceDrag;
  if (!drag?.active) return;
  if (!drag.row.isConnected || !drag.container.isConnected) { cancelWorkspaceSort(); return; }
  drag.ghost.style.transform = 'translate3d(' + (drag.x - drag.offsetX) + 'px,' + (drag.y - drag.offsetY) + 'px,0)';
  const horizontal = drag.options.axis === 'x';
  const scroller = drag.scroller;
  const bounds = scroller.getBoundingClientRect(), pointer = horizontal ? drag.x : drag.y;
  const cross = horizontal ? drag.y : drag.x;
  const inCrossBounds = cross >= (horizontal ? bounds.top : bounds.left) && cross <= (horizontal ? bounds.bottom : bounds.right);
  const start = horizontal ? bounds.left : bounds.top, end = horizontal ? bounds.right : bounds.bottom;
  const elapsed = Math.min(32, Math.max(0, time - (drag.lastFrame ?? time - 16)));
  drag.lastFrame = time;
  if (inCrossBounds && pointer >= start - 24 && pointer <= end + 24) {
    const edge = Math.min(40, (end - start) / 3);
    const speed = pointer < start + edge ? -Math.min(1, (start + edge - pointer) / edge)
      : pointer > end - edge ? Math.min(1, (pointer - end + edge) / edge) : 0;
    if (horizontal) scroller.scrollLeft += speed * elapsed * .4;
    else scroller.scrollTop += speed * elapsed * .4;
  }
  reorderWorkspaceSort(drag);
  if (scheduleNext) drag.frame = requestAnimationFrame(updateWorkspaceSort);
}

function workspaceSortEscape(event) { if (event.key === 'Escape') { event.preventDefault(); cancelWorkspaceSort(); } }
function cancelWorkspaceSort(event) {
  if (event?.pointerId !== undefined && event.pointerId !== workspaceDrag?.pointerId) return;
  finishWorkspaceSort(null, true);
}

function finishWorkspaceSort(event, cancelled = false) {
  const drag = workspaceDrag;
  if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
  if (event?.type === 'pointerup' && event.button !== 0) return;
  // A quick release can happen before requestAnimationFrame runs. Apply the
  // release coordinates synchronously, then persist exactly that final order.
  if (!cancelled && drag.active) {
    if (Number.isFinite(event?.clientX)) drag.x = event.clientX;
    if (Number.isFinite(event?.clientY)) drag.y = event.clientY;
    updateWorkspaceSort(drag.lastFrame ?? 0, false);
    if (workspaceDrag !== drag) return;
  }
  workspaceDrag = null;
  window.removeEventListener('pointermove', moveWorkspaceSort);
  window.removeEventListener('pointerup', finishWorkspaceSort);
  window.removeEventListener('pointercancel', cancelWorkspaceSort);
  window.removeEventListener('lostpointercapture', recoverWorkspaceSortCapture);
  window.removeEventListener('blur', cancelWorkspaceSort);
  window.removeEventListener('keydown', workspaceSortEscape);
  if (!drag.active) {
    if (workspaceSortRefreshPending) {
      workspaceSortRefreshPending = false;
      // Preserve the native click first; it may open a file or toggle a folder.
      requestAnimationFrame(() => drawFiles(false));
    }
    return;
  }
  cancelAnimationFrame(drag.frame);
  if (drag.captureTarget.hasPointerCapture(drag.pointerId)) drag.captureTarget.releasePointerCapture(drag.pointerId);
  drag.row.classList.remove('sort-source');
  drag.container.classList.remove('sort-active'); document.body.classList.remove('workspace-sorting');
  drag.scroller.classList.remove('sort-scrolling');
  workspaceSortRows(drag.container).forEach(row => row._sortAnimation?.cancel());
  workspaceClickBlockedUntil = Date.now() + 350;
  if (cancelled) drag.container.append(...drag.original);
  else drag.options.save(workspaceSortRows(drag.container).map(row => row.dataset.sortKey));
  // Poll/search updates were deferred while dragging. Apply their latest state now.
  workspaceSortRefreshPending = false;
  drawFiles(false);
  const destination = findWorkspaceSortRow(drag.options.scope, drag.row.dataset.sortKey);
  if (cancelled || !destination || !drag.ghost.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    drag.ghost.remove(); return;
  }
  const rect = workspaceSortHandle(destination).getBoundingClientRect();
  workspaceDropGhost = drag.ghost;
  const animation = drag.ghost.animate([
    { transform: drag.ghost.style.transform, opacity: .96 },
    { transform: 'translate3d(' + rect.left + 'px,' + rect.top + 'px,0)', opacity: 0 }
  ], { duration: workspaceDropDuration, easing: 'cubic-bezier(.25,.65,.3,1)', fill: 'forwards' });
  const removeGhost = () => { drag.ghost.remove(); if (workspaceDropGhost === drag.ghost) workspaceDropGhost = null; };
  if (animation.finished) animation.finished.then(removeGhost, removeGhost);
  else removeGhost();
}

document.addEventListener('click', event => {
  if (Date.now() < workspaceClickBlockedUntil && event.target.closest('#fileList, #documentHistoryList')) {
    event.preventDefault(); event.stopImmediatePropagation();
  }
}, true);
