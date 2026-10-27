import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';

const valid = {
  enabled: false,
  groupId: '1072362245',
  wsUrl: 'ws://127.0.0.1:3001',
  rawRetentionDays: 30,
  summaryRetentionDays: 90,
};

test('accepts the configured group and loopback endpoint while disabled by default', () => {
  assert.deepEqual(parseConfig({ ...valid, enabled: undefined }), {
    enabled: false,
    modelExportEnabled: false,
    groupId: '1072362245',
    wsUrl: 'ws://127.0.0.1:3001/',
    rawRetentionDays: 30,
    summaryRetentionDays: 90,
    reconnectMs: 1000,
    configPollMs: 1000,
    maintenancePollMs: 3_600_000,
  });
});

test('rejects a group other than the configured target', () => {
  assert.throws(() => parseConfig({ ...valid, groupId: '123456789' }), /target group/);
});

test('rejects an absent group ID', () => {
  assert.throws(() => parseConfig({ ...valid, groupId: undefined }), /target group/);
});

test('rejects remote WebSocket endpoints', () => {
  assert.throws(() => parseConfig({ ...valid, wsUrl: 'ws://example.com:3001' }), /loopback/);
});

test('rejects secure remote WebSocket endpoints', () => {
  assert.throws(() => parseConfig({ ...valid, wsUrl: 'wss://example.com:3001' }), /loopback/);
});

test('accepts numeric IPv6 loopback and rejects hostnames', () => {
  assert.equal(parseConfig({ ...valid, wsUrl: 'ws://[::1]:3001' }).wsUrl, 'ws://[::1]:3001/');
  assert.throws(() => parseConfig({ ...valid, wsUrl: 'ws://localhost:3001' }), /loopback/);
});

test('requires explicit enablement for collection', () => {
  assert.equal(parseConfig(valid).enabled, false);
  assert.equal(parseConfig({ ...valid, enabled: true }).enabled, true);
});

test('rejects non-positive retention periods', () => {
  assert.throws(() => parseConfig({ ...valid, rawRetentionDays: 0 }), /retention/);
});

test('rejects an unsafe reconnect interval', () => {
  assert.throws(() => parseConfig({ ...valid, reconnectMs: 1 }), /reconnect/);
});
