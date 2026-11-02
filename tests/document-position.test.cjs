const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../web/document-position.js'), 'utf8');
const key = 'mojian.documentPositions';

function fixture({ storage = new Map(), blocked = false } = {}) {
  const timers = new Map(), frames = new Map(), observers = [];
  let nextID = 0, currentPath = '', loading = false, maxTop = 10000, top = 0;
  function target() {
    const listeners = new Map();
    return {
      listeners,
      addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
      removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
      fire(name) { for (const callback of listeners.get(name) || []) callback(); },
    };
  }
  const viewport = Object.assign(target(), { scrollLeft: 0 });
  Object.defineProperty(viewport, 'scrollTop', { get: () => top, set: value => { top = Math.max(0, Math.min(maxTop, value)); } });
  const body = target(), inputRoot = target(), window = target(), document = { ...target(), hidden: false };
  const context = vm.createContext({ window, document,
    localStorage: { getItem: name => { if (blocked) throw Error('blocked'); return storage.get(name) ?? null; },
      setItem: (name, value) => { if (blocked) throw Error('full'); storage.set(name, value); } },
    setTimeout: (callback, delay) => { const id = ++nextID; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: callback => { const id = ++nextID; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } },
  });
  vm.runInContext(source, context);
  const tracker = context.createDocumentPositionTracker(viewport, body, savedPath => savedPath === currentPath && !loading, inputRoot);
  const runFrames = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
  const runTimers = delay => { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } };
  return { tracker, viewport, body, inputRoot, window, document, storage, observers, timers, frames, runFrames, runTimers,
    open(nextPath) { tracker.save(); currentPath = nextPath; tracker.restore(nextPath); },
    browse(value, left = 0) { inputRoot.fire('wheel'); viewport.scrollTop = value; viewport.scrollLeft = left; viewport.fire('scroll'); },
    set loading(value) { loading = value; }, set maxTop(value) { maxTop = value; },
    stored: () => new Map(JSON.parse(storage.get(key) || '[]')),
  };
}

test('每篇文档独立记忆位置，切回和刷新后恢复，首次打开从顶部开始', () => {
  const f = fixture();
  f.open('a.md'); f.browse(1842.5, 30);
  f.open('b.md'); assert.equal(f.viewport.scrollTop, 0);
  f.browse(624); f.open('a.md');
  assert.equal(f.viewport.scrollTop, 1842.5); assert.equal(f.viewport.scrollLeft, 30);
  assert.deepEqual(f.stored().get('b.md'), { top: 624, left: 0 });
  const refreshed = fixture({ storage: f.storage }); refreshed.open('a.md');
  assert.equal(refreshed.viewport.scrollTop, 1842.5);
  refreshed.open('b.md'); assert.equal(refreshed.viewport.scrollTop, 624);
});

test('滚动防抖写入，刷新或切到后台立即保存最新位置', () => {
  const f = fixture(); f.open('a.md'); f.browse(720);
  assert.equal(f.storage.has(key), false);
  f.window.fire('beforeunload'); assert.equal(f.stored().get('a.md').top, 720);
  f.browse(900); f.window.fire('pagehide'); assert.equal(f.stored().get('a.md').top, 900);
  f.browse(1200); f.document.hidden = true; f.document.fire('visibilitychange');
  assert.equal(f.stored().get('a.md').top, 1200);
  f.browse(1450); f.runTimers(150); assert.equal(f.stored().get('a.md').top, 1450);
});

test('加载和延迟布局不会覆盖旧位置，图片撑开后继续恢复且文档缩短时限制到有效范围', () => {
  const f = fixture({ storage: new Map([[key, JSON.stringify([['a.md', { top: 2400, left: 0 }]])]]) });
  f.maxTop = 500; f.open('a.md'); assert.equal(f.viewport.scrollTop, 500);
  f.viewport.fire('scroll'); f.runTimers(150); assert.equal(f.stored().get('a.md').top, 2400);
  f.maxTop = 4000; f.observers[0].callback(); f.runFrames(); assert.equal(f.viewport.scrollTop, 2400);
  f.viewport.scrollTop = 0; f.body.fire('load'); f.runFrames(); assert.equal(f.viewport.scrollTop, 2400);
  f.maxTop = 600; f.runTimers(2000); assert.equal(f.viewport.scrollTop, 600);
  assert.equal(f.stored().get('a.md').top, 600);
  f.loading = true; f.viewport.scrollTop = 0; f.tracker.save();
  assert.equal(f.stored().get('a.md').top, 600);
});

test('用户操作立即接管滚动，快速切换时旧恢复任务不影响新文档', () => {
  const storage = new Map([[key, JSON.stringify([['a.md', { top: 2000, left: 0 }], ['b.md', { top: 800, left: 0 }]])]]);
  const f = fixture({ storage }); f.open('a.md'); f.open('b.md'); f.runFrames();
  assert.equal(f.viewport.scrollTop, 800);
  f.browse(1200); f.body.fire('load'); f.observers[0].callback(); f.runFrames(); f.runTimers(2000);
  assert.equal(f.viewport.scrollTop, 1200);
  f.open('a.md'); assert.equal(f.viewport.scrollTop, 2000);
  assert.equal(f.stored().get('b.md').top, 1200);
});

test('损坏的存储和非法位置安全忽略，存储被禁用时当前页面仍能记忆', () => {
  for (const stored of ['{broken', '{}', '[null,1,[],["a.md",{"top":-1,"left":0}],["b.md",{"top":"200","left":0}]]']) {
    const f = fixture({ storage: new Map([[key, stored]]) }); f.open('a.md'); assert.equal(f.viewport.scrollTop, 0);
  }
  const f = fixture({ blocked: true }); f.open('a.md'); f.browse(777); f.open('b.md'); f.browse(222); f.open('a.md');
  assert.equal(f.viewport.scrollTop, 777);
});

test('文档历史限制为最近200篇，清理时移除监听器和待执行恢复任务', () => {
  const f = fixture();
  for (let index = 0; index < 205; index++) { f.open(index + '.md'); f.browse(index); f.tracker.save(); }
  assert.equal(f.stored().size, 200); assert.equal(f.stored().has('0.md'), false); assert.ok(f.stored().has('204.md'));
  f.open('100.md'); f.tracker.destroy();
  assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0); assert.equal(f.observers[0].disconnected, true);
  assert.equal(f.viewport.listeners.get('scroll').size, 0); assert.equal(f.window.listeners.get('pagehide').size, 0);
});
