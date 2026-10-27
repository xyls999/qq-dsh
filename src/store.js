import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Opens a single-group SQLite archive with deduplication, retention and deletion operations.
 * @param {string} databasePath The local database file path.
 * @param {string} groupId The only group permitted in this archive.
 * @returns {{insertMessage(record: object): boolean, search(options?: object): object[], status(): object, saveSummary(summary: object): number, listSummaries(options?: object): object[], purgeExpired(options: object): object, deleteRange(options: object): object, eraseGroup(): object, close(): void}} Archive operations.
 */
export function createStore(databasePath, groupId) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const isNewDatabase = !existsSync(databasePath);
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
  if (isNewDatabase) db.exec('PRAGMA journal_mode = DELETE;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      group_id TEXT NOT NULL,
      message_key TEXT NOT NULL,
      message_ref TEXT,
      timestamp_ms INTEGER NOT NULL,
      sender_key TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (group_id, message_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS messages_time ON messages(group_id, timestamp_ms);
    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY,
      group_id TEXT NOT NULL,
      generated_at_ms INTEGER NOT NULL,
      range_start_ms INTEGER NOT NULL,
      range_end_ms INTEGER NOT NULL,
      text TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS summaries_time ON summaries(group_id, generated_at_ms);
    CREATE TABLE IF NOT EXISTS connection_gaps (
      id INTEGER PRIMARY KEY,
      group_id TEXT NOT NULL,
      from_ms INTEGER NOT NULL,
      to_ms INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS gaps_time ON connection_gaps(group_id, from_ms);
  `);

  const insertMessageStatement = db.prepare(`
    INSERT INTO messages(group_id, message_key, message_ref, timestamp_ms, sender_key, text)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_id, message_key) DO NOTHING
  `);
  const insertSummaryStatement = db.prepare(`
    INSERT INTO summaries(group_id, generated_at_ms, range_start_ms, range_end_ms, text)
    VALUES (?, ?, ?, ?, ?)
  `);

  const transaction = (work) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  return {
    insertMessage(record) {
      if (record.groupId !== groupId) throw new Error('record does not match target group');
      if (!record.messageKey || !Number.isSafeInteger(record.timestampMs) || !record.senderKey
        || typeof record.text !== 'string' || !record.text) throw new Error('invalid archive record');
      const result = insertMessageStatement.run(groupId, record.messageKey, record.messageRef,
        record.timestampMs, record.senderKey, record.text);
      return result.changes === 1;
    },

    search(options = {}) {
      const clauses = ['group_id = ?'];
      const values = [groupId];
      if (options.fromMs !== undefined) { clauses.push('timestamp_ms >= ?'); values.push(options.fromMs); }
      if (options.toMs !== undefined) { clauses.push('timestamp_ms <= ?'); values.push(options.toMs); }
      if (options.query !== undefined && options.query !== '') { clauses.push('instr(text, ?) > 0'); values.push(String(options.query)); }
      const limit = options.limit ?? 1000;
      const offset = options.offset ?? 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('limit must be between 1 and 10000');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new Error('offset must be between 0 and 1000000');
      return db.prepare(`SELECT group_id AS groupId, message_key AS messageKey, message_ref AS messageRef,
        timestamp_ms AS timestampMs, sender_key AS senderKey, text FROM messages
        WHERE ${clauses.join(' AND ')} ORDER BY timestamp_ms, message_key LIMIT ? OFFSET ?`)
        .all(...values, limit, offset).map((row) => ({ ...row }));
    },

    status() {
      const messages = db.prepare(`SELECT count(*) AS messageCount, min(timestamp_ms) AS firstMessageMs,
        max(timestamp_ms) AS lastMessageMs FROM messages WHERE group_id = ?`).get(groupId);
      const summaries = db.prepare('SELECT count(*) AS summaryCount FROM summaries WHERE group_id = ?').get(groupId);
      return { ...messages, ...summaries };
    },

    saveSummary(summary) {
      if (!Number.isSafeInteger(summary.generatedAtMs) || !Number.isSafeInteger(summary.rangeStartMs)
        || !Number.isSafeInteger(summary.rangeEndMs) || summary.rangeStartMs > summary.rangeEndMs
        || typeof summary.text !== 'string' || !summary.text) throw new Error('invalid archive summary');
      const result = insertSummaryStatement.run(groupId, summary.generatedAtMs,
        summary.rangeStartMs, summary.rangeEndMs, summary.text);
      return Number(result.lastInsertRowid);
    },

    listSummaries(options = {}) {
      const limit = options.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('limit must be between 1 and 10000');
      return db.prepare(`SELECT id, generated_at_ms AS generatedAtMs, range_start_ms AS rangeStartMs,
        range_end_ms AS rangeEndMs, text FROM summaries WHERE group_id = ?
        ORDER BY generated_at_ms DESC, id DESC LIMIT ?`).all(groupId, limit).map((row) => ({ ...row }));
    },

    purgeExpired(options) {
      const { nowMs, rawRetentionDays, summaryRetentionDays } = options;
      if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(rawRetentionDays) || rawRetentionDays < 1
        || !Number.isSafeInteger(summaryRetentionDays) || summaryRetentionDays < 1) throw new Error('invalid retention settings');
      return transaction(() => {
        const messages = db.prepare('DELETE FROM messages WHERE group_id = ? AND timestamp_ms < ?')
          .run(groupId, nowMs - rawRetentionDays * 86_400_000).changes;
        const summaries = db.prepare('DELETE FROM summaries WHERE group_id = ? AND generated_at_ms < ?')
          .run(groupId, nowMs - summaryRetentionDays * 86_400_000).changes;
        const gaps = db.prepare('DELETE FROM connection_gaps WHERE group_id = ? AND to_ms < ?')
          .run(groupId, nowMs - rawRetentionDays * 86_400_000).changes;
        return { messages, summaries, gaps };
      });
    },

    deleteRange(options) {
      if (!Number.isSafeInteger(options.fromMs) || !Number.isSafeInteger(options.toMs) || options.fromMs > options.toMs) {
        throw new Error('invalid deletion date range');
      }
      return transaction(() => {
        const messages = db.prepare('DELETE FROM messages WHERE group_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ?')
          .run(groupId, options.fromMs, options.toMs).changes;
        const summaries = db.prepare(`DELETE FROM summaries WHERE group_id = ?
          AND range_start_ms <= ? AND range_end_ms >= ?`)
          .run(groupId, options.toMs, options.fromMs).changes;
        const gaps = db.prepare('DELETE FROM connection_gaps WHERE group_id = ? AND from_ms <= ? AND to_ms >= ?')
          .run(groupId, options.toMs, options.fromMs).changes;
        return { messages, summaries, gaps };
      });
    },

    recordGap(gap) {
      if (!Number.isSafeInteger(gap.fromMs) || !Number.isSafeInteger(gap.toMs) || gap.fromMs > gap.toMs) {
        throw new Error('invalid connection gap');
      }
      db.prepare('INSERT INTO connection_gaps(group_id, from_ms, to_ms) VALUES (?, ?, ?)')
        .run(groupId, gap.fromMs, gap.toMs);
    },

    listGaps(options = {}) {
      const limit = options.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be between 1 and 1000');
      return db.prepare(`SELECT id, from_ms AS fromMs, to_ms AS toMs FROM connection_gaps
        WHERE group_id = ? ORDER BY from_ms DESC, id DESC LIMIT ?`).all(groupId, limit).map((row) => ({ ...row }));
    },

    eraseGroup() {
      return transaction(() => {
        const messages = db.prepare('DELETE FROM messages WHERE group_id = ?').run(groupId).changes;
        const summaries = db.prepare('DELETE FROM summaries WHERE group_id = ?').run(groupId).changes;
        const gaps = db.prepare('DELETE FROM connection_gaps WHERE group_id = ?').run(groupId).changes;
        return { messages, summaries, gaps };
      });
    },

    close() {
      db.close();
    },
  };
}
