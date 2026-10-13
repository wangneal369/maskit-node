/**
 * 本地 SQLite 持久化（node:sqlite，无原生依赖）：占位符映射 + 网关事件。
 * 隐私硬约束：凭证类标签的映射永远不写盘（此处再兜一层，防调用方漏过滤）。
 * 本类不吞错：失败由调用方记录并降级为纯内存。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { isCredentialLabel } from '../core/credential-labels';
import type { GatewayEvent } from '../gateway/proxy';

export interface MappingRow {
  token: string;
  orig: string;
  label: string;
  lastUsed: number;
  pinned: boolean;
}

const SCHEMA_VERSION = 1;

export class MaskitDb {
  private readonly db: DatabaseSync;
  private readonly stUpsert: StatementSync;
  private readonly stDelete: StatementSync;
  private readonly stLoad: StatementSync;
  private readonly stInsertEv: StatementSync;
  private readonly stListEv: StatementSync;
  private readonly stListEvBefore: StatementSync;
  private readonly stListEvCursor: StatementSync;
  private readonly stTrim: StatementSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrate();
    this.stUpsert = this.db.prepare(
      `INSERT INTO mappings (token, orig, label, last_used, pinned) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET orig = excluded.orig, label = excluded.label,
         last_used = excluded.last_used, pinned = excluded.pinned`,
    );
    this.stDelete = this.db.prepare('DELETE FROM mappings WHERE token = ?');
    this.stLoad = this.db.prepare(
      'SELECT token, orig, label, last_used, pinned FROM mappings WHERE last_used >= ? OR pinned = 1 ORDER BY last_used DESC LIMIT ?',
    );
    this.stInsertEv = this.db.prepare('INSERT OR REPLACE INTO events (id, time, json) VALUES (?, ?, ?)');
    // 排序键 (time, rowid) 唯一，分页用 keyset 游标；只给 time 时退化为严格小于
    this.stListEv = this.db.prepare('SELECT rowid AS seq, json FROM events ORDER BY time DESC, rowid DESC LIMIT ?');
    this.stListEvBefore = this.db.prepare(
      'SELECT rowid AS seq, json FROM events WHERE time < ? ORDER BY time DESC, rowid DESC LIMIT ?',
    );
    this.stListEvCursor = this.db.prepare(
      'SELECT rowid AS seq, json FROM events WHERE time < ? OR (time = ? AND rowid < ?) ORDER BY time DESC, rowid DESC LIMIT ?',
    );
    this.stTrim = this.db.prepare(
      'DELETE FROM events WHERE rowid NOT IN (SELECT rowid FROM events ORDER BY time DESC, rowid DESC LIMIT ?)',
    );
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (row.user_version > SCHEMA_VERSION) {
      throw new Error(`数据库版本 ${row.user_version} 高于当前程序支持的 ${SCHEMA_VERSION}`);
    }
    if (row.user_version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS mappings (
          token TEXT PRIMARY KEY, orig TEXT NOT NULL, label TEXT NOT NULL,
          last_used INTEGER NOT NULL, pinned INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mappings_last_used ON mappings(last_used);
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY, time INTEGER NOT NULL, json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_time ON events(time);
      `);
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  private tx(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** 批量写入/更新映射；凭证类标签静默跳过（不落盘）。返回实际写入条数。 */
  upsertMappings(rows: MappingRow[]): number {
    const eligible = rows.filter((r) => !isCredentialLabel(r.label));
    if (!eligible.length) return 0;
    this.tx(() => {
      for (const r of eligible) this.stUpsert.run(r.token, r.orig, r.label, r.lastUsed, r.pinned ? 1 : 0);
    });
    return eligible.length;
  }

  deleteMappings(tokens: string[]): void {
    if (!tokens.length) return;
    this.tx(() => {
      for (const t of tokens) this.stDelete.run(t);
    });
  }

  /** keepPinned=true 时保留自定义词（与内存 clear 语义一致）。 */
  clearMappings(keepPinned: boolean): void {
    this.db.exec(keepPinned ? 'DELETE FROM mappings WHERE pinned = 0' : 'DELETE FROM mappings');
  }

  /** 最近使用优先；常驻（pinned）条目不受 sinceMs 限制。 */
  loadMappings(sinceMs: number, limit: number): MappingRow[] {
    const rows = this.stLoad.all(sinceMs, limit) as {
      token: string; orig: string; label: string; last_used: number; pinned: number;
    }[];
    return rows
      .filter((r) => !isCredentialLabel(r.label))
      .map((r) => ({ token: r.token, orig: r.orig, label: r.label, lastUsed: r.last_used, pinned: r.pinned === 1 }));
  }

  countMappings(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM mappings').get() as { n: number }).n;
  }

  /** 写入事件，返回其落库序号（rowid），用作分页游标的第二键 */
  insertEvent(ev: GatewayEvent): number {
    const { seq: _seq, ...rest } = ev;
    return Number(this.stInsertEv.run(ev.id, ev.time, JSON.stringify(rest)).lastInsertRowid);
  }

  /**
   * 新→旧分页。游标是上一页最后一条的 (time, seq)：
   * 同一毫秒的事件可能跨页，只按 time 翻页会漏掉或卡住，所以必须带 seq 做 keyset 分页。
   */
  listEvents(opts: { before?: number; beforeSeq?: number; limit: number }): GatewayEvent[] {
    let rows: { seq: number; json: string }[];
    if (opts.before === undefined) rows = this.stListEv.all(opts.limit) as typeof rows;
    else if (opts.beforeSeq === undefined) rows = this.stListEvBefore.all(opts.before, opts.limit) as typeof rows;
    else rows = this.stListEvCursor.all(opts.before, opts.before, opts.beforeSeq, opts.limit) as typeof rows;
    return rows.map((r) => ({ ...(JSON.parse(r.json) as GatewayEvent), seq: Number(r.seq) }));
  }

  countEvents(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  }

  trimEvents(maxEvents: number): void {
    this.stTrim.run(maxEvents);
  }

  clearEvents(): void {
    this.db.exec('DELETE FROM events');
  }

  close(): void {
    this.db.close();
  }
}
