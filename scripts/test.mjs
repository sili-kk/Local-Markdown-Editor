import { readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = path.join(root, 'bin', process.platform === 'win32' ? 'md-editor.exe' : 'md-editor');
mkdirSync(path.dirname(binary), { recursive: true });
function run(program, args, extraEnv = {}) {
  const result = spawnSync(program, args, { cwd: root, env: { ...process.env, ...extraEnv }, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run('go', ['test', './...']);
run('go', ['vet', './...']);
// Build before HTTP tests: the test server embeds the current frontend.
run('go', ['build', '-trimpath', '-o', binary, '.']);
const files = readdirSync(path.join(root, 'tests')).filter(name => /\.(test|http)\.cjs$/.test(name)).sort().map(name => path.join(root, 'tests', name));
run(process.execPath, ['--test', ...files], { EDITOR_TEST_BINARY: binary });
