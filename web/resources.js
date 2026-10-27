'use strict';

function resourceImageURL(reference, path = state.path) {
  return '/api/resource/image?' + new URLSearchParams({ path, reference });
}

function resourceAddress(reference) {
  if (/^[a-z]:[\\/]|^file:|^\\\\/i.test(reference)) return { local: true, url: resourceImageURL(reference) };
  const base = new URL('/assets/' + state.path.split('/').map(encodeURIComponent).join('/'), location.origin);
  const directory = state.directories.find(item => item.id === state.path.split('/')[0]);
  const root = directory ? '/assets/' + encodeURIComponent(directory.id) : '/assets';
  const url = new URL(reference.startsWith('/') && !reference.startsWith('//') && !reference.startsWith('/assets/') ? root + reference : reference, base);
  const local = url.origin === location.origin && url.pathname.startsWith('/assets/');
  // Resolve relative paths at the server, which enforces configured libraries.
  return { local, url: local ? resourceImageURL(reference) : url.href, target: url };
}

function isMarkdownResourceReference(reference) {
  try { reference = decodeURIComponent(reference); } catch { /* Keep literal spelling. */ }
  return /\.m(?:d|arkdown)$/i.test(reference.split(/[?#]/, 1)[0]);
}

function compactResourcePath(value) {
  let path = value;
  try { path = decodeURIComponent(path); } catch { /* Keep literal spelling. */ }
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(value);
      let pathname = url.pathname;
      try { pathname = decodeURIComponent(pathname); } catch { /* Keep literal spelling. */ }
      path = (url.hostname && url.hostname !== 'localhost' ? '//' + url.hostname : '') + pathname;
    } catch { /* Use shortened fallback. */ }
  }
  path = path.replace(/\\/g, '/');
  if (path.startsWith('/assets/@')) path = path.slice('/assets/'.length).split(/[?#]/, 1)[0];
  if (path.startsWith('@')) return '.../' + displayLibraryPath(path);
  if (!/^(?:\/?[a-z]:\/|\/|file:)/i.test(path)) return path;
  path = path.replace(/^\/(?=[a-z]:\/)/i, '');
  // Prefer a configured root's basename, retaining subfolders and filename.
  const root = state.directories.filter(item => item.path).map(item => ({
    path: item.path.replace(/\\/g, '/').replace(/\/$/, ''), isFile: item.is_file,
  })).filter(item => path.toLowerCase() === item.path.toLowerCase() ||
    !item.isFile && path.toLowerCase().startsWith(item.path.toLowerCase() + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (root) {
    const parts = root.path.split('/');
    return '.../' + (root.isFile ? parts.slice(-2).join('/') : parts.pop() + path.slice(root.path.length));
  }
  const parts = path.split('/').filter(Boolean);
  let doc = -1;
  for (let index = parts.length - 1; index >= 0; index--) {
    if (/^(?:docs?|doc-storage)$/i.test(parts[index])) { doc = index; break; }
  }
  return '.../' + parts.slice(doc >= 0 ? doc : -2).join('/');
}

// A ProseMirror mark view changes only how the link is rendered. Its original
// URL/title and all editable link text remain in the document model, so save,
// undo and the editor's link dialog continue to use the author's reference.
function localMarkdownLinksPlugin() {
  return { wysiwygNodeViews: { link(mark) {
    const spec = mark.type.spec.toDOM(mark);
    const link = document.createElement(spec[0]);
    for (const [name, value] of Object.entries(spec[1] || {})) {
      if (value !== null && value !== undefined) link.setAttribute(name, value);
    }
    const reference = mark.attrs.linkUrl || '';
    let local = false;
    try { local = resourceAddress(reference).local; } catch { /* Keep normal link rendering. */ }
    if (local && isMarkdownResourceReference(reference)) {
      link.dataset.resourceReference = reference;
      // Native hover status must not expose a drive/file URL. Clicks resolve
      // the untouched original reference through the resource API instead.
      link.setAttribute('href', '#');
      link.setAttribute('title', compactResourcePath(reference) + ' · 单击在本页查看文档');
    }
    return { dom: link, contentDOM: link };
  } } };
}

// Runs only inside the opaque-origin preview. Local image links open an
// overlay rather than navigating the sandbox to an editor-origin URL.
function htmlPreviewNavigation() {
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (!link || link.getAttribute('href')?.startsWith('#')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const source = link.getAttribute('data-preview-image') || link.getAttribute('href');
    const overlay = document.createElement('dialog');
    overlay.style.cssText = 'box-sizing:border-box;width:94vw;height:94vh;max-width:none;max-height:none;border:1px solid #cbd5cc;border-radius:14px;padding:50px 12px 12px;background:#f7f9f5;color:#253b35;';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭 · Esc';
    close.style.cssText = 'position:absolute;right:12px;top:10px;padding:6px 12px;border:1px solid #bacaba;border-radius:7px;background:#fff;color:#253b35;cursor:pointer;';
    close.onclick = () => overlay.close(); overlay.addEventListener('close', () => overlay.remove()); overlay.append(close);
    if (/^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|svg\+xml);base64,/i.test(source)) {
      const image = document.createElement('img'); image.src = source; image.alt = link.textContent.trim() || '图片原图';
      image.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;margin:0;'; overlay.append(image);
    } else {
      const message = document.createElement('p'); message.textContent = '此链接暂不支持在预览中打开；请返回编辑页查看原文件。'; overlay.append(message);
    }
    document.body.append(overlay); overlay.showModal(); close.focus();
  }, true);
}

async function prepareHTMLPreviewImages(data, resource, signal) {
  // A template keeps parsing inert: no referenced images/scripts are fetched.
  if (!/<img\b|\bhref\s*=\s*["'][^"']*\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)(?:[?#][^"']*)?["']/i.test(data.content)) return data.content;
  const template = document.createElement('template'); template.innerHTML = data.content;
  const nodes = [...template.content.querySelectorAll('img[src], a[href]')];
  const reference = node => node.getAttribute(node.tagName === 'IMG' ? 'src' : 'href');
  const isLocalImage = value => value && !/^(?:data:|blob:|https?:|\/\/|#)/i.test(value) && /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)(?:[?#].*)?$/i.test(value);
  const images = [...new Set(nodes.map(reference).filter(isLocalImage))].slice(0, 32);
  let loaded = {};
  if (images.length) {
    const response = await api('/api/resource/html-images', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ path: resource.path, reference: resource.reference, images }),
    });
    loaded = response.images || {};
  }
  for (const node of nodes) {
    const value = reference(node);
    if (node.tagName === 'IMG') {
      // srcset must not override the authorized, embedded image.
      node.removeAttribute('srcset');
      if (loaded[value]) node.setAttribute('src', loaded[value]);
      else if (isLocalImage(value)) { node.removeAttribute('src'); node.setAttribute('alt', '图片不存在、过大或无权访问'); }
    } else if (loaded[value]) {
      node.setAttribute('data-preview-image', loaded[value]);
    }
  }
  template.content.querySelectorAll('picture source').forEach(node => node.removeAttribute('srcset'));
  return template.innerHTML;
}

function installResourceInteractions(root) {
  const tooltip = document.createElement('div');
  tooltip.className = 'resource-tooltip'; tooltip.hidden = true; tooltip.setAttribute('role', 'dialog');
  tooltip.setAttribute('aria-label', '资源预览');
  const pathText = document.createElement('div'); pathText.className = 'resource-path';
  const previewLink = document.createElement('a'); previewLink.className = 'resource-preview-link'; previewLink.hidden = true;
  previewLink.target = '_blank'; previewLink.rel = 'noopener noreferrer'; previewLink.setAttribute('aria-label', '在新标签页打开原图');
  previewLink.title = '点击打开原图';
  const image = document.createElement('img'); image.alt = '图片预览'; image.hidden = true; image.decoding = 'async';
  previewLink.append(image);
  const hint = document.createElement('div'); hint.className = 'resource-hint';
  const documentLink = document.createElement('button'); documentLink.type = 'button'; documentLink.className = 'resource-document-link';
  documentLink.textContent = '在本页查看文档'; documentLink.hidden = true;
  tooltip.append(pathText, previewLink, hint, documentLink);
  const menu = document.createElement('div');
  menu.className = 'resource-menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '本地资源操作');
  menu.setAttribute('tabindex', '-1');
  const open = document.createElement('button'); open.type = 'button'; open.textContent = '直接打开文件'; open.setAttribute('role', 'menuitem');
  const reveal = document.createElement('button'); reveal.type = 'button'; reveal.textContent = '在资源管理器中定位'; reveal.setAttribute('role', 'menuitem');
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制完整路径'; copy.setAttribute('role', 'menuitem');
  menu.append(open, reveal, copy); document.body.append(tooltip, menu);
  let hovered = null, hoverTimer = null, hideTimer = null, hoverController = null, generation = 0, menuResource = null, previewResource = null;
  const cache = new Map();
  let openGeneration = 0;
  let htmlDialog = null, htmlFrame = null, htmlTitle = null, htmlController = null;
  function closeHTMLPreview() {
    openGeneration++;
    htmlController?.abort();
    if (htmlDialog?.open) htmlDialog.close();
    htmlFrame?.removeAttribute('srcdoc');
  }
  function showHTMLPreview(data) {
    if (!htmlDialog) {
      htmlDialog = document.createElement('dialog'); htmlDialog.className = 'resource-html-dialog';
      htmlDialog.setAttribute('aria-label', 'HTML 文件预览');
      const heading = document.createElement('div'); heading.className = 'resource-html-heading';
      htmlTitle = document.createElement('strong');
      const close = document.createElement('button'); close.type = 'button'; close.className = 'button';
      close.textContent = '关闭预览'; close.onclick = closeHTMLPreview;
      heading.append(htmlTitle, close);
      htmlFrame = document.createElement('iframe'); htmlFrame.title = 'HTML 文件内容';
      // Scripts can animate the preview, but cannot access parent DOM, storage,
      // editor APIs, popups, forms, downloads or the top-level window.
      htmlFrame.setAttribute('sandbox', 'allow-scripts');
      htmlFrame.setAttribute('referrerpolicy', 'no-referrer');
      htmlDialog.append(heading, htmlFrame); document.body.append(htmlDialog);
      htmlDialog.addEventListener('cancel', () => { openGeneration++; htmlController?.abort(); htmlFrame.removeAttribute('srcdoc'); });
      htmlDialog.addEventListener('close', () => htmlFrame.removeAttribute('srcdoc'));
    }
    htmlTitle.textContent = displayLibraryPath(data.path);
    // Local images have already been permission-checked and embedded. Network
    // requests and editor-origin privileges remain blocked in the sandbox.
    const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'";
    htmlFrame.srcdoc = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + policy + '"><script>(' + htmlPreviewNavigation.toString() + ')();</script>' + data.content;
    if (!htmlDialog.open) htmlDialog.showModal();
  }
  function checkMetadata(data) {
    if (!state.localAdmin && !data.path?.startsWith('@')) throw new Error('资源不存在或不可访问');
    return data;
  }
  function targetResource(target) {
    const element = target instanceof Element ? target.closest('img, a[href]') : null;
    if (!element || !root.contains(element) || !element.closest('.toastui-editor-ww-container .ProseMirror')) return null;
    const reference = element.dataset.resourceReference ?? element.getAttribute(element.tagName === 'IMG' ? 'src' : 'href');
    if (!reference || reference.startsWith('#')) return null;
    try { return { element, reference, path: state.path, ...resourceAddress(reference) }; } catch { return null; }
  }
  async function metadata(resource, signal) {
    const key = String(state.localAdmin) + '\n' + resource.path + '\n' + resource.reference;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.time < 3000) return cached.data;
    const data = await api('/api/resource', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ path: resource.path, reference: resource.reference }),
    });
    checkMetadata(data);
    if (cache.size >= 100) cache.delete(cache.keys().next().value);
    cache.set(key, { time: Date.now(), data });
    return data;
  }
  async function openMarkdown(resource) {
    if (state.merging) return;
    const request = ++openGeneration;
    hideTooltip(); hideMenu();
    try {
      const data = await metadata(resource);
      if (request !== openGeneration || resource.path !== state.path) return;
      checkMetadata(data);
      if (!data.exists || !data.document_path?.startsWith('@')) throw new Error('文档不存在或不可访问');
      await navigate(data.document_path);
    } catch (error) {
      if (request === openGeneration && resource.path === state.path) notice('文档不存在或不可访问，请检查配置目录与读取权限');
    }
  }
  async function openHTML(resource) {
    if (state.merging) return;
    htmlController?.abort(); htmlController = new AbortController();
    const controller = htmlController;
    const request = ++openGeneration;
    hideTooltip(); hideMenu();
    try {
      const data = await api('/api/resource/html', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ path: resource.path, reference: resource.reference }),
      });
      if (request !== openGeneration || resource.path !== state.path) return;
      checkMetadata(data);
      if (!data.path?.startsWith('@') || typeof data.content !== 'string') throw new Error('文件不存在或不可访问');
      data.content = await prepareHTMLPreviewImages(data, resource, controller.signal);
      if (request !== openGeneration || resource.path !== state.path) return;
      showHTMLPreview(data);
    } catch (error) {
      if (request === openGeneration && resource.path === state.path) notice(state.localAdmin ? error.message : 'HTML 文件不存在或不可访问，请检查读取权限');
    }
  }
  // Resolve on the server as well: Windows/file URLs and symlink aliases do
  // not have a reliable browser-derived document path.
  root.addEventListener('click', event => {
    if (event.button !== 0 || event.altKey || event.shiftKey) return;
    const resource = targetResource(event.target);
    if (!resource?.local || resource.element.tagName !== 'A') return;
    let reference = resource.reference;
    try { reference = decodeURIComponent(reference); } catch { /* Keep malformed URLs for normal editor handling. */ }
    if (/\.html?(?:[?#]|$)/i.test(reference)) {
      event.preventDefault(); event.stopImmediatePropagation();
      void openHTML(resource);
      return;
    }
    if (!isMarkdownResourceReference(resource.reference)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void openMarkdown(resource);
  }, true);
  documentLink.onclick = () => {
    if (!previewResource) return;
    if (documentLink.dataset.kind === 'html') void openHTML(previewResource);
    else void openMarkdown(previewResource);
  };
  function position(panel, x, y) {
    panel.style.left = '8px'; panel.style.top = '8px';
    const rect = panel.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(x, innerWidth - rect.width - 8)) + 'px';
    panel.style.top = Math.max(8, Math.min(y, innerHeight - rect.height - 8)) + 'px';
  }
  function hideTooltip() {
    clearTimeout(hoverTimer); clearTimeout(hideTimer); hoverController?.abort(); hoverController = null;
    hovered = null; previewResource = null; generation++; tooltip.hidden = true; image.hidden = true; previewLink.hidden = true;
    documentLink.hidden = true;
    delete documentLink.dataset.kind;
    image.removeAttribute('src'); previewLink.removeAttribute('href');
    pathText.textContent = ''; hint.textContent = '';
  }
  function keepTooltip() { clearTimeout(hideTimer); }
  function leaveTooltip(event) {
    if (tooltip.contains(event.relatedTarget) || hovered?.contains(event.relatedTarget)) return;
    clearTimeout(hoverTimer); clearTimeout(hideTimer);
    // Allow the pointer to cross the gap between the document and preview.
    hideTimer = setTimeout(hideTooltip, 220);
  }
  function hideMenu(restoreFocus = false) {
    const target = menuResource?.element;
    menu.hidden = true; menuResource = null;
    if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true });
  }
  async function showTooltip(resource) {
    if (!menu.hidden) return;
    const current = ++generation;
    previewResource = resource;
    hoverController = new AbortController();
    tooltip.hidden = false; image.hidden = true; previewLink.hidden = true; documentLink.hidden = true;
    pathText.textContent = resource.local ? '正在读取资源信息…' : /^(?:data|blob):/i.test(resource.reference) ? '内嵌图片' : resource.url;
    hint.textContent = resource.local ? state.localAdmin ? '右键可直接打开文件或在资源管理器中定位' : '资源按文档权限访问' : '';
    const place = () => { const rect = resource.element.getBoundingClientRect(); position(tooltip, rect.left, rect.bottom + 8); };
    place();
    try {
      const data = resource.local ? await metadata(resource, hoverController.signal) : null;
      if (current !== generation || resource.path !== state.path) return;
      if (data) {
        checkMetadata(data);
        const markdown = data.document_path || isMarkdownResourceReference(resource.reference);
        pathText.textContent = markdown ? compactResourcePath(data.path) : data.path.startsWith('@') ? displayLibraryPath(data.path) : data.path;
        hint.textContent = data.exists ? data.can_reveal ? '右键可直接打开文件或在资源管理器中定位' : '右键可复制路径' : '文件不存在';
        if (data.document_path?.startsWith('@') || data.html_path?.startsWith('@')) {
          documentLink.hidden = false;
          documentLink.dataset.kind = data.html_path ? 'html' : 'markdown';
          hint.textContent = '点击链接或下方按钮，在本页查看文档';
        }
      }
      if (data?.is_image || (!resource.local && (resource.element.tagName === 'IMG' || /\.(?:png|jpe?g|gif|webp|avif|bmp|ico)(?:[?#]|$)/i.test(resource.url)))) {
        image.onload = () => {
          if (current === generation) {
            image.hidden = false; previewLink.hidden = false;
            hint.textContent = data?.can_reveal ? '点击预览打开原图 · 右键可用默认程序打开或定位' : '点击预览打开原图';
            place();
          }
        };
        image.onerror = () => { if (current === generation) { image.hidden = true; previewLink.hidden = true; hint.textContent = '图片预览加载失败'; place(); } };
        previewLink.href = resource.local ? resourceImageURL(resource.reference, resource.path) : resource.url;
        image.src = previewLink.href;
      }
      place();
    } catch (error) {
      if (current !== generation) return;
      const markdown = resource.local && isMarkdownResourceReference(resource.reference);
      pathText.textContent = resource.local && !state.localAdmin ? '资源不存在或不可访问' : markdown ? compactResourcePath(resource.reference) : resource.reference;
      hint.textContent = markdown ? '文档不存在或不可访问，请检查配置目录与读取权限' : resource.local && !state.localAdmin ? '请联系文档管理员检查引用或读取权限' : error.message; place();
    }
  }
  root.addEventListener('pointerover', event => {
    const resource = targetResource(event.target);
    if (!resource || !menu.hidden) return;
    if (hovered === resource.element) { keepTooltip(); return; }
    hideTooltip(); hovered = resource.element;
    hoverTimer = setTimeout(() => showTooltip(resource), 250);
  });
  root.addEventListener('pointerout', event => {
    if (hovered) leaveTooltip(event);
  });
  root.addEventListener('focusin', event => {
    if (!menu.hidden) return;
    const resource = targetResource(event.target);
    if (resource) { hideTooltip(); hovered = resource.element; void showTooltip(resource); }
  });
  root.addEventListener('focusout', leaveTooltip);
  tooltip.addEventListener('pointerenter', keepTooltip);
  tooltip.addEventListener('pointerleave', leaveTooltip);
  tooltip.addEventListener('focusin', keepTooltip);
  tooltip.addEventListener('focusout', leaveTooltip);
  function showResourceMenu(event) {
    const resource = tooltip.contains(event.target) ? previewResource : targetResource(event.target);
    if (!resource?.local || event.shiftKey) return;
    event.preventDefault(); event.stopPropagation(); hideTooltip();
    menuResource = resource; menu.hidden = false; open.disabled = true; reveal.disabled = true; copy.disabled = true;
    reveal.textContent = '正在读取路径…';
    position(menu, event.clientX, event.clientY);
    // Move keyboard focus out of the editor even while metadata is loading.
    menu.focus({ preventScroll: true });
    void metadata(resource).then(data => {
      if (menuResource !== resource) return;
      checkMetadata(data);
      resource.absolutePath = data.path;
      copy.textContent = data.path.startsWith('@') ? '复制相对路径' : '复制完整路径';
      open.disabled = !data.exists || !data.can_open;
      reveal.disabled = !data.can_reveal; copy.disabled = false;
      reveal.textContent = data.exists ? '在资源管理器中定位' : '文件不存在';
      (!open.disabled ? open : !reveal.disabled ? reveal : copy).focus({ preventScroll: true });
    }).catch(error => {
      if (menuResource === resource) {
        hideMenu(); notice(state.localAdmin ? error.message : '资源不存在或不可访问，请检查读取权限');
      }
    });
  }
  root.addEventListener('contextmenu', showResourceMenu, true);
  tooltip.addEventListener('contextmenu', showResourceMenu);
  open.onclick = async () => {
    const resource = menuResource; if (!resource) return;
    hideMenu(true);
    try {
      await api('/api/resource/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: resource.path, reference: resource.reference }) });
    } catch (error) { notice(error.message); }
  };
  reveal.onclick = async () => {
    const resource = menuResource; if (!resource) return;
    hideMenu(true);
    try {
      await api('/api/resource/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: resource.path, reference: resource.reference }) });
    } catch (error) { notice(error.message); }
  };
  copy.onclick = async () => {
    const path = menuResource?.absolutePath; if (!path) return;
    hideMenu(true);
    try { await navigator.clipboard.writeText(path); } catch { notice('无法复制路径：' + path); }
  };
  menu.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const buttons = [open, reveal, copy].filter(button => !button.disabled);
    const index = buttons.indexOf(document.activeElement);
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
  });
  document.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target)) hideMenu();
    if (!tooltip.contains(event.target) && !hovered?.contains(event.target)) hideTooltip();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { hideTooltip(); hideMenu(true); } else if (event.key === 'Tab') hideMenu(); });
  const hide = () => { hideTooltip(); hideMenu(); };
  // A context menu stays at the chosen viewport position. Editor selection,
  // focus and layout can emit scroll after right-click; these are not a user
  // dismissal. Only transient hover previews follow scrolling.
  document.addEventListener('scroll', event => {
    if (!tooltip.contains(event.target) && !menu.contains(event.target)) hideTooltip();
  }, true);
  window.addEventListener('resize', () => {
    hideTooltip();
    if (menuResource) position(menu, parseFloat(menu.style.left), parseFloat(menu.style.top));
  });
  window.addEventListener('blur', hide);
  // A document switch replaces the editor's content without a page navigation.
  root.addEventListener('resourcehide', () => { closeHTMLPreview(); hide(); });
}
