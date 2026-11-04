const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const project = path.resolve(__dirname, '..');
const windows = process.platform === 'win32';
const env = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: windows ? 'NUL' : os.devNull,
  GIT_AUTHOR_NAME: 'Publish Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Publish Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
};
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', env, windowsHide: true, timeout: 60000, ...options });
  if (result.error) throw result.error;
  return result;
}
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mojian-publish-中文 '));
  const source = path.join(temporary, 'source project');
  const repository = path.join(source, 'github', 'Local-Markdown-Editor');
  const remote = path.join(temporary, 'remote.git');
  fs.mkdirSync(repository, { recursive: true });
  function write(root, name, text) {
    const destination = path.join(root, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, text);
  }
  function git(...args) {
    const result = command('git', ['-C', repository, ...args]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout.trim();
  }
  t.after(() => {
    const resolved = path.resolve(temporary);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('mojian-publish-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const init = command('git', ['init', '--bare', '--initial-branch=main', remote]);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  git('init', '--initial-branch=main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'commit.gpgSign', 'false');
  git('config', 'tag.gpgSign', 'false');
  git('config', 'core.hooksPath', path.join(repository, '.git', 'hooks'));
  const common = {
    'go.mod': 'module example.invalid/publishfixture\n\ngo 1.23\n',
    'main.go': 'package main\n\n// version location\nvar version = "dev"\n\nfunc main() {\n  println("old")\n}\n',
    'web/obsolete.js': 'const obsolete = true;\n',
    'README.md': '# Public example\n',
  };
  for (const [name, text] of Object.entries(common)) { write(source, name, text); write(repository, name, text); }
  const bat = fs.readFileSync(path.join(project, 'publish_github.bat'));
  const helper = fs.readFileSync(path.join(project, 'scripts/sync-source.mjs'));
  for (const root of [source, repository]) {
    write(root, 'publish_github.bat', bat);
    write(root, 'scripts/sync-source.mjs', helper);
  }
  write(repository, '.gitignore', 'bin/\nconfig.yaml\nlogs/\n');
  write(repository, 'Dockerfile', '# repository-only packaging\n');
  write(repository, 'update.md', '# History\n');
  write(repository, 'scripts/test.mjs', `import fs from 'node:fs';
if (fs.existsSync('fail-checks')) process.exit(7);
fs.mkdirSync('bin', { recursive: true });
fs.writeFileSync('bin/check-ran', 'ok');
`);
  git('add', '--all');
  git('commit', '-m', 'initial fixture');
  git('remote', 'add', 'origin', remote);
  git('tag', '-a', 'v0.1.1', '-m', 'previous release');
  git('push', 'origin', 'main', 'refs/tags/v0.1.1');
  function sync(...args) { return command(process.execPath, [path.join(source, 'scripts/sync-source.mjs'), '--source', source, ...args]); }
  function runBat(...args) {
    return command('cmd.exe', ['/d', '/s', '/c', `""${path.join(source, 'publish_github.bat')}" ${args.join(' ')}"`],
      { cwd: temporary, windowsVerbatimArguments: true });
  }
  function remoteRef(name) { return git('ls-remote', '--refs', 'origin', name).split(/\s/)[0]; }
  function initialize() {
    const result = sync('--init');
    assert.equal(result.status, 0, result.stderr + result.stdout);
  }
  return { source, repository, remote, write, git, sync, runBat, remoteRef, initialize };
}

// These are permanent regressions for merges and publishing; no real remote is used.
test('source sync merges new edits while retaining repository adaptations, additions and deletions', t => {
  const f = fixture(t);
  f.write(f.repository, 'main.go', fs.readFileSync(path.join(f.repository, 'main.go'), 'utf8').replace('"dev"', '"release-adapted"'));
  f.initialize();
  f.write(f.source, 'main.go', fs.readFileSync(path.join(f.source, 'main.go'), 'utf8').replace('"old"', '"new"'));
  f.write(f.source, 'web/added.js', 'const added = true;\n');
  f.write(f.source, 'config.yaml', 'private: never publish\n');
  f.write(f.source, 'docs/access/local.txt', 'private test output\n');
  fs.unlinkSync(path.join(f.source, 'web/obsolete.js'));
  const result = f.sync();
  assert.equal(result.status, 0, result.stderr);
  const merged = fs.readFileSync(path.join(f.repository, 'main.go'), 'utf8');
  assert.match(merged, /release-adapted/);
  assert.match(merged, /println\("new"\)/);
  assert.ok(fs.existsSync(path.join(f.repository, 'web/added.js')));
  assert.ok(!fs.existsSync(path.join(f.repository, 'web/obsolete.js')));
  assert.ok(!fs.existsSync(path.join(f.repository, 'config.yaml')));
  assert.ok(!fs.existsSync(path.join(f.repository, 'docs/access/local.txt')));
  assert.match(fs.readFileSync(path.join(f.repository, 'Dockerfile'), 'utf8'), /repository-only/);
  assert.deepEqual(JSON.parse(f.sync().stdout).changed, []);
});

test('a conflicting merge changes no target files and retains the previous source baseline', t => {
  const f = fixture(t);
  f.initialize();
  f.write(f.source, 'main.go', 'source replacement\n');
  f.write(f.repository, 'main.go', 'repository replacement\n');
  f.write(f.source, 'web/added.js', 'must not be copied on conflict\n');
  const result = f.sync();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NO repository files were changed/);
  assert.equal(fs.readFileSync(path.join(f.repository, 'main.go'), 'utf8'), 'repository replacement\n');
  assert.ok(!fs.existsSync(path.join(f.repository, 'web/added.js')));
  f.write(f.repository, 'main.go', 'source replacement\n');
  assert.equal(f.sync().status, 0);
  assert.ok(fs.existsSync(path.join(f.repository, 'web/added.js')));
});

test('fresh setup refuses to assume differing source and public files are equivalent', t => {
  const f = fixture(t);
  f.write(f.repository, 'README.md', '# Adapted public README\n');
  assert.notEqual(f.sync().status, 0);
  assert.equal(fs.readFileSync(path.join(f.repository, 'README.md'), 'utf8'), '# Adapted public README\n');
  f.initialize();
  assert.deepEqual(JSON.parse(f.sync().stdout).changed, []);
  assert.notEqual(f.sync('--init').status, 0);
});

test('Windows BAT merges, tests, commits and atomically pushes exactly main plus the new annotated tag', { skip: !windows }, t => {
  const f = fixture(t);
  f.initialize();
  f.write(f.source, 'web/feature.js', 'const feature = true;\n');
  f.git('tag', '-a', 'unrelated-local-tag', '-m', 'must stay local');
  f.git('config', 'push.followTags', 'true');
  f.git('config', 'remote.origin.mirror', 'true');
  const result = f.runBat('0.1.2');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const head = f.git('rev-parse', 'HEAD');
  assert.equal(f.remoteRef('refs/heads/main'), head);
  assert.equal(f.git('rev-parse', 'v0.1.2^{}'), head);
  assert.equal(f.git('cat-file', '-t', 'v0.1.2'), 'tag');
  assert.ok(f.remoteRef('refs/tags/v0.1.2'));
  assert.equal(f.remoteRef('refs/tags/unrelated-local-tag'), '');
  assert.match(f.git('show', 'HEAD:web/feature.js'), /feature/);
  assert.match(f.git('show', 'HEAD:update.md'), /node scripts\/test\.mjs/);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.ok(!f.git('ls-files').includes('source-base.json'));
});

test('Windows BAT --check synchronizes and tests but leaves index, commits, tags and remote unchanged', { skip: !windows }, t => {
  const f = fixture(t);
  f.initialize();
  const before = f.git('rev-parse', 'HEAD');
  f.write(f.source, 'web/feature.js', 'const checked = true;\n');
  const result = f.runBat('--check');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /v0\.1\.2/);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.remoteRef('refs/heads/main'), before);
  assert.equal(f.remoteRef('refs/tags/v0.1.2'), '');
  assert.equal(f.git('diff', '--cached', '--name-only'), '');
  assert.ok(fs.existsSync(path.join(f.repository, 'web/feature.js')));
  assert.ok(fs.existsSync(path.join(f.repository, 'bin/check-ran')));
});

test('Windows BAT test failure stops before staging, committing, tagging or pushing', { skip: !windows }, t => {
  const f = fixture(t);
  f.initialize();
  const before = f.git('rev-parse', 'HEAD');
  f.write(f.source, 'web/new.js', 'const newFile = true;\n');
  f.write(f.repository, 'fail-checks', 'yes\n');
  const result = f.runBat('v0.1.2');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Project checks failed/);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.remoteRef('refs/heads/main'), before);
  assert.equal(f.git('tag', '--list', 'v0.1.2'), '');
  assert.equal(f.git('diff', '--cached', '--name-only'), '');
});

test('Windows BAT rejects reused tags, non-main branches and remote commits absent locally', { skip: !windows }, t => {
  const f = fixture(t);
  f.initialize();
  const reused = f.runBat('v0.1.1');
  assert.notEqual(reused.status, 0);
  assert.match(reused.stdout, /Tag already exists/);
  f.git('checkout', '-b', 'feature');
  const branch = f.runBat('v0.1.2');
  assert.notEqual(branch.status, 0);
  assert.match(branch.stdout, /main branch first/);
  f.git('checkout', 'main');
  const before = f.git('rev-parse', 'HEAD');
  f.git('commit', '--allow-empty', '-m', 'remote change');
  f.git('push', 'origin', 'main');
  f.git('reset', '--hard', before);
  const ahead = f.runBat('v0.1.2');
  assert.notEqual(ahead.status, 0);
  assert.match(ahead.stdout, /ahead or has diverged/);
  assert.ok(!fs.existsSync(path.join(f.repository, 'bin/check-ran')));
  assert.equal(f.git('tag', '--list', 'v0.1.2'), '');
});

test('Windows BAT atomic push rejection keeps both remote refs unchanged and prints a retry command', { skip: !windows }, t => {
  const f = fixture(t);
  f.initialize();
  const before = f.remoteRef('refs/heads/main');
  f.write(f.source, 'web/new.js', 'const newFile = true;\n');
  f.write(f.remote, 'hooks/pre-receive', '#!/bin/sh\necho "test rejects release" >&2\nexit 1\n');
  fs.chmodSync(path.join(f.remote, 'hooks/pre-receive'), 0o755);
  const result = f.runBat('v0.1.2');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /To retry this exact commit and tag/);
  assert.equal(f.remoteRef('refs/heads/main'), before);
  assert.equal(f.remoteRef('refs/tags/v0.1.2'), '');
  assert.equal(f.git('cat-file', '-t', 'v0.1.2'), 'tag');
});

test('line endings do not create false conflicts and binary conflicts never use text decoding', t => {
  const f = fixture(t);
  f.write(f.source, 'docs/screenshots/demo.jpg', Buffer.from([255, 1, 2]));
  f.write(f.repository, 'docs/screenshots/demo.jpg', Buffer.from([255, 1, 2]));
  f.initialize();
  f.write(f.source, 'main.go', fs.readFileSync(path.join(f.source, 'main.go'), 'utf8').replace(/\n/g, '\r\n'));
  assert.deepEqual(JSON.parse(f.sync().stdout).changed, []);
  f.write(f.source, 'docs/screenshots/demo.jpg', Buffer.from([254, 1, 2]));
  f.write(f.repository, 'docs/screenshots/demo.jpg', Buffer.from([253, 1, 2]));
  assert.notEqual(f.sync().status, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.repository, 'docs/screenshots/demo.jpg')), Buffer.from([253, 1, 2]));
});

test('source sync rejects directory links instead of writing outside the repository', t => {
  const f = fixture(t);
  f.initialize();
  const outside = path.join(f.source, 'outside');
  fs.mkdirSync(outside);
  const web = path.resolve(f.repository, 'web');
  assert.ok(web.startsWith(path.resolve(f.repository) + path.sep));
  assert.equal(fs.lstatSync(web).isSymbolicLink(), false);
  fs.rmSync(web, { recursive: true });
  fs.symlinkSync(outside, path.join(f.repository, 'web'), windows ? 'junction' : 'dir');
  f.write(f.source, 'web/new.js', 'must stay outside link target\n');
  const result = f.sync();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic link or junction/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('Windows BAT without a version auto-increments remote and local release tags without interactive input', { skip: !windows }, t => {
  const f = fixture(t);
  f.initialize();
  // A remote-only stable tag must be included; higher prereleases are not stable versions.
  f.git('tag', '-a', 'v0.1.9', '-m', 'remote stable version');
  f.git('push', 'origin', 'refs/tags/v0.1.9');
  f.git('tag', '-d', 'v0.1.9');
  f.git('tag', '-a', 'v9.0.0-rc.1', '-m', 'prerelease');
  f.write(f.source, 'web/automatic.js', 'const automatic = true;\n');
  const first = f.runBat();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /Automatically selected version: v0\.1\.10/);
  assert.doesNotMatch(first.stdout, /New version \(Enter|Press any key|按任意键/i);
  assert.equal(f.git('rev-parse', 'v0.1.10^{}'), f.remoteRef('refs/heads/main'));
  assert.equal(f.git('cat-file', '-t', 'v0.1.10'), 'tag');
  assert.ok(f.remoteRef('refs/tags/v0.1.10'));
  // Numeric ordering must put .11 above .9 and avoid reusing a local-only tag.
  f.git('tag', '-a', 'v0.1.11', '-m', 'local stable version');
  const second = f.runBat();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /Automatically selected version: v0\.1\.12/);
  assert.equal(f.git('rev-parse', 'v0.1.12^{}'), f.remoteRef('refs/heads/main'));
  assert.ok(f.remoteRef('refs/tags/v0.1.12'));
  assert.equal(f.remoteRef('refs/tags/v0.1.11'), '');
  assert.equal(f.remoteRef('refs/tags/v9.0.0-rc.1'), '');
});
