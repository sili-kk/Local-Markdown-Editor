const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

// Run after go build. All writes, removals and processes belong to an isolated
// temporary fixture. The user's configuration and running service are untouched.
test('最终程序隔离 HTTP：右键权限、HTML 预览边界、本机管理、远端拒绝及删除通知', { timeout: 30000 }, async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mojian-context-'));
  let child, stream;
  try {
    const docs = path.join(fixtureRoot, 'notes'), nested = path.join(docs, 'sub'), hidden = path.join(docs, 'hidden');
    const other = path.join(fixtureRoot, 'notes-other'), isolatedFile = path.join(fixtureRoot, 'single.md');
    await Promise.all([nested, hidden, other].map(directory => fs.mkdir(directory, { recursive: true })));
    await Promise.all([
      fs.writeFile(path.join(nested, 'write.md'), 'draft'), fs.writeFile(path.join(hidden, 'secret.md'), 'hidden'),
      fs.writeFile(path.join(other, 'other.md'), 'other'), fs.writeFile(isolatedFile, 'single'),
      fs.writeFile(path.join(fixtureRoot, 'unconfigured.md'), 'outside'),
      fs.writeFile(path.join(fixtureRoot, 'outside.html'), '<h1>outside</h1>'),
      fs.writeFile(path.join(nested, 'page.HTML'), '<!doctype html><h1>preview</h1><script>document.body.dataset.ready="yes"</script><a href="' + path.join(hidden, 'secret.html') + '">hidden</a>'),
      fs.writeFile(path.join(nested, 'other.htm'), '<h1>HTM</h1>'),
      fs.writeFile(path.join(hidden, 'secret.html'), '<h1>hidden</h1>'),
      fs.writeFile(path.join(nested, 'too-large.html'), 'x'.repeat((1 << 20) + 1)),
      fs.writeFile(path.join(other, 'page.html'), '<h1>other-root</h1>'),
      fs.writeFile(path.join(nested, 'picture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64')),
      fs.writeFile(path.join(nested, 'drawing.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'),
      fs.writeFile(path.join(hidden, 'secret.png'), 'hidden image'),
      fs.writeFile(path.join(fixtureRoot, 'outside.png'), 'outside image'),
      fs.writeFile(path.join(nested, 'oversized.png'), Buffer.alloc((8 << 20) + 1)),
    ]);
    await fs.mkdir(path.join(nested, 'directory.html'));
    await fs.symlink(hidden, path.join(nested, 'hidden-alias'), 'junction');
    await fs.symlink(fixtureRoot, path.join(nested, 'outside-alias'), 'junction');
    await fs.symlink(other, path.join(nested, 'readable-alias'), 'junction');
    const configuredAlias = path.join(fixtureRoot, 'configured-alias');
    await fs.symlink(nested, configuredAlias, 'junction');
    const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const configPath = path.join(fixtureRoot, 'config.yaml');
    await fs.writeFile(configPath, JSON.stringify({ host: '127.0.0.1', port, docs_dir: [nested, docs, other, isolatedFile, configuredAlias],
      file_operations: true, log: { dir: path.join(fixtureRoot, 'logs') }, permissions: { default: 'rw', rules: [
        { path: path.join(nested, 'write.md'), access: 'rw' }, { path: hidden, access: 'none' },
      ] } }));
    const binary = process.env.EDITOR_TEST_BINARY || path.resolve(__dirname, process.platform === 'win32' ? '../md-editor.exe' : '../md-editor');
    child = spawn(binary, ['-config', configPath], { cwd: fixtureRoot, windowsHide: true, stdio: 'ignore' });
    const base = 'http://127.0.0.1:' + port, remote = { Via: 'context-validation' };
    async function request(url, method = 'GET', body, remoteAccess = false) {
      const response = await fetch(base + url, { method, headers: { ...(remoteAccess ? remote : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body && JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const data = await response.json(); return { status: response.status, data };
    }
    let started = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null) throw Error('Isolated validation server exited');
      try { if ((await request('/api/files')).status === 200) { started = true; break; } } catch {}
      await delay(100);
    }
    assert.ok(started, 'isolated server startup');
    const configuration = (await request('/api/directories')).data;
    const normalize = value => path.resolve(value).toLowerCase();
    const root = configuration.directories.find(item => normalize(item.path) === normalize(docs));
    const alias = configuration.directories.find(item => normalize(item.path) === normalize(nested));
    const otherRoot = configuration.directories.find(item => normalize(item.path) === normalize(other));
    const single = configuration.directories.find(item => item.is_file);
    assert.equal(configuration.directories.length, 4, 'configured junction root deduplicates by real target');
    const sourcePath = alias.id + '/write.md';
    const preview = (reference, remoteAccess = true, source = sourcePath) => request('/api/resource/html', 'POST', { path: source, reference }, remoteAccess);
    for (const reference of ['page.HTML', 'other.htm', '/assets/' + alias.id + '/page.HTML', path.join(nested, 'page.HTML'), new URL('file:///' + path.join(nested, 'page.HTML').replaceAll('\\', '/')).href]) {
      const result = await preview(reference);
      assert.equal(result.status, 200); assert.ok(result.data.path.startsWith('@'));
      assert.match(result.data.content, /<h1>(?:preview|HTM)<\/h1>/);
      assert.ok(!result.data.content.includes(hidden), 'absolute HTML attribute hidden remotely');
      if (reference !== 'other.htm') assert.match(result.data.content, /__unavailable/);
    }
    const htmlMeta = await request('/api/resource', 'POST', { path: sourcePath, reference: 'page.HTML' }, true);
    assert.equal(htmlMeta.data.html_path, alias.id + '/page.HTML'); assert.equal(htmlMeta.data.document_path, '');
    assert.match((await preview('page.HTML')).data.content, /<script>/, 'inline scripts remain available inside client sandbox');
    for (const reference of ['missing.html', '../hidden/secret.html', 'hidden-alias/secret.html', 'outside-alias/outside.html', path.join(fixtureRoot, 'outside.html'), '../../outside.html', 'directory.html', 'write.md']) {
      const result = await preview(reference);
      assert.ok(result.status >= 400, 'must reject: ' + reference);
      assert.ok(!JSON.stringify(result.data).includes(fixtureRoot), 'error must not disclose fixture path');
    }
    assert.equal((await preview('too-large.html')).status, 413);
    assert.ok((await preview('page.HTML', true, root.id + '/hidden/secret.md')).status >= 400, 'hidden source also rejected');
    assert.equal((await request('/api/resource/html')).status, 405);
    assert.equal((await request('/assets/' + alias.id + '/page.HTML')).status, 403, 'HTML never served directly in editor origin');
    const jsonHTML = await fetch(base + '/api/resource/html', { method: 'POST', headers: { 'Content-Type': 'application/json', Via: 'preview-check' }, body: JSON.stringify({ path: sourcePath, reference: 'page.HTML' }) });
    assert.match(jsonHTML.headers.get('content-type'), /^application\/json/);
    assert.equal(jsonHTML.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(jsonHTML.headers.get('x-frame-options'), 'DENY');
    const rawJSON = await jsonHTML.text(); assert.ok(!rawJSON.includes('<script>'), 'JSON escapes HTML rather than executing it');
    const crossSite = await fetch(base + '/api/resource/html', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'null' }, body: JSON.stringify({ path: sourcePath, reference: 'page.HTML' }) });
    assert.equal(crossSite.status, 403, 'sandbox-origin API request rejected');
    const previewImages = (images, reference = 'page.HTML', remoteAccess = true) => request('/api/resource/html-images', 'POST', { path: sourcePath, reference, images }, remoteAccess);
    const embedded = await previewImages(['picture.png', 'picture.png?cache=1', 'drawing.svg', 'missing.png', '../hidden/secret.png', 'hidden-alias/secret.png',
      'outside-alias/outside.png', path.join(fixtureRoot, 'outside.png'), 'oversized.png', 'write.md', 'page.HTML', 'https://example.org/picture.png']);
    assert.equal(embedded.status, 200);
    assert.deepEqual(Object.keys(embedded.data.images).sort(), ['drawing.svg', 'picture.png', 'picture.png?cache=1']);
    assert.match(embedded.data.images['picture.png'], /^data:image\/png;base64,/);
    assert.match(embedded.data.images['drawing.svg'], /^data:image\/svg\+xml;base64,/);
    assert.equal(Buffer.from(embedded.data.images['picture.png'].split(',')[1], 'base64').length, 68);
    assert.equal((await previewImages(['picture.png'], '../hidden/secret.html')).status, 404);
    assert.equal((await previewImages(['picture.png'], 'write.md')).status, 404);
    assert.equal((await previewImages(Array(33).fill('picture.png'))).status, 400);
    assert.equal((await request('/api/resource/html-images')).status, 405);
    const nullOriginImages = await fetch(base + '/api/resource/html-images', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'null' },
      body: JSON.stringify({ path: sourcePath, reference: 'page.HTML', images: ['picture.png'] }) });
    assert.equal(nullOriginImages.status, 403);
    assert.equal((await preview('readable-alias/page.html')).data.path, otherRoot.id + '/page.html', 'allowed junction resolves to canonical configured root');
    const hiddenAliasReference = 'hidden-alias/secret.md';
    assert.ok((await request('/api/resource', 'POST', { path: sourcePath, reference: hiddenAliasReference }, true)).status >= 400);
    assert.ok((await request('/api/resource/image?path=' + encodeURIComponent(sourcePath) + '&reference=' + encodeURIComponent(hiddenAliasReference), 'GET', null, true)).status >= 400);
    assert.ok((await request('/api/file?path=' + encodeURIComponent(alias.id + '/' + hiddenAliasReference), 'GET', null, true)).status >= 400);
    const context = vm.createContext({ document: { addEventListener() {} } });
    vm.runInContext(await fs.readFile(path.join(__dirname, '../web/library-context-menu.js'), 'utf8'), context);
    let permissions = (await request('/api/permissions')).data;
    const payload = context.libraryPermissionUpdate({ path: root.id, kind: 'directory' }, true, configuration.directories, permissions);
    assert.equal(payload.rules.find(rule => rule.path === alias.id + '/write.md').access, 'r');
    assert.equal((await request('/api/permissions', 'PUT', payload)).status, 200);
    for (const documentPath of [alias.id + '/write.md', root.id + '/sub/write.md']) {
      const document = await request('/api/file?path=' + encodeURIComponent(documentPath), 'GET', null, true);
      assert.equal(document.status, 200); assert.equal(document.data.access, 'r');
      assert.equal((await request('/api/file', 'PUT', { path: documentPath, content: 'blocked', revision: document.data.revision }, true)).status, 403);
    }
    const hiddenRequest = await request('/api/file?path=' + encodeURIComponent(root.id + '/hidden/secret.md'), 'GET', null, true);
    assert.ok([403, 404].includes(hiddenRequest.status));
    const remoteFiles = (await request('/api/files', 'GET', null, true)).data;
    assert.ok(!remoteFiles.files.some(file => file.endsWith('/secret.md')));
    assert.equal(remoteFiles.file_operations, false); assert.ok(remoteFiles.directories.every(item => !item.path));
    const otherDocumentPath = otherRoot.id + '/other.md';
    assert.equal((await request('/api/file?path=' + encodeURIComponent(otherDocumentPath), 'GET', null, true)).data.access, 'rw');
    assert.equal((await request('/api/file?path=' + encodeURIComponent(alias.id + '/write.md'))).data.access, 'rw');
    assert.equal((await request('/api/permissions', 'PUT', payload, true)).status, 403);
    assert.equal((await request('/api/directories', 'GET', null, true)).status, 403);
    assert.equal((await request('/api/documents', 'POST', { directory: root.id, name: 'blocked.md' }, true)).status, 403);
    assert.equal((await request('/api/documents', 'DELETE', { path: otherDocumentPath }, true)).status, 403);
    assert.equal((await request('/api/permissions', 'PUT', payload)).status, 409, 'stale policy rejected');
    permissions = (await request('/api/permissions')).data;
    const singlePayload = context.libraryPermissionUpdate({ path: single.id + '/single.md', kind: 'file' }, true, configuration.directories, permissions);
    assert.equal((await request('/api/permissions', 'PUT', singlePayload)).status, 200);
    assert.equal((await request('/api/file?path=' + encodeURIComponent(single.id + '/single.md'), 'GET', null, true)).data.access, 'r');
    assert.ok([403, 404].includes((await request('/api/file?path=' + encodeURIComponent(single.id + '/../unconfigured.md'), 'GET', null, true)).status));
    const created = await request('/api/documents', 'POST', { directory: otherRoot.id, name: 'new.md' });
    assert.equal(created.status, 201);
    stream = await fetch(base + '/api/document-events?path=' + encodeURIComponent(created.data.path), { headers: remote, signal: AbortSignal.timeout(5000) });
    const reader = stream.body.getReader(), decoder = new TextDecoder();
    assert.match(decoder.decode((await reader.read()).value), /event: ready/);
    const ticket = await request('/api/documents/delete-confirmation', 'POST', { path: created.data.path }); assert.equal(ticket.status, 200);
    assert.equal((await request('/api/documents', 'DELETE', { path: created.data.path, token: ticket.data.token })).status, 200);
    assert.match(decoder.decode((await reader.read()).value), /event: deleted/); await reader.cancel();
    assert.ok([403, 404].includes((await request('/api/file?path=' + encodeURIComponent(created.data.path), 'GET', null, true)).status));
    assert.equal(await fs.readFile(path.join(fixtureRoot, 'unconfigured.md'), 'utf8'), 'outside');
    const script = await fetch(base + '/static/library-context-menu.js'); assert.equal(script.status, 200); assert.match(await script.text(), /libraryPermissionUpdate/);
    // The isolated cwd has no web directory: verify the final EXE embeds the
    // current sorting fix, rather than serving an older build or local assets.
    for (const asset of ['workspace-sort.js', 'app.js', 'browsing-state.js', 'resources.js', 'styles.css']) {
      const response = await fetch(base + '/static/' + asset);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), await fs.readFile(path.join(__dirname, '../web', asset), 'utf8'), 'embedded asset: ' + asset);
    }
  } finally {
    if (stream?.body && !stream.body.locked) await stream.body.cancel().catch(() => {});
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    const absolute = path.resolve(fixtureRoot);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir())); assert.ok(path.basename(absolute).startsWith('mojian-context-'));
    await fs.rm(absolute, { recursive: true, force: true });
  }
});
