import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCollector } from './collector.js';
import { parseConfig } from './config.js';
import { createStore } from './store.js';
import { summarize } from './summarize.js';

const TARGET_GROUP_ID = '1072362245';
const MAX_MODEL_OUTPUT_BYTES = 20_000;
const MAX_MODEL_RECORD_CHARS = 500;
const DEFAULTS = {
  enabled: false,
  modelExportEnabled: false,
  groupId: TARGET_GROUP_ID,
  wsUrl: 'ws://127.0.0.1:3001',
  rawRetentionDays: 30,
  summaryRetentionDays: 90,
  reconnectMs: 1000,
  configPollMs: 1000,
  maintenancePollMs: 3_600_000,
};

function pathsFor(options = {}) {
  const home = options.home ?? process.env.USERPROFILE ?? homedir();
  const pluginDir = options.pluginDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return {
    home,
    pluginDir,
    configPath: join(pluginDir, 'config.json'),
    dataDir: options.dataDir ?? join(home, '.dsh', 'data', 'qq-archive'),
  };
}

function ensurePrivateKey(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const keyPath = join(dataDir, 'sender.key');
  try {
    const key = readFileSync(keyPath);
    if (key.length !== 32) throw new Error('sender key file is invalid; erase it and run setup again');
    return key;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const key = randomBytes(32);
  try {
    writeFileSync(keyPath, key, { flag: 'wx', mode: 0o600 });
    return key;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readFileSync(keyPath);
    if (existing.length !== 32) throw new Error('sender key file is invalid; erase it and run setup again');
    return existing;
  }
}

function loadConfig(paths) {
  if (!existsSync(paths.configPath)) throw new Error('run setup before using the archive');
  let input;
  try {
    input = JSON.parse(readFileSync(paths.configPath, 'utf8'));
  } catch {
    throw new Error('local config is unreadable; collection remains stopped');
  }
  return parseConfig(input);
}

function saveConfig(paths, config) {
  mkdirSync(paths.pluginDir, { recursive: true });
  writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function syncSummaryFiles(store, dataDir) {
  const directory = join(dataDir, 'summaries');
  mkdirSync(directory, { recursive: true });
  const activeIds = new Set(store.listSummaries({ limit: 10000 }).map((summary) => String(summary.id)));
  for (const name of readdirSync(directory)) {
    const match = /^summary-(\d+)\.md$/.exec(name);
    if (match && !activeIds.has(match[1])) rmSync(join(directory, name), { force: true });
  }
}

function openStore(paths, config, nowMs = Date.now()) {
  mkdirSync(paths.dataDir, { recursive: true });
  const store = createStore(join(paths.dataDir, 'archive.sqlite'), config.groupId);
  store.purgeExpired({ nowMs, rawRetentionDays: config.rawRetentionDays,
    summaryRetentionDays: config.summaryRetentionDays });
  syncSummaryFiles(store, paths.dataDir);
  return store;
}

function parseDate(date, endOfDay = false) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must use YYYY-MM-DD');
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0,
    endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day) throw new Error('invalid date');
  return value.getTime();
}

function requireDateRange(fromDate, toDate) {
  const fromMs = parseDate(fromDate);
  const toMs = parseDate(toDate, true);
  if (fromMs > toMs) throw new Error('invalid date range');
  return { fromMs, toMs };
}

function dateOrdinal(date) {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function reportStatus(paths, config, nowMs = Date.now()) {
  const store = openStore(paths, config, nowMs);
  try {
    return { enabled: config.enabled, modelExportEnabled: config.modelExportEnabled, groupId: config.groupId, ...store.status(),
      gaps: store.listGaps(), collector: readCollectorStatus(paths, config, nowMs) };
  } finally {
    store.close();
  }
}

function readCollectorStatus(paths, config, nowMs) {
  const path = join(paths.dataDir, 'collector-status.json');
  if (!existsSync(path)) return { state: 'not_started', observedAtMs: null };
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(saved.observedAtMs) || nowMs - saved.observedAtMs > config.configPollMs * 3) {
      return { ...saved, state: 'stale', lastKnownState: saved.state };
    }
    return saved;
  } catch {
    return { state: 'unknown', observedAtMs: null };
  }
}

/**
 * Reads local collector and archive status without returning message text.
 * @param {{home?: string, pluginDir?: string, dataDir?: string, nowMs?: number}} options User-local paths and status time.
 * @returns {object} Sanitized local archive status.
 */
export function readArchiveStatus(options = {}) {
  const paths = pathsFor(options);
  const config = loadConfig(paths);
  return reportStatus(paths, config, options.nowMs ?? Date.now());
}

/**
 * Returns one bounded page of records from the only configured QQ group.
 * @param {{fromDate: string, toDate: string, query?: string, limit?: number, offset?: number}} input Model-requested local date range and page.
 * @param {{home?: string, pluginDir?: string, dataDir?: string, nowMs?: number}} options User-local paths and query time.
 * @returns {object} Bounded records with explicit pagination and truncation metadata.
 */
export function readArchivePage(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('archive read arguments must be an object');
  const allowed = new Set(['fromDate', 'toDate', 'query', 'limit', 'offset']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`unexpected archive read argument: ${key}`);
  if (typeof input.fromDate !== 'string') throw new Error('fromDate is required');
  if (typeof input.toDate !== 'string') throw new Error('toDate is required');
  const fromDate = input.fromDate;
  const toDate = input.toDate;
  const range = requireDateRange(fromDate, toDate);
  if (dateOrdinal(toDate) - dateOrdinal(fromDate) + 1 > 31) throw new Error('date range must be 31 days or less');
  const query = input.query ?? '';
  if (typeof query !== 'string' || query.length > 128) throw new Error('query must be at most 128 characters');
  const limit = input.limit ?? 20;
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be between 1 and 50');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new Error('offset must be between 0 and 10000');

  const paths = pathsFor(options);
  const config = loadConfig(paths);
  if (!config.modelExportEnabled) throw new Error('model export is disabled; confirm the group notice before enabling it');
  const store = openStore(paths, config, options.nowMs ?? Date.now());
  try {
    const candidates = store.search({ ...range, query, limit: limit + 1, offset });
    const messages = [];
    let truncated = false;
    for (const record of candidates.slice(0, limit)) {
      const fullText = Array.from(record.text);
      const text = fullText.slice(0, MAX_MODEL_RECORD_CHARS).join('');
      if (fullText.length > MAX_MODEL_RECORD_CHARS) truncated = true;
      const message = {
        at: new Date(record.timestampMs).toLocaleString('sv-SE'),
        speaker: record.senderKey,
        ref: record.messageRef ?? '',
        text,
      };
      const candidate = {
        groupId: config.groupId,
        fromDate,
        toDate,
        messages: [...messages, message],
        hasMore: candidates.length > messages.length + 1,
        truncated,
        nextOffset: offset + messages.length + 1,
      };
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_MODEL_OUTPUT_BYTES) {
        truncated = true;
        break;
      }
      messages.push(message);
    }
    const hasMore = candidates.length > messages.length;
    return { groupId: config.groupId, fromDate, toDate, messages, hasMore, truncated, nextOffset: offset + messages.length };
  } finally {
    store.close();
  }
}

/**
 * Runs a local archive command without exposing message contents to stdout implicitly.
 * @param {string[]} argv Command and positional arguments.
 * @param {{home?: string, pluginDir?: string, dataDir?: string, env?: NodeJS.ProcessEnv, now?: () => number, log?: (value: object) => void}} options Local paths and injectable runtime functions.
 * @returns {Promise<object>} Command result.
 */
export async function runCommand(argv, options = {}) {
  const paths = pathsFor(options);
  const command = argv[0];
  if (command === 'setup') {
    mkdirSync(paths.pluginDir, { recursive: true });
    if (!existsSync(paths.configPath)) saveConfig(paths, DEFAULTS);
    const config = loadConfig(paths);
    ensurePrivateKey(paths.dataDir);
    const nowMs = options.now?.() ?? Date.now();
    const store = openStore(paths, config, nowMs);
    try { return { configured: true, ...reportStatus(paths, config, nowMs) }; } finally { store.close(); }
  }
  const config = loadConfig(paths);
  if (command === 'status') return reportStatus(paths, config, options.now?.() ?? Date.now());
  if (command === 'pause' || command === 'resume') {
    const next = { ...config, enabled: command === 'resume' };
    saveConfig(paths, next);
    return { enabled: next.enabled };
  }
  if (command === 'enable-model-export') {
    if (argv[1] !== '--confirm-group-notice' || argv[2] !== TARGET_GROUP_ID) {
      throw new Error(`confirm the group notice with enable-model-export --confirm-group-notice ${TARGET_GROUP_ID}`);
    }
    saveConfig(paths, { ...config, modelExportEnabled: true });
    return { modelExportEnabled: true };
  }
  if (command === 'disable-model-export') {
    saveConfig(paths, { ...config, modelExportEnabled: false });
    return { modelExportEnabled: false };
  }

  const store = openStore(paths, config, options.now?.() ?? Date.now());
  try {
    if (command === 'search') {
      const query = argv[1] ?? '';
      const range = argv.length >= 4 ? requireDateRange(argv[2], argv[3]) : {};
      return { records: store.search({ ...range, query, limit: 1000 }) };
    }
    if (command === 'summarize') {
      const range = requireDateRange(argv[1], argv[2]);
      const result = summarize(store.search(range), range);
      const summaryId = store.saveSummary(result);
      const summaryDir = join(paths.dataDir, 'summaries');
      mkdirSync(summaryDir, { recursive: true });
      const filePath = join(summaryDir, `summary-${summaryId}.md`);
      writeFileSync(filePath, `${result.text}\n`, { mode: 0o600 });
      return { saved: true, filePath, summaryCount: store.status().summaryCount };
    }
    if (command === 'purge') {
      return store.purgeExpired({ nowMs: options.now?.() ?? Date.now(),
        rawRetentionDays: config.rawRetentionDays, summaryRetentionDays: config.summaryRetentionDays });
    }
    if (command === 'delete-range') {
      const result = store.deleteRange(requireDateRange(argv[1], argv[2]));
      syncSummaryFiles(store, paths.dataDir);
      return result;
    }
    if (command === 'erase') {
      if (argv[1] !== '--confirm-group' || argv[2] !== TARGET_GROUP_ID) {
        throw new Error(`use erase --confirm-group ${TARGET_GROUP_ID} to erase this archive`);
      }
      const result = store.eraseGroup();
      syncSummaryFiles(store, paths.dataDir);
      return result;
    }
  } finally {
    store.close();
  }

  if (command === 'start') {
    if (argv.includes('--enable')) {
      const token = options.env?.SNOWLUMA_ACCESS_TOKEN ?? process.env.SNOWLUMA_ACCESS_TOKEN;
      if (!token) throw new Error('set SNOWLUMA_ACCESS_TOKEN in the local environment before enabling collection');
      saveConfig(paths, { ...config, enabled: true });
    }
    const next = loadConfig(paths);
    if (!next.enabled) return { started: false, reason: 'disabled; run start --enable after configuring the local token' };
    return runService(paths, next, options);
  }

  throw new Error('command must be setup, status, start, pause, resume, search, summarize, purge, delete-range or erase');
}

async function runService(paths, initialConfig, options) {
  const token = options.env?.SNOWLUMA_ACCESS_TOKEN ?? process.env.SNOWLUMA_ACCESS_TOKEN;
  const pseudonymKey = ensurePrivateKey(paths.dataDir);
  const store = openStore(paths, initialConfig, options.now?.() ?? Date.now());
  const log = options.log ?? ((value) => console.log(JSON.stringify(value)));
  const publishStatus = (status) => {
    const safeStatus = { ...status, observedAtMs: options.now?.() ?? Date.now() };
    try {
      writeFileSync(join(paths.dataDir, 'collector-status.json'), `${JSON.stringify(safeStatus)}\n`, { mode: 0o600 });
    } catch {
      log({ state: 'status_write_error' });
    }
    log({ state: status.state, error: status.lastError });
  };
  let collector = createCollector({ config: initialConfig, store, pseudonymKey, token, onStatus: publishStatus });
  await collector.start();
  store.purgeExpired({ nowMs: options.now?.() ?? Date.now(),
    rawRetentionDays: initialConfig.rawRetentionDays, summaryRetentionDays: initialConfig.summaryRetentionDays });
  let active = true;
  let config = initialConfig;
  let lastMaintenanceMs = options.now?.() ?? Date.now();
  const timer = setInterval(async () => {
    try {
      const current = loadConfig(paths);
      if (current.enabled !== active) {
        if (current.enabled) {
          collector = createCollector({ config: current, store, pseudonymKey, token, onStatus: publishStatus });
          await collector.start();
        } else {
          await collector.stop();
        }
        active = current.enabled;
        config = current;
        log({ state: active ? 'connected_or_connecting' : 'paused' });
      }
      publishStatus(collector.status());
      const nowMs = options.now?.() ?? Date.now();
      if (nowMs - lastMaintenanceMs >= config.maintenancePollMs) {
        store.purgeExpired({ nowMs, rawRetentionDays: config.rawRetentionDays,
          summaryRetentionDays: config.summaryRetentionDays });
        syncSummaryFiles(store, paths.dataDir);
        lastMaintenanceMs = nowMs;
      }
    } catch {
      await collector.stop();
      active = false;
      log({ state: 'paused', error: 'local_config_or_storage_error' });
    }
  }, config.configPollMs);
  timer.unref?.();

  await new Promise((resolvePromise) => {
    const stop = () => resolvePromise();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  clearInterval(timer);
  await collector.stop();
  store.close();
  return { stopped: true };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runCommand(process.argv.slice(2)).then((result) => {
    if (result && Object.keys(result).length) console.log(JSON.stringify(result));
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
