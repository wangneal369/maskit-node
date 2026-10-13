import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MaskitDb, type MappingRow } from '../electron/storage/db';
import type { GatewayEvent } from '../electron/gateway/proxy';
import type { AuditFinding } from '../electron/core/audit';
import type { CommandRecord } from '../electron/gateway/inspect';

const F = (kind: string): AuditFinding => ({ kind, severity: 'MEDIUM', title: kind, evidence: '' });
const C = (id: string): CommandRecord => ({ id, label: id, action: 'observe', snippet: '' });

function ev(id: string, time: number): GatewayEvent {
  return {
    id, time, upstream: 'openai', method: 'POST', path: '/v1/chat/completions', status: 200,
    durationMs: 1, stream: false, hits: [{ label: 'PHONE', token: '{{PHONE_bcdfgh}}' }],
    restored: 0, unresolved: 0, signedBlocksSkipped: 0,
  };
}

function row(token: string, over: Partial<MappingRow> = {}): MappingRow {
  return { token, orig: `orig-${token}`, label: 'PHONE', lastUsed: 1000, pinned: false, ...over };
}

describe('MaskitDb mappings', () => {
  it('upsert / load 往返，按 lastUsed 新→旧', () => {
    const db = new MaskitDb(':memory:');
    db.upsertMappings([row('{{PHONE_aaaaaa}}', { lastUsed: 10 }), row('{{PHONE_bbbbbb}}', { lastUsed: 30 }), row('{{PHONE_cccccc}}', { lastUsed: 20 })]);
    const rows = db.loadMappings(0, 10);
    expect(rows.map((r) => r.lastUsed)).toEqual([30, 20, 10]);
    expect(db.loadMappings(0, 2)).toHaveLength(2);
    expect(db.countMappings()).toBe(3);
  });

  it('upsert 覆盖同 token，sinceMs 过滤旧行但保留 pinned', () => {
    const db = new MaskitDb(':memory:');
    db.upsertMappings([row('{{PHONE_aaaaaa}}', { lastUsed: 5 })]);
    db.upsertMappings([row('{{PHONE_aaaaaa}}', { lastUsed: 50, orig: 'new' })]);
    db.upsertMappings([row('{{TERM_dddddd}}', { lastUsed: 1, pinned: true, label: 'TERM' }), row('{{PHONE_eeeeee}}', { lastUsed: 2 })]);
    const rows = db.loadMappings(40, 10);
    expect(rows.map((r) => r.token).sort()).toEqual(['{{PHONE_aaaaaa}}', '{{TERM_dddddd}}']);
    expect(rows.find((r) => r.token === '{{PHONE_aaaaaa}}')?.orig).toBe('new');
    expect(rows.find((r) => r.pinned)?.token).toBe('{{TERM_dddddd}}');
  });

  it('凭证类标签永不落盘（含去下划线形式）', () => {
    const db = new MaskitDb(':memory:');
    const labels = ['API_KEY', 'APIKEY', 'TOKEN', 'SECRET', 'ACCESS_KEY', 'ACCESSKEY', 'JWT', 'CONNSTR', 'PRIVATE_KEY', 'PRIVATEKEY'];
    const n = db.upsertMappings(labels.map((l, i) => row(`{{${l}_bbbbb${i}}}`, { label: l })));
    expect(n).toBe(0);
    expect(db.countMappings()).toBe(0);
  });

  it('deleteMappings / clearMappings(keepPinned)', () => {
    const db = new MaskitDb(':memory:');
    db.upsertMappings([row('a'), row('b'), row('c', { pinned: true })]);
    db.deleteMappings(['a']);
    expect(db.countMappings()).toBe(2);
    db.clearMappings(true);
    expect(db.loadMappings(0, 10).map((r) => r.token)).toEqual(['c']);
    db.clearMappings(false);
    expect(db.countMappings()).toBe(0);
  });
});

describe('MaskitDb events', () => {
  it('新→旧，limit 与 before 分页', () => {
    const db = new MaskitDb(':memory:');
    for (let i = 1; i <= 10; i++) db.insertEvent(ev(`e${i}`, i * 100));
    expect(db.listEvents({ limit: 3 }).map((e) => e.id)).toEqual(['e10', 'e9', 'e8']);
    expect(db.listEvents({ before: 800, limit: 3 }).map((e) => e.id)).toEqual(['e7', 'e6', 'e5']);
    expect(db.listEvents({ before: 100, limit: 3 })).toEqual([]);
    expect(db.listEvents({ limit: 1 })[0].hits[0].token).toBe('{{PHONE_bcdfgh}}');
  });

  it('同时间戳按插入倒序，顺序稳定', () => {
    const db = new MaskitDb(':memory:');
    for (let i = 1; i <= 5; i++) db.insertEvent(ev(`s${i}`, 1000));
    const a = db.listEvents({ limit: 5 }).map((e) => e.id);
    const b = db.listEvents({ limit: 5 }).map((e) => e.id);
    expect(a).toEqual(['s5', 's4', 's3', 's2', 's1']);
    expect(b).toEqual(a);
    expect(db.listEvents({ limit: 2 }).map((e) => e.id)).toEqual(['s5', 's4']);
  });

  it('同一毫秒的事件跨页边界时不丢', () => {
    const db = new MaskitDb(':memory:');
    db.insertEvent(ev('a', 100));
    for (let i = 1; i <= 4; i++) db.insertEvent(ev(`b${i}`, 200));
    db.insertEvent(ev('c', 300));
    const shown: string[] = [];
    let cursor: { before?: number; beforeSeq?: number } = {};
    // 模拟前端：每页 2 条，按 (time, seq) 游标翻页
    for (;;) {
      const page = db.listEvents({ ...cursor, limit: 2 });
      shown.push(...page.map((e) => e.id));
      if (page.length < 2) break;
      const last = page[page.length - 1];
      cursor = { before: last.time, beforeSeq: last.seq };
    }
    expect(shown).toEqual(['c', 'b4', 'b3', 'b2', 'b1', 'a']);
  });

  it('trimEvents 保留最新 N 条；clearEvents 清空', () => {
    const db = new MaskitDb(':memory:');
    for (let i = 1; i <= 20; i++) db.insertEvent(ev(`t${i}`, i));
    db.trimEvents(5);
    expect(db.countEvents()).toBe(5);
    expect(db.listEvents({ limit: 10 }).map((e) => e.id)).toEqual(['t20', 't19', 't18', 't17', 't16']);
    db.clearEvents();
    expect(db.countEvents()).toBe(0);
  });

  it('同 id 重复插入覆盖而非报错', () => {
    const db = new MaskitDb(':memory:');
    db.insertEvent(ev('x', 1));
    db.insertEvent({ ...ev('x', 1), status: 502 });
    expect(db.countEvents()).toBe(1);
    expect(db.listEvents({ limit: 1 })[0].status).toBe(502);
  });
});

describe('MaskitDb 文件库', () => {
  const dirs: string[] = [];
  afterEach(() => {
    dirs.forEach((d) => {
      try {
        fs.rmSync(d, { recursive: true });
      } catch {}
    });
    dirs.length = 0;
  });

  it('重新打开后数据仍在，WAL 模式', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maskit-db-'));
    dirs.push(dir);
    const file = path.join(dir, 'sub', 'maskit.db');
    const a = new MaskitDb(file);
    a.upsertMappings([row('{{PHONE_aaaaaa}}', { lastUsed: 7 })]);
    a.insertEvent(ev('p1', 5));
    a.close();
    const b = new MaskitDb(file);
    expect(b.loadMappings(0, 10)).toHaveLength(1);
    expect(b.listEvents({ limit: 10 }).map((e) => e.id)).toEqual(['p1']);
    b.close();
  });

  it('v1→v2 迁移：旧数据可读，新列可写', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maskit-migrate-'));
    dirs.push(dir);
    const file = path.join(dir, 'migrate.db');

    // 创建 v1 数据库（使用原始 SQL，不通过 MaskitDb）
    const dbRaw = new DatabaseSync(file);
    dbRaw.exec('PRAGMA journal_mode = WAL;');
    dbRaw.exec('PRAGMA user_version = 1;');
    dbRaw.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY, time INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX idx_events_time ON events(time);
    `);
    dbRaw.prepare('INSERT INTO events (id, time, json) VALUES (?, ?, ?)').run(
      'old-event',
      1000,
      JSON.stringify({
        id: 'old-event',
        time: 1000,
        upstream: 'openai',
        method: 'POST',
        path: '/v1/chat',
        status: 200,
        durationMs: 10,
        stream: false,
        hits: [],
        restored: 0,
        unresolved: 0,
        signedBlocksSkipped: 0,
      }),
    );
    dbRaw.close();

    // 用新 schema 打开，验证迁移和读取
    const db = new MaskitDb(file);
    expect(db.countEvents()).toBe(1);
    const events = db.listEvents({ limit: 10 });
    expect(events.length).toBeGreaterThan(0);
    if (events.length > 0) {
      expect(events[0].id).toBe('old-event');
      expect(events[0].time).toBe(1000);
    }

    // 写入新数据，验证新列可用
    db.insertEvent({
      ...ev('new-event', 2000),
      model: 'gpt-4o',
      usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0 },
      cost: 0.75,
      findings: [F('finding1')],
    });
    expect(db.countEvents()).toBe(2);

    db.close();
  });
});

describe('MaskitDb flagged 事件列表', () => {
  it('listFlagged 与 countFlagged：仅返回标记事件', () => {
    const db = new MaskitDb(':memory:');
    for (let i = 1; i <= 5; i++) {
      db.insertEvent(ev(`plain${i}`, i * 100));
    }
    for (let i = 6; i <= 8; i++) {
      db.insertEvent({
        ...ev(`flagged${i}`, i * 100),
        findings: [F(`finding${i}`)],
      });
    }
    expect(db.countFlagged()).toBe(3);
    const flagged = db.listFlagged({ limit: 10 });
    expect(flagged).toHaveLength(3);
    expect(flagged.map((e) => e.id)).toEqual(['flagged8', 'flagged7', 'flagged6']);
  });

  it('listFlagged keyset 分页', () => {
    const db = new MaskitDb(':memory:');
    for (let i = 1; i <= 10; i++) {
      db.insertEvent({
        ...ev(`f${i}`, i * 100),
        commands: i > 5 ? [C('cmd')] : undefined, // 6-10 被标记
      });
    }
    const page1 = db.listFlagged({ limit: 2 });
    expect(page1).toHaveLength(2);
    expect(page1[0].id).toBe('f10');

    const page2 = db.listFlagged({ before: page1[1].time, beforeSeq: page1[1].seq, limit: 2 });
    expect(page2).toHaveLength(2);
    expect(page2[0].id).toBe('f8');
  });

  it('flagged = 1 当有 findings 或 commands', () => {
    const db = new MaskitDb(':memory:');
    db.insertEvent(ev('no-flags', 1000));
    db.insertEvent({ ...ev('with-findings', 2000), findings: [F('f1'), F('f2')] });
    db.insertEvent({ ...ev('with-commands', 3000), commands: [C('cmd1')] });
    db.insertEvent({ ...ev('both', 4000), findings: [F('f1')], commands: [C('cmd1')] });

    expect(db.countFlagged()).toBe(3);
    const ids = db.listFlagged({ limit: 10 }).map((e) => e.id);
    expect(ids.sort()).toEqual(['both', 'with-commands', 'with-findings']);
  });
});

describe('MaskitDb 统计方法', () => {
  it('stats 日均聚合与按模型聚合', () => {
    const db = new MaskitDb(':memory:');

    // 两天的数据：T=1000ms (2000-01-01) 和 T=86400000+1000ms (2000-01-02)
    const baseTime = 946684800000; // 2000-01-01 00:00:00 UTC
    const tzOffset = 0; // UTC

    // 第 1 天：gpt-4o (100 input, 50 output, 0 cache, $0.75)
    db.insertEvent({
      ...ev('day1-a', baseTime),
      model: 'gpt-4o',
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      cost: 0.75,
    });

    // 第 1 天：claude-opus-4 (200 input, 100 output, 20 cache-read, 10 cache-write)
    // cost = 200*15/1M + 100*75/1M + 20*1.5/1M + 10*18.75/1M
    db.insertEvent({
      ...ev('day1-b', baseTime),
      model: 'claude-opus-4',
      usage: { input: 200, output: 100, cacheRead: 20, cacheWrite: 10 },
      cost: (200 * 15 + 100 * 75 + 20 * 1.5 + 10 * 18.75) / 1_000_000,
    });

    // 第 1 天：无模型事件（不计入 requests）
    db.insertEvent({
      ...ev('day1-c', baseTime),
      upstream: 'anthropic',
      status: 500,
    });

    // 第 2 天：gpt-4o (150 input, 60 output, 不定价)
    db.insertEvent({
      ...ev('day2-a', baseTime + 86400000),
      model: 'gpt-4o',
      usage: { input: 150, output: 60, cacheRead: 0, cacheWrite: 0 },
      cost: undefined, // 不定价
    });

    const stats = db.stats({ sinceMs: baseTime, tzOffsetMin: tzOffset });

    // 日均统计：应有 2 行（两天）
    expect(stats.daily).toHaveLength(2);
    expect(stats.daily[0].date).toBe('2000-01-02');
    expect(stats.daily[0].requests).toBe(1); // day2-a
    expect(stats.daily[0].input).toBe(150);
    expect(stats.daily[0].output).toBe(60);

    expect(stats.daily[1].date).toBe('2000-01-01');
    expect(stats.daily[1].requests).toBe(2); // day1-a + day1-b
    expect(stats.daily[1].input).toBe(300);
    expect(stats.daily[1].output).toBe(150);
    expect(stats.daily[1].cacheRead).toBe(20);
    expect(stats.daily[1].cacheWrite).toBe(10);

    // 按模型聚合
    expect(stats.byModel).toHaveLength(2);
    const gpt4o = stats.byModel.find((m) => m.model === 'gpt-4o');
    expect(gpt4o?.requests).toBe(2); // day1-a + day2-a
    expect(gpt4o?.input).toBe(250);
    expect(gpt4o?.output).toBe(110);
    expect(gpt4o?.unpriced).toBe(1); // day2-a

    const claude = stats.byModel.find((m) => m.model === 'claude-opus-4');
    expect(claude?.requests).toBe(1);
    expect(claude?.input).toBe(200);
    expect(claude?.output).toBe(100);
    expect(claude?.unpriced).toBe(0);
  });

  it('stats 考虑时区偏移', () => {
    const db = new MaskitDb(':memory:');

    // 时刻：2000-01-01 23:00:00 UTC (946768800000 ms)
    // 用 UTC-8 (tzOffset=-480)，应该被分到前一天（2000-01-01 15:00:00）
    const timeUtc = 946768800000;

    db.insertEvent({
      ...ev('e1', timeUtc),
      model: 'gpt-4o',
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      cost: 0.75,
    });

    const stats = db.stats({ sinceMs: 0, tzOffsetMin: -480 }); // UTC-8

    // 验证日期计算
    expect(stats.daily).toHaveLength(1);
    expect(stats.daily[0].date).toBe('2000-01-01'); // 仍在 2000-01-01（因为 UTC-8）
  });

  it('stats unpriced 统计：有 token 但无 cost', () => {
    const db = new MaskitDb(':memory:');

    db.insertEvent({
      ...ev('a', 1000),
      model: 'unknown-model',
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      cost: undefined,
    });

    db.insertEvent({
      ...ev('b', 2000),
      model: 'gpt-4o',
      usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0 },
      cost: 0.9,
    });

    const stats = db.stats({ sinceMs: 0, tzOffsetMin: 0 });
    const unknown = stats.byModel.find((m) => m.model === 'unknown-model');
    expect(unknown?.unpriced).toBe(1);

    const gpt = stats.byModel.find((m) => m.model === 'gpt-4o');
    expect(gpt?.unpriced).toBe(0);
  });
});

describe('MaskitDb 事件完整性', () => {
  it('读回的事件保留 model / usage / cost / findings / commands', () => {
    const db = new MaskitDb(':memory:');
    const full = {
      ...ev('full', 1000),
      model: 'gpt-4o',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      findings: [F('prompt_extraction')],
      commands: [C('builtin-rm-root')],
    };
    db.insertEvent(full);
    const [got] = db.listEvents({ limit: 1 });
    expect(got).toMatchObject({ model: 'gpt-4o', usage: full.usage, cost: 0, findings: full.findings, commands: full.commands });
    const [flagged] = db.listFlagged({ limit: 1 });
    expect(flagged.findings).toEqual(full.findings);
    // cost = 0 不能被当成「无价格」
    expect(db.stats({ sinceMs: 0, tzOffsetMin: 0 }).byModel[0].unpriced).toBe(0);
  });
});
