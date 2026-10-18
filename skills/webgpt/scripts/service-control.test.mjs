// Real loopback streams and disposable private discovery. No privileged host or
// browser/Worker control is exposed by this fixture. HMACs here are independent
// protocol clients, not mocks of the listener's authorization decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRuntimeLock } from './runtime.mjs';
import { listenServiceControl, sendServiceStop, readServiceControl, serviceRuntime } from './service-control.mjs';

const random = () => randomBytes(32).toString('hex');
const proof = (c, role, a, b) => createHmac('sha256', Buffer.from(c.key, 'hex'))
  .update(JSON.stringify(['webgpt-service-v1', role, c.instanceId, c.runtime, a, b])).digest('hex');
function peer(port) {
  const socket = createConnection({ host: '127.0.0.1', port });
  const queue = [], pending = []; let buffer = '', ended = false;
  socket.on('error', () => {});
  socket.on('data', bytes => {
    buffer += bytes.toString(); let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      if (pending.length) pending.shift()(frame); else queue.push(frame);
    }
  });
  const closed = new Promise(resolve => socket.once('close', () => {
    ended = true; for (const done of pending.splice(0)) done(null); resolve();
  }));
  return { socket, closed, send: value => socket.write(JSON.stringify(value) + '\n'),
    next: () => queue.length ? Promise.resolve(queue.shift()) : ended ? Promise.resolve(null) : new Promise(resolve => pending.push(resolve)) };
}
async function fixture(t, identity) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-channel-')));
  if (identity) {
    // Only dev/ino are synthetic. Paths, directories, owner bytes and TCP peers
    // remain real; Number callers see the same rounding as native fs metadata.
    const native = fs.lstatSync;
    const metadata = t.mock.method(fs, 'lstatSync', (path, options) => {
      const stat = native(path, options);
      if (path === dir) for (const field of ['dev', 'ino'])
        stat[field] = options?.bigint ? identity[field] : Number(identity[field]);
      return stat;
    });
    syncBuiltinESMExports();
    t.after(() => { metadata.mock.restore(); syncBuiltinESMExports(); });
  }
  const channel = await listenServiceControl(dir);
  const owner = acquireRuntimeLock(dir, { name: 'service', serviceControl: channel.descriptor });
  let stopped = 0; channel.activate(owner.instanceId, () => { stopped++; });
  const c = readServiceControl(dir), file = join(dir, 'service.lock', 'owner.json');
  t.after(async () => { await channel.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, channel, owner, c, file, stopped: () => stopped };
}
async function hello(c, port = c.port) {
  const p = peer(port), nonce = random();
  p.send({ version: 1, instanceId: c.instanceId, runtime: c.runtime, nonce });
  const challenge = await p.next();
  assert.equal(challenge.proof, proof(c, 'server', nonce, challenge.challenge));
  return { ...p, nonce, challenge: challenge.challenge };
}

test('live credentials stop once without creating, reading or deleting a stop marker', async t => {
  const f = await fixture(t), original = fs.readFileSync(f.file);
  const marker = join(f.dir, 'service.lock', 'stop-request');
  fs.mkdirSync(marker); fs.writeFileSync(join(marker, 'preserve'), 'not authority');
  assert.deepEqual(await sendServiceStop(f.c), { accepted: true });
  assert.deepEqual(await sendServiceStop(f.c), { accepted: true }); // Explicit repeats, one callback.
  assert.equal(f.stopped(), 1); assert.deepEqual(fs.readFileSync(f.file), original);
  assert.equal(fs.readFileSync(join(marker, 'preserve'), 'utf8'), 'not authority');
  await f.channel.close();
  await assert.rejects(sendServiceStop(f.c), { code: 'SERVICE_STOP_UNCONFIRMED', requestMayHaveBeenSent: false });
});

for (const [dev, ino] of [[17n, 42n], [0n, BigInt(Number.MAX_SAFE_INTEGER)], [BigInt(Number.MAX_SAFE_INTEGER), 0n]])
  test(`safe integer runtime ${dev}/${ino} retains the legacy digest and v1 stop`, async t => {
    const f = await fixture(t, { dev, ino });
    const legacy = createHash('sha256').update(JSON.stringify([f.dir, Number(dev), Number(ino)])).digest('hex');
    const before = fs.readFileSync(f.file), owner = JSON.parse(before);
    assert.equal(serviceRuntime(f.dir), legacy);
    assert.deepEqual(owner.serviceControl, { version: 1, port: f.c.port, key: f.c.key, runtime: legacy });
    assert.deepEqual(f.c, { ...owner.serviceControl, instanceId: f.owner.instanceId });
    assert.deepEqual(await sendServiceStop({ ...f.c, runtime: legacy }), { accepted: true });
    assert.equal(f.stopped(), 1); assert.deepEqual(fs.readFileSync(f.file), before);
  });

for (const field of ['dev', 'ino']) test(`full-width runtime ${field} rejects copied discovery after directory replacement`, async t => {
  const first = 2n ** 53n, identity = { dev: 17n, ino: 42n, [field]: first };
  const f = await fixture(t, identity), original = fs.readFileSync(f.file), retained = f.dir + '-original';
  t.after(() => fs.rmSync(retained, { recursive: true, force: true }));
  fs.renameSync(f.dir, retained); fs.mkdirSync(f.dir, { mode: 0o700 });
  fs.mkdirSync(join(f.dir, 'service.lock'), { mode: 0o700 });
  fs.writeFileSync(f.file, original, { mode: 0o600 });
  identity[field]++;
  assert.notEqual(first, identity[field]); assert.equal(Number(first), Number(identity[field]));
  // A fresh lookup must fail before the still-live original listener is sent a
  // stop. This same path authenticated and stopped it under rounded identities.
  await assert.rejects(async () => sendServiceStop(readServiceControl(f.dir)), { code: 'SERVICE_CONTROL_UNAVAILABLE' });
  assert.equal(f.stopped(), 0); assert.deepEqual(fs.readFileSync(f.file), original);
  assert.deepEqual(fs.readFileSync(join(retained, 'service.lock', 'owner.json')), original);

  // Returning the original directory to the same canonical path still permits
  // its unchanged v1 owner credentials to stop the real listener.
  fs.rmSync(f.dir, { recursive: true }); fs.renameSync(retained, f.dir); identity[field] = first;
  assert.deepEqual(readServiceControl(f.dir), f.c);
  assert.deepEqual(await sendServiceStop(readServiceControl(f.dir)), { accepted: true });
  assert.equal(f.stopped(), 1);
});

for (const field of ['key', 'instanceId', 'runtime']) test(`wrong ${field} cannot authenticate this instance`, async t => {
  const f = await fixture(t), changed = { ...f.c, [field]: field === 'instanceId' ? randomUUID() : random() };
  await assert.rejects(sendServiceStop(changed), { code: 'SERVICE_STOP_UNCONFIRMED', requestMayHaveBeenSent: false, retryable: false });
  assert.equal(f.stopped(), 0);
  assert.deepEqual(await sendServiceStop(f.c), { accepted: true });
});

test('discovery tampering cannot change the live key or redirect a stop across runtime identity', async t => {
  const a = await fixture(t), b = await fixture(t), original = fs.readFileSync(a.file);
  const other = JSON.parse(fs.readFileSync(b.file));
  fs.writeFileSync(a.file, JSON.stringify(other));
  assert.throws(() => readServiceControl(a.dir), { code: 'SERVICE_CONTROL_UNAVAILABLE' });
  fs.writeFileSync(a.file, original);
  const modified = JSON.parse(original); modified.serviceControl.key = random();
  fs.writeFileSync(a.file, JSON.stringify(modified));
  await assert.rejects(sendServiceStop(readServiceControl(a.dir)), { code: 'SERVICE_STOP_UNCONFIRMED' });
  assert.equal(a.stopped(), 0); assert.equal(b.stopped(), 0);
  // The captured original capability still addresses the live in-memory owner;
  // editing discovery cannot change that owner's authority or request a stop.
  assert.deepEqual(await sendServiceStop(a.c), { accepted: true });
});

test('stale credentials fail against a new instance even at its new port', async t => {
  const f = await fixture(t); await f.channel.close(); f.owner.release();
  const second = await listenServiceControl(f.dir);
  const owner = acquireRuntimeLock(f.dir, { name: 'service', serviceControl: second.descriptor });
  let stops = 0; second.activate(owner.instanceId, () => { stops++; }); t.after(() => second.close());
  const c = readServiceControl(f.dir);
  await assert.rejects(sendServiceStop({ ...f.c, port: c.port }), { code: 'SERVICE_STOP_UNCONFIRMED' });
  assert.equal(stops, 0); assert.notEqual(c.key, f.c.key); assert.notEqual(c.instanceId, f.c.instanceId);
  assert.deepEqual(await sendServiceStop(c), { accepted: true });
});

test('captured stop proof cannot be replayed on another connection; wrong roles also fail', async t => {
  const f = await fixture(t), first = await hello(f.c);
  const saved = proof(f.c, 'stop', first.nonce, first.challenge);
  first.socket.destroy(); await first.closed; assert.equal(f.stopped(), 0);
  const next = peer(f.c.port);
  next.send({ version: 1, instanceId: f.c.instanceId, runtime: f.c.runtime, nonce: first.nonce });
  const challenge = await next.next(); assert.notEqual(challenge.challenge, first.challenge);
  next.send({ proof: saved }); await next.closed; assert.equal(f.stopped(), 0);
  const roles = await hello(f.c);
  roles.send({ proof: proof(f.c, 'server', roles.nonce, roles.challenge) }); await roles.closed;
  assert.equal(f.stopped(), 0);
  const good = await hello(f.c);
  good.send({ proof: proof(f.c, 'stop', good.nonce, good.challenge) });
  assert.deepEqual(await good.next(), { accepted: true, proof: proof(f.c, 'accepted', good.nonce, good.challenge) });
  await good.closed; assert.equal(f.stopped(), 1);
});

test('invalid version, oversized/malformed frames and partial requests never stop service', async t => {
  const f = await fixture(t);
  for (const payload of ['{bad}\n', '{"version":2}\n', 'x'.repeat(1025), 'x'.repeat(5000), 'GET /shutdown HTTP/1.1\r\n']) {
    const p = peer(f.c.port); p.socket.write(payload); await p.closed;
    assert.equal(f.stopped(), 0);
  }
  const idle = peer(f.c.port); await once(idle.socket, 'connect');
  await f.channel.close(); await idle.closed; assert.equal(f.stopped(), 0);
});

async function proxy(t, target, failure = 'drop') {
  const sockets = new Set(); let connections = 0, authorizations = 0;
  const server = createServer(down => {
    connections++; sockets.add(down);
    const up = createConnection({ host: '127.0.0.1', port: target }); sockets.add(up);
    for (const s of [down, up]) { s.on('error', () => {}); s.on('close', () => { sockets.delete(s); }); }
    let requests = '', responses = '';
    down.on('data', data => {
      requests += data.toString(); let i;
      while ((i = requests.indexOf('\n')) >= 0) {
        const line = requests.slice(0, i); requests = requests.slice(i + 1);
        if (JSON.parse(line).proof) authorizations++;
        up.write(line + '\n');
      }
    });
    up.on('data', data => {
      responses += data.toString(); let i;
      while ((i = responses.indexOf('\n')) >= 0) {
        const line = responses.slice(0, i); responses = responses.slice(i + 1);
        if (JSON.parse(line).accepted) {
          if (failure === 'drop') { down.destroy(); up.destroy(); }
          else down.write(JSON.stringify({ accepted: true, proof: random() }) + '\n');
        } else down.write(line + '\n');
      }
    });
    up.on('end', () => down.end()); down.on('end', () => up.end());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { port: server.address().port, connections: () => connections, authorizations: () => authorizations };
}

for (const failure of ['drop', 'forged-ack']) test(`${failure} is unconfirmed after one authenticated send, never retried`, async t => {
  const f = await fixture(t), relay = await proxy(t, f.c.port, failure);
  await assert.rejects(sendServiceStop({ ...f.c, port: relay.port }), {
    code: 'SERVICE_STOP_UNCONFIRMED', retryable: false, requestMayHaveBeenSent: true,
  });
  assert.equal(f.stopped(), 1); assert.equal(relay.connections(), 1); assert.equal(relay.authorizations(), 1);
});

test('unverified peer cannot obtain a stop authorization or report a successful acknowledgment', async t => {
  const f = await fixture(t); let frames = 0;
  const server = createServer(socket => {
    socket.on('error', () => {});
    socket.on('data', () => { frames++; socket.end(JSON.stringify({ challenge: random(), proof: random() }) + '\n'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(sendServiceStop({ ...f.c, port: server.address().port }), { code: 'SERVICE_STOP_UNCONFIRMED', requestMayHaveBeenSent: false });
  assert.equal(frames, 1); assert.equal(f.stopped(), 0);
});

test('legacy/malformed discovery is read-only, has no marker fallback and no diagnostic secrets', async t => {
  const f = await fixture(t), original = JSON.parse(fs.readFileSync(f.file));
  for (const change of [owner => delete owner.serviceControl, owner => { owner.serviceControl.port = 0; },
    owner => { owner.serviceControl.host = 'example.com'; }, owner => { owner.serviceControl.runtime = random(); }]) {
    const owner = structuredClone(original); change(owner); fs.writeFileSync(f.file, JSON.stringify(owner));
    const before = fs.readFileSync(f.file);
    assert.throws(() => readServiceControl(f.dir), e => {
      assert.equal(e.code, 'SERVICE_CONTROL_UNAVAILABLE');
      assert.ok(!e.message.includes(f.c.key)); assert.ok(!e.message.includes(f.dir)); return true;
    });
    assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(fs.existsSync(join(f.dir, 'service.lock', 'stop-request')), false);
  }
  assert.equal(f.stopped(), 0); assert.equal(serviceRuntime(f.dir), f.c.runtime);
});
