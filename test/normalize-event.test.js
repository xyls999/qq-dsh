import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from '../src/normalize-event.js';

const key = Buffer.alloc(32, 7);
const base = {
  post_type: 'message',
  message_type: 'group',
  group_id: 1072362245,
  user_id: 321,
  self_id: 999,
  message_id: 42,
  time: 1_800_000_000,
  message: [{ type: 'text', data: { text: 'hello group' } }],
};

const normalize = (event) => normalizeEvent(event, {
  groupId: '1072362245',
  selfId: '999',
  pseudonymKey: key,
});

test('normalizes a target-group text message without preserving a QQ user ID', () => {
  const record = normalize(base);
  assert.equal(record.groupId, '1072362245');
  assert.equal(record.text, 'hello group');
  assert.equal(record.timestampMs, 1_800_000_000_000);
  assert.equal(record.messageRef, '42');
  assert.match(record.senderKey, /^member-[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(record).includes('321'), false);
});

test('rejects a message from another group', () => {
  assert.equal(normalize({ ...base, group_id: 123 }), null);
});

test('rejects private messages', () => {
  assert.equal(normalize({ ...base, message_type: 'private' }), null);
});

test('rejects non-message events', () => {
  assert.equal(normalize({ ...base, post_type: 'notice' }), null);
});

test('keeps messages authored by the connected account in the group archive', () => {
  assert.equal(normalize({ ...base, user_id: 999 }).text, 'hello group');
});

test('keeps text and excludes media segments', () => {
  const record = normalize({ ...base, message: [
    { type: 'text', data: { text: 'photo:' } },
    { type: 'image', data: { url: 'https://example.invalid/secret.jpg' } },
  ] });
  assert.equal(record.text, 'photo:');
  assert.equal(JSON.stringify(record).includes('example.invalid'), false);
});

test('replaces mentions without retaining their QQ IDs', () => {
  const record = normalize({ ...base, message: [
    { type: 'text', data: { text: 'hi ' } },
    { type: 'at', data: { qq: '456789' } },
  ] });
  assert.equal(record.text, 'hi [提及]');
  assert.equal(JSON.stringify(record).includes('456789'), false);
});

test('creates a deterministic fallback key when the source message ID is absent', () => {
  const event = { ...base, message_id: undefined };
  assert.equal(normalize(event).messageKey, normalize(event).messageKey);
  assert.match(normalize(event).messageKey, /^fallback-[a-f0-9]{64}$/);
});

test('ignores empty and malformed messages', () => {
  assert.equal(normalize({ ...base, message: [{ type: 'image', data: { file: 'x' } }] }), null);
  assert.equal(normalize({ ...base, message: 'not an array' }), null);
  assert.equal(normalize({ ...base, time: 'not a timestamp' }), null);
});
