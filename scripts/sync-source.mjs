import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';

// Local source snapshots live in .git, never in the public repository or a pushed ref.
const args = process.argv.slice(2);
let initialize = false, sourceArgument;
const acceptedNames = new Set();
function usage() {
  console.error('Usage: node scripts/sync-source.mjs --source <project-directory> [--init | --accept-merge <file> ...]');
  process.exit(1);
}
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--init' && !initialize) { initialize = true; continue; }
  if (argument !== '--source' && argument !== '--accept-merge') usage();
  const value = args[++index];
  if (!value || value.startsWith('-')) usage();
  if (argument === '--source') {
    if (sourceArgument !== undefined) usage();
    sourceArgument = value;
  } else {
    const name = value.replace(/\\/g, '/');
    if (acceptedNames.has(name)) usage();
    acceptedNames.add(name);
  }
}
if (!sourceArgument || initialize && acceptedNames.size) usage();
const source = fs.realpathSync(path.resolve(sourceArgument));
const repository = path.resolve(source, 'github/Local-Markdown-Editor');

function git(args, options = {}) {
  const result = spawnSync('git', ['-C', repository, ...args], { windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr?.toString().trim()}`);
  return result.stdout;
}
function allowed(relative) {
  if (relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) return false;
  if (!relative.includes('/')) return /\.go$/.test(relative) || ['go.mod', 'go.sum', 'README.md', 'publish_github.bat'].includes(relative);
  if (/^(web|tests|tools|scripts)\//.test(relative)) {
    return /\.(?:go|js|cjs|mjs|css|html|svg|json|map|md|txt|ps1|png|jpe?g|gif|webp|ico|woff2?|ttf)$/.test(relative);
  }
  return /^docs\/(?!access\/|security\/|resources\/|concurrency\/).+\.(?:md|png|jpe?g|gif|webp|svg)$/.test(relative);
}
function readChecked(root, relative) {
  if (!allowed(relative)) throw new Error(`Refusing a path outside the source allowlist: ${relative}`);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Refusing a symbolic link or junction: ${current}`);
  }
  if (!fs.statSync(current).isFile()) throw new Error(`Expected an ordinary file: ${current}`);
  return fs.readFileSync(current);
}
function equal(a, b) {
  if (a === null || b === null) return a === b;
  if (a.equals(b)) return true;
  return !a.includes(0) && !b.includes(0) && isUtf8(a) && isUtf8(b) && a.toString('utf8').replace(/\r\n/g, '\n') === b.toString('utf8').replace(/\r\n/g, '\n');
}
function enumerate(root, relative = '') {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Refusing a symbolic link or junction: ${directory}`);
  const found = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    if (['.git', 'node_modules', 'bin', 'dist', 'runtime', 'logs', 'tmp', 'test-results'].includes(item.name)) continue;
    if (item.isDirectory()) {
      if (relative || ['web', 'tests', 'tools', 'scripts', 'docs'].includes(item.name)) {
        if (!/^docs\/(?:access|security|resources|concurrency)(?:\/|$)/.test(name)) found.push(...enumerate(root, name));
      }
    } else if (allowed(name)) {
      if (item.isSymbolicLink()) throw new Error(`Refusing a symbolic link: ${name}`);
      // Only screenshots and already-public documents may enter docs automatically.
      if (!name.startsWith('docs/') || name.startsWith('docs/screenshots/') || readChecked(repository, name) !== null) found.push(name);
    }
  }
  return found.sort();
}
function merge(current, base, incoming) {
  if ([current, base, incoming].some(data => data.includes(0) || !isUtf8(data))) return null;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mojian-merge-'));
  try {
    const files = [current, base, incoming].map((data, index) => {
      const name = path.join(temporary, String(index));
      fs.writeFileSync(name, data.toString('utf8').replace(/\r\n/g, '\n'));
      return name;
    });
    const result = spawnSync('git', ['merge-file', '-p', '--', ...files], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) return null;
    return result.stdout;
  } finally {
    // Only these three known files are ever created or removed; no recursive cleanup.
    for (const name of ['0', '1', '2']) {
      const file = path.join(temporary, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(temporary);
  }
}

try {
  if (source === fs.realpathSync(repository)) throw new Error('Source and repository must be different directories.');
  if (fs.realpathSync(repository) !== repository) throw new Error('The repository path must not contain symbolic links or junctions.');
  for (const root of [source, repository]) {
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Project roots must not be symbolic links or junctions.');
  }
  const topLevel = git(['rev-parse', '--show-toplevel']).toString().trim();
  if (fs.realpathSync(topLevel) !== repository) throw new Error('The target must be the root of its own Git repository.');
  const gitDirectory = git(['rev-parse', '--absolute-git-dir']).toString().trim();
  const stateDirectory = path.join(gitDirectory, 'mojian-publish-sync');
  if (fs.existsSync(stateDirectory) && fs.lstatSync(stateDirectory).isSymbolicLink()) throw new Error('Sync state must not be a symbolic link.');
  const stateFile = path.join(stateDirectory, 'source-base.json');
  if (fs.existsSync(stateFile) && fs.lstatSync(stateFile).isSymbolicLink()) throw new Error('Sync state must not be a symbolic link.');
  if (initialize && fs.existsSync(stateFile)) throw new Error('A sync baseline already exists; refusing to replace it.');
  const previous = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { schema: 1, files: {} };
  if (previous.schema !== 1 || !previous.files || Array.isArray(previous.files)) throw new Error('Unsupported sync baseline.');
  if (acceptedNames.size && !fs.existsSync(stateFile)) throw new Error('No sync baseline exists; review first-time setup and use --init.');
  for (const name of acceptedNames) {
    if (readChecked(source, name) === null || readChecked(repository, name) === null) {
      throw new Error('--accept-merge requires an existing source and public file: ' + name);
    }
  }
  const names = [...new Set([...enumerate(source), ...Object.keys(previous.files), ...acceptedNames])].sort();
  const next = { schema: 1, files: {} };
  const changes = [];
  const conflicts = [];
  const preserved = [];
  const accepted = [];
  for (const name of names) {
    const incoming = readChecked(source, name);
    const current = readChecked(repository, name);
    const base = Object.hasOwn(previous.files, name) ? Buffer.from(previous.files[name], 'base64') : null;
    if (initialize) {
      if (incoming !== null && current !== null) {
        next.files[name] = incoming.toString('base64');
        if (!equal(incoming, current)) preserved.push(name);
      }
      continue;
    }
    if (incoming !== null) next.files[name] = incoming.toString('base64');
    // Explicitly record a reviewed manual merge without replacing its public
    // adaptation. Any other unresolved conflict still aborts the whole sync.
    if (acceptedNames.has(name)) { accepted.push(name); continue; }
    // An unchanged source must never overwrite edits made only in the public repository.
    if (equal(incoming, base) || equal(incoming, current)) continue;
    if (equal(current, base)) { changes.push({ name, data: incoming }); continue; }
    if (base !== null && incoming !== null && current !== null) {
      const merged = merge(current, base, incoming);
      if (merged !== null) { if (!equal(current, merged)) changes.push({ name, data: merged }); continue; }
    }
    conflicts.push(name);
  }
  if (conflicts.length) {
    throw new Error('Source synchronization conflicts; NO repository files were changed:\n' + conflicts.map(name => `  ${name}`).join('\n') +
      '\nAfter manually merging and reviewing each file in the public repository, record it with node scripts/sync-source.mjs --source <project-directory> --accept-merge <file> (repeat the flag for multiple files), then rerun publishing. For first-time setup only, review intentional differences and use --init.');
  }
  for (const { name, data } of changes) {
    // Recheck the path immediately before writing or deleting an allowlisted ordinary file.
    readChecked(repository, name);
    const destination = path.join(repository, name);
    if (data === null) fs.unlinkSync(destination);
    else { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, data); }
  }
  fs.mkdirSync(stateDirectory, { recursive: true });
  const temporaryState = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryState, JSON.stringify(next), { flag: 'wx' });
  fs.renameSync(temporaryState, stateFile);
  console.log(JSON.stringify({ initialized: initialize, changed: changes.map(change => change.name), preserved, accepted }));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
