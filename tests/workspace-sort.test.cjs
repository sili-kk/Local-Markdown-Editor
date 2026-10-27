const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Event/DOM simulation, including the real tree/history renderers. This is not
// a substitute for browser layout, touch hardware or visual performance checks.
function fixture(stored = {}) {
  const storage = new Map(Object.entries(stored)), frames = new Map(), listeners = new Map(), nodes = new Map();
  let frameId = 0, hit = null, redraws = 0, pointerX = 15, pointerY = 15;
  const animations = [];
  function listen(map, type, handler) { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(handler); }
  const dataKey = name => name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attrs = {}; this.handlers = new Map();
      this.className = ''; this.style = {}; this.scrollLeft = 0; this.scrollTop = 0; this.scrollWidth = 600; this.clientWidth = 400; this.value = ''; this.title = '';
      this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); } };
    }
    get isConnected() { return this === document.body || !!this.parentElement?.isConnected; }
    get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
    append(...items) { for (const item of items) { if (item.tagName === 'FRAGMENT') { this.append(...[...item.children]); continue; } item.remove(); item.parentElement = this; this.children.push(item); } }
    prepend(item) { this.insertBefore(item, this.children[0] || null); }
    insertBefore(item, reference) { if (item === reference) return; item.remove(); const index = reference ? this.children.indexOf(reference) : this.children.length; assert.ok(index >= 0); this.children.splice(index, 0, item); item.parentElement = this; }
    replaceChildren(...items) { for (const child of [...this.children]) child.remove(); this.append(...items); }
    remove() {
      if (this.parentElement) {
        // Browsers can release capture when a captured node (or an ancestor)
        // is detached by insertBefore. The original implementation missed this.
        for (const node of [this, ...this.querySelectorAll('*')]) if (node.pointer !== undefined && node.pointer !== null) {
          const pointerId = node.pointer; node.pointer = null;
          queueMicrotask(() => dispatch('window', 'lostpointercapture', { target: node, pointerId }));
        }
        this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      }
      this.parentElement = null;
    }
    setAttribute(key, value) { if (key === 'id') this.id = value; else this.attrs[key] = String(value); }
    removeAttribute(key) { if (key === 'id') delete this.id; else delete this.attrs[key]; }
    matches(selector) {
      return selector.split(',').some(raw => {
        const part = raw.trim();
        if (part.startsWith('#')) return this.id === part.slice(1);
        if (part.startsWith('.')) return this.className.split(' ').includes(part.slice(1));
        const data = part.match(/^\[data-([^\]]+)\]$/); if (data) return this.dataset[dataKey(data[1])] !== undefined;
        if (part === '[id]') return !!this.id;
        if (part === '[aria-current="page"]') return this.attrs['aria-current'] === 'page';
        return this.tagName === part.toUpperCase();
      });
    }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => selector === '*' || child.matches(selector)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, handler) { listen(this.handlers, type, handler); }
    setPointerCapture(id) { this.pointer = id; }
    hasPointerCapture(id) { return this.pointer === id; }
    releasePointerCapture() { this.pointer = null; }
    focus() { document.focused = this; }
    animate(keyframes, options) { animations.push({ node: this, keyframes, options }); return { cancel() {} }; }
    cloneNode(deep) { const copy = new Element(this.tagName); copy.dataset = { ...this.dataset }; copy.id = this.id; copy.className = this.className; if (deep) copy.append(...this.children.map(child => child.cloneNode(true))); return copy; }
    getBoundingClientRect() {
      if (this.rect) return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height };
      const parent = this.parentElement?.getBoundingClientRect() || { left: 0, top: 0, width: 400 };
      const horizontal = this.parentElement?._workspaceSortOptions?.axis === 'x';
      const siblings = this.parentElement?._workspaceSortOptions ? this.parentElement.children.slice(0, this.parentElement.children.indexOf(this)) : [];
      const children = this.className.split(' ').includes('folder-children');
      const left = parent.left + (horizontal ? siblings.length * 100 - this.parentElement.scrollLeft : children ? 20 : 0);
      const top = parent.top + (horizontal ? 0 : siblings.reduce((sum, node) => sum + node.layoutHeight, 0) - (this.parentElement?.scrollTop || 0)) + (children ? 40 : 0);
      const width = horizontal ? 100 : parent.width - (children ? 20 : 0), height = this.layoutHeight;
      return { left, top, width, height, right: left + width, bottom: top + height };
    }
    get layoutHeight() {
      if (this.tagName === 'DETAILS') return 40 + (this.open ? this.children.find(node => node.className === 'folder-children')?.layoutHeight || 0 : 0);
      if (this.className === 'folder-children') return this.children.reduce((sum, node) => sum + node.layoutHeight, 0);
      return 40;
    }
  }
  const documentHandlers = new Map();
  const document = { body: new Element('body'), createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'),
    addEventListener: (type, handler) => listen(documentHandlers, type, handler), elementFromPoint: () => hit,
    querySelectorAll: selector => document.body.querySelectorAll(selector) };
  const $ = id => { if (!nodes.has(id)) {
    const node = new Element(); node.id = id;
    if (id === 'fileList' || id === 'documentHistoryList') node.rect = { left: 0, top: 0, width: 400, height: id === 'fileList' ? 280 : 40 };
    nodes.set(id, node); document.body.append(node);
  } return nodes.get(id); };
  const state = { files: ['@root/a.md', '@root/b.md', '@root/c.md'], path: '@root/a.md', directories: [{ id: '@root', name: '文档' }],
    folders: ['@root'], fileOperations: false, expandedFolders: new Set(['@root']) };
  const navigations = [], searchState = { matches: new Set(), error: '', pending: false };
  const context = vm.createContext({ $, document, state, searchState,
    window: { addEventListener: (type, handler) => listen(listeners, type, handler), removeEventListener: (type, handler) => listeners.get(type)?.delete(handler), matchMedia: () => ({ matches: false }) },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    displayLibraryPath: value => value, directoryLabel: item => item.name, reducedMotion: { matches: false },
    drawFiles: () => { redraws++; }, updateFileHighlights() {}, syncFileOperationButtons() {}, icon: () => new Element('svg'),
    navigate: async target => { navigations.push(target); state.path = target; return true; } });
  const load = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '../web', file), 'utf8'), context);
  load('browsing-state.js'); load('workspace-sort.js');
  function renderTree() {
    const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
    vm.runInContext(source.slice(source.indexOf('function drawFiles('), source.indexOf('function updateFileHighlights()')), context);
    context.drawFiles();
  }
  function dispatch(target, type, values = {}) {
    const event = { type, target, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 7, pointerType: 'mouse', clientX: pointerX, clientY: pointerY,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = this.immediate = true; }, ...values };
    if (type === 'pointerdown' || type === 'pointermove') { pointerX = event.clientX; pointerY = event.clientY; }
    if (target === 'window') { for (const listener of [...listeners.get(type) || []]) listener(event); return event; }
    for (const listener of documentHandlers.get(type) || []) if (type === 'click') listener(event);
    for (let node = target; node && !event.stopped; node = node.parentElement) {
      for (const listener of node.handlers.get(type) || []) { listener(event); if (event.immediate) break; }
      if (!event.stopped) node['on' + type]?.(event);
    }
    return event;
  }
  function frame(time = 16) { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(time); }
  const rows = container => [...container.children].filter(node => node.dataset.sortKey !== undefined);
  const keys = container => rows(container).map(row => row.dataset.sortKey);
  function start(row) { const handle = row.dataset.sortHandle !== undefined ? row : row.querySelector('[data-sort-handle]'); const rect = handle.getBoundingClientRect(); dispatch(handle, 'pointerdown', { clientX: rect.left + 10, clientY: rect.top + 10 }); return handle; }
  function moveTo(handle, { after = true } = {}) { hit = handle; const rect = handle.getBoundingClientRect(); dispatch('window', 'pointermove', { clientX: rect.left + rect.width * (after ? .85 : .15), clientY: rect.top + rect.height * (after ? .85 : .15) }); frame(); }
  function end() { dispatch('window', 'pointerup'); }
  return { context, state, $, document, storage, load, renderTree, dispatch, frame, keys, rows, start, moveTo, end, listeners, navigations, animations,
    hit: value => { hit = value; }, get redraws() { return redraws; } };
}

test('大量折叠目录按需渲染，展开后支持文件选择和排序，重新展开不重复创建节点', () => {
  const f = fixture();
  f.state.files = Array.from({ length: 2000 }, (_, i) => '@root/folder' + i + '/note.md');
  f.state.expandedFolders.clear();
  f.renderTree();
  const root = f.$('fileList').children[0], children = root.querySelector('.folder-children');
  assert.equal(children.children.length, 0);
  assert.equal(f.$('fileList').querySelectorAll('.file').length, 0);
  f.dispatch(root.children[0], 'click'); f.dispatch(root, 'toggle');
  assert.equal(children.children.length, 2000);
  assert.equal(f.$('fileList').querySelectorAll('.file').length, 0);
  const folder = children.children[0];
  f.dispatch(folder.children[0], 'click'); f.dispatch(folder, 'toggle');
  assert.equal(folder.querySelectorAll('.file').length, 1);
  assert.ok(folder.querySelector('.file').dataset.sortKey);
  f.dispatch(folder.querySelector('.file'), 'click');
  assert.equal(f.navigations.length, 1);
  f.dispatch(root.children[0], 'click'); f.dispatch(root, 'toggle');
  f.dispatch(root.children[0], 'click'); f.dispatch(root, 'toggle');
  assert.equal(children.children.length, 2000);
  assert.equal(folder.querySelectorAll('.file').length, 1);
});

const historyStorage = { 'mojian.recentDocuments': JSON.stringify(['@root/a.md', '@root/b.md', '@root/c.md']) };

test('顶部真实渲染与指针拖动：自动保存、保持当前文档，刷新及再次打开不重排', () => {
  const f = fixture(historyStorage); f.context.renderDocumentHistory();
  const list = f.$('documentHistoryList'); list.scrollLeft = 23;
  f.start(list.children[0]); f.moveTo(list.children[2].children[0]); f.end();
  assert.deepEqual(f.keys(list), ['@root/b.md', '@root/c.md', '@root/a.md']);
  assert.deepEqual(JSON.parse(f.storage.get('mojian.recentDocuments')), f.keys(list));
  assert.equal(f.state.path, '@root/a.md'); assert.deepEqual(f.navigations, []); assert.equal(list.scrollLeft, 23);
  f.context.rememberDocument('@root/b.md'); f.context.renderDocumentHistory();
  assert.deepEqual(f.keys(list), ['@root/b.md', '@root/c.md', '@root/a.md']);
  const reloaded = fixture(Object.fromEntries(f.storage)); reloaded.context.renderDocumentHistory();
  assert.deepEqual(reloaded.keys(reloaded.$('documentHistoryList')), f.keys(list));
  assert.equal(f.document.body.querySelector('.sort-ghost'), null);
  assert.ok([...f.listeners.values()].every(handlers => handlers.size === 0));
});

test('拖动取消与误点击保护：Esc/指针取消/失焦恢复原顺序，不关闭、不切换', () => {
  for (const cancellation of ['keydown', 'pointercancel', 'blur']) {
    const f = fixture(historyStorage); f.context.renderDocumentHistory(); const list = f.$('documentHistoryList');
    f.start(list.children[0]); f.moveTo(list.children[2].children[0]);
    f.dispatch('window', cancellation, { key: 'Escape' });
    assert.deepEqual(f.keys(list), ['@root/a.md', '@root/b.md', '@root/c.md']);
    assert.equal(f.storage.get('mojian.recentDocuments'), historyStorage['mojian.recentDocuments']);
    assert.equal(f.dispatch(list.children[0].children[1], 'click').defaultPrevented, true);
    assert.deepEqual(f.navigations, []); assert.equal(f.context.workspaceSortBusy(), false);
  }
});

test('点击、关闭按钮与拖动阈值：轻微移动不触发排序，关闭不启动拖动', async () => {
  const f = fixture(historyStorage); f.context.renderDocumentHistory(); const list = f.$('documentHistoryList');
  f.start(list.children[1]); f.dispatch('window', 'pointermove', { clientX: 112, clientY: 12 }); f.end();
  assert.equal(f.context.workspaceSortBusy(), false);
  f.dispatch(list.children[1].children[0], 'click'); assert.deepEqual(f.navigations, ['@root/b.md']);
  f.dispatch(list.children[2].children[1], 'pointerdown'); assert.equal(f.listeners.get('pointermove').size, 0);
  f.dispatch(list.children[2].children[1], 'click'); await new Promise(setImmediate);
  assert.deepEqual(JSON.parse(f.storage.get('mojian.recentDocuments')), ['@root/a.md', '@root/b.md']);
});

test('菜单真实渲染：搜索下重排保留隐藏项位置，清除搜索/刷新恢复顺序及折叠状态', () => {
  const f = fixture(); f.state.fileOperations = true;
  f.$('search').value = 'a.md'; f.context.searchState.matches.add('@root/c.md'); f.renderTree();
  const root = f.$('fileList').children[0], children = root.querySelector('.folder-children');
  assert.deepEqual(f.keys(children), ['@root/a.md', '@root/c.md']);
  f.start(children.children[1]); f.moveTo(children.children[0].children[0], { after: false }); f.end();
  const saved = JSON.parse(f.storage.get('mojian.order.menu:@root'));
  assert.deepEqual(saved, ['@root/c.md', '@root/b.md', '@root/a.md']);
  f.$('search').value = ''; f.context.drawFiles();
  assert.deepEqual(f.keys(f.$('fileList').children[0].querySelector('.folder-children')), saved);
  assert.equal(f.$('fileList').children[0].open, true); assert.deepEqual(f.state.files, ['@root/a.md', '@root/b.md', '@root/c.md']);
  const reloaded = fixture(Object.fromEntries(f.storage)); reloaded.renderTree();
  assert.deepEqual(reloaded.keys(reloaded.$('fileList').children[0].querySelector('.folder-children')), saved);
});

test('根目录与子目录整体排序；跨层级/跨栏不能移动文件', () => {
  const f = fixture(historyStorage);
  f.state.files = ['@root/folder/note.md', '@root/z.md', '@other/a.md'];
  f.state.directories.push({ id: '@other', name: '其他' }); f.state.expandedFolders.add('@root/folder'); f.renderTree();
  const list = f.$('fileList'), root = f.rows(list).find(row => row.dataset.sortKey === '@root');
  f.start(root); f.moveTo(f.rows(list).find(row => row !== root).children[0]); f.end();
  assert.deepEqual(f.keys(list), ['@other', '@root']);
  const children = f.rows(list)[1].querySelector('.folder-children'), folder = children.children[0];
  f.start(folder); f.moveTo(children.children[1]); f.end();
  assert.deepEqual(f.keys(f.rows(list)[1].querySelector('.folder-children')), ['@root/z.md', '@root/folder']);
  const nested = f.rows(list)[1].querySelector('.folder').querySelector('.folder-children');
  const original = [...f.state.files]; f.start(nested.children[0]); f.moveTo(f.rows(list)[0].children[0]); f.end();
  assert.deepEqual(f.state.files, original);
  assert.deepEqual(f.keys(f.rows(list)[1].querySelector('.folder-children')), ['@root/z.md', '@root/folder']);
  assert.equal(f.state.path, '@root/a.md');
});

test('连续帧边缘滚动支持横向及纵向，取消后停止；拖动期间延迟重绘', () => {
  for (const axis of ['x', 'y']) {
    const f = fixture(historyStorage); f.renderTree();
    const list = axis === 'x' ? f.$('documentHistoryList') : f.$('fileList');
    list.rect = { left: 0, top: 0, width: 300, height: 180 };
    const row = axis === 'x' ? list.children[0] : list.children[0].querySelector('.folder-children').children[0];
    f.start(row); f.hit(null);
    f.dispatch('window', 'pointermove', { clientX: axis === 'x' ? 298 : 20, clientY: axis === 'y' ? 178 : 20 });
    f.frame(16); const first = axis === 'x' ? list.scrollLeft : list.scrollTop; f.frame(32);
    assert.ok(first > 0); assert.ok((axis === 'x' ? list.scrollLeft : list.scrollTop) > first);
    f.context.drawFiles(); assert.equal(row.isConnected, true);
    f.dispatch('window', 'pointercancel'); const stopped = axis === 'x' ? list.scrollLeft : list.scrollTop; f.frame(48);
    assert.equal(axis === 'x' ? list.scrollLeft : list.scrollTop, stopped);
  }
});

test('键盘排序自动保存并保留焦点；触摸标签留给滚动，拖动柄支持排序', () => {
  const f = fixture(historyStorage); f.context.renderDocumentHistory(); const list = f.$('documentHistoryList');
  f.dispatch(list.children[0].children[0], 'keydown', { altKey: true, key: 'ArrowRight' });
  assert.deepEqual(f.keys(list), ['@root/b.md', '@root/a.md', '@root/c.md']);
  assert.equal(f.document.focused, list.children[1].children[0]);
  f.dispatch(list.children[1].children[0], 'pointerdown', { pointerType: 'touch' });
  assert.equal(f.listeners.get('pointermove')?.size || 0, 0);
  f.dispatch(list.children[1].children[0].children[0], 'pointerdown', { pointerType: 'touch', clientX: 110, clientY: 10 });
  f.moveTo(list.children[0].children[0], { after: false }); f.end();
  assert.deepEqual(f.keys(list), ['@root/a.md', '@root/b.md', '@root/c.md']);
});

test('损坏的缓存、新增项、不同层级和不可用的本地存储均能安全降级', () => {
  const f = fixture({ 'mojian.order.menu:@root': '{broken' }); f.renderTree();
  const list = f.$('fileList'); assert.deepEqual(f.keys(list.children[0].querySelector('.folder-children')), f.state.files);
  f.storage.set('mojian.order.menu:@root', JSON.stringify(['@root/c.md', '@root/a.md', '@root/b.md', '@removed/secret.md']));
  f.state.files.push('@root/d.md'); f.context.drawFiles();
  assert.deepEqual(f.keys(list.children[0].querySelector('.folder-children')), ['@root/c.md', '@root/a.md', '@root/b.md', '@root/d.md']);
  vm.runInContext("localStorage.getItem = () => { throw Error('blocked'); }; localStorage.setItem = () => { throw Error('full'); };", f.context);
  f.context.drawFiles(); const children = list.children[0].querySelector('.folder-children');
  f.start(children.children[0]); f.moveTo(children.children[2]); assert.doesNotThrow(() => f.end());
});

test('轮询更新：从按下起保护节点，拖动中权限/文件变化在松手后立即应用', () => {
  const f = fixture(historyStorage); f.renderTree();
  let children = f.$('fileList').children[0].querySelector('.folder-children');
  const pressed = children.children[0]; f.start(pressed); f.context.drawFiles();
  assert.doesNotThrow(() => f.dispatch('window', 'pointermove', { clientX: 90, clientY: 90 }));
  assert.equal(f.context.workspaceSortBusy(), true); assert.equal(pressed.isConnected, true);
  f.dispatch('window', 'pointercancel');
  children = f.$('fileList').children[0].querySelector('.folder-children');
  f.start(children.children[0]); f.moveTo(children.children[2]);
  f.state.files = ['@root/b.md', '@root/c.md']; f.state.path = '@root/b.md';
  f.context.drawFiles(); assert.equal(f.context.workspaceSortBusy(), true);
  f.end();
  assert.deepEqual(f.keys(f.$('fileList').children[0].querySelector('.folder-children')), ['@root/b.md', '@root/c.md']);
  assert.deepEqual(f.keys(f.$('documentHistoryList')), ['@root/b.md', '@root/c.md']);
});

test('左侧真实菜单只保留名称和拖动柄，加减操作已移除，文件/目录可识别右键目标', () => {
  const f = fixture(); f.state.localAdmin = true; f.state.fileOperations = true; f.renderTree();
  const root = f.$('fileList').children[0], summary = root.children[0];
  assert.equal(summary.dataset.libraryKind, 'directory'); assert.equal(summary.attrs['aria-haspopup'], 'menu');
  assert.equal(f.$('fileList').querySelectorAll('.file-operation').length, 0);
  assert.ok(f.$('fileList').querySelectorAll('.file').every(button => button.dataset.libraryKind === 'file'));
  f.state.localAdmin = false; f.context.drawFiles();
  assert.equal(f.$('fileList').children[0].children[0].attrs['aria-haspopup'], undefined);
});

function sortableFixture(axis) {
  const f = fixture(historyStorage); f.renderTree();
  const scroller = f.$(axis === 'x' ? 'documentHistoryList' : 'fileList');
  const group = axis === 'x' ? scroller : scroller.children[0].querySelector('.folder-children');
  const point = index => axis === 'x' ? { clientX: index * 100 + 85, clientY: 20 }
    : { clientX: 100, clientY: 40 + index * 40 + 34 };
  const saved = () => JSON.parse(f.storage.get(axis === 'x' ? 'mojian.recentDocuments' : 'mojian.order.menu:@root'));
  return { ...f, scroller, group, point, saved };
}

test('两栏重排后捕获保留在固定容器，持续按住超过一分钟仍可继续排序并保存', async () => {
  for (const axis of ['x', 'y']) {
    const f = sortableFixture(axis), original = f.keys(f.group), row = f.group.children[0];
    const handle = f.start(row);
    f.dispatch('window', 'pointermove', f.point(1)); f.frame(16);
    await Promise.resolve(); // Detached captured nodes would dispatch lostpointercapture here.
    assert.equal(f.scroller.hasPointerCapture(7), true);
    assert.equal(handle.hasPointerCapture(7), false);
    for (const time of [1000, 10000, 61000, 90000]) {
      f.context.drawFiles(); f.context.renderDocumentHistory(); f.frame(time);
      assert.equal(f.context.workspaceSortBusy(), true);
      assert.equal(row.isConnected, true);
      assert.deepEqual(f.keys(f.group), [original[1], original[0], original[2]]);
    }
    f.dispatch('window', 'pointermove', f.point(2)); f.frame(90016);
    f.end();
    assert.deepEqual(f.saved(), [original[1], original[2], original[0]]);
    assert.equal(f.context.workspaceSortBusy(), false);
    assert.equal(f.scroller.hasPointerCapture(7), false);
  }
});

test('两栏忽略移动节点的捕获丢失，固定容器意外失去捕获后恢复并继续拖动', () => {
  for (const axis of ['x', 'y']) {
    const f = sortableFixture(axis), original = f.keys(f.group), handle = f.start(f.group.children[0]);
    f.dispatch('window', 'pointermove', f.point(1)); f.frame();
    f.dispatch('window', 'lostpointercapture', { target: handle });
    assert.equal(f.context.workspaceSortBusy(), true);
    f.scroller.releasePointerCapture(7);
    f.dispatch('window', 'lostpointercapture', { target: f.scroller });
    assert.equal(f.scroller.hasPointerCapture(7), true);
    f.dispatch('window', 'pointermove', f.point(2)); f.end();
    assert.deepEqual(f.saved(), [original[1], original[2], original[0]]);
  }
});

test('两栏快速移动后未执行首帧就松手，仍按最终位置持久化', () => {
  for (const axis of ['x', 'y']) {
    const f = sortableFixture(axis), original = f.keys(f.group);
    f.start(f.group.children[0]); f.hit(null);
    f.dispatch('window', 'pointermove', f.point(2)); f.end();
    assert.deepEqual(f.saved(), [original[1], original[2], original[0]]);
    f.frame();
    assert.equal(f.context.workspaceSortBusy(), false);
    const reload = fixture(Object.fromEntries(f.storage)); reload.renderTree();
    const group = axis === 'x' ? reload.$('documentHistoryList') : reload.$('fileList').children[0].querySelector('.folder-children');
    assert.deepEqual(reload.keys(group), f.saved());
  }
});

test('两栏松手坐标优先于最后一次移动，其他指针或非主按钮不能提前结束', () => {
  for (const axis of ['x', 'y']) {
    const f = sortableFixture(axis), original = f.keys(f.group);
    f.start(f.group.children[0]);
    f.dispatch('window', 'pointermove', f.point(1)); f.frame();
    f.dispatch('window', 'pointerup', { ...f.point(2), pointerId: 99 });
    f.dispatch('window', 'pointerup', { ...f.point(2), button: 2 });
    assert.equal(f.context.workspaceSortBusy(), true);
    f.dispatch('window', 'pointerup', f.point(2));
    assert.deepEqual(f.saved(), [original[1], original[2], original[0]]);
  }
});

test('顶部空隙和轻微斜移仍可排序，远离栏位不会误排，松开主按钮补交排序', () => {
  const f = sortableFixture('x'), original = f.keys(f.group);
  f.start(f.group.children[0]); f.hit(null);
  f.dispatch('window', 'pointermove', { clientX: 199, clientY: 55 }); f.frame();
  assert.deepEqual(f.keys(f.group), [original[1], original[0], original[2]]);
  f.dispatch('window', 'pointermove', { clientX: 10, clientY: 200 }); f.frame();
  assert.deepEqual(f.keys(f.group), [original[1], original[0], original[2]]);
  f.dispatch('window', 'pointermove', { clientX: 285, clientY: 55, buttons: 0 });
  assert.equal(f.context.workspaceSortBusy(), false);
  assert.deepEqual(f.saved(), [original[1], original[2], original[0]]);
});

test('按下期间延迟重绘保留原生打开与折叠点击，松手后一帧应用更新', () => {
  const f = fixture(historyStorage); f.renderTree();
  const history = f.$('documentHistoryList'), row = history.children[1];
  f.start(row); f.context.drawFiles(); f.context.renderDocumentHistory();
  f.end(); assert.equal(row.isConnected, true);
  f.dispatch(row.children[0], 'click'); assert.deepEqual(f.navigations, ['@root/b.md']);
  f.frame(); assert.equal(row.isConnected, false);
  const root = f.$('fileList').children[0];
  f.start(root); f.context.drawFiles(); f.end();
  assert.equal(root.isConnected, true);
  // Browser default toggles <details> after the click event.
  f.dispatch(root.children[0], 'click'); root.open = false;
  f.dispatch(root, 'toggle'); f.frame();
  assert.equal(f.$('fileList').children[0].open, false);
});

test('让位360ms、归位280ms，减少动态效果时两者均跳过', () => {
  for (const reduce of [false, true]) {
    const f = sortableFixture('x');
    f.context.window.matchMedia = () => ({ matches: reduce });
    f.start(f.group.children[0]);
    f.dispatch('window', 'pointermove', f.point(2)); f.frame(); f.end();
    const durations = f.animations.map(animation => animation.options.duration);
    if (reduce) assert.deepEqual(durations, []);
    else { assert.ok(durations.includes(360)); assert.ok(durations.includes(280)); }
    assert.equal(f.document.body.querySelector('.sort-ghost'), null);
  }
});
