const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

test('路径保存后并发刷新：依赖跳过、共享列表、空目录权限、显式依赖根和缓存失效', { timeout: 30000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mojian-scan-'));
  let child;
  try {
    const docs = path.join(temporary, 'notes'), dependency = path.join(docs, 'node_modules', 'package');
    await Promise.all([dependency, path.join(docs, '.git'), path.join(docs, 'empty')].map(p => fs.mkdir(p, { recursive: true })));
    await Promise.all([
      fs.writeFile(path.join(docs, 'note.md'), 'visible needle'),
      fs.writeFile(path.join(dependency, 'README.md'), 'dependency needle'),
      fs.writeFile(path.join(docs, '.git', 'internal.md'), 'internal needle'),
    ]);
    await Promise.all(Array.from({ length: 100 }, async (_, i) => {
      const p = path.join(docs, 'node_modules', 'pkg' + i);
      await fs.mkdir(p); await fs.writeFile(path.join(p, 'README.md'), 'dependency needle');
    }));
    const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const configPath = path.join(temporary, 'config.yaml');
    await fs.writeFile(configPath, JSON.stringify({ host: '127.0.0.1', port, docs_dir: [docs], file_operations: true, log: { dir: path.join(temporary, 'logs') } }));
    const binary = process.env.EDITOR_TEST_BINARY || path.resolve(__dirname, process.platform === 'win32' ? '../md-editor.exe' : '../md-editor');
    child = spawn(binary, ['-config', configPath], { cwd: temporary, windowsHide: true, stdio: 'ignore' });
    async function request(url, method = 'GET', payload, remote = false) {
      const response = await fetch('http://127.0.0.1:' + port + url, { method, headers: { 'Content-Type': 'application/json', ...(remote ? { Via: 'test' } : {}) },
        body: payload && JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    }
    let config;
    for (let i = 0; i < 50; i++) {
      try { config = await request('/api/directories'); break; } catch { await delay(50); }
    }
    assert.ok(config);
    const root = config.directories[0].id;
    const initial = await request('/api/files');
    assert.deepEqual(initial.files, [root + '/note.md']);
    assert.deepEqual(initial.folders.sort(), [root, root + '/empty'].sort());
    const permissions = await request('/api/permissions');
    assert.ok(permissions.targets.some(item => item.path === root + '/empty' && item.kind === 'directory'));
    config = await request('/api/directories', 'PUT', { paths: [docs], names: ['Renamed'], permissions: { default: 'none', rules: [] }, config_revision: config.config_revision });
    const lists = await Promise.all(Array.from({ length: 8 }, () => request('/api/files')));
    for (const list of lists) { assert.equal(list.directories[0].name, 'Renamed'); assert.deepEqual(list.files, initial.files); }
    const remote = await request('/api/files', 'GET', null, true);
    assert.deepEqual(remote.files, []); assert.equal(remote.folders, undefined);
    const search = await request('/api/search?q=needle');
    assert.deepEqual(search.files, initial.files);
    await request('/api/documents', 'POST', { directory: root + '/empty', name: 'new.md' });
    assert.ok((await request('/api/files')).files.includes(root + '/empty/new.md'));
    config = await request('/api/directories', 'PUT', { paths: [docs, dependency], names: ['Notes', 'Explicit dependency'], config_revision: config.config_revision });
    const explicitRoot = config.directories.find(item => item.name === 'Explicit dependency').id;
    assert.ok((await request('/api/files')).files.includes(explicitRoot + '/README.md'));
    assert.ok((await request('/api/search?q=dependency')).files.includes(explicitRoot + '/README.md'));
    // A directory rule applies to existing and newly created descendants.
    await fs.mkdir(path.join(docs, 'empty', 'deep'));
    await request('/api/documents', 'POST', { directory: root + '/empty/deep', name: 'nested.md' });
    const nestedPath = root + '/empty/deep/nested.md', siblingPath = root + '/empty/new.md';
    async function saveRules(rules) {
      config = await request('/api/directories', 'PUT', { paths: [docs, dependency], names: ['Notes', 'Explicit dependency'],
        permissions: { default: 'none', rules }, config_revision: config.config_revision });
    }
    await saveRules([{ path: root + '/empty', access: 'r' }]);
    for (const p of [nestedPath, siblingPath]) {
      const doc = await request('/api/file?path=' + encodeURIComponent(p), 'GET', null, true);
      assert.equal(doc.access, 'r');
      const denied = await fetch('http://127.0.0.1:' + port + '/api/file', { method: 'PUT', headers: { 'Content-Type': 'application/json', Via: 'test' },
        body: JSON.stringify({ path: p, content: 'blocked', revision: doc.revision }), signal: AbortSignal.timeout(5000) });
      assert.equal(denied.status, 403); await denied.arrayBuffer();
    }
    await saveRules([{ path: root + '/empty', access: 'r' }, { path: root + '/empty/deep', access: 'rw' }]);
    assert.equal((await request('/api/file?path=' + encodeURIComponent(nestedPath), 'GET', null, true)).access, 'rw');
    assert.equal((await request('/api/file?path=' + encodeURIComponent(siblingPath), 'GET', null, true)).access, 'r');
    const persisted = await request('/api/permissions');
    assert.equal(persisted.rules.length, 2);
    assert.ok(persisted.rules.every(rule => persisted.targets.some(target => target.path === rule.path && target.kind === 'directory')));
    await saveRules([{ path: root + '/empty', access: 'r' }]);
    assert.equal((await request('/api/file?path=' + encodeURIComponent(nestedPath), 'GET', null, true)).access, 'r');
    await saveRules([{ path: root + '/empty', access: 'none' }]);
    assert.deepEqual((await request('/api/files', 'GET', null, true)).files, []);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
