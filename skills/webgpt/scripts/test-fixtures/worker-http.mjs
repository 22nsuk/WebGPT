// Test transport only: callers still own task setup, evidence and assertions.
// All traffic is loopback; config is the fixture's own (restartable) controller.
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

export const replyJson = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
};
export async function callTool(worker, name, args) {
  const response = await fetch(`http://127.0.0.1:${worker.mcpPort}/mcp`, {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await response.json()).result;
}

// Observe completion of the real body parser, then let its state-check
// continuation finish before exposing the parked response to a test trigger.
export function afterWaitBody(req, res, accepted) {
  if (req.method === 'POST') req.once('end', () => setImmediate(() => accepted(res)));
  else setImmediate(() => accepted(res));
}

export async function readScope(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return req.method === 'POST' ? JSON.parse(Buffer.concat(chunks).toString('utf8')).ids
    : new URL(req.url, 'http://localhost').searchParams.getAll('id');
}

export function controllerObservation(req, bytes) {
  const url = new URL(req.url, 'http://localhost');
  const ids = ['/wait', '/reconcile'].includes(url.pathname)
    ? req.method === 'POST' ? JSON.parse(bytes.toString('utf8')).ids : url.searchParams.getAll('id')
    : undefined;
  return { method: req.method, path: req.url, ids };
}

export function assertScopedRead(observation, ids) {
  const path = new URL(observation.path, 'http://localhost').pathname;
  if (['/wait', '/reconcile'].includes(path))
    assert.deepEqual(observation, { method: 'POST', path, ids });
}

export async function controllerProxy(config, intercept = async () => false) {
  const actions = [], requests = [], failures = [];
  const server = createServer((req, res) => {
    Promise.resolve().then(async () => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      actions.push(req.url);
      const observation = controllerObservation(req, Buffer.concat(chunks));
      requests.push(observation);
      const event = { req, res, actions, requests, observation };
      if (await intercept({ ...event, phase: 'before' })) return;
      // Read the fixture's current port on every request so restarts stay real.
      // Never forward to a Location header or replace controller state with a mock.
      const response = await fetch(`http://127.0.0.1:${config.controlPort}${req.url}`, {
        method: req.method, headers: { authorization: req.headers.authorization, 'content-type': 'application/json' },
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}), redirect: 'error',
      });
      const data = await response.json();
      if (!await intercept({ ...event, phase: 'after', data })) replyJson(res, data, response.status);
    }).catch(error => { failures.push(error.message); res.destroy(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { actions, requests, failures, port: server.address().port, close: () => new Promise(resolve => {
    // Stop accepting connections before destroying this proxy's owned sockets.
    server.close(resolve); server.closeAllConnections();
  }) };
}
