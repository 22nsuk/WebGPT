import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

// Plain transport: no model calls, shell execution, polling, or public listener.
export async function createReceiver({ journal, backupMs = 900000 } = {}) {
  if (!journal || !Number.isFinite(backupMs) || backupMs <= 0) throw new Error('journal and positive backupMs required');
  const tasks = new Map(), pending = new Map(), waiters = new Set();
  let closed = false;
  const save = event => appendFileSync(journal, JSON.stringify(event) + '\n', { mode: 0o600 });
  const wake = () => { for (const fn of [...waiters]) fn(); };
  const server = createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const task = [...tasks.values()].find(t => req.url === '/complete/' + t.token);
    if (req.method !== 'POST' || !task) return reply(404, { error: 'unknown callback' });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 8192) return reply(413, { error: 'payload too large' }); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!input || input.taskId !== task.id || !['completed','failed','cancelled'].includes(input.status)) return reply(400, { error: 'invalid task/status' });
      for (const key of ['summary','artifact']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 2048)) return reply(400, { error: 'invalid ' + key });
      if (task.done) return reply(200, { accepted: true, duplicate: true });
      const event = { taskId: task.id, status: input.status, summary: input.summary ?? '', artifact: input.artifact ?? '', receivedAt: new Date().toISOString() };
      save({ type: 'completion', ...event });
      task.done = true; pending.set(task.id, event); wake();
      reply(200, { accepted: true });
    } catch (error) { reply(error instanceof SyntaxError ? 400 : 500, { error: 'completion not accepted' }); }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const snapshot = () => ({ events: [...pending.values()], backupDue: [...tasks.values()].filter(t => !t.done && Date.now() >= t.nextCheck).map(t => t.id), closed });
  return {
    register(id) {
      if (closed || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || tasks.has(id)) throw new Error('invalid/duplicate task');
      const task = { id, token: randomUUID(), done: false, nextCheck: Date.now() + backupMs };
      save({ type: 'registered', taskId: id, at: new Date().toISOString() });
      tasks.set(id, task); wake(); return { taskId: id, callback: base + '/complete/' + task.token };
    },
    ack(id) { if (!pending.has(id)) throw new Error('no pending completion'); save({ type: 'collected', taskId: id }); pending.delete(id); },
    checked(id) { const task = tasks.get(id); if (!task) throw new Error('unknown task'); task.nextCheck = Date.now() + backupMs; },
    finish(id) { const task = tasks.get(id); if (!task) throw new Error('unknown task'); save({ type: 'fallback-collected', taskId: id }); task.done = true; pending.delete(id); wake(); },
    async wait(maxMs = 55000) {
      if (!Number.isFinite(maxMs) || maxMs <= 0 || maxMs > 55000) throw new Error('wait must be 1..55000 ms');
      const state = snapshot(); if (state.events.length || state.backupDue.length || closed) return state;
      return new Promise(resolve => {
        let timer;
        const done = () => { clearTimeout(timer); waiters.delete(done); resolve(snapshot()); };
        waiters.add(done);
        const due = Math.min(...[...tasks.values()].filter(t => !t.done).map(t => t.nextCheck - Date.now()));
        timer = setTimeout(done, Math.max(1, Math.min(maxMs, due)));
      });
    },
    async close() { if (closed) return; closed = true; wake(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}
