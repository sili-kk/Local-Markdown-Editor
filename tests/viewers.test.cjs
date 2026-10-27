const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../web/viewers.js'), 'utf8');

function fixture() {
  const events = {}, windowEvents = {}, requests = [], beacons = [];
  const document = { activeElement: null, hidden: false, addEventListener(name, callback) { events[name] = callback; } };
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.attributes = {}; this.style = { setProperty() {} }; this.clientWidth = 300; this.offsetWidth = 70; }
    append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); }
    replaceChildren() { this.children = []; }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() { document.activeElement = this; }
  }
  document.createElement = () => new Element();
  const elements = Object.fromEntries(['documentViewers', 'viewerList', 'viewerCount', 'toggleViewers'].map(id => [id, new Element()]));
  elements.documentViewers.append(elements.viewerList, elements.viewerCount, elements.toggleViewers);
  let response = { ips: [], self: '', viewers: [] }, responder;
  const state = { path: '@root/one.md' };
  const c = vm.createContext({ crypto: webcrypto, document, state, Blob, AbortSignal,
    $: id => elements[id], displayLibraryPath: value => value.replace('@root/', '笔记/'), syncDocumentEvents() {},
    navigator: { sendBeacon: (...args) => { beacons.push(args); return true; } },
    window: { addEventListener: (name, callback) => { windowEvents[name] = callback; } },
    setInterval() {}, getComputedStyle: () => ({ columnGap: '6', getPropertyValue: name => ({ '--viewer-dot-width': '14', '--viewer-dot-gap': '2', '--viewer-toggle-width': '68' })[name] }),
    api: async (_url, options) => { requests.push(JSON.parse(options.body)); return responder ? responder() : response; },
  });
  vm.runInContext(source, c);
  return { c, state, events, windowEvents, requests, beacons, elements,
    setResponse(value) { response = value; }, setResponder(value) { responder = value; } };
}
const globalResponse = { ips: ['192.0.2.1', '192.0.2.2'], self: '192.0.2.1', viewers: [
  { ip: '192.0.2.1', documents: ['@root/one.md', '@root/two.md'] },
  { ip: '192.0.2.2', documents: ['@root/three.md'] },
] };

test('跨文档合计人数，悬停和展开均显示每个 IP 的全部文档，人数不变也更新文档', async () => {
  const f = fixture(); f.setResponse(globalResponse); await f.c.refreshDocumentViewers();
  assert.equal(f.elements.viewerCount.textContent, '共 2 人查看');
  const dot = f.elements.viewerList.children[0];
  assert.match(dot.title, /192.0.2.1（当前 IP）/);
  assert.match(dot.title, /笔记\/one.md\n笔记\/two.md/);
  assert.equal(dot.children[0].children[1].textContent, '笔记/one.md\n笔记/two.md');
  assert.equal(f.elements.toggleViewers.textContent, '详情');
  dot.onclick(); assert.equal(f.elements.documentViewers.dataset.expanded, 'true');
  f.setResponse({ ...globalResponse, viewers: [{ ip: '192.0.2.1', documents: ['@root/changed.md'] }, globalResponse.viewers[1]] });
  await f.c.refreshDocumentViewers();
  assert.match(f.elements.viewerList.children[0].title, /changed.md/);
  assert.doesNotMatch(f.elements.viewerList.children[0].title, /one.md/);
});

test('空视图继续统计，切换文档保留名单且不发送离开，页面离开才注销', async () => {
  const f = fixture(); f.setResponse(globalResponse); await f.c.refreshDocumentViewers();
  f.state.path = ''; f.c.syncDocumentViewers();
  assert.equal(f.elements.viewerCount.textContent, '共 2 人查看');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.at(-1).path, ''); assert.equal(f.beacons.length, 0);
  f.events.DOMContentLoaded(); await new Promise(resolve => setImmediate(resolve));
  f.windowEvents.pagehide(); assert.equal(f.beacons.length, 1);
  assert.equal(JSON.parse(await f.beacons[0][1].text()).action, 'leave');
  const count = f.requests.length; await f.c.refreshDocumentViewers(); assert.equal(f.requests.length, count);
  f.windowEvents.pageshow(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, count + 1);
});

test('在途切换文档忽略旧响应并立即补发当前心跳', async () => {
  const f = fixture(); let finish;
  f.setResponder(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.c.refreshDocumentViewers(); f.state.path = '@root/new.md';
  f.setResponder(null); f.setResponse(globalResponse);
  finish({ ips: ['stale'], self: 'stale', viewers: [] }); await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].path, '@root/new.md');
  assert.equal(f.elements.viewerCount.textContent, '共 2 人查看');
  assert.doesNotMatch(f.elements.viewerList.children[0].title, /stale/);
});

test('只有一人也能展开，窄宽度展开全部，Esc 与点击外部收起，安全显示文档名称', async () => {
  const f = fixture(); f.events.DOMContentLoaded(); await new Promise(resolve => setImmediate(resolve));
  f.setResponse({ ips: ['192.0.2.1'], self: '', viewers: [{ ip: '192.0.2.1', documents: ['@root/<img onerror=alert(1)>.md'], unavailable: true }] });
  await f.c.refreshDocumentViewers();
  assert.equal(f.elements.toggleViewers.hidden, false); assert.equal(f.elements.toggleViewers.textContent, '详情');
  const dot = f.elements.viewerList.children[0], reading = dot.children[0].children[1];
  assert.equal(reading.textContent, '笔记/<img onerror=alert(1)>.md\n其他不可访问的文档');
  assert.equal(reading.children.length, 0);
  f.elements.documentViewers.clientWidth = 150; f.c.layoutDocumentViewers();
  assert.equal(dot.hidden, true); assert.equal(f.elements.toggleViewers.textContent, '+1 展开');
  f.elements.toggleViewers.onclick(); assert.equal(dot.hidden, false);
  f.events.keydown({ key: 'Escape' }); assert.equal(dot.hidden, true);
  f.elements.toggleViewers.onclick(); f.events.pointerdown({ target: {} }); assert.equal(dot.hidden, true);
});

test('网络失败显示状态不可用，恢复后重建名单，空文档显示未打开文档', async () => {
  const f = fixture(); f.setResponse(globalResponse); await f.c.refreshDocumentViewers();
  f.setResponder(() => { throw new Error('offline'); }); await f.c.refreshDocumentViewers();
  assert.equal(f.elements.viewerCount.textContent, '在线状态暂不可用'); assert.equal(f.elements.viewerList.children.length, 0);
  f.setResponder(null); f.setResponse({ ips: ['192.0.2.2'], self: '192.0.2.2', viewers: [{ ip: '192.0.2.2', documents: [] }] });
  await f.c.refreshDocumentViewers(); assert.equal(f.elements.viewerCount.textContent, '共 1 人查看');
  assert.match(f.elements.viewerList.children[0].title, /未打开文档/); assert.equal(f.elements.viewerCount.dataset.error, undefined);
});
