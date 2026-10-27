const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const tick = () => new Promise(setImmediate);

// Interaction/state tests; no access to user files, running service or browser.
function fixture(options = {}) {
  const nodes = new Map(), ready = [], documentHandlers = {}, windowHandlers = {}, requests = [], notices = [], creates = [], deletes = [];
  class Element {
    constructor() { this.dataset = {}; this.children = []; this.handlers = {}; this.attributes = {}; this.style = {}; this.hidden = false; this.disabled = false; this.isConnected = true; }
    append(...items) { for (const item of items) { this.children.push(item); item.parentElement = this; } }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return { left: 20, right: 260, top: 25, bottom: 65, width: 240, height: 240 }; }
    contains(node) { for (; node; node = node.parentElement) if (node === this) return true; return false; }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (selector === '[data-library-kind]' && node.dataset.libraryKind) return node; return null; }
    querySelectorAll(selector) { return this.children.filter(node => selector === 'button'); }
  }
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const document = { addEventListener(type, handler) { if (type === 'DOMContentLoaded') ready.push(handler); else documentHandlers[type] = handler; } };
  const state = { localAdmin: true, fileOperations: true, files: ['@root/a.md'], folders: ['@root', '@root/sub'], path: '@root/a.md',
    directories: [{ id: '@root', name: '文档', path: 'D:/notes' }], ...options.state };
  const permissions = options.permissions || { default: 'rw', config_revision: 'v1', targets: [{ path: '@root', kind: 'directory' }, { path: '@root/a.md', kind: 'file' }], rules: [] };
  const context = vm.createContext({ $, document, state, fileMutationBusy: false, pathsSaving: false, pathsLoading: false, libraryGeneration: 0,
    window: { innerWidth: 800, innerHeight: 600, addEventListener: (type, handler) => { windowHandlers[type] = handler; } },
    workspaceSortBusy: () => false, displayLibraryPath: value => value.replace('@root', '文档'), flush: async () => options.flush !== false,
    openCreateDocument: target => creates.push(target), deleteDocument: async target => deletes.push(target),
    syncFileOperationButtons: () => context.syncLibraryContextMenu(), applyLibraryData() {}, drawFiles() {}, notice: text => notices.push(text),
    api: async (url, config) => {
      requests.push({ url, method: config?.method || 'GET', body: config?.body && JSON.parse(config.body) });
      if (config?.method === 'PUT') { if (options.conflict) throw Error('配置已变化'); return { config_revision: 'v2' }; }
      if (url === '/api/directories') return { directories: state.directories, config_revision: options.mismatch ? 'v0' : 'v1' };
      if (url === '/api/permissions') return permissions;
      return {};
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/library-context-menu.js'), 'utf8'), context);
  const menuIds = ['libraryContextCreate', 'libraryContextDelete', 'libraryContextLock', 'libraryContextUnlock'];
  $('libraryContextMenu').hidden = true; $('libraryContextMenu').append(...menuIds.map($));
  ready.forEach(handler => handler());
  function anchor(path = '@root/a.md', kind = 'file') {
    const node = new Element(); node.dataset.path = path; node.dataset.libraryKind = kind; $('fileList').append(node); return node;
  }
  function open(target = anchor(), event = {}) {
    const input = { target, clientX: 790, clientY: 590, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...event };
    $('fileList').handlers.contextmenu(input); return input;
  }
  function click(id) { $(id).onclick({ preventDefault() {}, stopPropagation() {} }); }
  return { context, state, $, document, documentHandlers, windowHandlers, requests, notices, creates, deletes, permissions, anchor, open, click };
}

test('右键文件/目录使用不同操作，定位不切换正文，菜单在窗口内且支持键盘与关闭', () => {
  const f = fixture(), original = f.state.path, file = f.anchor();
  assert.equal(f.open(file).prevented, true); assert.equal(f.$('libraryContextMenu').hidden, false);
  assert.equal(f.$('libraryContextCreate').hidden, true); assert.equal(f.$('libraryContextDelete').hidden, false);
  assert.equal(f.state.path, original); assert.ok(parseInt(f.$('libraryContextMenu').style.left) <= 552);
  assert.ok(parseInt(f.$('libraryContextMenu').style.top) <= 352);
  f.$('libraryContextMenu').handlers.keydown({ key: 'End', preventDefault() {} });
  assert.equal(f.document.activeElement, f.$('libraryContextUnlock'));
  f.$('libraryContextMenu').handlers.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(f.$('libraryContextMenu').hidden, true); assert.equal(f.document.activeElement, file);
  const folder = f.anchor('@root', 'directory'); f.open(folder);
  assert.equal(f.$('libraryContextCreate').hidden, false); assert.equal(f.$('libraryContextDelete').hidden, true);
  f.click('libraryContextCreate'); assert.deepEqual(f.creates, ['@root']);
  f.open(file); f.click('libraryContextDelete'); assert.deepEqual(f.deletes, ['@root/a.md']);
  f.open(file); f.documentHandlers.pointerdown({ target: folder }); assert.equal(f.$('libraryContextMenu').hidden, true);
  f.$('fileList').handlers.keydown({ target: file, key: 'F10', shiftKey: true, preventDefault() {}, stopPropagation() {} });
  assert.equal(f.$('libraryContextMenu').hidden, false);
});

test('本机轮询保持已打开菜单；权限、文件开关、目标或忙碌状态变化时关闭', () => {
  const f = fixture(), anchor = f.anchor(); f.open(anchor); f.context.syncLibraryContextMenu();
  assert.equal(f.$('libraryContextMenu').hidden, false);
  anchor.isConnected = false; f.context.syncLibraryContextMenu(); assert.equal(f.$('libraryContextMenu').hidden, true);
  anchor.isConnected = true; f.open(anchor); f.state.fileOperations = false; f.context.syncLibraryContextMenu();
  assert.equal(f.$('libraryContextMenu').hidden, true);
  f.open(anchor); assert.equal(f.$('libraryContextDelete').hidden, true); assert.equal(f.$('libraryContextLock').hidden, false);
});

test('远端、未配置路径、单文件根的父目录、文件开关关闭和状态变化不能触发文件操作', async () => {
  const remote = fixture({ state: { localAdmin: false } });
  assert.equal(remote.open().prevented, undefined); remote.click('libraryContextDelete');
  await remote.context.setLibraryReadOnly({ path: '@root/a.md', kind: 'file' }, true); assert.equal(remote.requests.length, 0);
  const unknown = fixture(); assert.equal(unknown.open(unknown.anchor('@outside/a.md')).prevented, undefined);
  const disabled = fixture({ state: { fileOperations: false } }); disabled.open(); disabled.click('libraryContextDelete'); assert.deepEqual(disabled.deletes, []);
  disabled.open(disabled.anchor('@root', 'directory')); disabled.click('libraryContextCreate'); assert.deepEqual(disabled.creates, []);
  const single = fixture({ state: { directories: [{ id: '@root', path: 'D:/private/a.md', is_file: true }] } });
  single.open(single.anchor('@root', 'file-root')); assert.equal(single.$('libraryContextCreate').hidden, true);
  single.click('libraryContextDelete'); assert.deepEqual(single.deletes, ['@root/a.md']);
  const changed = fixture(); changed.open(); changed.state.localAdmin = false; changed.click('libraryContextDelete'); assert.deepEqual(changed.deletes, []);
});

test('文件锁定和解除通过原权限接口携带版本保存，不依赖新建删除开关', async () => {
  const f = fixture({ state: { fileOperations: false } });
  await f.context.setLibraryReadOnly({ path: '@root/a.md', kind: 'file' }, true);
  let writes = f.requests.filter(item => item.method === 'PUT');
  assert.equal(writes[0].url, '/api/permissions'); assert.equal(writes[0].body.config_revision, 'v1');
  assert.deepEqual(writes[0].body.rules, [{ path: '@root/a.md', access: 'r' }]);
  await f.context.setLibraryReadOnly({ path: '@root/a.md', kind: 'file' }, false);
  writes = f.requests.filter(item => item.method === 'PUT'); assert.deepEqual(writes[1].body.rules, [{ path: '@root/a.md', access: 'rw' }]);
  assert.ok(f.notices[0].includes('已限制远端写入')); assert.equal(f.context.fileMutationBusy, false);
});

test('目录锁收紧子项读写并保留隐藏/其他目录；重叠根及 Windows 大小写别名不能绕过', () => {
  const f = fixture();
  const directories = [{ id: '@root', path: 'D:/Notes' }, { id: '@alias', path: 'd:/notes/sub' }, { id: '@other', path: 'D:/Notes2' }];
  const permissions = { default: 'none', config_revision: 'v1', targets: [{ path: '@root', kind: 'directory' }], rules: [
    { path: '@root', access: 'rw' }, { path: '@root/hidden', access: 'none' }, { path: '@alias/a.md', access: 'rw' },
    { path: '@root/strict.md', access: 'r' }, { path: '@other/a.md', access: 'rw' },
  ] };
  const result = JSON.parse(JSON.stringify(f.context.libraryPermissionUpdate({ path: '@root', kind: 'directory' }, true, directories, permissions)));
  assert.equal(result.default, 'none');
  assert.deepEqual(result.rules, [{ path: '@root/hidden', access: 'none' }, { path: '@alias/a.md', access: 'r' },
    { path: '@root/strict.md', access: 'r' }, { path: '@other/a.md', access: 'rw' }, { path: '@root', access: 'r' }]);
  const unlocked = f.context.libraryPermissionUpdate({ path: '@root', kind: 'directory' }, false, directories, { ...result, targets: permissions.targets });
  assert.equal(unlocked.rules.find(rule => rule.path === '@root/hidden').access, 'none');
  assert.equal(unlocked.rules.find(rule => rule.path === '@alias/a.md').access, 'r');
});

test('单文件根使用根权限目标；相同物理路径的规则只保留一条，父目录不能设置', () => {
  const f = fixture(); const directories = [{ id: '@single', path: 'D:/notes/a.md', is_file: true }, { id: '@root', path: 'D:/notes' }];
  const permissions = { default: 'rw', config_revision: 'v1', targets: [{ path: '@single', kind: 'file' }], rules: [{ path: '@root/a.md', access: 'rw' }] };
  const result = f.context.libraryPermissionUpdate({ path: '@single/a.md', kind: 'file' }, true, directories, permissions);
  assert.deepEqual(JSON.parse(JSON.stringify(result.rules)), [{ path: '@single', access: 'r' }]);
  assert.throws(() => f.context.libraryPermissionUpdate({ path: '@single', kind: 'directory' }, true, directories, permissions), /不存在/);
});

test('锁定动作不会开放原本隐藏的文件/目录，最近父目录规则和全局隐藏仍生效', () => {
  const f = fixture();
  const directories = [{ id: '@root', path: 'D:/notes' }];
  for (const rules of [[], [{ path: '@root', access: 'none' }], [{ path: '@root/a.md', access: 'none' }]]) {
    const permissions = { default: rules.length ? 'rw' : 'none', config_revision: 'v1', rules,
      targets: [{ path: '@root', kind: 'directory' }, { path: '@root/a.md', kind: 'file' }] };
    const result = f.context.libraryPermissionUpdate({ path: '@root/a.md', kind: 'file' }, true, directories, permissions);
    assert.equal(result.rules.find(rule => rule.path === '@root/a.md').access, 'none');
  }
});

test('未保存草稿、配置版本不一致、目标消失及并发冲突不覆盖配置', async () => {
  for (const options of [{ flush: false }, { mismatch: true }, { permissions: { default: 'rw', rules: [], targets: [], config_revision: 'v1' } }]) {
    const f = fixture(options); await f.context.setLibraryReadOnly({ path: '@root/a.md', kind: 'file' }, true);
    assert.equal(f.requests.filter(item => item.method === 'PUT').length, 0); assert.equal(f.context.fileMutationBusy, false);
    assert.match(f.notices.at(-1), /权限未修改/);
  }
  const conflict = fixture({ conflict: true }); await conflict.context.setLibraryReadOnly({ path: '@root/a.md', kind: 'file' }, true);
  assert.equal(conflict.requests.filter(item => item.method === 'PUT').length, 1); assert.match(conflict.notices.at(-1), /配置已变化/);
  assert.equal(conflict.context.fileMutationBusy, false);
});

test('菜单锁定动作复用保存流程且不切换文档，互斥状态阻止重复提交', async () => {
  const f = fixture(); f.open(); f.click('libraryContextLock'); f.click('libraryContextUnlock'); await tick();
  assert.equal(f.requests.filter(item => item.method === 'PUT').length, 1); assert.equal(f.state.path, '@root/a.md');
  assert.equal(f.$('libraryContextMenu').hidden, true); assert.equal(f.context.fileMutationBusy, false);
});
