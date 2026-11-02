const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Event routing contract; native layout and editing use the browser regression.
const source = fs.readFileSync(path.join(__dirname, '../web/editor-code-block.js'), 'utf8');
function fixture(factory) {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const plugin = context.editorCodeBlockPlugin({ pmState: {
    Plugin: class { constructor(spec) { this.spec = spec; } },
  } }).wysiwygPlugins[0]();
  const image = () => {};
  const view = { props: { nodeViews: { codeBlock: factory, image } },
    setProps(props) { Object.assign(this.props, props); } };
  plugin.spec.view(view);
  return { plugin, view, image };
}

test('代码正文将输入法、输入、回车及粘贴事件交给编辑器，保留语言选择控件的事件隔离', () => {
  const code = {}, text = {}, label = {}, input = {};
  const calls = [];
  const native = { contentDOM: { contains: target => target === code || target === text },
    stopEvent(event) { assert.equal(this, native); calls.push(event); return true; } };
  const { view, image } = fixture(() => native);
  const node = view.props.nodeViews.codeBlock();
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'keydown', 'paste', 'cut']) {
    assert.equal(node.stopEvent({ type, target: code }), false, type);
    assert.equal(node.stopEvent({ type, target: text }), false, type + ' text node');
  }
  assert.equal(calls.length, 0);
  for (const target of [label, input, null]) assert.equal(node.stopEvent({ type: 'keydown', target }), true);
  assert.equal(calls.length, 3);
  assert.equal(view.props.nodeViews.image, image);
});

test('保留原生代码块的节点、光标位置、更新及销毁行为', () => {
  const args = [{ type: 'codeBlock' }, { name: 'editor view' }, () => 42, ['decoration']];
  let received, updated = 0, destroyed = 0;
  const native = { dom: {}, contentDOM: { contains: () => true },
    update(node) { assert.equal(node, args[0]); updated++; return true; }, destroy() { destroyed++; } };
  const { view } = fixture((...values) => { received = values; return native; });
  const node = view.props.nodeViews.codeBlock(...args);
  assert.deepEqual(received, args);
  assert.equal(node, native);
  assert.equal(node.update(args[0]), true);
  node.destroy();
  assert.equal(updated, 1);
  assert.equal(destroyed, 1);
  assert.equal(node.stopEvent({ target: {} }), false);
});

test('重复初始化不会层层包装代码块，缺少原生代码块时保留其他节点视图', () => {
  const { plugin, view, image } = fixture(() => ({ contentDOM: { contains: () => true } }));
  const first = view.props.nodeViews.codeBlock;
  plugin.spec.view(view);
  assert.equal(view.props.nodeViews.codeBlock, first);
  delete view.props.nodeViews.codeBlock;
  plugin.spec.view(view);
  assert.equal(view.props.nodeViews.image, image);
});
