const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');

function fixture(fetch) {
  let expire, cleared = false;
  const context = vm.createContext({ fetch, AbortController, AbortSignal,
    setTimeout(callback, ms) { assert.equal(ms, 20000); expire = callback; return 1; },
    clearTimeout() { cleared = true; },
  });
  vm.runInContext(source.slice(source.indexOf('async function api('), source.indexOf('function drawFiles(')), context);
  return { api: context.api, expire: () => expire(), cleared: () => cleared };
}

test('API 超时覆盖等待响应和读取正文阶段，并清理计时器；保存请求不自动重发', async () => {
  for (const bodyPending of [false, true]) {
    let calls = 0;
    const f = fixture(async (_url, { signal }) => {
      calls++;
      const pending = new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return bodyPending ? { ok: true, json: () => pending } : pending;
    });
    const task = f.api('/api/directories', { method: 'PUT' });
    f.expire();
    await assert.rejects(task, /请求超时/);
    assert.equal(calls, 1); assert.equal(f.cleared(), true);
  }
});

test('API 保留 HTTP 配置冲突状态和正常响应，截断正文不能当作保存成功', async () => {
  const f = fixture(async () => ({ ok: false, status: 409, json: async () => ({ error: '配置已变化' }) }));
  await assert.rejects(f.api('/api/directories'), error => error.status === 409 && error.message === '配置已变化');
  assert.equal(f.cleared(), true);
  const broken = fixture(async () => ({ ok: true, json: async () => { throw Error('truncated'); } }));
  await assert.rejects(broken.api('/api/files'), /truncated/);
});
