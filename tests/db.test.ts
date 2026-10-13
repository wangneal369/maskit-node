import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MaskitDb, type MappingRow } from '../electron/storage/db';
import type { GatewayEvent } from '../electron/gateway/proxy';

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
});
