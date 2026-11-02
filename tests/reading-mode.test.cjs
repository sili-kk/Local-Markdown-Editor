const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../web/reading-mode.js'), 'utf8');
const app = fs.readFileSync(require('node:path').join(__dirname, '../web/app.js'), 'utf8');

test('分页保留最后一页，容忍亚像素误差，空文档仍有一页', () => {
  const c = vm.createContext({}); vm.runInContext(source, c);
  for (const [width, viewport, pages] of [[0, 350, 1], [350, 350, 1], [351, 350, 1], [740, 350, 2], [1130, 350, 3], [1130.8, 350.4, 3], [1160, 350, 4]]) {
    assert.equal(c.readerPageCount(width, viewport), pages);
  }
});

test('阅读模式暂停自动/手动保存及切换前保存，保留脏草稿，零写请求', async () => {
  let current = 'draft', writes = 0, cleared = 0;
  const state = { reading: true, path: 'note.md', saved: 'disk' };
  const c = vm.createContext({ state, clearTimeout() { cleared++; }, dirty: () => current !== state.saved,
    notice() {}, api() { writes++; }, content: () => current });
  vm.runInContext(app.slice(app.indexOf('async function save()'), app.indexOf('function setBusy(')), c);
  assert.equal(await c.save(), false);
  assert.equal(await c.flush(), false);
  assert.equal(current, 'draft'); assert.equal(writes, 0); assert.ok(cleared >= 2);
  current = 'disk'; assert.equal(await c.save(), true); assert.equal(await c.flush(), true); assert.equal(writes, 0);
});

test('保存前的异步版本检查期间进入阅读模式，后续不会发送 PUT', async () => {
  const state = { reading: false, path: 'note.md', saved: 'disk' };
  let writes = 0, release;
  const checking = new Promise(resolve => { release = resolve; });
  const c = vm.createContext({ state, clearTimeout() {}, dirty: () => true, status() {}, notice() {},
    checkExternalChanges: () => checking, api() { writes++; }, content: () => 'draft' });
  vm.runInContext(app.slice(app.indexOf('async function save()'), app.indexOf('function setBusy(')), c);
  const task = c.save(); state.reading = true; release(true);
  assert.equal(await task, false); assert.equal(writes, 0);
});

test('翻页仅改变阅读视图，首尾钳制，忙碌时不移动', () => {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { scrollLeft: 0, getBoundingClientRect: () => ({ left: 0, right: 350 }), querySelectorAll: () => [] }); return nodes.get(id); };
  const state = { reading: true, path: 'note.md' };
  const c = vm.createContext({ $, state, updateDocumentOutlinePosition() {} });
  vm.runInContext(source + '\nreadingLayout.pages=5; readingLayout.stride=390.4;', c);
  c.goToReaderPage(-8); assert.equal($('readerViewport').scrollLeft, 0); assert.equal($('readerPrevious').disabled, true);
  c.goToReaderPage(2); assert.equal($('readerViewport').scrollLeft, 780.8);
  c.goToReaderPage(99); assert.equal($('readerViewport').scrollLeft, 1561.6); assert.equal($('readerNext').disabled, true);
  state.navigating = true; c.goToReaderPage(0); assert.equal($('readerViewport').scrollLeft, 1561.6);
});
