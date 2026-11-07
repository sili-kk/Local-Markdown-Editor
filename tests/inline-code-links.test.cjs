const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../web/inline-code-links.js'), 'utf8');
const reference = 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/doc/filters.texi';
const plain = value => JSON.parse(JSON.stringify(value));
function context(extra = {}) { const c = vm.createContext({ URL, ...extra }); vm.runInContext(source, c); return c; }
function text(value, marks = ['code']) { return Object.freeze({ isText: true, type: { name: 'text' }, text: value, marks: marks.map(name => ({ type: { name } })) }); }
function documentWith(nodes, type = 'paragraph') {
  return Object.freeze({ descendants(visit) {
    if (visit({ type: { name: type } }, 0) === false) return;
    let position = 1;
    for (const node of nodes) { visit(node, position); position += node.text.length; }
  } });
}
function plugin(c) {
  return c.inlineCodeLinksPlugin({ pmState: {
    PluginKey: class { getState(state) { return state.links; } },
    Plugin: class { constructor(spec) { this.spec = spec; } },
  }, pmView: {
    Decoration: { inline: (from, to, attrs) => ({ from, to, attrs }) },
    DecorationSet: { empty: [], create: (_doc, decorations) => decorations },
  } }).wysiwygPlugins[0]().spec;
}

test('行内代码只识别完整 HTTP/HTTPS URL，支持 FFmpeg 文档地址、查询与片段', () => {
  const c = context();
  for (const value of [reference, 'http://example.org/a?q=1#part', '  https://example.org/guide  ']) {
    assert.equal(c.inlineCodeURL(value), new URL(value.trim()).href);
  }
  for (const value of ['', 'hqdn3d', 'guide.md', 'file:///D:/docs/a.md', 'javascript:alert(1)', 'data:text/html,test', 'https://[invalid', 'curl ' + reference, reference + ' more', '<https://example.org>']) {
    assert.equal(c.inlineCodeURL(value), null, value);
  }
});

test('表格内行内代码 URL 使用显示装饰，保留原始代码文字和文档模型', () => {
  const c = context(), spec = plugin(c), node = text('  ' + reference + '  ');
  const doc = documentWith([text('FFmpeg 官方过滤器文档源：', []), node], 'tableCell');
  const before = JSON.stringify(node), decorations = spec.state.init({}, { doc });
  assert.equal(decorations.length, 1);
  const decoration = decorations[0];
  assert.equal(decoration.from, 1 + 'FFmpeg 官方过滤器文档源：'.length + 2);
  assert.equal(decoration.to - decoration.from, reference.length);
  assert.equal(decoration.attrs['data-external-url'], reference);
  assert.equal(decoration.attrs.role, 'link'); assert.equal(decoration.attrs.tabindex, '0');
  assert.equal(JSON.stringify(node), before);
  assert.equal(spec.props.decorations({ links: decorations }), decorations);
});

test('代码命令、代码块、已有 Markdown 链接和普通文字不重复装饰', () => {
  const c = context(), spec = plugin(c);
  for (const [nodes, type] of [
    [[text('curl ' + reference)], 'paragraph'], [[text(reference)], 'codeBlock'],
    [[text(reference, ['code', 'link'])], 'paragraph'], [[text(reference, [])], 'paragraph'],
  ]) assert.deepEqual(plain(spec.state.init({}, { doc: documentWith(nodes, type) })), []);
});

test('光标变化不重新扫描文档，编辑 URL 后装饰随正文更新', () => {
  const c = context(), spec = plugin(c), doc = documentWith([text(reference)]);
  const original = spec.state.init({}, { doc });
  const moved = { docChanged: false, get doc() { throw Error('cursor must not scan'); } };
  assert.equal(spec.state.apply(moved, original), original);
  const changed = spec.state.apply({ docChanged: true, doc: documentWith([text('not a URL')]) }, original);
  assert.deepEqual(plain(changed), []);
  assert.equal(original.length, 1);
});

function interactions(url = reference) {
  const handlers = {}, opened = [], c = context({ window: { open: (...args) => opened.push(args) } });
  c.installInlineCodeLinkInteractions({ addEventListener(name, handler, capture) {
    assert.equal(capture, true); handlers[name] = handler;
  } });
  const link = { getAttribute: () => url };
  return { opened, send(overrides = {}) {
    const event = { type: 'click', button: 0, target: { closest: () => link },
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides };
    handlers[event.type](event); return event;
  } };
}

test('行内代码 URL 及其子元素单击或按 Enter，在新标签页打开一次', () => {
  for (const overrides of [{}, { ctrlKey: true }, { metaKey: true }, { type: 'keydown', key: 'Enter' }]) {
    const f = interactions(), event = f.send(overrides);
    assert.deepEqual(f.opened, [[reference, '_blank', 'noopener,noreferrer']]);
    assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  }
});

test('普通代码、右键、其他按键及已处理事件保持原编辑行为', () => {
  for (const overrides of [{ button: 1 }, { button: 2 }, { altKey: true }, { shiftKey: true }, { defaultPrevented: true }, { type: 'keydown', key: ' ' }, { target: { closest: () => null } }]) {
    const f = interactions(); assert.equal(f.send(overrides).prevented, undefined); assert.deepEqual(f.opened, []);
  }
  for (const url of ['javascript:alert(1)', 'https://[invalid', '']) {
    const f = interactions(url); assert.equal(f.send().prevented, undefined); assert.deepEqual(f.opened, []);
  }
});

test('阅读模式为行内 URL 增加可点击与键盘属性，保留代码文字及原有类名', () => {
  const c = context();
  function code(value, parent = null) {
    return { textContent: value, attributes: {}, classes: ['existing'], closest: () => parent,
      classList: { add(value) { this.owner.classes.push(value); } }, setAttribute(name, value) { this.attributes[name] = value; } };
  }
  const codes = [code(reference), code('curl ' + reference), code(reference, 'pre'), code(reference, 'a')];
  for (const item of codes) item.classList.owner = item;
  c.decorateReaderCodeLinks({ querySelectorAll: () => codes });
  assert.equal(codes[0].attributes['data-external-url'], reference);
  assert.equal(codes[0].attributes.role, 'link'); assert.equal(codes[0].attributes.tabindex, '0');
  assert.deepEqual(codes[0].classes, ['existing', 'inline-code-link']);
  for (const item of codes.slice(1)) assert.deepEqual(item.attributes, {});
  for (const item of [codes[0], codes[2], codes[3]]) assert.equal(item.textContent, reference);
});
