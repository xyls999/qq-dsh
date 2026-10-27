import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/cli.js';
import { createStore } from '../src/store.js';
import { apply, createArchiveTools } from '../src/dsh-plugin.js';

const groupId = '1072362245';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'qq-dsh-tool-test-'));
  const pluginDir = join(home, '.dsh', 'plugins', 'dsh-qq-archive');
  const dataDir = join(home, '.dsh', 'data', 'qq-archive');
  const now = new Date();
  const testDate = now.toLocaleDateString('sv-SE');
  const options = { home, pluginDir, dataDir };
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { ...options, options, testDate, nowMs: now.getTime() };
}

async function seed(f) {
  await runCommand(['setup'], f.options);
  const store = createStore(join(f.dataDir, 'archive.sqlite'), groupId);
  store.insertMessage({ groupId, messageKey: 'm1', messageRef: 'm1', timestampMs: f.nowMs - 60_000, senderKey: 'member-1111111111111111', text: '确认周五完成项目计划。' });
  store.insertMessage({ groupId, messageKey: 'm2', messageRef: 'm2', timestampMs: f.nowMs - 30_000, senderKey: 'member-2222222222222222', text: '同日另一条群消息。' });
  store.close();
}

test('registers only read-only status and message-query tools', () => {
  const names = createArchiveTools().map((tool) => tool.name);
  assert.deepEqual(names, ['qq_archive_status', 'qq_archive_read']);
  assert.equal(names.some((name) => /send|reply|delete|erase/i.test(name)), false);
});

test('status tool reports local collector state without returning message text', async (t) => {
  const f = fixture(t);
  await seed(f);
  const [status] = createArchiveTools(f.options);
  const result = await status.execute({}, { signal: new AbortController().signal });
  assert.equal(result.groupId, groupId);
  assert.equal(result.enabled, false);
  assert.equal(result.modelExportEnabled, false);
  assert.equal(result.messageCount, 2);
  assert.equal(JSON.stringify(result).includes('确认周五'), false);
});

test('message tool returns only the selected group page for DSH model summaries', async (t) => {
  const f = fixture(t);
  await seed(f);
  const [, read] = createArchiveTools(f.options);
  const args = { fromDate: f.testDate, toDate: f.testDate, limit: 1, offset: 0 };
  await assert.rejects(read.execute(args, { signal: new AbortController().signal }), /model export is disabled/);
  await runCommand(['enable-model-export', '--confirm-group-notice', groupId], f.options);
  const result = await read.execute(args, {
    signal: new AbortController().signal,
  });
  assert.deepEqual(result.messages.map((message) => message.ref), ['m1']);
  assert.equal(result.groupId, groupId);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextOffset, 1);
  assert.match(result.messages[0].text, /确认周五/);
  const nextPage = await read.execute({ fromDate: f.testDate, toDate: f.testDate, limit: 1, offset: result.nextOffset }, {
    signal: new AbortController().signal,
  });
  assert.deepEqual(nextPage.messages.map((message) => message.ref), ['m2']);
  assert.equal(nextPage.hasMore, false);
  assert.equal(JSON.stringify(result).includes('另一日'), false);
  const rendered = read.output.render({}, result);
  assert.equal(rendered[0].type, 'text');
  assert.ok(Buffer.byteLength(rendered[0].text, 'utf8') <= 20_000);
  assert.match(rendered[0].text, /确认周五/);
});

test('message tool validates date scope, page size and offset', async (t) => {
  const f = fixture(t);
  await seed(f);
  const [, read] = createArchiveTools(f.options);
  const context = { signal: new AbortController().signal };
  await assert.rejects(read.execute({ fromDate: '2026-01-01', toDate: '2026-02-01' }, context), /31 days/);
  await assert.rejects(read.execute({ fromDate: f.testDate }, context), /toDate/);
  await assert.rejects(read.execute({ fromDate: f.testDate, toDate: f.testDate, groupId }, context), /unexpected/);
  await assert.rejects(read.execute({ fromDate: '2026-01-04', toDate: '2026-01-03' }, context), /date range/);
  await assert.rejects(read.execute({ fromDate: f.testDate, toDate: f.testDate, limit: 51 }, context), /limit/);
  await assert.rejects(read.execute({ fromDate: f.testDate, toDate: f.testDate, offset: -1 }, context), /offset/);
});

test('plugin owns and disposes both DSH tool registrations', () => {
  const registered = [];
  let effectDisposer;
  const context = {
    tools: { register(tool) { registered.push(tool); return () => registered.splice(registered.indexOf(tool), 1); } },
    effect(start) { effectDisposer = start(); return effectDisposer; },
  };
  apply(context);
  assert.deepEqual(registered.map((tool) => tool.name), ['qq_archive_status', 'qq_archive_read']);
  effectDisposer();
  assert.deepEqual(registered, []);
});
