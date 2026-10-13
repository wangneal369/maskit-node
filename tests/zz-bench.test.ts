import { describe, expect, it } from 'vitest';
import { Masker, MappingStore, maskJson } from '../electron/core';

/**
 * 性能回归：大请求体脱敏在主线程上的耗时。
 * 实测（12 核开发机）1MB ≈ 12ms、4MB ≈ 45ms，远低于把脱敏挪到 worker 的序列化开销，
 * 所以脱敏留在主线程；这里的阈值放宽数倍，只用来拦住数量级的退化（如正则回溯）。
 */
describe('大请求体脱敏耗时', () => {
  it('4MB 多轮对话在 500ms 内完成', () => {
    const masker = new Masker(new MappingStore());
    const filler = '这是一段普通的对话内容，讨论代码重构与接口设计。function foo(a, b) { return a + b; } ';
    const msgs: { role: string; content: string }[] = [];
    let size = 0;
    for (let i = 0; size < 4 * 1024 * 1024; i++) {
      const content = filler.repeat(20) + (i % 7 === 0 ? ` 联系 1380013${String(1000 + i).slice(-4)} 邮箱 u${i}@corp.com` : '');
      msgs.push({ role: i % 2 ? 'assistant' : 'user', content });
      size += Buffer.byteLength(content);
    }
    const t0 = performance.now();
    const r = maskJson(masker, { model: 'gpt-4o', messages: msgs });
    const ms = performance.now() - t0;
    expect(r.hits.length).toBeGreaterThan(100);
    expect(ms).toBeLessThan(500);
  });
});
