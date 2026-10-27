const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Geometry/event/transaction contract checks, not browser layout coverage.
function fixture(lastKind = 'paragraph', empty = false) {
  const types = Object.fromEntries(['paragraph', 'heading', 'bulletList', 'codeBlock', 'table', 'thematicBreak'].map(name => [name, { name }]));
  types.paragraph.create = () => ({ type: types.paragraph, content: { size: 0 }, nodeSize: 2 });
  const original = { type: types[lastKind], content: { size: empty ? 0 : 8 }, nodeSize: empty ? 2 : 10 };
  const viewportHandlers = new Map(), operations = [], dispatched = [];
  const bounds = { left: 10, right: 410, top: 20, bottom: 420 };
  const viewport = { getBoundingClientRect: () => bounds,
    addEventListener: (type, handler) => viewportHandlers.set(type, handler), removeEventListener: type => viewportHandlers.delete(type) };
  const dom = { parentElement: viewport, getBoundingClientRect: () => bounds, closest: () => null };
  const makeDoc = nodes => ({ nodes, get lastChild() { return this.nodes.at(-1); }, get childCount() { return this.nodes.length; },
    get content() { return { size: this.nodes.reduce((sum, node) => sum + node.nodeSize, 0) }; }, canReplaceWith: () => true });
  const initialDoc = makeDoc([original]);
  const view = { dom, editable: true, composing: false, focused: false,
    state: { doc: initialDoc, schema: { nodes: types } },
    nodeDOM: () => ({ getBoundingClientRect: () => ({ bottom: 100 }) }),
    dispatch: tr => { dispatched.push(tr); view.state.doc = tr.doc; }, focus: () => { view.focused = true; } };
  Object.defineProperty(view.state, 'tr', { get() {
    return { doc: view.state.doc, insert(position, node) { operations.push(['insert', position, node]); this.doc = makeDoc([...this.doc.nodes, node]); return this; },
      setSelection(selection) { this.selection = selection; return this; }, setStoredMarks(marks) { this.marks = marks; return this; },
      setMeta(key, value) { this[key] = value; return this; }, scrollIntoView() { this.scroll = true; return this; } };
  } });
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/editor-end-click.js'), 'utf8'), context);
  const plugin = context.editorEndClickPlugin({ pmState: {
    Plugin: class { constructor(spec) { this.spec = spec; } }, TextSelection: { create: (doc, position) => { assert.ok(position >= 1 && position < doc.content.size); return { position }; } },
  } }).wysiwygPlugins[0]();
  const click = (overrides = {}) => {
    const event = { button: 0, detail: 1, clientX: 80, clientY: 180, target: dom,
      preventDefault() { this.defaultPrevented = true; }, ...overrides };
    return { handled: plugin.spec.props.handleDOMEvents.mousedown(view, event), event };
  };
  return { view, dom, viewport, operations, dispatched, click, original, initialDoc, plugin, viewportHandlers, types };
}

test('文末留白点击创建普通段落并定位光标，单次事务保留原文和撤销入口', () => {
  for (const kind of ['paragraph', 'heading', 'bulletList', 'codeBlock', 'table', 'thematicBreak']) {
    const f = fixture(kind), result = f.click();
    assert.equal(result.handled, true); assert.equal(result.event.defaultPrevented, true);
    assert.equal(f.operations.length, 1); assert.equal(f.operations[0][1], f.initialDoc.content.size);
    assert.equal(f.view.state.doc.nodes[0], f.original); assert.equal(f.view.state.doc.lastChild.type, f.types.paragraph);
    assert.equal(f.dispatched.length, 1); assert.equal(f.dispatched[0].selection.position, f.initialDoc.content.size + 1);
    assert.deepEqual(Array.from(f.dispatched[0].marks), []); assert.equal(f.dispatched[0].scroll, true);
    assert.notEqual(f.dispatched[0].addToHistory, false); assert.equal(f.view.focused, true);
  }
});

test('已有空段落直接复用，连续点击不会不断追加空行或延续代码/标题格式', () => {
  const empty = fixture('paragraph', true); empty.click();
  assert.equal(empty.operations.length, 0); assert.equal(empty.view.state.doc, empty.initialDoc);
  assert.equal(empty.dispatched[0].selection.position, 1);
  const f = fixture('codeBlock'); f.click(); f.click(); f.click();
  assert.equal(f.operations.length, 1); assert.equal(f.view.state.doc.childCount, 2);
});

test('正文、链接等子节点、正文上方、左右边界与滚动条区域保持正常点击', () => {
  for (const event of [
    { target: { tagName: 'A' } }, { target: { tagName: 'P' } }, { target: { tagName: 'TABLE' } },
    { clientY: 99 }, { clientY: 420 }, { clientY: 450 }, { clientX: 9 }, { clientX: 410 },
  ]) {
    const f = fixture(); const result = f.click(event);
    assert.equal(result.handled, false); assert.equal(result.event.defaultPrevented, undefined); assert.equal(f.dispatched.length, 0);
  }
});

test('只读、输入法、锁定区域、右键、修饰键和已处理的点击均不能新增段落', () => {
  for (const change of [f => { f.view.editable = false; }, f => { f.view.composing = true; }, f => { f.dom.closest = () => ({}); }]) {
    const f = fixture(); change(f); assert.equal(f.click().handled, false); assert.equal(f.operations.length, 0);
  }
  for (const event of [{ button: 2 }, { detail: 2 }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { defaultPrevented: true }]) {
    const f = fixture(); assert.equal(f.click(event).handled, false); assert.equal(f.operations.length, 0);
  }
});

test('短文档滚动容器留白也可点击，监听器销毁后移除，非法文档结构不插入', () => {
  const f = fixture(); const lifecycle = f.plugin.spec.view(f.view);
  f.viewportHandlers.get('mousedown')({ target: f.viewport, button: 0, detail: 1, clientX: 80, clientY: 200, preventDefault() {} });
  assert.equal(f.operations.length, 1); lifecycle.destroy(); assert.equal(f.viewportHandlers.size, 0);
  const constrained = fixture(); constrained.initialDoc.canReplaceWith = () => false;
  assert.equal(constrained.click().handled, false); assert.equal(constrained.operations.length, 0);
});
