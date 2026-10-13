import { describe, expect, it, vi } from 'vitest';
import { MappingStore, type PersistedMapping, type StorePersistHooks } from '../electron/core';

function hooks() {
  const added: PersistedMapping[] = [];
  const removed: string[] = [];
  const cleared: boolean[] = [];
  const h: StorePersistHooks = {
    onAdd: (e) => added.push(e),
    onRemove: (t) => removed.push(...t),
    onClear: (k) => cleared.push(k),
  };
  return { h, added, removed, cleared };
}

describe('MappingStore 持久化钩子', () => {
  it('新映射触发 onAdd，复用不触发', () => {
    const { h, added } = hooks();
    const s = new MappingStore({ persist: h });
    const t = s.tokenFor('13800138000', 'PHONE');
    s.tokenFor('13800138000', 'PHONE');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ token: t, orig: '13800138000', label: 'PHONE', pinned: false });
  });

  it('凭证标签永不触发 onAdd / exportDirty / entries 之外的落盘通路', () => {
    const { h, added } = hooks();
    const s = new MappingStore({ persist: h });
    for (const l of ['API_KEY', 'TOKEN', 'SECRET', 'ACCESS_KEY', 'JWT', 'CONNSTR', 'PRIVATE_KEY']) {
      const t = s.tokenFor(`secret-${l}`, l);
      s.lookup(t);
      s.tokenFor(`secret-${l}`, l);
    }
    expect(added).toHaveLength(0);
    expect(s.exportDirty()).toHaveLength(0);
    expect(s.size).toBe(7);
  });

  it('lastUsed 变动进入 exportDirty，markClean 后清空', () => {
    const { h } = hooks();
    const s = new MappingStore({ persist: h });
    const t = s.tokenFor('张三', 'NAME');
    expect(s.exportDirty()).toHaveLength(0);
    s.lookup(t);
    expect(s.exportDirty().map((e) => e.token)).toEqual([t]);
    s.markClean([t]);
    expect(s.exportDirty()).toHaveLength(0);
    s.tokenFor('张三', 'NAME');
    expect(s.exportDirty()).toHaveLength(1);
    s.markClean();
    expect(s.exportDirty()).toHaveLength(0);
  });

  it('prune 淘汰触发 onRemove（仅非凭证）', () => {
    const { h, removed } = hooks();
    const s = new MappingStore({ persist: h, maxEntries: 2 });
    const a = s.tokenFor('a', 'NAME');
    const k = s.tokenFor('k', 'API_KEY');
    s.tokenFor('b', 'NAME');
    s.tokenFor('c', 'NAME');
    expect(removed).toContain(a);
    expect(removed).not.toContain(k);
  });

  it('clear 触发 onClear 并带 keepPinned', () => {
    const { h, cleared } = hooks();
    const s = new MappingStore({ persist: h });
    s.clear();
    s.clear(false);
    expect(cleared).toEqual([true, false]);
  });
});

describe('MappingStore.restore', () => {
  const now = Date.now();
  const mk = (orig: string, suffix: string, over: Partial<PersistedMapping> = {}): PersistedMapping => ({
    token: `{{NAME_${suffix}}}`, orig, label: 'NAME', lastUsed: now, pinned: false, ...over,
  });

  it('重建 lookup / lookupBare / 后缀索引，tokenFor 复用同一占位符', () => {
    const s = new MappingStore();
    expect(s.restore([mk('张三', 'bcdfgh')])).toBe(1);
    expect(s.lookup('{{NAME_bcdfgh}}')).toBe('张三');
    // 标签不兼容时不进行后缀回退（安全修复）
    expect(s.lookup('{{PERSON_bcdfgh}}')).toBeUndefined();
    expect(s.lookupBare('NAME', 'bcdfgh')).toBe('张三');
    expect(s.lookupBare('OTHER', 'bcdfgh')).toBeUndefined();
    expect(s.tokenFor('张三', 'NAME')).toBe('{{NAME_bcdfgh}}');
    expect(s.size).toBe(1);
  });

  it('不触发 onAdd', () => {
    const { h, added } = hooks();
    const s = new MappingStore({ persist: h });
    s.restore([mk('李四', 'bcdfgh')]);
    expect(added).toHaveLength(0);
  });

  it('过期的非常驻条目被跳过，常驻保留', () => {
    const s = new MappingStore({ ttlMs: 1000 });
    const old = now - 10_000;
    const n = s.restore([
      mk('旧', 'bcdfgh', { lastUsed: old }),
      mk('常驻', 'jkmnpq', { lastUsed: old, pinned: true }),
      mk('新', 'rstvwx'),
    ]);
    expect(n).toBe(2);
    expect(s.lookup('{{NAME_bcdfgh}}')).toBeUndefined();
    expect(s.lookup('{{NAME_jkmnpq}}')).toBe('常驻');
    expect(s.lookup('{{NAME_rstvwx}}')).toBe('新');
  });

  it('超 maxEntries 时淘汰 lastUsed 最旧者（LRU 序按 lastUsed）', () => {
    const { h, removed } = hooks();
    const s = new MappingStore({ maxEntries: 2, persist: h });
    s.restore([
      mk('c', 'ccccch', { lastUsed: now - 1 }),
      mk('a', 'aaaaah', { lastUsed: now - 300 }),
      mk('b', 'bbbbbh', { lastUsed: now - 200 }),
    ]);
    expect(s.size).toBe(2);
    expect(s.lookup('{{NAME_aaaaah}}')).toBeUndefined();
    expect(s.lookup('{{NAME_bbbbbh}}')).toBe('b');
    expect(removed).toEqual(['{{NAME_aaaaah}}']);
  });

  it('凭证标签与冲突条目被跳过', () => {
    const s = new MappingStore();
    const n = s.restore([
      mk('sk-xxx', 'bcdfgh', { label: 'APIKEY', token: '{{APIKEY_bcdfgh}}' }),
      mk('甲', 'jkmnpq'),
      mk('乙', 'jkmnpq'), // 后缀冲突
      mk('甲', 'rstvwx'), // 原文重复
    ]);
    expect(n).toBe(1);
    expect(s.lookup('{{APIKEY_bcdfgh}}')).toBeUndefined();
    expect(s.size).toBe(1);
  });

  it('restore 后新签发不会撞已恢复的后缀', () => {
    const s = new MappingStore();
    s.restore([mk('甲', 'bcdfgh')]);
    const spy = vi.spyOn(Math, 'random');
    const t = s.tokenFor('乙', 'NAME');
    expect(t).not.toBe('{{NAME_bcdfgh}}');
    spy.mockRestore();
  });
});
