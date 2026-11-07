const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const resources = fs.readFileSync(path.join(__dirname, '../web/resources.js'), 'utf8');
const start = app.indexOf("  root.addEventListener('click', event => {", app.indexOf('function createEditor()'));
assert.ok(start >= 0, 'editor link handler exists');
const end = app.indexOf('  }, true);', start) + '  }, true);'.length;

// Run the installed capture handler with the real resource URL resolver.
function fixture(reference) {
  const opened = [], navigated = [], state = { path: '@docs/note.md', directories: [] };
  let click;
  const root = { addEventListener(type, handler, capture) { assert.equal(type, 'click'); assert.equal(capture, true); click = handler; } };
  const context = vm.createContext({ root, state, URL, URLSearchParams,
    location: { origin: 'http://127.0.0.1:8081' },
    window: { open: (...args) => opened.push(args) }, navigate: target => navigated.push(target) });
  vm.runInContext(resources, context);
  vm.runInContext(app.slice(start, end), context);
  const link = { getAttribute: () => reference };
  return { opened, navigated, click(overrides = {}) {
    const event = { button: 0, target: { closest: () => link },
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides };
    click(event); return event;
  } };
}

test('外部 HTTP/HTTPS 链接及链接内子元素单击，在独立标签页打开一次', () => {
  for (const reference of ['https://example.org/page?q=1#part', 'http://example.org/guide.md', '//example.org/page.html']) {
    const f = fixture(reference), event = f.click();
    assert.deepEqual(f.opened, [[new URL(reference, 'http://127.0.0.1:8081').href, '_blank', 'noopener,noreferrer']]);
    assert.equal(event.prevented, true); assert.equal(event.stopped, true);
    assert.deepEqual(f.navigated, []);
  }
});

test('外部链接保留 Ctrl/⌘ 点击，避免当前页面默认导航或重复打开', () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const f = fixture('https://example.org/');
    assert.equal(f.click({ [modifier]: true }).prevented, true);
    assert.equal(f.opened.length, 1); assert.deepEqual(f.navigated, []);
  }
});

test('非主键、Alt 和 Shift 点击沿用原有处理', () => {
  for (const overrides of [{ button: 1 }, { button: 2 }, { altKey: true }, { shiftKey: true }]) {
    const f = fixture('https://example.org/');
    assert.equal(f.click(overrides).prevented, undefined); assert.deepEqual(f.opened, []);
  }
});

test('锚点、本地文件、无效 URL 与非网页协议不会被普通点击作为外部网页打开', () => {
  for (const reference of ['', '#part', 'guide.md', 'image.png', 'file:///D:/docs/guide.md', 'D:/docs/guide.md', 'http://[invalid', 'mailto:editor@example.org', 'javascript:alert(1)', 'data:text/html,test']) {
    const f = fixture(reference);
    assert.doesNotThrow(() => f.click());
    assert.deepEqual(f.opened, []); assert.deepEqual(f.navigated, []);
  }
  const f = fixture('https://example.org/');
  f.click({ target: { closest: () => null } }); assert.deepEqual(f.opened, []);
});

test('本地 Markdown 和邮件链接保留既有 Ctrl/⌘ 导航', () => {
  const local = fixture('guide.md'); local.click({ ctrlKey: true });
  assert.deepEqual(local.navigated, ['@docs/guide.md']); assert.deepEqual(local.opened, []);
  const mail = fixture('mailto:editor@example.org'); mail.click({ metaKey: true });
  assert.deepEqual(mail.opened, [['mailto:editor@example.org', '_blank', 'noopener,noreferrer']]);
});
