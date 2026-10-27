'use strict';

// Inline marks and table cells can yield several rectangles for the same row.
// Count rendered rows, independent of Markdown syntax and paragraph margins.
function mergeEditorLineRects(rects) {
  const rows = [];
  const sorted = rects.filter(rect => Number.isFinite(rect.top) && Number.isFinite(rect.height) && rect.height > 0)
    .map(rect => ({ top: rect.top, height: rect.height })).sort((a, b) => a.top - b.top);
  for (const rect of sorted) {
    const previous = rows.at(-1);
    const overlap = previous && Math.min(previous.top + previous.height, rect.top + rect.height) - Math.max(previous.top, rect.top);
    if (previous && overlap >= Math.min(previous.height, rect.height) / 2) {
      previous.height = Math.max(previous.top + previous.height, rect.top + rect.height) - previous.top;
    } else rows.push(rect);
  }
  return rows;
}

function visibleEditorLineRange(rows, top, height, overscan = 80) {
  let low = 0, high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].top + rows[middle].height < top - overscan) low = middle + 1;
    else high = middle;
  }
  const first = low;
  while (low < rows.length && rows[low].top <= top + height + overscan) low++;
  return [first, low];
}

function editorLineNumbersPlugin({ pmState }) {
  return {
    wysiwygPlugins: [() => new pmState.Plugin({
      view(view) {
        const body = view.dom, viewport = body.parentElement;
        const gutter = document.createElement('div');
        gutter.className = 'editor-line-numbers';
        gutter.setAttribute('aria-hidden', 'true');
        gutter.setAttribute('contenteditable', 'false');
        viewport.classList.add('editor-has-line-numbers');
        // Keep UI outside the ProseMirror document so it cannot enter saves,
        // selections, the clipboard or the editor's undo/input-method state.
        viewport.append(gutter);
        const handle = document.createElement('div');
        handle.className = 'editor-line-resize';
        handle.tabIndex = 0;
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-label', '调整行号栏宽度');
        handle.setAttribute('aria-orientation', 'vertical');
        handle.setAttribute('contenteditable', 'false');
        handle.title = '拖动调整行号栏宽度，双击恢复默认；方向键也可调整';
        viewport.append(handle);
        const target = document.createElement('div');
        target.className = 'editor-line-target';
        target.setAttribute('aria-hidden', 'true');
        target.hidden = true;
        viewport.append(target);
        const listeners = new Set();
        let targetLine = null;
        let rows = [], frame = null, measure = true, destroyed = false, renderedRange = '';
        let preferredWidth = 36, width = 0, drag = null;
        try {
          const saved = Number(localStorage.getItem('mojian.lineNumberWidth'));
          if (Number.isFinite(saved) && saved >= 28 && saved <= 96) preferredWidth = saved;
        } catch {}
        const minWidth = () => Math.max(28, String(Math.max(1, rows.length)).length * 7 + 14);
        const persistWidth = () => {
          try { localStorage.setItem('mojian.lineNumberWidth', String(preferredWidth)); } catch {}
        };
        const applyWidth = value => {
          const next = Math.round(Math.max(minWidth(), Math.min(96, value)));
          handle.setAttribute('aria-valuemin', minWidth());
          handle.setAttribute('aria-valuemax', 96);
          handle.setAttribute('aria-valuenow', next);
          handle.setAttribute('aria-valuetext', next + ' 像素');
          if (next === width) return;
          width = next;
          viewport.style.setProperty('--editor-line-width', width + 'px');
          schedule(true);
        };
        const draw = () => {
          frame = null;
          if (destroyed || !viewport.offsetWidth || !body.getClientRects().length) return;
          if (measure) {
            const bounds = viewport.getBoundingClientRect();
            const scale = bounds.width / viewport.offsetWidth;
            if (!Number.isFinite(scale) || scale <= 0) return;
            const origin = bounds.top + viewport.clientTop * scale;
            const rects = [];
            const append = rect => {
              if (rect.height > 0) rects.push({ top: (rect.top - origin) / scale + viewport.scrollTop, height: rect.height / scale });
            };
            const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
            const range = document.createRange();
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
              if (!text.length) continue;
              range.selectNodeContents(text);
              for (const rect of range.getClientRects()) append(rect);
            }
            for (const br of body.querySelectorAll('br')) {
              for (const rect of br.getClientRects()) append(rect);
            }
            // Empty paragraphs, standalone media and separators have no text
            // rectangle. Represent each as one row, rather than its full height.
            for (const element of body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, pre, hr')) {
              if (element.textContent.length) continue;
              const rect = element.getBoundingClientRect();
              if (!rect.height) continue;
              const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 20;
              append({ top: rect.top, height: Math.min(rect.height, lineHeight * scale) });
            }
            rows = mergeEditorLineRects(rects);
            const bodyTop = (body.getBoundingClientRect().top - origin) / scale + viewport.scrollTop;
            gutter.style.height = Math.max(viewport.clientHeight, bodyTop + body.offsetHeight) + 'px';
            measure = false;
            renderedRange = '';
            applyWidth(preferredWidth);
            listeners.forEach(listener => listener(rows.length));
          }
          const selected = targetLine === null ? null : rows[targetLine - 1];
          target.hidden = !selected;
          if (selected) { target.style.top = selected.top + 'px'; target.style.height = selected.height + 'px'; }
          handle.style.height = viewport.clientHeight + 'px';
          handle.style.transform = 'translateY(' + viewport.scrollTop + 'px)';
          const [first, last] = visibleEditorLineRange(rows, viewport.scrollTop, viewport.clientHeight);
          const key = first + ':' + last + ':' + targetLine;
          if (key === renderedRange) return;
          const fragment = document.createDocumentFragment();
          for (let index = first; index < last; index++) {
            const number = document.createElement('span');
            number.className = 'editor-line-number' + (index + 1 === targetLine ? ' is-line-target' : '');
            number.textContent = String(index + 1);
            number.style.top = rows[index].top + 'px';
            number.style.height = rows[index].height + 'px';
            fragment.append(number);
          }
          gutter.replaceChildren(fragment);
          renderedRange = key;
        };
        const schedule = (remeasure = false) => {
          if (destroyed) return;
          measure = measure || remeasure;
          if (frame === null) frame = requestAnimationFrame(draw);
        };
        const scroll = () => schedule();
        const resize = () => schedule(true);
        const controller = {
          get count() { return rows.length; },
          subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
          jump(value) {
            if (destroyed || !viewport.offsetWidth || !body.getClientRects().length) return { ok: false, count: 0 };
            // ResizeObserver may not have delivered a CSS zoom/width change yet.
            // Explicit navigation always measures the current layout first.
            measure = true;
            for (let attempt = 0; measure && attempt < 3; attempt++) {
              if (frame !== null) cancelAnimationFrame(frame);
              draw();
            }
            const text = String(value).trim(), line = Number(text);
            if (!/^\d+$/.test(text) || !Number.isSafeInteger(line) || line < 1 || line > rows.length) return { ok: false, count: rows.length };
            targetLine = line;
            const row = rows[line - 1];
            viewport.scrollTo({ top: Math.max(0, row.top - Math.max(12, (viewport.clientHeight - row.height) / 3)), behavior: 'instant' });
            schedule();
            return { ok: true, count: rows.length, line };
          },
        };
        viewport.editorLineNumbers = controller;
        const finishDrag = (cancel = false) => {
          if (!drag) return;
          const previous = drag; drag = null;
          if (cancel) { preferredWidth = previous.width; applyWidth(preferredWidth); }
          else persistWidth();
          viewport.classList.remove('editor-line-resizing');
          if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id);
        };
        const moveDrag = event => {
          if (!drag || event.pointerId !== drag.id) return;
          applyWidth(drag.startWidth + (event.clientX - drag.x) / drag.scale);
          preferredWidth = width;
        };
        handle.addEventListener('pointerdown', event => {
          if (drag || event.button !== 0 || event.isPrimary === false) return;
          const scale = viewport.getBoundingClientRect().width / viewport.offsetWidth;
          if (!Number.isFinite(scale) || scale <= 0) return;
          event.preventDefault(); event.stopPropagation();
          drag = { id: event.pointerId, x: event.clientX, scale, width: preferredWidth, startWidth: width };
          handle.setPointerCapture(event.pointerId);
          viewport.classList.add('editor-line-resizing');
        });
        handle.addEventListener('pointermove', moveDrag);
        handle.addEventListener('pointerup', event => {
          if (!drag || event.pointerId !== drag.id) return;
          moveDrag(event); finishDrag();
        });
        const cancelDrag = () => finishDrag(true);
        handle.addEventListener('pointercancel', event => { if (event.pointerId === drag?.id) cancelDrag(); });
        handle.addEventListener('lostpointercapture', event => { if (event.pointerId === drag?.id) cancelDrag(); });
        handle.addEventListener('keydown', event => {
          if (drag) return;
          const step = event.shiftKey ? 12 : 4;
          const values = { ArrowLeft: width - step, ArrowRight: width + step, Home: minWidth(), End: 96 };
          if (!(event.key in values)) return;
          event.preventDefault(); event.stopPropagation();
          applyWidth(values[event.key]); preferredWidth = width; persistWidth();
        });
        const escapeDrag = event => {
          if (drag && event.key === 'Escape') { event.preventDefault(); cancelDrag(); }
        };
        handle.addEventListener('dblclick', event => {
          event.preventDefault(); preferredWidth = 36; applyWidth(preferredWidth); persistWidth();
        });
        window.addEventListener('blur', cancelDrag);
        window.addEventListener('keydown', escapeDrag);
        viewport.addEventListener('scroll', scroll, { passive: true });
        body.addEventListener('load', resize, true);
        window.addEventListener('resize', resize);
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
        observer?.observe(body); observer?.observe(viewport);
        document.fonts?.addEventListener('loadingdone', resize);
        document.fonts?.ready.then(resize);
        applyWidth(preferredWidth);
        schedule(true);
        return {
          update(next, previous) {
            if (next.state.doc !== previous.doc) { targetLine = null; target.hidden = true; schedule(true); }
          },
          destroy() {
            cancelDrag();
            destroyed = true;
            if (frame !== null) cancelAnimationFrame(frame);
            observer?.disconnect();
            viewport.removeEventListener('scroll', scroll);
            body.removeEventListener('load', resize, true);
            window.removeEventListener('resize', resize);
            window.removeEventListener('blur', cancelDrag);
            window.removeEventListener('keydown', escapeDrag);
            document.fonts?.removeEventListener('loadingdone', resize);
            gutter.remove();
            handle.remove();
            target.remove();
            listeners.clear();
            if (viewport.editorLineNumbers === controller) delete viewport.editorLineNumbers;
            viewport.style.removeProperty('--editor-line-width');
            viewport.classList.remove('editor-has-line-numbers');
          },
        };
      },
    })],
  };
}
