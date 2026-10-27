const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../web/editor-search.js'), 'utf8');

function documentWithBlocks(blocks) {
  return Object.freeze({ descendants(callback) {
    for (const { position = 0, parts } of blocks) callback({ isTextblock: true, descendants(visit) {
      let offset = 0;
      for (const part of parts) {
        const node = typeof part === 'string' ? { isText: true, text: part, nodeSize: part.length } : { isLeaf: true, nodeSize: 1 };
        visit(node, offset); offset += node.nodeSize;
      }
    } }, position);
  } });
}
const plain = doc => JSON.parse(JSON.stringify(doc));

test('本页搜索按字面匹配，跨粗体等行内片段，保留中文、大小写、正则符号与 Unicode 的真实位置', () => {
  const c = vm.createContext({}); vm.runInContext(source, c);
  const doc = documentWithBlocks([{ parts: ['he', 'llo HELLO [a.*] İ 🌸 中文'] }, { position: 100, parts: ['中文'] }]);
  assert.deepEqual(plain(c.findEditorTextMatches(doc, 'hello').matches), [{ from: 1, to: 6 }, { from: 7, to: 12 }]);
  assert.deepEqual(plain(c.findEditorTextMatches(doc, '[a.*]').matches), [{ from: 13, to: 18 }]);
  assert.deepEqual(plain(c.findEditorTextMatches(doc, '🌸').matches), [{ from: 21, to: 23 }]);
  assert.deepEqual(plain(c.findEditorTextMatches(doc, '中文').matches), [{ from: 24, to: 26 }, { from: 101, to: 103 }]);
  assert.deepEqual(plain(c.findEditorTextMatches(doc, '').matches), []);
});

test('搜索不跨段落或图片/换行原子节点，匹配过多时限制装饰数量', () => {
  const c = vm.createContext({}); vm.runInContext(source, c);
  const doc = documentWithBlocks([{ parts: ['ab', {}, 'cd'] }, { position: 10, parts: ['ef'] }]);
  assert.equal(c.findEditorTextMatches(doc, 'abcd').matches.length, 0);
  assert.equal(c.findEditorTextMatches(doc, 'cdef').matches.length, 0);
  assert.deepEqual(plain(c.findEditorTextMatches(doc, 'cd').matches), [{ from: 4, to: 6 }]);
  const limited = c.findEditorTextMatches(documentWithBlocks([{ parts: ['x'.repeat(6000)] }]), 'x');
  assert.equal(limited.matches.length, 5000); assert.equal(limited.truncated, true);
});

function fixture() {
  const handlers = new Map(), frames = new Map(), transactions = [], timers = new Map(); let timerId = 0;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.handlers = new Map(); this.value = ''; }
    append(...children) { for (const child of children) { this.children.push(child); child.parentElement = this; } }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    focus() { this.focused = true; }
    addEventListener(name, callback) { this.handlers.set(name, callback); }
    remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  }
  const viewport = { offsetWidth: 800, clientHeight: 120, scrollTop: 0, getBoundingClientRect: () => ({ width: 1200, top: 40 }), scrollTo({ top }) { this.scrollTop = top; } };
  const body = { parentElement: viewport }, toolbar = new Element('div');
  const document = { createElement: tag => new Element(tag) };
  const context = vm.createContext({ document, icon: () => Object.assign(new Element('svg'), { classList: { add() {} } }), setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(source, context);
  const plugin = context.editorSearchPlugin({ pmState: {
    PluginKey: class { getState(state) { return state.search; } }, Plugin: class { constructor(spec) { this.spec = spec; } },
  }, pmView: { Decoration: { inline: (from, to, attrs) => ({ from, to, attrs }) }, DecorationSet: { empty: [], create: (_doc, decorations) => decorations } } }).wysiwygPlugins[0]();
  const doc = documentWithBlocks([{ parts: ['hello HELLO'] }]);
  function stateFor(doc, search) {
    return { doc, search, get tr() {
      const meta = new Map();
      return { doc, docChanged: false, setMeta(key, value) { meta.set(key, value); return this; }, getMeta: key => meta.get(key) };
    } };
  }
  let lifecycle;
  const view = { dom: body, state: stateFor(doc, plugin.spec.state.init()),
    coordsAtPos: position => ({ top: 40 + (position * 30 - viewport.scrollTop) * 1.5 }),
    dispatch(transaction) {
      transactions.push(transaction); const previous = this.state;
      this.state = stateFor(transaction.doc, plugin.spec.state.apply(transaction, previous.search));
      lifecycle?.update(this, previous);
    },
  };
  lifecycle = plugin.spec.view(view);
  return { context, viewport, toolbar, view, doc, plugin, lifecycle, transactions, timers, handlers, frames };
}

test('文字高亮是文档装饰，上下匹配循环定位，编辑后重新计算，清空后移除高亮与监听', () => {
  const f = fixture(), search = f.viewport.editorTextSearch;
  let updates = 0; search.subscribe(() => updates++);
  search.setQuery('hello');
  assert.equal(search.state.matches.length, 2); assert.equal(search.state.index, 0);
  assert.equal(search.state.decorations[0].attrs.class, 'editor-search-match is-search-current');
  assert.equal(search.move(-1), true); assert.equal(search.state.index, 1); assert.equal(f.viewport.scrollTop, 170);
  search.move(1); assert.equal(search.state.index, 0); assert.equal(f.viewport.scrollTop, 0);
  assert.equal(f.view.state.doc, f.doc);
  for (const transaction of f.transactions) { assert.equal(transaction.docChanged, false); assert.equal(transaction.getMeta('addToHistory'), false); }
  const changed = f.view.state.tr; changed.docChanged = true; changed.doc = documentWithBlocks([{ parts: ['nothing'] }]); f.view.dispatch(changed);
  assert.equal(search.state.matches.length, 0); assert.equal(search.move(), false);
  search.setQuery(''); assert.equal(search.state.decorations.length, 0); assert.ok(updates >= 5);
  f.lifecycle.destroy(); assert.equal(f.viewport.editorTextSearch, undefined);
});

test('工具栏支持回车/上下项、本页计数、清除、行号范围错误及忙碌保护，不发网络请求', () => {
  const f = fixture(), jumps = [];
  f.viewport.editorLineNumbers = { count: 20, subscribe: () => () => {}, jump(value) { jumps.push(value); return { ok: value === '5', count: 20, line: 5 }; } };
  const root = { querySelector: selector => selector === '.toastui-editor-toolbar' ? f.toolbar : f.viewport };
  const controls = f.context.installEditorSearch(root); controls.setAvailable(true);
  const bar = f.toolbar.children[0], [form, lineForm, message] = bar.children;
  const [, input, count, clear, navigation] = form.children, [previous, next] = navigation.children, [, line] = lineForm.children;
  const event = extra => ({ preventDefault() {}, ...extra });
  input.value = 'hello'; input.handlers.get('input')();
  for (const callback of f.timers.values()) callback();
  assert.equal(count.textContent, '1/2'); assert.equal(previous.disabled, false);
  input.handlers.get('keydown')(event({ key: 'Enter' })); assert.equal(f.viewport.editorTextSearch.state.index, 0);
  next.handlers.get('click')(); assert.equal(count.textContent, '2/2');
  next.handlers.get('click')(); assert.equal(count.textContent, '1/2');
  input.handlers.get('keydown')(event({ key: 'Enter', shiftKey: true })); assert.equal(count.textContent, '2/2');
  line.value = '999'; lineForm.handlers.get('submit')(event());
  assert.equal(message.hidden, false); assert.match(message.textContent, /1–20/); assert.equal(line.attributes['aria-invalid'], 'true');
  line.value = '5'; lineForm.handlers.get('submit')(event()); assert.equal(message.hidden, true);
  controls.setAvailable(false); lineForm.handlers.get('submit')(event()); assert.deepEqual(jumps, ['999', '5']);
  assert.equal(input.disabled, true); controls.setAvailable(true);
  clear.handlers.get('click')(); assert.equal(input.value, ''); assert.equal(input.focused, true); assert.equal(clear.hidden, true);
  assert.equal(count.textContent, '本页'); assert.equal(f.viewport.editorTextSearch.state.decorations.length, 0);
  input.value = 'hello'; form.handlers.get('submit')(event());
  input.handlers.get('keydown')(event({ key: 'Escape' })); assert.equal(count.textContent, '本页'); assert.equal(f.viewport.editorTextSearch.state.decorations.length, 0);
  input.value = 'unknown'; form.handlers.get('submit')(event()); assert.equal(count.textContent, '0/0'); assert.equal(next.disabled, true);
  controls.reset(); assert.equal(input.value, ''); assert.equal(line.value, '');
  controls.destroy(); assert.equal(f.toolbar.children.length, 0); assert.equal(root.editorSearch, undefined);
});
