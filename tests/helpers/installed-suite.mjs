// Repository-only harness. Test children run solely against the copied skill.
import fs from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const execute = promisify(execFile);
const tailLimit = 64 * 1024;
async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
  finally { clearTimeout(timer); }
}

async function discover(directory, prefix = '') {
  const entries = await fs.readdir(join(directory, prefix), { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const name = join(prefix, entry.name);
    return entry.isDirectory() ? discover(directory, name)
      : entry.isFile() && name.endsWith('.test.mjs') ? [name] : [];
  }));
  return files.flat().sort();
}

async function terminateTree(child) {
  // Do not send an OS command to a PID whose tracked process already exited.
  // Inherited pipes can remain open after that exit; preserve evidence instead.
  if (child.exitCode !== null || child.signalCode !== null || !child.pid)
    throw Error('runner exited before tree teardown; descendant ownership is unconfirmed');
  if (process.platform === 'win32') {
    await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, timeout: 5000,
    });
  } else {
    // Each test runner owns a new process group, including ordinary fixture children.
    process.kill(-child.pid, 'SIGKILL');
  }
}

async function runFile(directory, file, timeoutMs, progress) {
  const started = performance.now();
  progress(`START ${file}`);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--test', '--test-concurrency=2', '--test-reporter=tap', file], {
    cwd: directory, env, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', spawnError;
  child.stdout.on('data', bytes => { stdout = (stdout + bytes.toString()).slice(-tailLimit); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-tailLimit); });
  child.on('error', error => { spawnError = error; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let exit = await within(closed, timeoutMs);
  let error, cleanupSafe = true;
  if (!exit) {
    error = Object.assign(Error(`installed test file exceeded ${timeoutMs} ms: ${file}`), { code: 'TEST_FILE_TIMEOUT' });
    try {
      await terminateTree(child);
      // A successful kill request is not a substitute for observing stream closure.
      exit = await within(closed, 5000);
      if (!exit) throw Error('test runner streams did not close after tree teardown');
    } catch (teardownError) {
      cleanupSafe = false;
      error = new Error(error.message + '; tree teardown unconfirmed: ' + teardownError.message, { cause: error });
      // Do not let inherited pipes turn a bounded failure into an indefinite wait.
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
    }
  } else if (spawnError || exit.code !== 0 || exit.signal) {
    error = new Error(`installed test file failed: ${file}; code=${exit.code}, signal=${exit.signal}`, { cause: spawnError });
    // An abnormal runner exit is not proof its descendants have released the copy.
    cleanupSafe = false;
  }
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(name =>
    [name, Number(stdout.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN)]));
  if (!error && (!Number.isSafeInteger(counts.tests) || counts.tests < 1
      || !Number.isSafeInteger(counts.pass) || !Number.isSafeInteger(counts.skipped)
      || counts.fail !== 0 || counts.cancelled !== 0))
    error = Error(`installed test file did not report a successful TAP summary: ${file}`);
  const elapsed = Math.round(performance.now() - started);
  progress(`${error ? 'FAIL' : 'DONE'} ${file} (${elapsed} ms)`);
  if (error) progress(`${error.message}\nstdout tail:\n${stdout}\nstderr tail:\n${stderr}`);
  return { file, counts, error, cleanupSafe };
}

export async function runInstalledSuite(directory, {
  timeoutMs = process.platform === 'win32' ? 120000 : 60000,
  progress = message => process.stderr.write(`[installed] ${message}\n`),
} = {}) {
  const files = await discover(directory);
  if (!files.length) throw Error('installed skill has no test files');
  let next = 0;
  const results = [];
  // One budget of two active test files. Continue after failure, like node --test.
  const pools = await Promise.allSettled([0, 1].map(async () => {
    while (next < files.length) results.push(await runFile(directory, files[next++], timeoutMs, progress));
  }));
  const failures = results.filter(result => result.error);
  const unexpected = pools.filter(pool => pool.status === 'rejected').map(pool => pool.reason);
  if (unexpected.length) throw Object.assign(new AggregateError([...failures.map(result => result.error), ...unexpected],
    'installed runner failed', { cause: failures[0]?.error ?? unexpected[0] }), { cleanupSafe: false });
  if (failures.length) throw Object.assign(new AggregateError(failures.map(result => result.error),
    `${failures.length} installed test file(s) failed`, { cause: failures[0].error }), {
    cleanupSafe: results.every(result => result.cleanupSafe),
  });
  return results.reduce((total, result) => {
    for (const key of Object.keys(result.counts)) total[key] = (total[key] ?? 0) + result.counts[key];
    return total;
  }, {});
}

export async function cleanupInstallation(directory, primaryError) {
  if (primaryError?.cleanupSafe === false)
    throw new Error(`${primaryError.message}; retained installation with unconfirmed descendant teardown: ${directory}`, { cause: primaryError });
  try {
    // Windows handle release can lag process closure. Bound retries; never mask failure.
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (cleanupError) {
    if (primaryError) throw new AggregateError([primaryError, cleanupError],
      `${primaryError.message}; installation cleanup also failed: ${cleanupError.message}`, { cause: primaryError });
    throw cleanupError;
  }
  if (primaryError) throw primaryError;
}
