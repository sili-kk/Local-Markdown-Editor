'use strict';

const $ = id => document.getElementById(id);
const iconPaths = {
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  unlock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2M12 14v3"/>',
  outline: '<path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  'arrow-down': '<path d="M12 4v16m-6-6 6 6 6-6M5 22h14"/>',
  'arrow-up': '<path d="M12 20V4m-6 6 6-6 6 6M5 2h14"/>',
  mountain: '<path d="M2 20 10 5l8 15H2ZM14 12.5 17 8l6 12h-5M7 10.6 10 13l3-2.4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  drive: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 13h18M7 16h.01M11 16h.01"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16M5.8 8h.01M5.8 11h.01"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  refresh: '<path d="M20 10a8 8 0 0 0-14-5L3 8M3 3v5h5M4 14a8 8 0 0 0 14 5l3-3M21 21v-5h-5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  heading: '<path d="M5 5v14M16 5v14M5 12h11M20 15v4"/>',
  bold: '<path stroke-width="2" d="M7 4h6a4 4 0 0 1 0 8H7V4Zm0 8h7a4 4 0 0 1 0 8H7v-8Z"/>',
  italic: '<path d="M10 4h9M5 20h9M15 4 9 20"/>',
  strike: '<path d="M17 6c-1-2-7-3-9 0-1 2 0 4 4 5M6 18c2 3 9 3 11-1M3 12h18"/>',
  hrline: '<path d="M4 12h16"/><path d="M4 6h5M15 18h5" opacity=".45"/>',
  quote: '<path d="M5 7h5v6H5V7Zm9 0h5v6h-5V7ZM10 13c0 3-2 5-5 5M19 13c0 3-2 5-5 5"/>',
  'bullet-list': '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  'ordered-list': '<path d="M10 6h10M10 12h10M10 18h10M4 4h1v5M3 9h4M3 15c0-2 4-2 4 0 0 1-4 3-4 4h4"/>',
  'task-list': '<rect x="3" y="4" width="7" height="7" rx="1.5"/><path d="m4.5 7.5 1.5 1.5 2.5-3M14 7h7M14 17h7"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  indent: '<path d="M4 5h16M11 10h9M11 15h9M4 20h16M3 10l4 3-4 3"/>',
  outdent: '<path d="M4 5h16M11 10h9M11 15h9M4 20h16M7 10l-4 3 4 3"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 9v11M15 9v11"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L4 21"/>',
  link: '<path d="m10 13 4-4M9 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M15 8l2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(0 0) scale(.95)"/>',
  code: '<path d="m7 7-5 5 5 5M17 7l5 5-5 5M14 4l-4 16"/>',
  codeblock: '<rect x="2" y="3" width="20" height="18" rx="2.5"/><path d="M2 8h20M6 5.5h.01M9 5.5h.01m-1 6-3 3 3 3m8-6 3 3-3 3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
};
function iconMarkup(name) {
  return '<svg xmlns="http://www.w3.org/2000/svg" class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (iconPaths[name] || iconPaths.file) + '</svg>';
}
function icon(name) {
  const wrapper = document.createElement('span');
  wrapper.innerHTML = iconMarkup(name);
  return wrapper.firstElementChild;
}
const state = {
  path: '', revision: '', saved: '', lineEnding: '\n', trailingNewline: false,
  limits: null,
  localAdmin: false, fileAccess: {}, readOnly: false, revokedDraft: null,
  documentsClosed: readBrowsingPaths('mojian.closedView').includes('closed'),
  fileOperations: false, folders: [], deletedDocument: '', unavailablePath: '',
  files: [], directories: [], libraryWarning: '', saving: null, navigating: false, loading: false, conflict: false, merging: false,
  composing: false, saveTimer: null, editor: null, imageViews: new Set(), expandedFolders: new Set(readBrowsingPaths('mojian.expandedFolders')),
  pendingNavigation: null, navigationTask: null, navigationTarget: '',
};
const content = () => state.editor ? state.editor.getMarkdown() : '';
const dirty = () => !!state.path && content() !== state.saved;
const searchState = { query: '', matches: new Set(), timer: null, controller: null, request: 0, pending: false, error: '' };

function searchDocuments(immediate = false) {
  clearTimeout(searchState.timer);
  searchState.controller?.abort();
  const query = $('search').value.trim();
  const request = ++searchState.request;
  if (query !== searchState.query) searchState.matches.clear();
  searchState.query = query;
  searchState.error = '';
  searchState.pending = !!query;
  drawFiles();
  if (!query) return;
  searchState.timer = setTimeout(async () => {
    const controller = new AbortController();
    searchState.controller = controller;
    try {
      const data = await api('/api/search?q=' + encodeURIComponent(query), { signal: controller.signal });
      if (request !== searchState.request) return;
      searchState.matches = new Set(data.files);
      if (data.warnings?.length) searchState.error = '部分文档无法检索';
    } catch (error) {
      if (request !== searchState.request) return;
      searchState.error = '正文检索失败：' + error.message;
    } finally {
      if (request === searchState.request) {
        searchState.pending = false;
        searchState.controller = null;
        drawFiles();
      }
    }
  }, immediate ? 0 : 200);
}

let editorZoom = 100;
let editorLayoutFrame = null;
function fitEditorToViewport() {
  const viewport = $('document'), editor = $('editor');
  const scale = editorZoom / 100;
  // 用未缩放容器的实际像素尺寸计算，避免百分比宽度受 zoom 影响而重复放大。
  editor.style.width = viewport.clientWidth / scale + 'px';
  editor.style.height = viewport.clientHeight / scale + 'px';
  scheduleScrollNavigation();
}
function scheduleEditorLayout() {
  if (editorLayoutFrame !== null) return;
  editorLayoutFrame = requestAnimationFrame(() => {
    editorLayoutFrame = null;
    fitEditorToViewport();
    // TOAST UI 会根据当前可用宽度折叠工具栏。
    window.dispatchEvent(new Event('resize'));
  });
}
function setEditorZoom(value) {
  const number = Number(value);
  editorZoom = Number.isFinite(number) ? Math.min(150, Math.max(50, Math.round(number / 10) * 10)) : 100;
  $('document').style.setProperty('--editor-zoom', String(editorZoom / 100));
  fitEditorToViewport();
  $('zoomReset').textContent = editorZoom + '%';
  $('zoomReset').setAttribute('aria-label', '当前缩放 ' + editorZoom + '%，点击恢复原始大小');
  $('zoomOut').disabled = editorZoom <= 50;
  $('zoomIn').disabled = editorZoom >= 150;
  try { localStorage.setItem('mojian.editorZoom', String(editorZoom)); } catch {}
  // 工具栏根据缩放后的实际可用宽度重新排列。
  window.dispatchEvent(new Event('resize'));
}

function status(text, error = false) {
  $('status').textContent = text;
  $('status').dataset.state = error ? 'error' : /等待|正在|待保存/.test(text) ? 'pending' : 'saved';
}
function notice(text = '') {
  $('notice').textContent = text;
  $('notice').style.display = text ? 'block' : 'none';
}
function count() {
  const text = state.editor ? $('editor').querySelector('.toastui-editor-ww-container .ProseMirror')?.textContent || '' : '';
  let characters = 0;
  for (const character of text) characters++;
  $('charCount').textContent = characters.toLocaleString() + ' 字符 · UTF-8';
  scheduleScrollNavigation();
}
async function api(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const response = await fetch(url, { cache: 'no-store', ...options, signal });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || '请求失败（' + response.status + '）');
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('请求超时，请稍后重新读取确认结果。');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function drawFiles(revealHistory = true) {
  if (deferWorkspaceSortRender()) return;
  const list = $('fileList');
  const scrollTop = list.scrollTop;
  list.replaceChildren();
  const query = $('search').value.trim().toLowerCase();
  const files = state.files.filter(path => {
    if (!query) return true;
    return displayLibraryPath(path, true).toLowerCase().includes(query) || searchState.matches.has(path);
  });
  $('fileCount').textContent = state.files.length;
  const searchStatus = $('searchStatus');
  searchStatus.hidden = !query;
  searchStatus.textContent = searchState.pending ? '正在检索正文…' : searchState.error || '找到 ' + files.length + ' 篇文档';
  searchStatus.title = searchState.error;
  list.setAttribute('aria-busy', String(searchState.pending));
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = searchState.pending ? '正在查找匹配的文档…' : searchState.error ? '可继续按文件名搜索' : state.files.length ? '没有匹配的文档' : '目录中暂无 Markdown 文件';
    list.append(empty);
  }
  const visibleFiles = new Set(files);
  const root = { path: '', folders: new Map(), files: [], count: files.length };
  for (const directory of state.directories) {
    root.folders.set(directory.id, { path: directory.id, label: directoryLabel(directory), title: directoryLabel(directory), folders: new Map(), files: [], count: 0 });
  }
  for (const path of state.files) {
    const parts = path.split('/');
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i], folderPath = parts.slice(0, i + 1).join('/');
      if (!parent.folders.has(name)) parent.folders.set(name, { path: folderPath, folders: new Map(), files: [], count: 0 });
      parent = parent.folders.get(name);
      if (visibleFiles.has(path)) parent.count++;
    }
    parent.files.push(path);
  }
  if (state.fileOperations) {
    for (const path of state.folders) {
      let parent = root;
      const parts = path.split('/');
      parts.forEach((name, index) => {
        if (!parent.folders.has(name)) parent.folders.set(name, { path: parts.slice(0, index + 1).join('/'), folders: new Map(), files: [], count: 0 });
        parent = parent.folders.get(name);
      });
    }
  }
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  function fileButton(path) {
    const button = document.createElement('button');
    button.className = 'file' + (path === state.path ? ' active' : '');
    button.title = displayLibraryPath(path, true);
    button.dataset.path = path;
    button.dataset.libraryKind = 'file';
    if (state.localAdmin) { button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-controls', 'libraryContextMenu'); }
    button.setAttribute('aria-current', path === state.path ? 'page' : 'false');
    const name = document.createElement('span');
    name.className = 'file-name';
    const basename = path.split('/').pop();
    name.textContent = basename.replace(/\.(md|markdown)$/i, '') || basename;
    const type = document.createElement('span');
    type.className = 'file-type';
    type.textContent = 'MD';
    if (query && searchState.matches.has(path) && !displayLibraryPath(path, true).toLowerCase().includes(query)) {
      type.textContent = '正文';
      type.classList.add('content-match');
    }
    type.setAttribute('aria-hidden', 'true');
    button.append(icon('file'), name, type);
    button.onclick = () => navigate(path);
    markWorkspaceSortItem(button, button, path);
    return button;
  }
  function drawTree(parent, container) {
    const scope = 'menu:' + parent.path;
    const entries = orderedWorkspaceEntries(scope, [
      ...[...parent.folders].sort((a, b) => collator.compare(a[1].label || a[0], b[1].label || b[0]))
        .map(([name, folder]) => ({ key: folder.path, name, folder })),
      ...[...parent.files].sort(collator.compare).map(path => ({ key: path }))
    ]);
    for (const { key, name, folder } of entries) {
      if (!folder) {
        if (visibleFiles.has(key)) container.append(fileButton(key));
        continue;
      }
      if (query && !folder.count) continue;
      const details = document.createElement('details');
      details.className = 'folder';
      details.dataset.path = folder.path;
      details.open = !!query || state.expandedFolders.has(folder.path);
      const summary = document.createElement('summary');
      summary.dataset.path = folder.path;
      const configuredRoot = state.directories.find(item => item.id === folder.path);
      summary.dataset.libraryKind = configuredRoot?.is_file ? 'file-root' : 'directory';
      if (state.localAdmin) { summary.setAttribute('aria-haspopup', 'menu'); summary.setAttribute('aria-controls', 'libraryContextMenu'); }
      summary.title = folder.title || displayLibraryPath(folder.path, true);
      const chevron = icon('chevron'); chevron.classList.add('chevron');
      const label = document.createElement('span'); label.className = 'folder-name'; label.textContent = folder.label || name;
      const count = document.createElement('span'); count.className = 'folder-count'; count.textContent = folder.count;
      summary.append(chevron, icon('folder'), label, count);
      summary.onclick = event => {
        event.preventDefault();
        details.open = !details.open;
        if (details.open) state.expandedFolders.add(folder.path);
        else state.expandedFolders.delete(folder.path);
        writeBrowsingPaths('mojian.expandedFolders', [...state.expandedFolders]);
      };
      const children = document.createElement('div'); children.className = 'folder-children';
      let rendered = false;
      const renderChildren = () => {
        if (!details.open || rendered) return;
        rendered = true;
        drawTree(folder, children);
      };
      details.addEventListener('toggle', renderChildren);
      renderChildren();
      details.append(summary, children); container.append(details);
      markWorkspaceSortItem(details, summary, folder.path);
    }
    bindWorkspaceSort(container, { axis: 'y', scope, save: order => {
      writeBrowsingPaths(workspaceOrderKey(scope), mergeWorkspaceOrder(entries.map(entry => entry.key), order));
    } });
  }
  drawTree(root, list);
  list.scrollTop = scrollTop;
  updateFileHighlights();
  renderDocumentHistory(revealHistory);
  syncFileOperationButtons();
}

function updateFileHighlights() {
  const pending = state.pendingNavigation?.path || state.navigationTarget;
  $('fileList').querySelectorAll('.file').forEach(button => {
    const active = button.dataset.path === state.path;
    button.classList.toggle('active', active);
    button.classList.toggle('pending', !!pending && button.dataset.path === pending && !active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let scrollNavigationFrame = null;
function scheduleScrollNavigation() {
  if (scrollNavigationFrame !== null) return;
  scrollNavigationFrame = requestAnimationFrame(() => {
    scrollNavigationFrame = null;
    updateScrollNavigation();
  });
}

function updateScrollNavigation() {
  const viewport = $('editor').querySelector('.toastui-editor-ww-container > .toastui-editor');
  const maxScroll = viewport ? Math.max(0, viewport.scrollHeight - viewport.clientHeight) : 0;
  const available = !!state.path && !$('editor').hidden && maxScroll > 1;
  // 缩放后的滚动位置可能包含小数，边界保留一个像素的容差。
  const atTop = !viewport || viewport.scrollTop <= 1;
  const atBottom = !viewport || viewport.scrollTop >= maxScroll - 1;
  const busy = state.navigating || state.merging || $('document').inert;
  $('editor').editorSearch?.setAvailable(!!state.path && !$('editor').hidden && !busy);
  $('toggleOutline').disabled = !state.path || $('editor').hidden || busy;
  updateDocumentOutlinePosition();
  for (const id of ['scrollNavigationTop', 'scrollNavigationBottom']) {
    const group = $(id);
    group.querySelectorAll('[data-scroll-to]').forEach(button => {
      button.disabled = !available || busy || (button.dataset.scrollTo === 'top' ? atTop : atBottom);
    });
  }
}

function scrollDocument(toBottom) {
  if (!state.path || state.navigating || state.merging || $('editor').hidden) return;
  const viewport = $('editor').querySelector('.toastui-editor-ww-container > .toastui-editor');
  if (!viewport) return;
  viewport.scrollTo({
    top: toBottom ? Math.max(0, viewport.scrollHeight - viewport.clientHeight) : 0,
    behavior: reducedMotion.matches ? 'instant' : 'smooth',
  });
}

function animateDocument(phase) {
  const target = $('editor').querySelector('.toastui-editor-ww-container > .toastui-editor');
  if (!target || reducedMotion.matches || document.hidden) {
    delete $('app').dataset.documentTransition;
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      target.removeEventListener('animationend', onEnd);
      target.removeEventListener('animationcancel', onEnd);
      if (phase === 'in') delete $('app').dataset.documentTransition;
      resolve();
    };
    const onEnd = event => {
      const expected = phase === 'out' ? 'document-exit' : 'document-enter';
      if (event.target === target && event.animationName === expected) finish();
    };
    // 后台标签页或动画事件缺失时也能完成切换。
    const timer = setTimeout(finish, phase === 'out' ? 180 : 280);
    target.addEventListener('animationend', onEnd);
    target.addEventListener('animationcancel', onEnd);
    $('app').dataset.documentTransition = phase;
  });
}

function decorateToolbar() {
  $('editor').querySelectorAll('.toastui-editor-toolbar-icons').forEach(button => {
    if (button.dataset.iconReady) return;
    const name = Object.keys(iconPaths).find(key => button.classList.contains(key));
    if (!name) return;
    // CSS 蒙版保留按钮原有的事件目标和快捷键行为。
    const svg = iconMarkup(name).replace('stroke="currentColor"', 'stroke="black"');
    button.style.setProperty('--toolbar-icon', 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")');
    button.dataset.iconReady = 'true';
  });
}

const mobileSidebar = window.matchMedia('(max-width: 900px)');
let desktopSidebarCollapsed = false;
try { desktopSidebarCollapsed = localStorage.getItem('mojian.sidebarCollapsed') === 'true'; } catch {}
function setSidebar(open) {
  if (mobileSidebar.matches) $('app').classList.toggle('sidebar-open', open);
  else {
    $('app').classList.toggle('sidebar-collapsed', !open);
    desktopSidebarCollapsed = !open;
    try { localStorage.setItem('mojian.sidebarCollapsed', String(!open)); } catch {}
  }
  $('sidebar').inert = !open;
  $('toggleSidebar').setAttribute('aria-expanded', String(open));
  syncSidebarResizer();
}
function sidebarOpen() { return $('toggleSidebar').getAttribute('aria-expanded') === 'true'; }
function showDocumentPath(path) {
  const parts = displayLibraryPath(path).split('/'), name = parts.pop();
  $('currentFolder').textContent = parts.join(' / ') || '文档库';
  document.title = '屿墨笺 · ' + (name.replace(/\.(md|markdown)$/i, '') || name);
}

function assetURL(value) {
  return resourceAddress(value).url;
}

// 只转换图片的显示地址，不改变文档模型中的原始相对路径。
function localImagesPlugin() {
  return {
    wysiwygNodeViews: {
      image(node) {
        const img = document.createElement('img');
        img.loading = 'lazy'; img.decoding = 'async';
        let current = node;
        const update = next => {
          if (next.type.name !== 'image') return false;
          current = next;
          img.dataset.resourceReference = next.attrs.imageUrl;
          img.src = assetURL(next.attrs.imageUrl);
          img.alt = next.attrs.altText || '';
          return true;
        };
        update(node);
        const refresh = () => update(current);
        state.imageViews.add(refresh);
        return { dom: img, update, ignoreMutation: () => true, destroy: () => state.imageViews.delete(refresh) };
      },
    },
  };
}

function onChange() {
  if (state.loading || !state.path || state.readOnly) return;
  clearTimeout(state.saveTimer);
  count();
  const resumed = Date.now() - externalChanges.lastEdit >= idleCheckDelay;
  externalChanges.lastEdit = Date.now();
  if (externalChanges.changed) { showExternalChangeDialog(); return; }
  if (state.conflict) return;
  if (resumed) void checkExternalChanges();
  status(dirty() ? '等待自动保存…' : '已保存到本地');
  if (!state.composing) state.saveTimer = setTimeout(save, 800);
}

function createEditor() {
  if (state.editor) return;
  state.editor = new toastui.Editor({
    el: $('editor'), height: '100%', minHeight: '200px',
    initialEditType: 'wysiwyg', hideModeSwitch: true, autofocus: false,
    language: 'zh-CN', usageStatistics: false, frontMatter: true,
    placeholder: '开始书写，或输入 # 空格、- 空格、**粗体** 自动转换格式…',
    linkAttributes: { target: '_blank', rel: 'noopener noreferrer' },
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'], ['hr', 'quote'],
      ['ul', 'ol', 'task', 'indent', 'outdent'], ['table', 'image', 'link'], ['code', 'codeblock'],
    ],
    plugins: [...tableEditorPlugins(), markdownShortcutsPlugin, editorEndClickPlugin, editorLineNumbersPlugin, editorSearchPlugin, localImagesPlugin, localMarkdownLinksPlugin],
  });
  state.editor.on('change', onChange);
  // 独立于格式按钮的折叠菜单，始终固定在编辑工具栏最右侧。
  $('editor').querySelector('.toastui-editor-toolbar').appendChild($('scrollNavigationTop'));
  $('scrollNavigationTop').hidden = false;
  $('editor').querySelector('.toastui-editor-toolbar').appendChild($('toggleOutline'));
  $('toggleOutline').hidden = false;
  installEditorSearch($('editor'));
  decorateToolbar();
  const toolbar = $('editor').querySelector('.toastui-editor-defaultUI-toolbar');
  new MutationObserver(decorateToolbar).observe(toolbar, { childList: true, subtree: true });
  const root = $('editor');
  installResourceInteractions(root);
  installDocumentOutline(root);
  const scrollViewport = root.querySelector('.toastui-editor-ww-container > .toastui-editor');
  scrollViewport.addEventListener('scroll', scheduleScrollNavigation, { passive: true });
  // 图片加载、正文增删和缩放都可能改变文章是否能滚动。
  root.addEventListener('load', scheduleScrollNavigation, true);
  if (typeof ResizeObserver === 'function') {
    const scrollObserver = new ResizeObserver(scheduleScrollNavigation);
    scrollObserver.observe(scrollViewport);
    scrollObserver.observe(root.querySelector('.toastui-editor-ww-container .ProseMirror'));
  }
  root.querySelector('.toastui-editor-ww-container .ProseMirror').setAttribute('aria-label', '文档正文，直接编辑');
  root.addEventListener('compositionstart', () => {
    state.composing = true;
    clearTimeout(state.saveTimer);
  });
  root.addEventListener('compositionend', () => { state.composing = false; onChange(); });
  root.addEventListener('click', event => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const link = event.target.closest('a[href]');
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    const address = resourceAddress(href);
    const url = address.target || new URL(address.url, location.origin);
    if (address.local && !address.target) return;
    if (url.origin === location.origin && url.pathname.startsWith('/assets/') && /\.m(?:d|arkdown)$/i.test(url.pathname)) {
      navigate(decodeURIComponent(url.pathname.slice('/assets/'.length)));
    } else if (['http:', 'https:', 'mailto:'].includes(url.protocol)) {
      window.open(url.href, '_blank', 'noopener,noreferrer');
    }
  }, true);
}

async function save() {
  clearTimeout(state.saveTimer);
  if (state.readOnly) { if (dirty()) notice('当前文档为只读，不能保存。'); return !dirty(); }
  if (state.saving) return state.saving;
  if (!dirty()) return true;
  if (state.composing) return false;
  const path = state.path;
  status('正在保存…');
  const task = (async () => {
    try {
      if (!await checkExternalChanges(true)) return false;
      if (state.composing) return false;
      let merged = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const markdown = content(), revision = state.revision;
        let diskContent = markdown.replace(/\r+\n|\r/g, '\n');
        if (state.trailingNewline && !diskContent.endsWith('\n')) diskContent += '\n';
        diskContent = diskContent.replace(/\n/g, state.lineEnding);
        try {
          const data = await api('/api/file', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, content: diskContent, revision }),
          });
          if (state.path !== path) return false;
          state.revision = data.revision;
          state.saved = markdown;
          state.conflict = false;
          notice(merged ? '已合并网页和本地文件的修改，并保存到本地。' : '');
          status(dirty() ? '有修改待保存' : '已保存到本地 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
          return true;
        } catch (error) {
          if (state.path !== path) return false;
          if (error.status !== 409) throw error;
          state.conflict = true;
          if (attempt === 3) throw new Error('本地文件持续变动，请稍后点击保存重试合并');
          // 不打断正文输入法尚未提交的文字；提交后再锁定并取最新正文。
          if (state.composing) {
            await new Promise(resolve => $('editor').addEventListener('compositionend', resolve, { once: true }));
          }
          // 冲突响应前仍可输入；此刻锁定编辑，并将这些新输入一并纳入合并。
          state.merging = true;
          setBusy(true);
          clearTimeout(state.saveTimer);
          status('正在合并本地修改…');
          const latest = await api('/api/file?path=' + encodeURIComponent(path));
          if (state.path !== path) return false;
          if (latest.limits) state.limits = latest.limits;
          const disk = normalizeMarkdown(latest.content);
          const result = await chooseMerge(mergeRegions(state.saved, content(), disk));
          if (state.path !== path) return false;
          if (result === null) {
            notice('合并已取消，网页草稿仍保留。点击“保存”可再次合并；重新加载会丢弃未保存内容。');
            status('草稿已保留，等待合并', true);
            return false;
          }
          assertDocumentMemory(result);
          state.loading = true;
          try { state.editor.setMarkdown(result, false); } finally { state.loading = false; }
          state.saved = disk;
          state.revision = latest.revision;
          state.lineEnding = latest.content.includes('\r\n') ? '\r\n' : '\n';
          state.trailingNewline = latest.content.endsWith('\n');
          count();
          merged = true;
          // 下一次 PUT 使用最新版本号；再次有外部修改时继续合并，绝不强制覆盖。
        }
      }
      return false;
    } catch (error) {
      if (state.path !== path) return false;
      notice(error.message + '（正文中的修改仍保留）');
      status(state.conflict ? '文件冲突，尚未保存' : '保存失败，请重试', true);
      return false;
    } finally {
      if (state.merging) {
        state.merging = false;
        setBusy(state.navigating);
      }
    }
  })();
  state.saving = task;
  const success = await task;
  state.saving = null;
  if (success && dirty() && !state.composing) state.saveTimer = setTimeout(save, 800);
  return success;
}

async function flush() {
  if (state.saving && !await state.saving) return false;
  while (dirty()) { if (!await save()) return false; }
  return true;
}

function setBusy(busy) {
  if (busy) setDocumentOutlineOpen(false);
  $('document').classList.toggle('busy', busy);
  $('document').inert = busy;
  $('document').setAttribute('aria-busy', String(busy));
  $('editor').editorSearch?.setAvailable(!busy && !!state.path && !$('editor').hidden);
  $('toggleOutline').disabled = busy || !state.path || $('editor').hidden;
  $('save').disabled = busy || state.readOnly || !state.path;
  $('reload').disabled = busy;
  $('managePaths').disabled = busy || !state.localAdmin;
  syncFileOperationButtons();
  scheduleScrollNavigation();
}

function navigate(path, refresh = false, { closing = false } = {}) {
  if (state.merging) return Promise.resolve(false);
  if (!refresh && !state.navigating && path === state.path) return Promise.resolve(true);
  // 连续点击只保留最新目标；读取中的旧结果不会覆盖之后的选择。
  state.pendingNavigation = { path, refresh, closing };
  updateFileHighlights();
  if (state.navigating) return state.navigationTask;
  state.navigating = true;
  state.navigationTask = (async () => {
    try {
      while (state.pendingNavigation) {
        const request = state.pendingNavigation;
        state.pendingNavigation = null;
        if (!request.refresh && request.path === state.path) continue;
        state.navigationTarget = request.path;
        updateFileHighlights();
        if (!await switchDocument(request.path, request.refresh, { closing: request.closing })) {
          state.pendingNavigation = null;
          return false;
        }
      }
      return true;
    } finally {
      state.navigating = false;
      state.navigationTarget = '';
      state.navigationTask = null;
      delete $('app').dataset.documentTransition;
      setBusy(false);
      updateFileHighlights();
    }
  })();
  return state.navigationTask;
}

async function switchDocument(path, refresh, { closing = false } = {}) {
  $('editor').dispatchEvent(new Event('resourcehide'));
  const previousPath = state.path;
  try {
    if (state.saving && !await state.saving) return false;
    if (refresh && dirty()) {
      if (!confirm('重新加载会丢弃尚未保存的修改。是否继续？')) return false;
    } else if (!refresh && !await flush()) return false;
    if (state.pendingNavigation) return true;
    clearTimeout(state.saveTimer);
    setBusy(true);
    status('正在读取本地文件…');
    if (state.saving) await state.saving;
    clearTimeout(state.saveTimer);
    if (refresh) {
      const data = await api('/api/files');
      applyLibraryData(data);
      drawFiles();
      if (path && !path.startsWith('@') && state.directories.length) {
        const migrated = state.directories[0].id + '/' + path;
        if (state.files.includes(migrated)) path = migrated;
      }
      if (!state.files.includes(path) && (path || !state.documentsClosed)) path = readBrowsingPaths('mojian.lastDocument').find(item => state.files.includes(item)) || [...recentDocuments].reverse().find(item => state.files.includes(item)) || state.files[0] || '';
    }
    if (state.pendingNavigation) return true;
    if (!path) {
      if (state.path && !closing) await animateDocument('out');
      state.path = ''; state.saved = ''; state.revision = ''; state.conflict = false;
      state.loading = true;
      $('editor').editorSearch?.reset();
      state.editor?.setMarkdown('', false);
      state.documentsClosed = state.files.length > 0;
      writeBrowsingPaths('mojian.closedView', state.documentsClosed ? ['closed'] : []);
      writeBrowsingPaths('mojian.lastDocument', []);
      resetExternalChanges();
      $('editor').hidden = true; $('empty').hidden = false;
      $('empty').textContent = state.documentsClosed ? '文档已关闭，请从左侧选择文档打开。' : '目录中没有 .md 或 .markdown 文件，请添加文件后重新加载。';
      $('currentPath').textContent = '选择一篇文档';
      $('currentPath').removeAttribute('title');
      $('currentFolder').textContent = '文档库';
      document.title = '屿墨笺 · 本地 Markdown';
      $('charCount').textContent = '0 字符 · UTF-8';
      syncDocumentViewers();
      setDocumentOutlineOpen(false);
      history.replaceState(null, '', location.pathname);
      notice(state.libraryWarning); status(state.documentsClosed ? '文档已关闭' : '目录为空');
      if (closing) updateFileHighlights(); else drawFiles();
      return true;
    }
    const deletionGeneration = documentEventGeneration;
    const data = await api('/api/file?path=' + encodeURIComponent(path));
    if (documentEventGeneration !== deletionGeneration && state.deletedDocument === path) return false;
    if (state.pendingNavigation) return true;
    if (data.limits) state.limits = data.limits;
    // Complete admission checks and table conversion before replacing the
    // current document, so a rejected file leaves its editor and draft intact.
    const prepared = prepareDocumentMarkdown(data.content);
    // 请求完成后再淡出，慢请求期间保留当前文档，避免白屏。
    if (state.path && !closing) await animateDocument('out');
    if (documentEventGeneration !== deletionGeneration && state.deletedDocument === path) return false;
    state.loading = true;
    createEditor();
    if (data.path !== previousPath) $('editor').editorSearch?.reset();
    state.path = data.path;
    state.deletedDocument = ''; state.unavailablePath = '';
    $('editor').hidden = false; $('empty').hidden = true;
    state.editor.setMarkdown(prepared, false);
    state.editor.setScrollTop(0);
    $('editor').querySelector('.toastui-editor-ww-container > .toastui-editor').scrollTop = 0;
    state.imageViews.forEach(refresh => refresh());
    // 使用编辑器规范化后的 Markdown 作基线：只阅读时不改写原文件。
    state.saved = content();
    applyDocumentAccess(data.access || (state.localAdmin ? 'rw' : state.fileAccess[data.path] || 'r'));
    if (!state.readOnly && state.revokedDraft?.path === data.path) {
      const draft = state.revokedDraft;
      if (confirm('访问权限已恢复，是否恢复本页面之前未保存的草稿？恢复后可点击“保存”，文件变化时会进行合并。')) {
        state.editor.setMarkdown(draft.content, false);
        state.saved = draft.saved; data.revision = draft.revision;
      }
      state.revokedDraft = null;
    }
    state.revision = data.revision;
    state.lineEnding = data.content.includes('\r\n') ? '\r\n' : '\n';
    state.trailingNewline = data.content.endsWith('\n');
    state.conflict = false;
    resetExternalChanges();
    showDocumentPath(data.path);
    rememberDocument(data.path);
    syncDocumentViewers();
    history.replaceState(null, '', location.pathname + '?file=' + encodeURIComponent(data.path));
    // Closing a tab changes the active document, not the library. The caller
    // removes the closed tab after success; keep the surrounding UI in place.
    if (closing) updateFileHighlights(); else drawFiles();
    count(); notice(state.libraryWarning); status(state.readOnly ? '只读文档 · 可查看和复制' : '已加载 · 点击正文即可编辑');
    if (mobileSidebar.matches) setSidebar(false);
    if (!closing) await animateDocument('in');
    return true;
  } catch (error) {
    if (state.pendingNavigation && state.path === previousPath) return true;
    state.path = previousPath === state.deletedDocument || previousPath === state.unavailablePath ? '' : previousPath;
    notice(error.message); status('加载失败', true);
    if ($('app').dataset.documentTransition) await animateDocument('in');
    return false;
  } finally {
    state.loading = false;
  }
}

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    setSidebar(true); $('search').focus(); $('search').select();
  }
  if (event.key === 'Escape' && mobileSidebar.matches && sidebarOpen()) {
    setSidebar(false); $('toggleSidebar').focus();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (!state.navigating) save();
  }
}, true);
window.addEventListener('beforeunload', event => {
  if (dirty()) { event.preventDefault(); event.returnValue = ''; }
});
$('search').oninput = () => searchDocuments();
$('save').onclick = () => save();
$('toggleOutline').onclick = () => setDocumentOutlineOpen($('documentOutline').hidden);
$('closeOutline').onclick = () => setDocumentOutlineOpen(false, true);
document.querySelectorAll('[data-scroll-to]').forEach(button => {
  button.onclick = () => scrollDocument(button.dataset.scrollTo === 'bottom');
});
$('reload').onclick = () => navigate(state.path, true);
$('zoomOut').onclick = () => setEditorZoom(editorZoom - 10);
$('zoomIn').onclick = () => setEditorZoom(editorZoom + 10);
$('zoomReset').onclick = () => setEditorZoom(100);
let storedZoom = 100;
try { storedZoom = localStorage.getItem('mojian.editorZoom') ?? 100; } catch {}
setEditorZoom(storedZoom);
if (typeof ResizeObserver === 'function') {
  const editorViewportObserver = new ResizeObserver(scheduleEditorLayout);
  editorViewportObserver.observe($('document'));
} else {
  window.addEventListener('resize', fitEditorToViewport);
}
document.querySelectorAll('[data-icon]').forEach(placeholder => placeholder.replaceWith(icon(placeholder.dataset.icon)));
const apple = /Mac|iPhone|iPad/.test(navigator.platform);
document.querySelector('.search-key').textContent = apple ? '⌘ K' : 'Ctrl K';
document.querySelector('.save-shortcut').textContent = apple ? '⌘ S' : 'Ctrl S';
$('toggleSidebar').onclick = () => setSidebar(!sidebarOpen());
$('sidebarScrim').onclick = () => { setSidebar(false); $('toggleSidebar').focus(); };
mobileSidebar.addEventListener('change', () => setSidebar(mobileSidebar.matches ? false : !desktopSidebarCollapsed));
setSidebar(mobileSidebar.matches ? false : !desktopSidebarCollapsed);
navigate(new URLSearchParams(location.search).get('file') || '', true);

