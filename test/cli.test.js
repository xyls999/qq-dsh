import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { runCommand } from '../src/cli.js';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'qq-cli-test-'));
  const pluginDir = join(home, '.dsh', 'plugins', 'dsh-qq-archive');
  const paths = { home, pluginDir, dataDir: join(home, '.dsh', 'data', 'qq-archive') };
  const options = { ...paths, env: {}, now: () => Date.UTC(2026, 0, 20) };
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { ...options, paths, options };
}

async function setup(f) {
  return runCommand(['setup'], f.options);
}

test('setup creates a disabled single-group config, local key and empty store', async (t) => {
  const f = fixture(t);
  const result = await setup(f);
  const config = JSON.parse(readFileSync(join(f.pluginDir, 'config.json'), 'utf8'));
  assert.equal(result.enabled, false);
  assert.equal(config.groupId, '1072362245');
  assert.equal(config.enabled, false);
  assert.equal(readFileSync(join(f.dataDir, 'sender.key')).length, 32);
  assert.equal(result.messageCount, 0);
  assert.equal(result.collector.state, 'not_started');
});

test('model export requires exact group-notice confirmation and can be disabled again', async (t) => {
  const options = fixture(t);
  await runCommand(['setup'], options);
  await assert.rejects(runCommand(['enable-model-export'], options), /confirm the group notice/);
  assert.deepEqual(await runCommand(['enable-model-export', '--confirm-group-notice', '1072362245'], options), {
    modelExportEnabled: true,
  });
  assert.equal((await runCommand(['status'], options)).modelExportEnabled, true);
  assert.deepEqual(await runCommand(['disable-model-export'], options), { modelExportEnabled: false });
  assert.equal((await runCommand(['status'], options)).modelExportEnabled, false);
});

test('pause and resume explicitly change only the local enabled flag', async (t) => {
  const f = fixture(t);
  await setup(f);
  assert.deepEqual(await runCommand(['resume'], f.options), { enabled: true });
  assert.equal(JSON.parse(readFileSync(join(f.pluginDir, 'config.json'), 'utf8')).enabled, true);
  assert.deepEqual(await runCommand(['pause'], f.options), { enabled: false });
  assert.equal(JSON.parse(readFileSync(join(f.pluginDir, 'config.json'), 'utf8')).enabled, false);
});

test('search and summary use local records and persist a markdown report', async (t) => {
  const f = fixture(t);
  await setup(f);
  const store = createStore(join(f.dataDir, 'archive.sqlite'), '1072362245');
  store.insertMessage({ groupId: '1072362245', messageKey: 'm1', messageRef: 'm1', timestampMs: Date.UTC(2026, 0, 3), senderKey: 'member-0123456789abcdef', text: '确认项目计划，阿余负责测试。' });
  store.close();
  const found = await runCommand(['search', '项目计划', '2026-01-03', '2026-01-03'], f.options);
  assert.equal(found.records.length, 1);
  const summary = await runCommand(['summarize', '2026-01-03', '2026-01-03'], f.options);
  assert.match(readFileSync(summary.filePath, 'utf8'), /确认项目计划/);
  assert.equal(summary.saved, true);
  await runCommand(['delete-range', '2026-01-03', '2026-01-03'], f.options);
  assert.equal(existsSync(summary.filePath), false);
});

test('refuses to erase without the exact target-group confirmation', async (t) => {
  const f = fixture(t);
  await setup(f);
  await assert.rejects(runCommand(['erase'], f.options), /confirm-group/);
  assert.deepEqual(await runCommand(['erase', '--confirm-group', '1072362245'], f.options), {
    messages: 0,
    summaries: 0,
    gaps: 0,
  });
});

test('rejects invalid and reversed date ranges', async (t) => {
  const f = fixture(t);
  await setup(f);
  await assert.rejects(runCommand(['search', 'x', '2026-02-30', '2026-03-01'], f.options), /date/);
  await assert.rejects(runCommand(['delete-range', '2026-01-04', '2026-01-01'], f.options), /date range/);
});
