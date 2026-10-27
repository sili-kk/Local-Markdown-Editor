const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../web/editor-line-numbers.js'), 'utf8');

// Test geometry and the plugin's lifecycle without altering an editor document.
// Native text wrapping/layout still needs a real browser for visual verification.
function fixture({ count = 12, scale = 1, hidden = false, extras = [], storedWidth, storageBlocked = false } = {}) {
  const frames = new Map(), resizeObservers = [], windowHandlers = new Map(), fontHandlers = new Map();
  const storage = new Map(storedWidth === undefined ? [] : [['mojian.lineNumberWidth', String(storedWidth)]]);
  let frameID = 0, measurements = 0;
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.attributes = {}; this.handlers = new Map(); this.classes = new Set();
      this.classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value) }; }
    append(child) { if (child.tagName === 'FRAGMENT') { for (const item of child.children) this.append(item); } else { this.children.push(child); child.parentElement = this; } }
    replaceChildren(child) { this.children = []; if (child) this.append(child); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.handlers.set(name, callback); }
    removeEventListener(name) { this.handlers.delete(name); }
    remove() { this.parentElement.children = this.parentElement.children.filter(item => item !== this); }
    setPointerCapture(id) { this.pointer = id; }
    hasPointerCapture(id) { return this.pointer === id; }
    releasePointerCapture() { this.pointer = null; }
  }
  const viewport = new Element();
  viewport.style.setProperty = (name, value) => { viewport.style[name] = value; };
  viewport.style.removeProperty = name => { delete viewport.style[name]; };
  Object.assign(viewport, { offsetWidth: 800, clientTop: 0, clientHeight: 120, scrollTop: 0,
    scrollTo({ top }) { this.scrollTop = top; },
    getBoundingClientRect: () => ({ top: 40, width: 800 * scale }) });
  const physical = rect => ({ top: 40 + (rect.top - viewport.scrollTop) * scale, height: rect.height * scale });
  const texts = Array.from({ length: count }, (_, i) => ({ length: 5, rects: [{ top: 28 + i * 30, height: 18 }] }));
  const body = new Element(); viewport.append(body);
  Object.assign(body, { offsetHeight: count * 30 + 100,
    getBoundingClientRect: () => ({ top: 40 - viewport.scrollTop * scale }),
    getClientRects: () => hidden ? [] : [{ height: body.offsetHeight * scale }],
    querySelectorAll: selector => selector === 'br' ? [] : extras.map(rect => ({ textContent: '',
      getBoundingClientRect: () => physical(rect) })) });
  const document = {
    createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'),
    createTreeWalker: () => { let index = 0; return { nextNode: () => texts[index++] }; },
    createRange: () => { let node; measurements++; return { selectNodeContents: value => { node = value; }, getClientRects: () => node.rects.map(physical) }; },
    fonts: { ready: Promise.resolve(), addEventListener: (name, callback) => fontHandlers.set(name, callback), removeEventListener: name => fontHandlers.delete(name) },
  };
  const context = vm.createContext({ document, NodeFilter: { SHOW_TEXT: 4 }, getComputedStyle: () => ({ lineHeight: '30px' }),
    localStorage: { getItem: key => { if (storageBlocked) throw Error('storage disabled'); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (storageBlocked) throw Error('storage disabled'); storage.set(key, value); } },
    window: { addEventListener: (name, callback) => windowHandlers.set(name, callback), removeEventListener: name => windowHandlers.delete(name) },
    requestAnimationFrame: callback => { frames.set(++frameID, callback); return frameID; }, cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { constructor(callback) { this.callback = callback; this.observed = []; resizeObservers.push(this); } observe(node) { this.observed.push(node); } disconnect() { this.observed = []; } },
  });
  vm.runInContext(source, context);
  const view = { dom: body, state: { doc: Object.freeze({ original: true }) }, dispatch() { throw Error('Line numbers must not dispatch a transaction'); } };
  const plugin = context.editorLineNumbersPlugin({ pmState: { Plugin: class { constructor(spec) { this.spec = spec; } } } }).wysiwygPlugins[0]();
  const lifecycle = plugin.spec.view(view), gutter = viewport.children[1], handle = viewport.children[2];
  const flush = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); };
  return { context, viewport, body, view, texts, lifecycle, gutter, handle, storage, flush, frames, windowHandlers, fontHandlers, resizeObservers,
    get measurements() { return measurements; }, show: () => { hidden = false; } };
}

test('行号合并同一显示行的粗体/链接片段与表格单元格，保留换行和不同字号标题', () => {
  const context = vm.createContext({}); vm.runInContext(source, context);
  const rows = context.mergeEditorLineRects([{ top: 2, height: 18 }, { top: 0, height: 22 }, { top: 32, height: 18 },
    { top: 32, height: 18 }, { top: 70, height: 40 }, { top: 130, height: 18 }, { top: NaN, height: 15 }, { top: 200, height: 0 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{ top: 0, height: 22 }, { top: 32, height: 18 }, { top: 70, height: 40 }, { top: 130, height: 18 }]);
});

test('行号独立于文档与剪贴板，缩放 50%/100%/150% 后仍按正文坐标对齐', () => {
  for (const scale of [.5, 1, 1.5]) {
    const f = fixture({ scale });
    try {
      f.flush();
      assert.equal(f.gutter.attributes['aria-hidden'], 'true');
      assert.equal(f.gutter.attributes.contenteditable, 'false');
      assert.equal(f.body.children.length, 0);
      assert.equal(f.view.state.doc.original, true);
      assert.equal(f.gutter.children[0].textContent, '1');
      assert.equal(f.gutter.children[0].style.top, '28px');
      assert.equal(f.gutter.children[0].style.height, '18px');
      assert.equal(f.gutter.children[1].style.top, '58px');
    } finally { f.lifecycle.destroy(); }
  }
});

test('长文档只创建可见行号，滚动不重新测量正文，不因可见范围变化重新从 1 编号', () => {
  const f = fixture({ count: 5000 });
  try {
    f.flush(); f.flush(); assert.ok(f.gutter.children.length < 20);
    const before = f.measurements;
    f.viewport.scrollTop = 6000; f.viewport.handlers.get('scroll')(); f.viewport.handlers.get('scroll')();
    assert.equal(f.frames.size, 1); f.flush();
    assert.equal(f.measurements, before);
    assert.ok(Number(f.gutter.children[0].textContent) > 100);
    assert.ok(f.gutter.children.length < 20);
    const saved = f.gutter.children;
    f.viewport.handlers.get('scroll')(); f.flush(); assert.equal(f.gutter.children, saved);
  } finally { f.lifecycle.destroy(); }
});

const pointer = (pointerId, clientX, extra = {}) => ({ pointerId, clientX, button: 0, preventDefault() {}, stopPropagation() {}, ...extra });

test('行号栏默认收窄，缩放下拖动按实际比例调整、限制宽度，松手后记忆', () => {
  for (const scale of [.5, 1, 1.5]) {
    const f = fixture({ scale });
    try {
      f.flush();
      assert.equal(f.viewport.style['--editor-line-width'], '36px');
      assert.equal(f.handle.attributes.role, 'separator');
      assert.equal(f.handle.attributes['aria-orientation'], 'vertical');
      assert.equal(f.handle.tabIndex, 0);
      f.handle.handlers.get('pointerdown')(pointer(1, 100));
      f.handle.handlers.get('pointermove')(pointer(2, 500));
      assert.equal(f.viewport.style['--editor-line-width'], '36px');
      f.handle.handlers.get('pointermove')(pointer(1, 100 + 20 * scale));
      assert.equal(f.viewport.style['--editor-line-width'], '56px');
      assert.equal(f.storage.has('mojian.lineNumberWidth'), false);
      // The final pointerup position is used even without a last pointermove.
      f.handle.handlers.get('pointerup')(pointer(1, 100 + 24 * scale));
      assert.equal(f.storage.get('mojian.lineNumberWidth'), '60');
      assert.equal(f.handle.pointer, null);
      assert.equal(f.viewport.classes.has('editor-line-resizing'), false);
      f.viewport.scrollTop = 90; f.viewport.handlers.get('scroll')(); f.flush();
      assert.equal(f.handle.style.transform, 'translateY(90px)');
      assert.equal(f.handle.style.height, '120px');
      assert.equal(f.view.state.doc.original, true);
      const reopened = fixture({ storedWidth: f.storage.get('mojian.lineNumberWidth') });
      assert.equal(reopened.viewport.style['--editor-line-width'], '60px'); reopened.lifecycle.destroy();
    } finally { f.lifecycle.destroy(); }
    assert.equal(f.viewport.style['--editor-line-width'], undefined);
  }
});

test('键盘调节和双击重置，长文档保护多位行号，损坏或不可用存储可降级', () => {
  for (const storedWidth of [undefined, '', 'broken', -1, 999]) {
    const f = fixture({ storedWidth });
    try { assert.equal(f.viewport.style['--editor-line-width'], '36px'); } finally { f.lifecycle.destroy(); }
  }
  const f = fixture({ storedWidth: 40 });
  try {
    const key = (key, shiftKey = false) => f.handle.handlers.get('keydown')({ key, shiftKey, preventDefault() {}, stopPropagation() {} });
    key('ArrowLeft'); assert.equal(f.storage.get('mojian.lineNumberWidth'), '36');
    key('ArrowRight', true); assert.equal(f.storage.get('mojian.lineNumberWidth'), '48');
    key('Home'); assert.equal(f.storage.get('mojian.lineNumberWidth'), '28');
    key('End'); key('ArrowRight'); assert.equal(f.storage.get('mojian.lineNumberWidth'), '96');
    f.handle.handlers.get('dblclick')({ preventDefault() {} });
    assert.equal(f.storage.get('mojian.lineNumberWidth'), '36');
  } finally { f.lifecycle.destroy(); }
  const long = fixture({ count: 10000, storedWidth: 28 });
  try {
    long.flush(); long.flush();
    assert.equal(long.viewport.style['--editor-line-width'], '49px');
    assert.equal(long.handle.attributes['aria-valuemin'], 49);
    assert.ok(long.gutter.children.length < 20);
  } finally { long.lifecycle.destroy(); }
  const blocked = fixture({ storageBlocked: true });
  blocked.handle.handlers.get('dblclick')({ preventDefault() {} }); blocked.lifecycle.destroy();
});

test('取消、丢失捕获、失焦、Esc 与销毁都会结束拖动并恢复原宽度，不污染文档', () => {
  for (const reason of ['pointercancel', 'lostpointercapture', 'blur', 'Escape', 'destroy']) {
    const f = fixture({ storedWidth: 44 }); f.flush();
    f.handle.handlers.get('pointerdown')(pointer(1, 100, { button: 2 }));
    assert.equal(f.handle.pointer, undefined);
    f.handle.handlers.get('pointerdown')(pointer(1, 100));
    f.handle.handlers.get('pointermove')(pointer(1, 1000));
    assert.equal(f.viewport.style['--editor-line-width'], '96px');
    if (reason === 'blur') f.windowHandlers.get('blur')();
    else if (reason === 'Escape') f.windowHandlers.get('keydown')({ key: 'Escape', preventDefault() {} });
    else if (reason === 'destroy') f.lifecycle.destroy();
    else f.handle.handlers.get(reason)(pointer(1, 1000));
    assert.equal(f.storage.get('mojian.lineNumberWidth'), '44');
    assert.equal(f.viewport.classes.has('editor-line-resizing'), false);
    assert.equal(f.handle.pointer, null); assert.equal(f.view.state.doc.original, true);
    if (reason !== 'destroy') {
      assert.equal(f.viewport.style['--editor-line-width'], '44px');
      f.lifecycle.destroy();
    }
    assert.equal(f.windowHandlers.size, 0); assert.equal(f.frames.size, 0); assert.equal(f.viewport.children.length, 1);
  }
});

test('编辑、图片加载、调整尺寸与字体加载会重新计算，选择光标不触发全篇扫描', () => {
  const f = fixture();
  try {
    f.flush(); const first = f.measurements;
    f.lifecycle.update(f.view, f.view.state); assert.equal(f.frames.size, 0);
    const previous = f.view.state;
    f.view.state = { doc: {} };
    f.texts[0].rects.push({ top: 48, height: 8 });
    f.lifecycle.update(f.view, previous); f.flush(); assert.equal(f.measurements, first + 1);
    f.body.handlers.get('load')(); f.windowHandlers.get('resize')(); f.fontHandlers.get('loadingdone')();
    f.resizeObservers[0].callback(); assert.equal(f.frames.size, 1);
    f.flush(); assert.equal(f.measurements, first + 2);
  } finally { f.lifecycle.destroy(); }
});

test('空段落与独立图片有行号，隐藏后重新显示正常计算；销毁时取消帧并清理监听', async () => {
  const f = fixture({ count: 0, hidden: true, extras: [{ top: 28, height: 30 }, { top: 100, height: 300 }] });
  f.flush(); assert.equal(f.measurements, 0);
  f.show(); f.resizeObservers[0].callback(); f.flush();
  assert.deepEqual(f.gutter.children.map(node => node.textContent), ['1', '2']);
  f.windowHandlers.get('resize')(); assert.equal(f.frames.size, 1);
  f.lifecycle.destroy(); await Promise.resolve();
  assert.equal(f.frames.size, 0); assert.equal(f.viewport.children.length, 1);
  assert.equal(f.viewport.handlers.size, 0); assert.equal(f.body.handlers.size, 0);
  assert.equal(f.windowHandlers.size, 0); assert.equal(f.fontHandlers.size, 0);
  assert.equal(f.resizeObservers[0].observed.length, 0);
  assert.equal(f.viewport.classes.size, 0);
});

test('按显示行号跳转，在缩放下定位并标记目标行，非法行号保持原位置且不改正文', () => {
  for (const scale of [.5, 1, 1.5]) {
    const f = fixture({ count: 500, scale });
    try {
      const lines = f.viewport.editorLineNumbers;
      const result = lines.jump('250'); // Measurement is pending; do not rely on a paint first.
      assert.equal(result.ok, true); assert.equal(result.count, 500);
      assert.equal(f.viewport.scrollTop, 28 + 249 * 30 - 34);
      f.flush();
      assert.equal(f.gutter.children.find(node => node.textContent === '250').className, 'editor-line-number is-line-target');
      const target = f.viewport.children[3]; assert.equal(target.hidden, false); assert.equal(target.style.top, '7498px');
      // Layout can change before ResizeObserver delivers its notification.
      f.texts[249].rects[0].top += 5;
      assert.equal(lines.jump('250').ok, true);
      assert.equal(f.viewport.scrollTop, 7503 - 34);
      const before = f.viewport.scrollTop;
      for (const invalid of ['', 'abc', '-1', '0', '1.5', '501', '9e1', 'Infinity']) {
        assert.equal(lines.jump(invalid).ok, false); assert.equal(f.viewport.scrollTop, before);
      }
      assert.equal(f.view.state.doc.original, true);
      const old = f.view.state; f.view.state = { doc: {} }; f.texts.splice(10);
      f.lifecycle.update(f.view, old);
      assert.equal(lines.jump('11').ok, false); assert.equal(lines.count, 10); assert.equal(target.hidden, true);
    } finally { f.lifecycle.destroy(); }
    assert.equal(f.viewport.editorLineNumbers, undefined);
  }
});
