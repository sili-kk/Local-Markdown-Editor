const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

test('路径选择权限、目录和文件浏览，以及失效旧路径替换后立即重新加载', { timeout: 30000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mojian-paths-'));
  let child;
  try {
    const previous = path.join(temporary, 'old'), next = path.join(temporary, '新路径');
    await Promise.all([previous, next, path.join(next, 'empty')].map(p => fs.mkdir(p, { recursive: true })));
    await fs.writeFile(path.join(previous, 'old.md'), 'old');
    await fs.writeFile(path.join(next, '新文档.MARKDOWN'), 'new content');
    await fs.writeFile(path.join(next, 'ignored.txt'), 'not markdown');
    const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const configPath = path.join(temporary, 'config.yaml');
    await fs.writeFile(configPath, JSON.stringify({ host: '127.0.0.1', port, docs_dir: [previous],
      permissions: { default: 'r', rules: [{ path: previous, access: 'rw' }] }, log: { dir: path.join(temporary, 'logs') } }));
    const binary = process.env.EDITOR_TEST_BINARY || path.resolve(__dirname, process.platform === 'win32' ? '../md-editor.exe' : '../md-editor');
    child = spawn(binary, ['-config', configPath], { cwd: temporary, windowsHide: true, stdio: 'ignore' });
    async function request(url, method = 'GET', payload, remote = false) {
      const response = await fetch('http://127.0.0.1:' + port + url, { method,
        headers: { 'Content-Type': 'application/json', ...(remote ? { Via: 'test' } : {}) },
        body: payload && JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
      return { status: response.status, data: await response.json() };
    }
    let config;
    for (let i = 0; i < 60; i++) {
      try { const response = await request('/api/directories'); if (response.status === 200) { config = response.data; break; } } catch {}
      await delay(50);
    }
    assert.ok(config, 'isolated server started');
    const browse = value => '/api/directories/browse?path=' + encodeURIComponent(value);
    assert.equal((await request(browse(next), 'GET', null, true)).status, 403, 'remote clients cannot browse server paths');
    assert.equal((await request(browse(next), 'POST')).status, 405);
    let result = await request(browse(next));
    assert.equal(result.status, 200);
    assert.equal(result.data.path, next);
    assert.equal(result.data.parent, temporary);
    assert.equal(result.data.selected, next);
    assert.deepEqual(result.data.entries.map(entry => [entry.name, entry.directory]), [['empty', true], ['新文档.MARKDOWN', false]]);
    result = await request(browse(path.join(next, '新文档.MARKDOWN')));
    assert.equal(result.data.path, next); assert.equal(result.data.selected, path.join(next, '新文档.MARKDOWN'));
    assert.equal((await request(browse(path.join(next, 'ignored.txt')))).status, 400);
    assert.equal((await request(browse(path.join(next, 'missing')))).status, 400);
    result = await request(browse(path.join(next, 'empty')));
    assert.deepEqual(result.data.entries, []); assert.equal(result.data.selected, path.join(next, 'empty'));
    result = await request('/api/directories/browse?roots=1');
    assert.equal(result.status, 200); assert.ok(result.data.entries.length > 0);
    result = await request(browse('.')); assert.equal(result.data.path, temporary, 'relative paths use config location');

    // The old directory and its explicitly configured permissions are now gone.
    // Repairing docs_dir must validate the replacement, not stat the old rule.
    await fs.rename(previous, path.join(temporary, 'moved'));
    result = await request('/api/directories', 'PUT', { paths: [next], names: ['新手稿'], config_revision: config.config_revision,
      permissions: { default: 'r', rules: [{ path: config.directories[0].id, access: 'rw' }] } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    config = result.data;
    assert.equal(config.directories[0].path, next); assert.equal(config.directories[0].name, '新手稿');
    result = await request('/api/permissions'); assert.deepEqual(result.data.rules, []); assert.equal(result.data.default, 'r');
    result = await request('/api/files'); assert.deepEqual(result.data.files, [config.directories[0].id + '/新文档.MARKDOWN']);
    const file = await request('/api/file?path=' + encodeURIComponent(result.data.files[0]));
    assert.equal(file.status, 200); assert.equal(file.data.content, 'new content');
    const unchanged = await fs.readFile(configPath, 'utf8');
    result = await request('/api/directories', 'PUT', { paths: [path.join(next, 'missing')], names: ['无效'], config_revision: config.config_revision });
    assert.equal(result.status, 400); assert.equal(await fs.readFile(configPath, 'utf8'), unchanged);
    // Normal replacement and single-file paths still work after recovery.
    result = await request('/api/directories', 'PUT', { paths: [path.join(next, '新文档.MARKDOWN')], names: ['单文件'], config_revision: config.config_revision });
    assert.equal(result.status, 200); assert.equal(result.data.directories[0].is_file, true);
    assert.equal(result.data.directories[0].name, '单文件');
    const html = await (await fetch('http://127.0.0.1:' + port + '/')).text();
    assert.match(html, /id="pathPickerDialog"/); assert.match(html, /\/static\/path-picker\.js/);
    const script = await (await fetch('http://127.0.0.1:' + port + '/static/path-picker.js')).text();
    assert.match(script, /function openPathPicker/);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    // This directory is created exclusively for this test.
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
