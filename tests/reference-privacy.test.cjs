const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Exercise event handlers and asynchronous responses without loading a browser
// or touching the user's documents. This does not assert browser rendering.
function fixture(api, reference = '/assets/@0123456789abcdef/pic.png?__local_ref=example') {
  const navigations = [], notices = [], copiedPaths = [];
  const documentHandlers = {}, windowHandlers = {};
  const ui = { scrollOnMenuFocus: false };
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.handlers = {}; this.attributes = {}; this.dataset = {}; this.style = {}; this.children = []; this.hidden = false; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    removeAttribute(name) { delete this.attributes[name]; }
    append(...children) { this.children.push(...children); }
    addEventListener(name, listener) { this.handlers[name] = listener; }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    closest(selector) { return selector.includes('ProseMirror') ? root : this; }
    getBoundingClientRect() { return { left: 10, bottom: 20, width: 200, height: 100 }; }
    get isConnected() { return root.contains(this) || body.contains(this); }
    focus(options) {
      this.focusOptions = options; document.activeElement = this;
      // Editor selection/focus adjustments can emit an asynchronous scroll
      // even when the menu itself requests preventScroll.
      if (ui.scrollOnMenuFocus && menu.contains(this)) queueMicrotask(() => documentHandlers.scroll?.({ target: root }));
    }
    showModal() { this.open = true; }
    close() { this.open = false; this.handlers.close?.(); }
    set srcdoc(value) { this.attributes.srcdoc = value; }
    get srcdoc() { return this.attributes.srcdoc; }
  }
  const root = new Element('div'), link = new Element('a'), body = new Element('body');
  link.setAttribute('href', reference); root.append(link);
  const state = { path: '@0123456789abcdef/doc.md', localAdmin: false, directories: [] };
  const document = { createElement: tag => new Element(tag), body, activeElement: body,
    addEventListener(name, listener) { documentHandlers[name] = listener; } };
  const context = vm.createContext({ Element, state, URL, URLSearchParams, AbortController, api,
    location: { origin: 'http://127.0.0.1:8081' }, innerWidth: 1000, innerHeight: 800,
    document,
    window: { addEventListener(name, listener) { windowHandlers[name] = listener; } },
    navigator: { clipboard: { writeText: async value => copiedPaths.push(value) } }, notice: message => notices.push(message), displayLibraryPath: value => value,
    navigate: async target => { navigations.push(target); return false; },
    setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/resources.js'), 'utf8'), context);
  context.installResourceInteractions(root);
  const [tooltip, menu] = body.children;
  return { root, link, state, tooltip, menu, body, context, document, documentHandlers, windowHandlers, ui, copiedPaths, navigations, notices, click: (target = link) => {
    const event = { target, button: 0, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    root.handlers.click(event); return event;
  }, focus: async () => {
    root.handlers.focusin({ target: link });
    await new Promise(setImmediate);
  } };
}

test('远端失败提示不回显绝对引用或包含路径的错误', async () => {
  const f = fixture(async () => { throw Error('cannot read D:/private/secret.png'); }, 'D:/private/secret.png');
  await f.focus();
  assert.equal(f.tooltip.children[0].textContent, '资源不存在或不可访问');
  assert.doesNotMatch(f.tooltip.children[2].textContent, /D:|private|secret/);
});

test('Markdown 路径缩写：配置目录保留 doc 和子目录，盘符、file、UNC 与脱敏引用不显示前缀', () => {
  const f = fixture(async () => ({}));
  f.state.directories = [{ id: '@root', path: 'D:\\workspace\\project\\doc', name: '文档' },
    { id: '@nested', path: 'D:\\workspace\\project\\doc\\nested', name: '子目录' },
    { id: '@single', path: 'D:\\workspace\\single\\note.md', is_file: true }];
  f.context.displayLibraryPath = path => path.replace('@root', '文档');
  for (const [input, expected] of [
    ['D:/workspace/project/doc/part/guide.md', '.../doc/part/guide.md'],
    ['d:\\workspace\\project\\doc\\part\\guide.md', '.../doc/part/guide.md'],
    ['file:///D:/workspace/project/doc/part/guide%20one.md', '.../doc/part/guide one.md'],
    ['file:///D:/workspace/project/doc/part/guide%23one.md', '.../doc/part/guide#one.md'],
    ['file:///D:/workspace/project/doc/part/guide%2520one.md', '.../doc/part/guide%20one.md'],
    ['D:/workspace/project/doc/nested/guide.md', '.../nested/guide.md'],
    ['D:/workspace/single/note.md', '.../single/note.md'],
    ['\\\\server\\share\\doc\\part\\guide.md', '.../doc/part/guide.md'],
    ['/home/private/doc/part/guide.md', '.../doc/part/guide.md'],
    ['D:/unconfigured/folder/note.md', '.../folder/note.md'],
    ['/assets/@root/guide.md?__local_ref=example#chapter', '.../文档/guide.md'],
    ['../guide.md', '../guide.md'],
  ]) assert.equal(f.context.compactResourcePath(input), expected);
});

function renderMarkdownLink(f, reference, title = null) {
  const attrs = Object.freeze({ linkUrl: reference, title });
  const mark = Object.freeze({ attrs, type: { spec: { toDOM: () => ['a', { href: reference, title, target: '_blank', rel: 'noopener noreferrer' }] } } });
  const rendered = f.context.localMarkdownLinksPlugin().wysiwygNodeViews.link(mark);
  f.root.append(rendered.dom);
  return { ...rendered, mark };
}

test('Markdown 链接渲染仅缩写标题与浏览器地址，模型原链接及本页导航保持原样', async () => {
  for (const reference of ['D:/workspace/project/doc/guide.MD', 'file:///D:/workspace/project/doc/guide.markdown', '../guide.md', '/assets/@0123456789abcdef/guide.md?__local_ref=example#chapter']) {
    const requests = [];
    const f = fixture(async (url, options) => {
      requests.push(JSON.parse(options.body));
      return { path: 'D:/workspace/project/doc/guide.MD', exists: true, document_path: '@0123456789abcdef/guide.md' };
    });
    f.state.localAdmin = true;
    f.state.directories = [{ id: '@0123456789abcdef', path: 'D:/workspace/project/doc', name: '文档' }];
    const { dom, contentDOM, mark } = renderMarkdownLink(f, reference, 'D:/workspace/project/doc/guide.MD');
    assert.equal(contentDOM, dom, 'editable link text stays in the original model content');
    assert.equal(dom.getAttribute('href'), '#');
    assert.doesNotMatch(dom.getAttribute('title'), /D:|workspace|file:|__local_ref/);
    assert.match(dom.getAttribute('title'), /本页查看/);
    assert.equal(dom.dataset.resourceReference, reference);
    assert.equal(mark.attrs.linkUrl, reference); assert.equal(mark.attrs.title, 'D:/workspace/project/doc/guide.MD');
    const event = f.click(dom); await new Promise(setImmediate);
    assert.equal(event.prevented, true);
    assert.deepEqual(requests, [{ path: '@0123456789abcdef/doc.md', reference }]);
    assert.deepEqual(f.navigations, ['@0123456789abcdef/guide.md']);
    assert.equal(f.state.path, '@0123456789abcdef/doc.md');
  }
});

test('本机 Markdown 悬停成功和失败都隐藏绝对路径，成功仍提供本页查看；图片保留原行为', async () => {
  const f = fixture(async () => ({ path: 'D:/workspace/project/doc/part/guide.md', exists: true, document_path: '@0123456789abcdef/part/guide.md' }), 'D:/workspace/project/doc/part/guide.md');
  f.state.localAdmin = true; await f.focus();
  assert.equal(f.tooltip.children[0].textContent, '.../doc/part/guide.md');
  assert.equal(f.tooltip.children[3].hidden, false);
  f.tooltip.children[3].onclick(); await new Promise(setImmediate);
  assert.deepEqual(f.navigations, ['@0123456789abcdef/part/guide.md']);
  const failure = fixture(async () => { throw Error('cannot read D:/private/doc/guide.md'); }, 'D:/private/doc/guide.md');
  failure.state.localAdmin = true; await failure.focus();
  assert.equal(failure.tooltip.children[0].textContent, '.../doc/guide.md');
  assert.doesNotMatch(failure.tooltip.children[2].textContent, /D:|private/);
  failure.click(); await new Promise(setImmediate); assert.doesNotMatch(failure.notices[0], /D:|private/);
  const image = fixture(async () => ({ path: 'D:/workspace/doc/pic.png', exists: true }), 'pic.png');
  image.state.localAdmin = true; await image.focus();
  assert.equal(image.tooltip.children[0].textContent, 'D:/workspace/doc/pic.png');
});

test('外部 Markdown、普通链接、HTML 和图片链接保持原渲染；查询参数中的 .md 不误判', () => {
  const f = fixture(async () => ({}));
  for (const reference of ['https://example.org/guide.md', 'mailto:person@example.org', 'pic.png', 'page.html', 'image.png?name=guide.md', '#guide.md']) {
    const { dom } = renderMarkdownLink(f, reference, '原有标题');
    assert.equal(dom.getAttribute('href'), reference);
    assert.equal(dom.getAttribute('title'), '原有标题');
    assert.equal(dom.dataset.resourceReference, undefined);
  }
});

test('引用右键菜单：焦点引发正文滚动后保持显示，鼠标移开仍可选择复制', async () => {
  const f = fixture(async () => ({ path: '@0123456789abcdef/file.html', exists: true, can_open: false, can_reveal: false }), 'file.html');
  f.ui.scrollOnMenuFocus = true;
  const event = { target: f.link, clientX: 900, clientY: 700, preventDefault() {}, stopPropagation() {} };
  f.root.handlers.contextmenu(event); await new Promise(setImmediate);
  assert.equal(f.menu.hidden, false, 'focus-triggered editor scroll must not dismiss menu');
  assert.equal(f.document.activeElement, f.menu.children[2]);
  f.root.handlers.pointerout({ relatedTarget: f.menu });
  f.root.handlers.focusout({ relatedTarget: f.menu.children[2] });
  f.documentHandlers.scroll({ target: f.menu });
  f.documentHandlers.scroll({ target: f.root });
  assert.equal(f.menu.hidden, false);
  f.documentHandlers.pointerdown({ target: f.menu.children[2], button: 0 });
  await f.menu.children[2].onclick();
  assert.deepEqual(f.copiedPaths, ['@0123456789abcdef/file.html']);
  assert.equal(f.menu.hidden, true); assert.deepEqual(f.navigations, []);
  assert.equal(f.link.focusOptions.preventScroll, true);
});

test('引用右键菜单：加载中及旧悬停请求返回后保持显示，焦点和悬停不重开预览', async () => {
  const pending = [];
  const f = fixture(() => new Promise(resolve => pending.push(resolve)));
  f.root.handlers.focusin({ target: f.link });
  f.root.handlers.contextmenu({ target: f.link, clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} });
  assert.equal(f.document.activeElement, f.menu);
  f.documentHandlers.scroll({ target: f.root });
  f.root.handlers.focusin({ target: f.link });
  f.root.handlers.pointerover({ target: f.link });
  assert.equal(pending.length, 2); assert.equal(f.menu.hidden, false);
  pending[0]({ path: '@0123456789abcdef/pic.png', exists: true, is_image: true });
  await new Promise(setImmediate);
  assert.equal(f.tooltip.hidden, true); assert.equal(f.menu.hidden, false);
  pending[1]({ path: '@0123456789abcdef/pic.png', exists: true, can_open: false, can_reveal: false });
  await new Promise(setImmediate);
  assert.equal(f.menu.children[2].disabled, false);
  f.root.handlers.focusin({ target: f.link });
  await new Promise(setImmediate);
  assert.equal(f.tooltip.hidden, true); assert.equal(f.menu.hidden, false);
  f.root.handlers.resourcehide();
});

test('引用右键菜单：缩放窗口重新限位，内部点击和键盘选择不关闭，主动关闭后旧请求不重开', async () => {
  for (const dismissal of ['outside', 'Escape', 'Tab', 'blur', 'resourcehide']) {
    let respond;
    const f = fixture(() => new Promise(resolve => { respond = resolve; }));
    f.root.handlers.contextmenu({ target: f.link, clientX: 980, clientY: 790, preventDefault() {}, stopPropagation() {} });
    f.context.innerWidth = 500; f.context.innerHeight = 300;
    f.windowHandlers.resize(); assert.equal(f.menu.hidden, false);
    assert.ok(parseFloat(f.menu.style.left) <= 500 - 200 - 8);
    assert.ok(parseFloat(f.menu.style.top) <= 300 - 100 - 8);
    f.documentHandlers.pointerdown({ target: f.menu, button: 0 }); assert.equal(f.menu.hidden, false);
    if (dismissal === 'outside') f.documentHandlers.pointerdown({ target: f.body, button: 0 });
    else if (dismissal === 'blur') f.windowHandlers.blur();
    else if (dismissal === 'resourcehide') f.root.handlers.resourcehide();
    else f.documentHandlers.keydown({ key: dismissal });
    assert.equal(f.menu.hidden, true);
    respond({ path: '@0123456789abcdef/pic.png', exists: true }); await new Promise(setImmediate);
    assert.equal(f.menu.hidden, true);
    assert.deepEqual(f.notices, []);
  }
});

test('引用右键菜单：本机打开和定位仍可选择，方向键切换可用项，Shift 右键保留原生菜单', async () => {
  for (const action of ['open', 'reveal']) {
    const requests = [];
    const f = fixture(async (url, options) => {
      requests.push({ url, ...JSON.parse(options.body) });
      return { path: 'D:/notes/pic.png', exists: true, can_open: true, can_reveal: true };
    });
    f.state.localAdmin = true; f.ui.scrollOnMenuFocus = true;
    const event = { target: f.link, clientX: 80, clientY: 90, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    f.root.handlers.contextmenu({ ...event, shiftKey: true });
    assert.equal(f.menu.hidden, true); assert.equal(requests.length, 0);
    f.root.handlers.contextmenu(event); await new Promise(setImmediate);
    assert.equal(event.prevented, true); assert.equal(f.menu.hidden, false);
    assert.equal(f.document.activeElement, f.menu.children[0]);
    f.menu.handlers.keydown({ key: 'ArrowDown', preventDefault() {} });
    await new Promise(setImmediate);
    assert.equal(f.document.activeElement, f.menu.children[1]); assert.equal(f.menu.hidden, false);
    await f.menu.children[action === 'open' ? 0 : 1].onclick();
    assert.equal(f.menu.hidden, true);
    assert.equal(requests[1].url, '/api/resource/' + action);
    assert.equal(requests[1].reference, '/assets/@0123456789abcdef/pic.png?__local_ref=example');
    assert.deepEqual(f.notices, []);
  }
});

test('引用右键菜单：连续右键只应用最新目标，远端错误不回显本机路径', async () => {
  const pending = [];
  const f = fixture(() => new Promise(resolve => pending.push(resolve)));
  const event = { target: f.link, clientX: 80, clientY: 90, preventDefault() {}, stopPropagation() {} };
  f.root.handlers.contextmenu(event);
  f.link.setAttribute('href', 'second.png'); f.root.handlers.contextmenu(event);
  pending[1]({ path: '@0123456789abcdef/second.png', exists: true }); await new Promise(setImmediate);
  pending[0]({ path: '@0123456789abcdef/first.png', exists: true }); await new Promise(setImmediate);
  await f.menu.children[2].onclick();
  assert.deepEqual(f.copiedPaths, ['@0123456789abcdef/second.png']);
  const failed = fixture(async () => { throw Error('cannot read D:/private/secret.png'); });
  failed.root.handlers.contextmenu({ ...event, target: failed.link }); await new Promise(setImmediate);
  assert.equal(failed.menu.hidden, true); assert.doesNotMatch(failed.notices[0], /D:|private|secret/);
});

test('远端预览和右键只使用相对资源地址和相对路径', async () => {
  const f = fixture(async () => ({ path: '@0123456789abcdef/pic.png', exists: true, is_image: true, can_open: false, can_reveal: false }));
  await f.focus();
  const preview = f.tooltip.children[1], image = preview.children[0];
  image.onload();
  assert.match(preview.href, /^\/api\/resource\/image\?/);
  assert.doesNotMatch(decodeURIComponent(preview.href), /[a-z]:[\\/]|file:/i);
  assert.equal(f.tooltip.children[0].textContent, '@0123456789abcdef/pic.png');
  f.root.handlers.contextmenu({ target: f.link, preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 20 });
  await new Promise(setImmediate);
  assert.equal(f.menu.children[0].disabled, true);
  assert.equal(f.menu.children[1].disabled, true);
  assert.equal(f.menu.children[2].textContent, '复制相对路径');
});

test('本机和远端不复用资源路径缓存', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { path: f.state.localAdmin ? 'D:/private/pic.png' : '@0123456789abcdef/pic.png', exists: true };
  });
  f.state.localAdmin = true; await f.focus();
  assert.equal(f.tooltip.children[0].textContent, 'D:/private/pic.png');
  f.state.localAdmin = false; await f.focus();
  assert.equal(calls, 2);
  assert.equal(f.tooltip.children[0].textContent, '@0123456789abcdef/pic.png');
});

test('身份降权后到达的本机元数据不会显示绝对路径', async () => {
  let respond;
  const f = fixture(() => new Promise(resolve => { respond = resolve; }));
  f.state.localAdmin = true;
  f.root.handlers.focusin({ target: f.link });
  f.state.localAdmin = false;
  respond({ path: 'D:/private/pic.png', exists: true });
  await new Promise(setImmediate);
  assert.equal(f.tooltip.children[0].textContent, '资源不存在或不可访问');
});

test('命中本机缓存后立刻降权也不会显示绝对路径', async () => {
  const f = fixture(async () => ({ path: 'D:/private/pic.png', exists: true }));
  f.state.localAdmin = true; await f.focus();
  f.root.handlers.focusin({ target: f.link });
  f.state.localAdmin = false;
  await new Promise(setImmediate);
  assert.equal(f.tooltip.children[0].textContent, '资源不存在或不可访问');
});

test('Markdown 相对、盘符、file 和脱敏链接单击复用当前页面导航', async () => {
  for (const ref of ['../guide.MD', 'D:/docs/guide.md', 'file:///D:/docs/guide.markdown', '/assets/@0123456789abcdef/guide.md?__local_ref=example#chapter', 'guide%2Emd']) {
    const f = fixture(async () => ({ path: '@0123456789abcdef/guide.md', exists: true, document_path: '@0123456789abcdef/guide.md' }), ref);
    const event = f.click();
    assert.equal(event.prevented, true); assert.equal(event.stopped, true);
    await new Promise(setImmediate);
    assert.deepEqual(f.navigations, ['@0123456789abcdef/guide.md']);
    // A cancelled/failed save in navigate must leave the current view intact.
    assert.equal(f.state.path, '@0123456789abcdef/doc.md');
  }
});

test('Markdown 悬停预览提供本页查看按钮', async () => {
  const f = fixture(async () => ({ path: '@0123456789abcdef/guide.md', exists: true, document_path: '@0123456789abcdef/guide.md' }), 'guide.md');
  await f.focus();
  const button = f.tooltip.children[3];
  assert.equal(button.hidden, false);
  assert.deepEqual(f.navigations, []);
  button.onclick(); await new Promise(setImmediate);
  assert.deepEqual(f.navigations, ['@0123456789abcdef/guide.md']);
  assert.equal(f.tooltip.hidden, true);
});

test('无权限或缺失的 Markdown 点击不会导航，也不回显底层路径', async () => {
  for (const api of [async () => { throw Error('cannot read D:/private/secret.md'); }, async () => ({ path: '@0123456789abcdef/guide.md', exists: false, document_path: '' })]) {
    const f = fixture(api, 'guide.md'); f.click(); await new Promise(setImmediate);
    assert.deepEqual(f.navigations, []);
    assert.match(f.notices[0], /不可访问/);
    assert.doesNotMatch(f.notices[0], /D:|private/);
  }
});

test('连续点击 Markdown 只打开最新目标，切换文档会取消旧请求', async () => {
  const pending = [];
  const f = fixture(() => new Promise(resolve => pending.push(resolve)), 'first.md');
  f.click(); f.link.setAttribute('href', 'second.md'); f.click();
  pending[1]({ path: '@0123456789abcdef/second.md', exists: true, document_path: '@0123456789abcdef/second.md' });
  await new Promise(setImmediate);
  pending[0]({ path: '@0123456789abcdef/first.md', exists: true, document_path: '@0123456789abcdef/first.md' });
  await new Promise(setImmediate);
  assert.deepEqual(f.navigations, ['@0123456789abcdef/second.md']);
  f.link.setAttribute('href', 'third.md'); f.click(); f.root.handlers.resourcehide();
  pending[2]({ path: '@0123456789abcdef/third.md', exists: true, document_path: '@0123456789abcdef/third.md' });
  await new Promise(setImmediate);
  assert.equal(f.navigations.length, 1);
});

test('外部链接和普通图片不被 Markdown 单击处理接管', () => {
  for (const ref of ['https://example.org/guide.md', 'https://example.org/page.html', 'pic.png', '#chapter']) {
    const f = fixture(async () => { throw Error('unexpected metadata call'); }, ref);
    assert.equal(f.click().prevented, undefined);
    assert.deepEqual(f.navigations, []);
  }
});

test('HTML/HTM 相对、盘符、file、编码和脱敏链接单击在本页沙箱预览，不切换或保存 Markdown', async () => {
  for (const reference of ['../page.HTML', 'page.htm', 'D:/docs/page.html', 'file:///D:/docs/page.htm', 'page%2Ehtml', '/assets/@0123456789abcdef/page.html?__local_ref=example#chapter']) {
    const requests = [];
    const source = '<html><body><h1>HTML</h1><script>document.body.dataset.ready = "yes"</script></body></html>';
    const f = fixture(async (url, options) => {
      requests.push({ url, ...JSON.parse(options.body) });
      return { path: '@0123456789abcdef/page.html', content: source };
    }, reference);
    const event = f.click(); await new Promise(setImmediate);
    assert.equal(event.prevented, true); assert.equal(event.stopped, true);
    assert.deepEqual(requests, [{ url: '/api/resource/html', path: '@0123456789abcdef/doc.md', reference }]);
    const dialog = f.body.children[2], frame = dialog.children[1];
    assert.equal(dialog.open, true);
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
    assert.match(frame.srcdoc, /^<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"/);
    assert.ok(frame.srcdoc.endsWith(source));
    assert.match(frame.srcdoc, /default-src 'none'/);
    assert.match(frame.srcdoc, /base-uri 'none'; form-action 'none'/);
    assert.doesNotMatch(frame.srcdoc.split(source)[0], /allow-same-origin|https?:|unsafe-eval/);
    assert.deepEqual(f.navigations, []); assert.equal(f.state.path, '@0123456789abcdef/doc.md');
    dialog.children[0].children[1].onclick();
    assert.equal(dialog.open, false); assert.equal(frame.srcdoc, undefined);
  }
});

test('HTML 悬停按钮使用预览接口；Esc、关闭和切换文档清空 iframe 停止内容', async () => {
  const f = fixture(async url => url === '/api/resource' ? { path: '@0123456789abcdef/page.html', exists: true, html_path: '@0123456789abcdef/page.html' }
    : { path: '@0123456789abcdef/page.html', content: '<h1>hello</h1>' }, 'page.html');
  await f.focus(); const button = f.tooltip.children[3];
  assert.equal(button.hidden, false); assert.equal(button.dataset.kind, 'html');
  button.onclick(); await new Promise(setImmediate);
  const dialog = f.body.children[2], frame = dialog.children[1];
  assert.equal(dialog.open, true);
  dialog.handlers.cancel(); dialog.close(); assert.equal(frame.srcdoc, undefined);
  f.click(); await new Promise(setImmediate);
  assert.equal(dialog.open, true); assert.equal(f.body.children.length, 3);
  f.root.handlers.resourcehide();
  assert.equal(dialog.open, false); assert.equal(frame.srcdoc, undefined);
});

test('HTML 预览失败不回显绝对路径；不存在、越界、降权元数据均不能显示预览', async () => {
  for (const api of [async () => { throw Error('D:/private/secret.html'); }, async () => ({ path: 'D:/private/page.html', content: 'private' }), async () => ({ path: '@0123456789abcdef/page.html' })]) {
    const f = fixture(api, 'page.html'); f.click(); await new Promise(setImmediate);
    assert.equal(f.body.children.length, 2); assert.deepEqual(f.navigations, []);
    assert.match(f.notices[0], /不可访问/); assert.doesNotMatch(f.notices[0], /D:|private|secret/);
  }
});

test('HTML 与 Markdown 连续点击只显示最新结果；切换文档作废旧 HTML 响应', async () => {
  const pending = [];
  const f = fixture(() => new Promise(resolve => pending.push(resolve)), 'first.html');
  f.click(); f.link.setAttribute('href', 'second.html'); f.click();
  pending[1]({ path: '@0123456789abcdef/second.html', content: '<h1>second</h1>' }); await new Promise(setImmediate);
  const frame = f.body.children[2].children[1];
  pending[0]({ path: '@0123456789abcdef/first.html', content: '<h1>first</h1>' }); await new Promise(setImmediate);
  assert.ok(frame.srcdoc.endsWith('<h1>second</h1>'));
  f.root.handlers.resourcehide();
  f.link.setAttribute('href', 'third.html'); f.click(); f.root.handlers.resourcehide();
  pending[2]({ path: '@0123456789abcdef/third.html', content: '<h1>third</h1>' }); await new Promise(setImmediate);
  assert.equal(frame.srcdoc, undefined); assert.equal(f.body.children[2].open, false);
  f.link.setAttribute('href', 'last.html'); f.click(); f.link.setAttribute('href', 'guide.md'); f.click();
  pending[4]({ path: '@0123456789abcdef/guide.md', exists: true, document_path: '@0123456789abcdef/guide.md' }); await new Promise(setImmediate);
  pending[3]({ path: '@0123456789abcdef/last.html', content: 'stale' }); await new Promise(setImmediate);
  assert.equal(frame.srcdoc, undefined); assert.deepEqual(f.navigations, ['@0123456789abcdef/guide.md']);
});

test('HTML 图片按预览文件位置请求、去重并嵌入；无权限图片不导航，srcset 不覆盖结果', async () => {
  const requests = [], f = fixture(async (url, options) => {
    requests.push({ url, ...JSON.parse(options.body), signal: options.signal });
    return { images: { 'pic.png': 'data:image/png;base64,aW1hZ2U=' } };
  });
  const image = new f.link.constructor('img'), link = new f.link.constructor('a'), hidden = new f.link.constructor('img');
  image.setAttribute('src', 'pic.png'); image.setAttribute('srcset', 'wrong.png 2x');
  link.setAttribute('href', 'pic.png'); hidden.setAttribute('src', 'hidden.svg');
  const source = new f.link.constructor('source'); source.setAttribute('srcset', 'override.png');
  const nodes = [image, link, hidden], originalCreate = f.document.createElement;
  f.document.createElement = tag => tag === 'template' ? { content: { querySelectorAll: selector => selector === 'picture source' ? [source] : nodes }, innerHTML: '' } : originalCreate(tag);
  const controller = new AbortController();
  await f.context.prepareHTMLPreviewImages({ content: '<img src="pic.png"><a href="pic.png">原图</a>' }, { path: 'doc.md', reference: '../gallery/index.html' }, controller.signal);
  assert.equal(requests.length, 1); assert.equal(requests[0].url, '/api/resource/html-images');
  assert.equal(requests[0].reference, '../gallery/index.html'); assert.equal(requests[0].path, 'doc.md');
  assert.deepEqual(Array.from(requests[0].images), ['pic.png', 'hidden.svg']); assert.equal(requests[0].signal, controller.signal);
  assert.equal(image.getAttribute('src'), 'data:image/png;base64,aW1hZ2U=');
  assert.equal(image.getAttribute('srcset'), undefined); assert.equal(source.getAttribute('srcset'), undefined);
  assert.equal(link.getAttribute('data-preview-image'), image.getAttribute('src'));
  assert.equal(hidden.getAttribute('src'), undefined); assert.match(hidden.getAttribute('alt'), /无权访问/);
});

test('预览内点击原图使用图片弹层，普通链接拦截导航并提示，不访问服务器页面', () => {
  const f = fixture(async () => ({})); f.context.htmlPreviewNavigation();
  const original = 'data:image/png;base64,aW1hZ2U='; f.link.setAttribute('data-preview-image', original); f.link.textContent = '原图';
  const event = { target: f.link, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  f.documentHandlers.click(event); const dialog = f.body.children.at(-1);
  assert.equal(event.prevented, true); assert.equal(event.stopped, true); assert.equal(dialog.open, true);
  assert.equal(dialog.children[1].src, original); assert.equal(dialog.children[1].tagName, 'IMG');
  f.link.removeAttribute('data-preview-image'); f.link.setAttribute('href', 'other.html');
  f.documentHandlers.click(event); assert.match(f.body.children.at(-1).children[1].textContent, /暂不支持/);
  assert.equal(f.navigations.length, 0);
});
