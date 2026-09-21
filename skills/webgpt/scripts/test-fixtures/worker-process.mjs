// Test-only process fixtures: exercise the real CLI/IPC lifecycle with kernel-owned
// ports from the actual listen, not a listen(0)/close reservation that another
// parallel test or outgoing connection can take. Fixed-port binding/conflict is
// covered separately by client.test.mjs; no production port contract changes.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { Server } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

if (new URL(import.meta.url).search === '?ephemeral') {
  const config = JSON.parse(readFileSync(process.env.WEBGPT_CONFIG, 'utf8'));
  const expected = [config.mcpPort, config.controlPort];
  const listen = Server.prototype.listen;
  let index = 0;
  Server.prototype.listen = function(port, host, callback) {
    if (arguments.length !== 3 || !Number.isInteger(port) || port !== expected[index++]
        || host !== '127.0.0.1' || typeof callback !== 'function')
      throw Error('unexpected worker fixture listener');
    return listen.call(this, 0, host, callback);
  };
}

export function observeChild(child, onListening = () => {}) {
  let stdout = '', stderr = '', pending = '';
  const observed = { child, listening: null, exit: once(child, 'exit'),
    diagnostic: () => JSON.stringify({ pid: child.pid, exitCode: child.exitCode,
      signalCode: child.signalCode, stdout, stderr }),
  };
  child.stdout.on('data', bytes => {
    const text = bytes.toString(); stdout = (stdout + text).slice(-8192);
    pending = (pending + text).slice(-8192);
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.event === 'listening' && Number.isInteger(event.mcpPort) && Number.isInteger(event.controlPort)) {
        observed.listening = event; onListening(event);
      }
    }
  });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-8192); });
  return observed;
}

export function spawnFixtureWorker(executable, args, options, onListening) {
  return observeChild(spawn(executable, ['--import', import.meta.url + '?ephemeral', ...args], {
    ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  }), onListening);
}

export async function untilFixture(predicate, { timeoutMs, label, diagnostic = () => '', stopped = () => false }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    if (stopped()) throw Error(label + ': child exited before readiness; ' + diagnostic(), { cause: last });
    try { if (await predicate()) return; } catch (error) { last = error; }
    await delay(10);
  }
  throw Error(label + ': fixture deadline; ' + diagnostic(), { cause: last });
}
