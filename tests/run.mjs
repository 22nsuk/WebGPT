// Keep one test-file budget across the repository and installed-layout phases.
// Each file may also launch real workers, supervisors and PowerShell processes.
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = directory => readdirSync(new URL('../' + directory + '/', import.meta.url), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(directory + '/' + entry.name)
    : entry.isFile() && entry.name.endsWith('.test.mjs') ? [directory + '/' + entry.name] : []).sort();
const installation = 'tests/installation.test.mjs';
const phases = [
  ['repository', [...files('skills/webgpt/scripts'), ...files('tests').filter(file => file !== installation)]],
  ['installed layout', [installation]],
];
for (const [name, tests] of phases) {
  console.log('WebGPT test phase: ' + name);
  const child = spawn(process.execPath, ['--test', '--test-concurrency=2', '--test-reporter=tap', ...tests], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(signal ? 1 : code));
  });
  if (code !== 0) { process.exitCode = code ?? 1; break; }
}
