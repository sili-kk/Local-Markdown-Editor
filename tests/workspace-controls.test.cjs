const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const tick = () => new Promise(setImmediate);

// Minimal DOM for event/state regression; these checks do not claim visual or
// browser integration coverage and never access a user's service or files.
function environment(extra = {}, stored = {}) {
  const nodes = new Map(), storage = new Map(Object.entries(stored)), ready = [], windowEvents = {};
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.handlers = {}; this.style = { setProperty: (key, value) => { this.style[key] = value; } }; this.classList = { add() {}, remove() {} }; this.value = ''; this.open = false; this.hidden = false; this.scrollLeft = 0; this.scrollWidth = 300; this.clientWidth = 600; }
    append(...children) { for (const child of children) { if (child.tagName === 'FRAGMENT') this.append(...child.children); else { this.children.push(child); child.parent = this; } } }
    prepend(child) { this.children.unshift(child); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key]; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(key, listener) { this.handlers[key] = listener; }
    removeEventListener(key, listener) { if (this.handlers[key] === listener) delete this.handlers[key]; }
    dispatchEvent(event) { this.handlers[event.type]?.(event); }
    focus() { this.focused = true; }
    scrollIntoView() {}
    getBoundingClientRect() { return { left: 0, right: 400, width: 400 }; }
    querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]).filter(child => selector === 'input' ? child.tagName === 'INPUT' : selector.startsWith('.') ? child.className?.split(' ').includes(selector.slice(1)) : child.attributes['aria-current'] === 'page'); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    setPointerCapture(id) { this.pointer = id; }
    hasPointerCapture(id) { return this.pointer === id; }
    releasePointerCapture() { this.pointer = null; }
  }
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const document = { body: new Element('body'), hidden: false, createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'), querySelectorAll: () => [], addEventListener: (event, callback) => { if (event === 'DOMContentLoaded') ready.push(callback); } };
  const context = vm.createContext({ $, document, Event: class { constructor(type) { this.type = type; } }, window: { addEventListener: (event, callback) => { windowEvents[event] = callback; } }, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, requestAnimationFrame: () => 1, setInterval() {}, ...extra });
  const load = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '../web', file), 'utf8'), context);
  return { context, $, load, storage, ready, windowEvents };
}

function historyFixture(paths, current, navigation = true) {
  const state = { files: [...paths], path: current }, calls = [];
  const env = environment({ state, displayLibraryPath: value => value, navigate: async target => { calls.push(target); if (navigation) { state.path = target; if (target) env.context.rememberDocument(target); else state.documentsClosed = true; } return navigation; } }, { 'mojian.recentDocuments': JSON.stringify(paths) });
  env.load('browsing-state.js'); env.load('workspace-sort.js'); return { ...env, state, calls };
}

test('关闭历史项不删除文件、不重排其他项，也不切换当前正文', async () => {
  const f = historyFixture(['a.md', 'b.md', 'c.md'], 'a.md');
  await f.context.closeDocumentHistory('b.md');
  assert.deepEqual(JSON.parse(f.storage.get('mojian.recentDocuments')), ['a.md', 'c.md']);
  assert.deepEqual(f.state.files, ['a.md', 'b.md', 'c.md']); assert.deepEqual(f.calls, []);
  f.context.renderDocumentHistory();
  const tab = f.$('documentHistoryList').children[0];
  assert.equal(tab.tagName, 'DIV'); assert.equal(tab.children[0].tagName, 'BUTTON'); assert.equal(tab.children[1].className, 'history-close');
});

test('关闭当前项选择相邻文档，保存失败时保留当前项及历史', async () => {
  const f = historyFixture(['a.md', 'b.md', 'c.md'], 'b.md'); await f.context.closeDocumentHistory('b.md');
  assert.equal(f.state.path, 'c.md'); assert.deepEqual(JSON.parse(f.storage.get('mojian.recentDocuments')), ['a.md', 'c.md']);
  const blocked = historyFixture(['a.md', 'b.md'], 'a.md', false); await blocked.context.closeDocumentHistory('a.md');
  assert.equal(blocked.state.path, 'a.md'); assert.deepEqual(JSON.parse(blocked.storage.get('mojian.recentDocuments')), ['a.md', 'b.md']);
});

test('关闭最后文档进入空视图并清除上次打开记录；忙碌期间不关闭', async () => {
  const f = historyFixture(['a.md'], 'a.md'); await f.context.closeDocumentHistory('a.md');
  assert.equal(f.state.path, ''); assert.equal(f.state.documentsClosed, true);
  assert.deepEqual(JSON.parse(f.storage.get('mojian.lastDocument')), []); assert.deepEqual(JSON.parse(f.storage.get('mojian.recentDocuments')), []);
  const busy = historyFixture(['a.md'], 'a.md'); busy.state.merging = true; await busy.context.closeDocumentHistory('a.md'); assert.deepEqual(busy.calls, []);
});

test('真实文档切换流程关闭末项会清空正文与地址，刷新时保持关闭，保存失败不清空', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
  const switchSource = source.slice(source.indexOf('async function switchDocument('), source.indexOf("document.addEventListener('keydown'", source.indexOf('async function switchDocument(')));
  for (const canSave of [true, false]) {
    let body = 'unsaved text', url = '?file=note.md';
    const state = { path: 'note.md', saved: 'old', revision: 'old', files: ['note.md'], editor: { setMarkdown: value => { body = value; } } };
    const f = environment({ state, flush: async () => canSave, dirty: () => !!state.path && body !== state.saved, animateDocument: async () => {}, setBusy() {}, resetExternalChanges() {}, syncDocumentViewers() {}, setDocumentOutlineOpen() {}, notice() {}, status() {}, drawFiles() {}, clearTimeout() {}, applyLibraryData: data => { state.files = data.files; }, api: async () => ({ files: ['note.md'] }), history: { replaceState: (_state, _unused, next) => { url = next; } }, location: { pathname: '/' } });
    f.load('browsing-state.js'); vm.runInContext(switchSource, f.context);
    const closed = await f.context.switchDocument('', false);
    assert.equal(closed, canSave);
    if (canSave) {
      assert.equal(body, ''); assert.equal(state.path, ''); assert.equal(url, '/'); assert.equal(state.documentsClosed, true);
      await f.context.switchDocument('', true); assert.equal(state.path, ''); assert.equal(body, '');
      assert.deepEqual(JSON.parse(f.storage.get('mojian.closedView')), ['closed']);
    } else { assert.equal(body, 'unsaved text'); assert.equal(state.path, 'note.md'); }
  }
});

// Exercise the real close handler, navigation queue and document switch together.
// A full library redraw or transition here caused the apparent page refresh.
function tabCloseFixture({ paths = ['a.md', 'b.md', 'c.md'], current = 'b.md', canSave = true, loadError = false, load } = {}) {
  let body = 'draft', url = '?file=' + current, redraws = 0, highlights = 0, saves = 0, creations = 0;
  const requests = [], animations = [], viewport = { scrollTop: 123 };
  const editor = { setMarkdown: value => { body = value; }, setScrollTop() {} };
  const state = { path: current, saved: 'old', revision: 'old', files: [...paths], editor, imageViews: new Set(),
    localAdmin: true, fileAccess: {}, pendingNavigation: null, navigating: false, navigationTarget: '' };
  const f = environment({ state, displayLibraryPath: value => value, documentEventGeneration: 0,
    flush: async () => { saves++; if (canSave) state.saved = body; return canSave; }, dirty: () => body !== state.saved,
    animateDocument: async phase => { animations.push(phase); }, setBusy() {}, resetExternalChanges() {},
    syncDocumentViewers() {}, setDocumentOutlineOpen() {}, notice() {}, status() {}, clearTimeout() {},
    updateFileHighlights: () => { highlights++; }, drawFiles: () => { redraws++; },
    api: async target => { requests.push(target); if (loadError) throw Error('读取失败'); if (load) await load();
      return { path: new URL('http://localhost' + target).searchParams.get('path'), content: 'next document', revision: 'new' }; },
    prepareDocumentMarkdown: value => value, createEditor: () => { creations++; assert.equal(state.editor, editor); },
    content: () => body, applyDocumentAccess() {}, showDocumentPath() {}, count() {}, mobileSidebar: { matches: false },
    history: { replaceState: (_state, _unused, next) => { url = next; } },
    // Any browser navigation or page reload would fail this regression.
    location: { pathname: '/', reload() { throw Error('Unexpected page reload'); }, set href(value) { throw Error('Unexpected navigation'); } },
  }, { 'mojian.recentDocuments': JSON.stringify(paths) });
  f.$('editor').querySelector = () => viewport;
  f.load('browsing-state.js'); f.load('workspace-sort.js');
  const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function navigate('), source.indexOf("document.addEventListener('keydown'", source.indexOf('function navigate('))), f.context);
  f.context.renderDocumentHistory();
  return { ...f, state, requests, animations, editor, viewport,
    get body() { return body; }, get url() { return url; }, get redraws() { return redraws; }, get highlights() { return highlights; },
    get saves() { return saves; }, get creations() { return creations; } };
}

test('点击顶部关闭按钮只移除非当前标签，保留正文、滚动和编辑器，不请求或刷新', async () => {
  const f = tabCloseFixture();
  const tab = f.$('documentHistoryList').children.find(item => item.dataset.path === 'a.md');
  let prevented = false, stopped = false;
  assert.equal(tab.children[1].type, 'button');
  tab.children[1].onclick({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  await tick();
  assert.ok(prevented && stopped);
  assert.equal(f.state.path, 'b.md'); assert.equal(f.body, 'draft'); assert.equal(f.viewport.scrollTop, 123);
  assert.equal(f.state.editor, f.editor); assert.equal(f.saves, 0); assert.equal(f.redraws, 0);
  assert.deepEqual(f.requests, []); assert.deepEqual(f.animations, []);
  assert.deepEqual(JSON.parse(f.storage.get('mojian.recentDocuments')), ['b.md', 'c.md']);
});

test('关闭当前标签保存后只读取相邻正文，无整页切换动画或侧栏重建', async () => {
  let finishLoad;
  const pending = new Promise(resolve => { finishLoad = resolve; });
  const f = tabCloseFixture({ load: () => pending });
  const closing = f.context.closeDocumentHistory('b.md');
  await tick();
  assert.equal(f.body, 'draft'); assert.equal(f.state.path, 'b.md');
  assert.equal(f.state.saved, 'draft'); assert.equal(f.saves, 1);
  assert.equal(f.$('documentHistoryList').children.length, 3);
  finishLoad(); await closing;
  assert.equal(f.state.path, 'c.md'); assert.equal(f.body, 'next document');
  assert.equal(f.state.editor, f.editor); assert.equal(f.creations, 1);
  assert.deepEqual(f.requests, ['/api/file?path=c.md']);
  assert.deepEqual(f.animations, []); assert.equal(f.redraws, 0); assert.ok(f.highlights > 0);
  assert.equal(f.url, '/?file=c.md'); assert.equal(f.state.navigating, false);
  assert.deepEqual(f.state.files, ['a.md', 'b.md', 'c.md']);
  assert.deepEqual(f.$('documentHistoryList').children.map(item => item.dataset.path), ['a.md', 'c.md']);
  assert.deepEqual(JSON.parse(f.storage.get('mojian.recentDocuments')), ['a.md', 'c.md']);
});

test('关闭最后标签仅清空正文，保存或读取失败则保留当前文档及全部标签', async () => {
  const last = tabCloseFixture({ paths: ['b.md'] });
  await last.context.closeDocumentHistory('b.md');
  assert.equal(last.state.path, ''); assert.equal(last.body, ''); assert.equal(last.url, '/');
  assert.equal(last.state.documentsClosed, true); assert.equal(last.$('editor').hidden, true);
  assert.equal(last.redraws, 0); assert.deepEqual(last.animations, []); assert.deepEqual(last.requests, []);
  assert.deepEqual(JSON.parse(last.storage.get('mojian.recentDocuments')), []);
  for (const options of [{ canSave: false }, { loadError: true }]) {
    const f = tabCloseFixture(options);
    await f.context.closeDocumentHistory('b.md');
    assert.equal(f.state.path, 'b.md'); assert.equal(f.body, 'draft'); assert.equal(f.viewport.scrollTop, 123);
    assert.equal(f.state.navigating, false); assert.equal(f.redraws, 0); assert.deepEqual(f.animations, []);
    assert.deepEqual(JSON.parse(f.storage.get('mojian.recentDocuments')), ['a.md', 'b.md', 'c.md']);
    assert.equal(f.$('documentHistoryList').children.length, 3);
  }
});

test('普通文档打开仍保留正文切换动画，不继承关闭标签的导航选项', async () => {
  const f = tabCloseFixture();
  await f.context.closeDocumentHistory('b.md');
  assert.equal(await f.context.navigate('a.md'), true);
  assert.equal(f.state.path, 'a.md');
  assert.deepEqual(f.animations, ['out', 'in']); assert.equal(f.redraws, 1);
});

test('侧栏拖动、键盘、限宽、记忆和移动端取消拖动', () => {
  const mobile = { matches: false };
  const f = environment({ innerWidth: 1400, mobileSidebar: mobile, sidebarOpen: () => true }, { 'mojian.sidebarWidth': '400' });
  f.load('sidebar-resize.js'); f.ready[0]();
  const handle = f.$('sidebarResize'); assert.equal(handle.getAttribute('aria-valuenow'), '400');
  handle.handlers.pointerdown({ button: 0, pointerId: 1, clientX: 400, preventDefault() {} });
  handle.handlers.pointermove({ pointerId: 1, clientX: 1000 });
  assert.equal(f.storage.get('mojian.sidebarWidth'), '600'); assert.equal(f.$('app').style['--sidebar-width'], '600px');
  handle.handlers.pointerup(); assert.equal(handle.pointer, null);
  handle.handlers.keydown({ key: 'Home', preventDefault() {} }); assert.equal(handle.getAttribute('aria-valuenow'), '220');
  handle.handlers.keydown({ key: 'ArrowRight', preventDefault() {} }); assert.equal(handle.getAttribute('aria-valuenow'), '236');
  handle.handlers.dblclick(); assert.equal(handle.getAttribute('aria-valuenow'), '272');
  handle.handlers.pointerdown({ button: 0, pointerId: 2, clientX: 400, preventDefault() {} });
  mobile.matches = true; f.windowEvents.resize(); assert.equal(handle.hidden, true); assert.equal(handle.pointer, null);
});

function pathsFixture({ mismatch = false, flush = true, failSave = false, hooks = {} } = {}) {
  const requests = [], state = { localAdmin: true, files: ['@root/doc.md'], directories: [{ id: '@root', name: '手稿' }], path: '@root/doc.md' };
  const f = environment({ state, flush: async () => flush, displayLibraryPath: value => value, syncFileOperationButtons() {}, drawFiles() {}, notice() {}, navigate: async (...args) => hooks.navigate ? hooks.navigate(...args) : true,
    api: async (url, options) => {
      if (options?.method === 'PUT') { requests.push({ url, body: JSON.parse(options.body) }); if (failSave) throw Object.assign(Error('配置已变化'), { status: 409 }); return hooks.save ? hooks.save() : { config_revision: 'new' }; }
      if (url === '/api/directories') return { directories: [{ id: '@root', path: 'D:/notes', name: '手稿' }], config_revision: 'same' };
      if (url === '/api/permissions') return { default: 'r', rules: [{ path: '@root', access: 'r' }], targets: [{ path: '@root', kind: 'directory' }], config_revision: mismatch ? 'other' : 'same' };
      return hooks.list ? hooks.list() : { files: state.files };
    }, setInterval() {} });
  f.load('permissions.js'); f.load('directories.js');
  vm.runInContext('applyLibraryData = data => { state.files = data.files; }', f.context);
  f.$('pathsDialog').open = true;
  return { ...f, requests, state };
}

test('路径窗口加载必填名称和权限，通过同一个请求提交', async () => {
  const f = pathsFixture(); await f.context.loadPathForm();
  const row = f.$('pathsList').children[0]; assert.equal(row.querySelector('.path-name').value, '手稿'); assert.equal(row.querySelector('.path-name').required, true);
  assert.equal(f.$('permissionDefault').value, 'r');
  await f.context.savePathForm({ preventDefault() {} });
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, '/api/directories');
  assert.deepEqual(f.requests[0].body.names, ['手稿']); assert.deepEqual(f.requests[0].body.paths, ['D:/notes']);
  assert.equal(f.requests[0].body.permissions.default, 'r'); assert.equal(f.$('pathsDialog').open, false);
});

test('配置版本不一致、名称留空、草稿未保存和保存失败均不丢表单', async () => {
  const mismatched = pathsFixture({ mismatch: true }); await mismatched.context.loadPathForm();
  assert.equal(mismatched.$('pathsSave').disabled, true); assert.equal(mismatched.$('pathsFields').disabled, true);
  const blank = pathsFixture(); await blank.context.loadPathForm(); blank.$('pathsList').children[0].querySelector('.path-name').value = ' ';
  await blank.context.savePathForm({ preventDefault() {} }); assert.equal(blank.requests.length, 0);
  const unsaved = pathsFixture({ flush: false }); await unsaved.context.loadPathForm(); await unsaved.context.savePathForm({ preventDefault() {} }); assert.equal(unsaved.requests.length, 0);
  const failed = pathsFixture({ failSave: true }); await failed.context.loadPathForm(); await failed.context.savePathForm({ preventDefault() {} });
  assert.equal(failed.$('pathsDialog').open, true); assert.equal(failed.$('pathsList').children[0].querySelector('.path-name').value, '手稿'); assert.match(failed.$('pathsMessage').textContent, /配置已变化/);
});

test('权限列表显示已保存配置，选项和快捷项仅包含文档路径中的目录', async () => {
  const f = pathsFixture(); await f.context.loadPathForm();
  f.state.path = '@root/sub/note.md';
  f.context.populatePermissionForm({ default: 'none', rules: [{ path: '@root', access: 'r' }, { path: '@root/sub/note.md', access: 'rw' }],
    targets: [{ path: '@root', kind: 'directory' }, { path: '@root/sub', kind: 'directory' }, { path: '@root/sub/note.md', kind: 'file' }] });
  const saved = f.$('permissionSavedList').children;
  assert.equal(saved.length, 3);
  assert.equal(saved[0].children[1].textContent, '隐藏（无权限）');
  assert.equal(saved[1].children[2].textContent, '此目录、子目录和文件');
  assert.equal(saved[2].children[2].textContent, '此文件的独立权限');
  const target = f.$('permissionRules').children[0].children[0];
  assert.deepEqual(target.children.map(option => option.value), ['', '@root']);
  assert.equal(f.$('permissionShortcuts').children.length, 1);
  assert.ok(f.$('permissionShortcuts').children[0].textContent.startsWith('当前配置目录'));
  assert.equal(f.$('permissionRules').children.length, 1);
  f.context.selectPermissionTarget('@root/sub/note.md'); assert.equal(f.$('permissionRules').children.length, 1);
  f.context.selectPermissionTarget('@root/sub');
  assert.equal(f.context.readPermissionForm().rules.length, 2);
  assert.equal(f.$('permissionRules').children.length, 1, 'unconfigured child directories cannot be selected');
  assert.equal(f.$('permissionExtraSection').hidden, false);
  f.$('permissionExtraRules').children[0].children[2].onclick();
  assert.equal(f.$('permissionExtraSection').hidden, true);
  assert.equal(f.context.readPermissionForm().rules.length, 1);
  assert.equal(f.$('permissionSavedList').children.length, 3, 'pending changes do not pretend to be persisted');
});

test('单文件配置不开放父目录；无独立规则显示默认继承；重复目录与文件注入不能提交', async () => {
  const f = pathsFixture(); await f.context.loadPathForm();
  f.state.directories = [{ id: '@single', name: '单文件', is_file: true }]; f.state.path = '@single/one.md';
  f.context.populatePermissionForm({ default: 'r', rules: [], targets: [{ path: '@single', kind: 'file' }] });
  assert.equal(f.$('permissionSavedList').children.length, 1);
  assert.match(f.$('permissionSavedMessage').textContent, /继承全局默认/);
  assert.equal(f.$('permissionAdd').disabled, true);
  assert.equal(f.$('permissionShortcuts').hidden, true);
  f.context.populatePermissionForm({ default: 'r', rules: [], targets: [{ path: '@root', kind: 'directory' }] }, [{ id: '@root' }]);
  const row = f.context.addPermissionRow('@root');
  f.context.addPermissionRow('@root');
  assert.throws(() => f.context.readPermissionForm(), /同一目录/);
  f.$('permissionRules').children[1].remove();
  row.children[0].value = '@root/note.md';
  assert.throws(() => f.context.readPermissionForm(), /有效目录/);
});

test('独立配置的嵌套根可选；已有子目录规则完整显示并保留，不混入候选或误判成文件', async () => {
  const f = pathsFixture(); await f.context.loadPathForm();
  const configured = [{ id: '@root', path: 'D:/notes' }, { id: '@nested', path: 'D:/notes/sub' }, { id: '@single', is_file: true }];
  f.context.populatePermissionForm({ default: 'none', rules: [{ path: '@root/sub', access: 'r' }, { path: '@root/sub/note.md', access: 'rw' }],
    targets: [{ path: '@root', kind: 'directory' }, { path: '@root/sub', kind: 'directory' }, { path: '@root/sub/deep', kind: 'directory' },
      { path: '@nested', kind: 'directory' }, { path: '@single', kind: 'file' }, { path: '@root/sub/note.md', kind: 'file' }] }, configured);
  const row = f.context.addPermissionRow('@root');
  assert.deepEqual(row.children[0].children.map(option => option.value), ['', '@root', '@nested']);
  assert.equal(f.$('permissionSavedList').children[1].children[2].textContent, '此目录、子目录和文件');
  assert.ok(f.$('permissionExtraRules').children[0].children[0].textContent.startsWith('子目录'));
  assert.equal(f.context.readPermissionForm().rules.length, 3);
  row.children[0].value = '@root/sub';
  assert.throws(() => f.context.readPermissionForm(), /有效目录/);
  row.children[0].value = '@nested';
  f.$('permissionExtraRules').children[0].children[2].onclick();
  const rules = f.context.readPermissionForm().rules;
  assert.equal(rules.length, 2);
  assert.ok(rules.some(rule => rule.path === '@root/sub/note.md' && rule.access === 'rw'));
});

test('配置已保存时明确显示加载状态；列表失败后恢复按钮并保留表单与最新版本', async () => {
  let rejectList;
  const f = pathsFixture({ hooks: { list: () => new Promise((_resolve, reject) => { rejectList = reject; }) } });
  await f.context.loadPathForm();
  const task = f.context.savePathForm({ preventDefault() {} });
  await tick();
  assert.match(f.$('pathsMessage').textContent, /已保存.*正在加载/);
  assert.equal(f.$('pathsSave').textContent, '正在加载…');
  rejectList(Error('请求超时'));
  await task;
  assert.match(f.$('pathsMessage').textContent, /已保存.*加载列表失败/);
  assert.equal(f.$('pathsDialog').open, true);
  assert.equal(f.$('pathsSave').disabled, false); assert.equal(f.$('pathsCancel').disabled, false);
  assert.equal(f.$('pathsSave').textContent, '保存并加载');
  assert.equal(vm.runInContext('pathsRevision', f.context), 'new');
  assert.equal(f.$('permissionSavedList').children[0].children[1].textContent, '只读（r）');
});

test('保存结果未知时要求重新读取，避免重复覆盖；导航复用已加载列表', async () => {
  const unknown = pathsFixture({ hooks: { save: () => { throw Error('请求超时'); } } });
  await unknown.context.loadPathForm(); await unknown.context.savePathForm({ preventDefault() {} });
  assert.match(unknown.$('pathsMessage').textContent, /尚未确认.*重新读取/);
  assert.equal(unknown.$('pathsSave').disabled, true); assert.equal(unknown.$('pathsReload').disabled, false);
  const navigations = [];
  const f = pathsFixture({ hooks: { list: () => ({ files: ['@new/first.md'] }), navigate: async (...args) => { navigations.push(args); return true; } } });
  await f.context.loadPathForm(); await f.context.savePathForm({ preventDefault() {} });
  assert.deepEqual(navigations, [['@new/first.md']]);
});

function deleteFixture() {
  const requests = [], state = { localAdmin: true, fileOperations: true, folders: ['@root'], path: '', files: ['@root/note.md'] };
  const f = environment({ state, displayLibraryPath: value => value, notice() {}, drawFiles() {}, applyLibraryData() {},
    api: async (url, options) => { requests.push({ url, options }); return { token: 'single-use-ticket' }; },
  });
  f.load('file-operations.js'); return { ...f, requests, state };
}

test('主题删除弹窗两次确认后才发送 DELETE，任一步取消都不删除', async () => {
  for (const cancelStep of [1, 2, 0]) {
    const f = deleteFixture(), task = f.context.deleteDocument('@root/note.md');
    assert.equal(f.$('deleteConfirmDialog').open, true); assert.equal(f.requests.length, 0); assert.equal(f.$('deleteConfirmCancel').focused, true);
    if (cancelStep === 1) f.$('deleteConfirmCancel').onclick();
    else {
      f.$('deleteConfirmProceed').onclick(); await tick();
      assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, '/api/documents/delete-confirmation');
      assert.equal(f.$('deleteConfirmDialog').dataset.final, 'true');
      if (cancelStep === 2) f.$('deleteConfirmDialog').handlers.cancel({ preventDefault() {} }); else f.$('deleteConfirmProceed').onclick();
    }
    await task;
    const deletes = f.requests.filter(item => item.options?.method === 'DELETE'); assert.equal(deletes.length, cancelStep ? 0 : 1);
    if (!cancelStep) assert.equal(JSON.parse(deletes[0].options.body).token, 'single-use-ticket');
    assert.equal(f.$('deleteConfirmDialog').open, false);
  }
});

test('远端或文件操作开关关闭时不弹出删除确认', async () => {
  for (const flag of ['localAdmin', 'fileOperations']) {
    const f = deleteFixture(); f.state[flag] = false; await f.context.deleteDocument('@root/note.md');
    assert.equal(f.$('deleteConfirmDialog').open, false); assert.equal(f.requests.length, 0);
  }
});
