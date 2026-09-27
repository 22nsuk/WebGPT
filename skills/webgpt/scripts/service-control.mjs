// Local supervisor control only. No HTTP/MCP, filesystem command marker or retry.
// owner.json is private discovery; only credentials captured by the live listener
// authorize a stop. Mutual challenge proofs keep keys off the wire and bind each
// command/ack to this runtime, incarnation and connection's two fresh nonces.
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { readDiagnosticBytes } from './audit.mjs';
import { fault } from './runtime.mjs';

const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const nonce = () => randomBytes(32).toString('hex');
const unavailable = () => fault('SERVICE_CONTROL_UNAVAILABLE', 'service control unavailable; inspect the selected runtime and update matching scripts');
const unconfirmed = () => fault('SERVICE_STOP_UNCONFIRMED', 'service stop unconfirmed; inspect the instance before any explicit retry');
const mac = (c, role, client, server) => createHmac('sha256', Buffer.from(c.key, 'hex'))
  .update(JSON.stringify(['webgpt-service-v1', role, c.instanceId, c.runtime, client, server])).digest('hex');
const matches = (actual, expected) => hex(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));

export function serviceRuntime(dir) {
  const raw = realpathSync.native(dir, { encoding: 'buffer' }), canonical = raw.toString('utf8');
  if (!Buffer.from(canonical).equals(raw)) throw unavailable();
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  return createHash('sha256').update(JSON.stringify([canonical, stat.dev, stat.ino])).digest('hex');
}

export function readServiceControl(dir) {
  try {
    const lock = join(dir, 'service.lock'), stat = lstatSync(lock), file = join(lock, 'owner.json');
    const ownerStat = lstatSync(file);
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || (process.platform !== 'win32' && ((stat.mode | ownerStat.mode) & 0o077))) throw unavailable();
    const bytes = readDiagnosticBytes(file, 4096);
    const owner = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const c = owner.serviceControl;
    if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !uuid(owner.instanceId)
        || !exact(c, ['version', 'port', 'key', 'runtime']) || c.version !== 1
        || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535 || !hex(c.key)
        || !hex(c.runtime) || c.runtime !== serviceRuntime(dir)) throw unavailable();
    return { ...c, instanceId: owner.instanceId };
  } catch { throw unavailable(); } // Never echo owner data, credentials, endpoint or raw I/O details.
}

// Newline JSON frames, bounded before concatenation/parse; strict UTF-8, one
// fixed protocol flow, no idle timeout reset. No arbitrary command dispatch.
function receive(socket, onFrame, onFailure) {
  let pending = Buffer.alloc(0), total = 0;
  const fail = () => { socket.destroy(); onFailure?.(); };
  socket.on('error', fail);
  socket.on('data', chunk => {
    total += chunk.length;
    if (total > 4096) return fail();
    pending = Buffer.concat([pending, chunk]);
    let at;
    while ((at = pending.indexOf(10)) !== -1) {
      if (at > 1024) return fail();
      const line = pending.subarray(0, at); pending = pending.subarray(at + 1);
      try { onFrame(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))); }
      catch { return fail(); }
      if (socket.destroyed) return;
    }
    if (pending.length > 1024) fail();
  });
}
const send = (socket, frame) => socket.write(JSON.stringify(frame) + '\n');

export async function listenServiceControl(dir) {
  const runtime = serviceRuntime(dir), key = nonce(), sockets = new Set();
  let credentials, stop, closing, accepted = false;
  const server = createServer(socket => {
    if (!credentials || closing || socket.remoteAddress !== '127.0.0.1' || sockets.size >= 16) return socket.destroy();
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), 2000);
    socket.once('close', () => { clearTimeout(timer); sockets.delete(socket); });
    let phase = 0, client, challenge;
    receive(socket, frame => {
      if (phase === 0) {
        if (!exact(frame, ['version', 'instanceId', 'runtime', 'nonce']) || frame.version !== 1
            || frame.instanceId !== credentials.instanceId || frame.runtime !== runtime || !hex(frame.nonce)) throw Error();
        client = frame.nonce; challenge = nonce(); phase = 1;
        send(socket, { challenge, proof: mac(credentials, 'server', client, challenge) });
      } else if (phase === 1) {
        if (!exact(frame, ['proof']) || !matches(frame.proof, mac(credentials, 'stop', client, challenge))) throw Error();
        phase = 2; // Consume before the callback: a duplicate frame cannot invoke it again.
        if (!accepted) { accepted = true; stop(); } // Independent of acknowledgment delivery.
        socket.end(JSON.stringify({ accepted: true, proof: mac(credentials, 'accepted', client, challenge) }) + '\n');
      } else throw Error();
    });
  });
  server.maxConnections = 16;
  const listening = once(server, 'listening');
  server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
  try { await listening; } catch (error) { server.close(); throw error; }
  // An unexpected listener failure cannot authorize a stop or bypass ownership.
  server.on('error', () => { for (const socket of sockets) socket.destroy(); });
  return {
    descriptor: Object.freeze({ version: 1, port: server.address().port, key, runtime }),
    activate(instanceId, callback) {
      if (credentials || !uuid(instanceId) || typeof callback !== 'function') throw unavailable();
      credentials = { key, runtime, instanceId }; stop = callback;
    },
    close() {
      if (!closing) closing = new Promise(resolve => {
        const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 250);
        server.close(() => { clearTimeout(timer); resolve(); });
      });
      return closing;
    },
  };
}

export async function sendServiceStop(c) {
  c = { ...c }; // One captured target; no reread/retarget during an uncertain exchange.
  // Discovery supplies only the port; neither a host nor a URL/redirect is accepted.
  if (!c || c.version !== 1 || !uuid(c.instanceId) || !hex(c.runtime) || !hex(c.key)
      || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw unavailable();
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: c.port });
    const client = nonce(); let phase = 0, challenge, settled = false, sent = false;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(Object.assign(unconfirmed(), { requestMayHaveBeenSent: sent }));
      else resolve({ accepted: true });
    };
    const timer = setTimeout(() => finish(true), 2000);
    socket.once('close', () => finish(true));
    receive(socket, frame => {
      if (phase === 0) {
        if (!exact(frame, ['challenge', 'proof']) || !hex(frame.challenge)
            || !matches(frame.proof, mac(c, 'server', client, frame.challenge))) throw Error();
        challenge = frame.challenge; phase = 1; sent = true;
        send(socket, { proof: mac(c, 'stop', client, challenge) });
      } else if (phase === 1) {
        if (!exact(frame, ['accepted', 'proof']) || frame.accepted !== true
            || !matches(frame.proof, mac(c, 'accepted', client, challenge))) throw Error();
        phase = 2; finish(false);
      } else throw Error();
    }, () => finish(true));
    socket.once('connect', () => send(socket, { version: 1, instanceId: c.instanceId, runtime: c.runtime, nonce: client }));
  }); // Exactly one connection/stop attempt. Never retry or use a marker on uncertainty.
}
