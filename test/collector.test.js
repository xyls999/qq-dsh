import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { createCollector } from '../src/collector.js';

const groupId = '1072362245';
const key = Buffer.alloc(32, 2);

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-collector-test-'));
  const store = createStore(join(dir, 'archive.sqlite'), groupId);
  let server;
  let port;
  let sockets = [];
  let upgradeHeaders = [];
  const statuses = [];
  const launchServer = async (requestedPort = 0) => {
    server = new WebSocketServer({ port: requestedPort, host: '127.0.0.1' });
    await new Promise((resolve) => server.once('listening', resolve));
    port = server.address().port;
    server.on('connection', (socket, request) => {
      sockets.push(socket);
      upgradeHeaders.push(request.headers.authorization);
    });
  };
  await launchServer();
  const collector = createCollector({
    config: { enabled: options.enabled ?? true, groupId, wsUrl: `ws://127.0.0.1:${port}/`, reconnectMs: options.reconnectMs ?? 100 },
    store,
    pseudonymKey: key,
    token: 'test-token',
    WebSocketImpl: WebSocket,
    onStatus: (status) => statuses.push(status),
  });
  t.after(async () => {
    await collector.stop();
    for (const socket of sockets) socket.terminate();
    if (server) await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { collector, store, launchServer, get server() { return server; }, get sockets() { return sockets; }, get headers() { return upgradeHeaders; }, get statuses() { return statuses; }, get port() { return port; } };
}

async function waitFor(predicate, message = 'condition not reached') {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

const event = (overrides = {}) => JSON.stringify({
  post_type: 'message',
  message_type: 'group',
  group_id: groupId,
  user_id: '321',
  self_id: '999',
  message_id: 'm-1',
  time: 1_800_000_000,
  message: [{ type: 'text', data: { text: 'local message' } }],
  ...overrides,
});

test('does not connect when disabled', async (t) => {
  const f = await fixture(t, { enabled: false });
  assert.deepEqual(await f.collector.start(), { started: false, reason: 'disabled' });
  assert.equal(f.collector.status().state, 'disabled');
  assert.equal(f.headers.length, 0);
});

test('authenticates locally and stores only target-group events', async (t) => {
  const f = await fixture(t);
  await f.collector.start();
  await waitFor(() => f.headers.length === 1, 'client did not connect');
  assert.equal(f.headers[0], 'Bearer test-token');
  f.sockets[0].send(event());
  f.sockets[0].send(event({ group_id: '55', message_id: 'other' }));
  f.sockets[0].send(event({ message_type: 'private', message_id: 'private' }));
  f.sockets[0].send(event({ user_id: '999', message_id: 'self', message: [{ type: 'text', data: { text: 'my group message' } }] }));
  f.sockets[0].send('{malformed');
  await waitFor(() => f.store.status().messageCount === 2);
  assert.deepEqual(f.store.search({}).map((record) => record.text), ['local message', 'my group message']);
  assert.equal(f.collector.status().lastError, 'malformed_event');
  const renderedStatus = JSON.stringify(f.statuses);
  assert.ok(f.statuses.some((status) => status.state === 'connected'));
  assert.equal(renderedStatus.includes('test-token'), false);
  assert.equal(renderedStatus.includes('local message'), false);
});

test('reports disconnect gaps and reconnects', async (t) => {
  const f = await fixture(t, { reconnectMs: 100 });
  await f.collector.start();
  await waitFor(() => f.headers.length === 1);
  const firstServer = f.server;
  f.sockets[0].terminate();
  await waitFor(() => f.collector.status().state === 'disconnected');
  await new Promise((resolve) => firstServer.close(resolve));
  await f.launchServer(f.port);
  await waitFor(() => f.headers.length >= 2, 'client did not reconnect');
  assert.equal(f.collector.status().state, 'connected');
  assert.equal(f.store.listGaps().length, 1);
  assert.ok(f.store.listGaps()[0].toMs >= f.store.listGaps()[0].fromMs);
});

test('closes an open disconnect gap when paused before reconnection', async (t) => {
  const f = await fixture(t, { reconnectMs: 500 });
  await f.collector.start();
  await waitFor(() => f.headers.length === 1);
  f.sockets[0].terminate();
  await waitFor(() => f.collector.status().state === 'disconnected');
  await f.collector.stop();
  assert.equal(f.store.listGaps().length, 1);
});

test('stops without reconnecting', async (t) => {
  const f = await fixture(t);
  await f.collector.start();
  await waitFor(() => f.headers.length === 1);
  await f.collector.stop();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(f.collector.status().state, 'stopped');
  assert.equal(f.headers.length, 1);
});
