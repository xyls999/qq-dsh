import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';

const groupId = '1072362245';
const at = (day) => Date.UTC(2026, 0, day);
const message = (key, day, text = `message ${key}`) => ({
  groupId,
  messageKey: key,
  messageRef: key,
  timestampMs: at(day),
  senderKey: 'member-0123456789abcdef',
  text,
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-archive-test-'));
  const store = createStore(join(dir, 'archive.sqlite'), groupId);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

test('inserts a target-group record and ignores duplicate source message keys', (t) => {
  const store = fixture(t);
  assert.equal(store.insertMessage(message('m1', 1)), true);
  assert.equal(store.insertMessage(message('m1', 1, 'duplicate')), false);
  assert.deepEqual(store.search({}), [message('m1', 1)]);
});

test('refuses records from any group other than the configured target', (t) => {
  const store = fixture(t);
  assert.throws(() => store.insertMessage({ ...message('m1', 1), groupId: '55' }), /target group/);
  assert.deepEqual(store.search({}), []);
});

test('searches within a date range and matches literal text', (t) => {
  const store = fixture(t);
  store.insertMessage(message('m1', 1, 'discuss [topic]'));
  store.insertMessage(message('m2', 2, 'another topic'));
  store.insertMessage(message('m3', 3, 'topic outside'));
  assert.deepEqual(store.search({ fromMs: at(1), toMs: at(2), query: '[topic]' }).map((item) => item.messageKey), ['m1']);
});

test('paginates text searches in chronological order', (t) => {
  const store = fixture(t);
  store.insertMessage(message('m1', 1));
  store.insertMessage(message('m2', 2));
  store.insertMessage(message('m3', 3));
  assert.deepEqual(store.search({ limit: 2, offset: 1 }).map((item) => item.messageKey), ['m2', 'm3']);
});

test('reports message and summary counters', (t) => {
  const store = fixture(t);
  store.insertMessage(message('m1', 2));
  store.saveSummary({ generatedAtMs: at(2), rangeStartMs: at(1), rangeEndMs: at(2), text: 'daily summary' });
  assert.deepEqual(store.status(), { messageCount: 1, summaryCount: 1, firstMessageMs: at(2), lastMessageMs: at(2) });
});

test('purges expired messages and summaries using separate retention periods', (t) => {
  const store = fixture(t);
  const now = at(10);
  store.insertMessage(message('old', 1));
  store.insertMessage(message('recent', 9));
  store.saveSummary({ generatedAtMs: at(1), rangeStartMs: at(1), rangeEndMs: at(1), text: 'old' });
  store.saveSummary({ generatedAtMs: at(9), rangeStartMs: at(8), rangeEndMs: at(9), text: 'recent' });
  assert.deepEqual(store.purgeExpired({ nowMs: now, rawRetentionDays: 2, summaryRetentionDays: 2 }), { messages: 1, summaries: 1, gaps: 0 });
  assert.deepEqual(store.search({}).map((item) => item.messageKey), ['recent']);
  assert.deepEqual(store.listSummaries().map((item) => item.text), ['recent']);
});

test('records connection gaps and removes them with matching date-range deletion or full erase', (t) => {
  const store = fixture(t);
  store.recordGap({ fromMs: at(1), toMs: at(2) });
  assert.equal(store.listGaps().length, 1);
  assert.deepEqual(store.deleteRange({ fromMs: at(1), toMs: at(2) }), { messages: 0, summaries: 0, gaps: 1 });
  store.recordGap({ fromMs: at(2), toMs: at(3) });
  assert.deepEqual(store.eraseGroup(), { messages: 0, summaries: 0, gaps: 1 });
  assert.deepEqual(store.listGaps(), []);
});

test('deletes selected dates and erases all remaining group data', (t) => {
  const store = fixture(t);
  store.insertMessage(message('m1', 1));
  store.insertMessage(message('m2', 2));
  store.saveSummary({ generatedAtMs: at(1), rangeStartMs: at(1), rangeEndMs: at(1), text: 'one' });
  store.saveSummary({ generatedAtMs: at(2), rangeStartMs: at(2), rangeEndMs: at(2), text: 'two' });
  assert.deepEqual(store.deleteRange({ fromMs: at(1), toMs: at(1) }), { messages: 1, summaries: 1, gaps: 0 });
  assert.deepEqual(store.eraseGroup(), { messages: 1, summaries: 1, gaps: 0 });
  assert.deepEqual(store.status(), { messageCount: 0, summaryCount: 0, firstMessageMs: null, lastMessageMs: null });
});
