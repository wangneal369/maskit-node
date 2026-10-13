import { describe, expect, it } from 'vitest';
import { maskBody, maskJson, Masker, MappingStore, Restorer } from '../electron/core';
import type { MaskHit } from '../electron/core';
import { entityMap, requestTexts } from '../electron/ner/request-texts';

const ents = (o: Record<string, string>) => new Map(Object.entries(o));

describe('Masker.mask 实体替换', () => {
  it('不传 entities 时与旧行为完全一致', () => {
    const m = new Masker();
    const text = '张伟的手机 13800138000，在腾讯公司';
    const a = m.mask(text);
    const b = new Masker().mask(text, undefined, undefined);
    expect(a.replace(/\{\{[A-Z0-9_a-z]+\}\}/g, 'T')).toBe(b.replace(/\{\{[A-Z0-9_a-z]+\}\}/g, 'T'));
    expect(a).toContain('张伟');
  });

  it('按实体表替换，标签取自 value，hits 记录 label/token/orig', () => {
    const m = new Masker();
    const hits = new Map<string, MaskHit>();
    const out = m.mask('请联系张伟，他在腾讯公司，住中关村大街1号', hits, ents({ 张伟: 'NAME', 腾讯公司: 'ORG', 中关村大街1号: 'ADDR' }));
    expect(out).not.toMatch(/张伟|腾讯公司|中关村大街1号/);
    expect(out).toMatch(/\{\{NAME_[a-z]{6}\}\}/);
    expect(out).toMatch(/\{\{ORG_[a-z]{6}\}\}/);
    expect(out).toMatch(/\{\{ADDR_[a-z]{6}\}\}/);
    expect([...hits.values()].map((h) => h.label).sort()).toEqual(['ADDR', 'NAME', 'ORG']);
    expect(new Restorer(m.store).restore(out, '', false, true)).toBe('请联系张伟，他在腾讯公司，住中关村大街1号');
  });

  it('同一实体多次出现共用一个占位符；非 pinned（随机后缀）', () => {
    const m = new Masker();
    const out = m.mask('张伟说张伟来了', undefined, ents({ 张伟: 'NAME' }));
    const toks = out.match(/\{\{NAME_[a-z]{6}\}\}/g)!;
    expect(toks).toHaveLength(2);
    expect(toks[0]).toBe(toks[1]);
    // 非 pinned：同一原文在另一个 store 里得到不同后缀（pinned 词是确定性后缀）
    const other = new Masker().mask('张伟', undefined, ents({ 张伟: 'NAME' }));
    const third = new Masker().mask('张伟', undefined, ents({ 张伟: 'NAME' }));
    expect(new Set([toks[0], other, third]).size).toBeGreaterThan(1);
  });

  it('最长优先：长实体不被短实体截断', () => {
    const m = new Masker();
    const out = m.mask('腾讯公司北京分公司和腾讯公司', undefined, ents({ 腾讯公司: 'ORG', 腾讯公司北京分公司: 'ORG' }));
    const toks = out.match(/\{\{ORG_[a-z]{6}\}\}/g)!;
    expect(toks).toHaveLength(2);
    expect(toks[0]).not.toBe(toks[1]);
    expect(out).not.toContain('腾讯');
  });

  it('不改写已有占位符内部，规则优先于实体', () => {
    const m = new Masker();
    const hits = new Map<string, MaskHit>();
    // “ORG” 若被当实体，不能把 {{PHONE_xxxxxx}} 之类的占位符打碎
    const out = m.mask('手机 13800138000 张伟', hits, ents({ PHONE: 'ORG', 张伟: 'NAME' }));
    expect(out).toMatch(/\{\{PHONE_[a-z]{6}\}\}/);
    expect(out).toMatch(/\{\{NAME_[a-z]{6}\}\}/);
    // 一旦实体文本已经被规则吞进占位符，就不会二次包裹
    const m2 = new Masker();
    const out2 = m2.mask('电话 13800138000', undefined, ents({ 13800138000: 'NAME' }));
    expect(out2).toMatch(/^电话 \{\{PHONE_[a-z]{6}\}\}$/);
  });

  it('正则元字符按字面量处理，且 < 2 字符的实体被忽略', () => {
    const m = new Masker();
    const out = m.mask('张(伟)+李.明 与 张 伟 以及 王', undefined, ents({ '张(伟)+李.明': 'NAME', 张: 'NAME', 王: 'NAME' }));
    expect(out).toMatch(/^\{\{NAME_[a-z]{6}\}\} 与 张 伟 以及 王$/);
    const same = m.mask('张 王', undefined, ents({ 张: 'NAME' }));
    expect(same).toBe('张 王');
  });

  it('空实体表 = 无操作；同一个 Map 的正则只构造一次（性能：大实体表 × 大量叶子）', () => {
    const m = new Masker();
    expect(m.mask('张伟', undefined, new Map())).toBe('张伟');
    const big = new Map<string, string>();
    for (let i = 0; i < 2000; i++) big.set(`人名${i}号`, 'NAME');
    const leaves = Array.from({ length: 2000 }, (_, i) => `第${i}条：人名${i}号来了，人名${(i * 7) % 2000}号也来了`);
    const t0 = performance.now();
    const outs = leaves.map((l) => m.mask(l, undefined, big));
    const dt = performance.now() - t0;
    expect(outs.every((o) => !/人名\d+号/.test(o))).toBe(true);
    expect(dt).toBeLessThan(2000);
  });
});

describe('maskJson / maskBody 透传 entities', () => {
  const entities = ents({ 张伟: 'NAME', 腾讯公司: 'ORG' });

  it('maskJson 只替换业务文本，协议字段与不传 entities 时不动', () => {
    const m = new Masker();
    const body = { model: 'm', messages: [{ role: 'user', content: '张伟在腾讯公司' }] };
    const plain = maskJson(m, body);
    expect(plain.changed).toBe(false);
    const r = maskJson(m, body, { entities });
    expect(r.changed).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/张伟|腾讯公司/);
    expect((r.body as typeof body).messages[0].role).toBe('user');
    expect(r.hits.map((h) => h.label).sort()).toEqual(['NAME', 'ORG']);
  });

  it('maskJson 对 thinking 签名块仍整块跳过', () => {
    const m = new Masker();
    const body = { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '张伟', signature: 'sig' }] }] };
    const r = maskJson(m, body, { entities });
    expect(r.changed).toBe(false);
    expect(r.signedBlocksSkipped).toBe(1);
  });

  it('maskBody：JSON 体与纯文本体都生效', () => {
    const m = new Masker();
    const j = maskBody(m, JSON.stringify({ messages: [{ role: 'user', content: '张伟' }] }), { entities });
    expect(j.text).not.toContain('张伟');
    const t = maskBody(m, '纯文本里的张伟', { entities });
    expect(t.text).not.toContain('张伟');
    expect(maskBody(m, '纯文本里的张伟').text).toContain('张伟');
  });
});

describe('requestTexts / entityMap', () => {
  it('按文档顺序取含汉字的字符串叶子，跳过协议位置', () => {
    const body = {
      model: '模型',
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: [{ type: 'text', text: '请联系张伟' }, { type: 'image_url', image_url: { url: 'data:abc' } }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '思考中', signature: 's' }] },
        { role: 'user', content: 'English only', cache_control: { type: 'ephemeral', note: '备注' } },
        { role: 'tool', tool_call_id: '调用', content: '结果：北京' },
      ],
    };
    expect(requestTexts(body)).toEqual(['你是助手', '请联系张伟', '结果：北京']);
  });

  it('entityMap：首个出现的类型为准，丢弃 <2 字符', () => {
    const m = entityMap([
      { text: '张伟', type: 'NAME', start: 0, end: 2 },
      { text: '张伟', type: 'ORG', start: 0, end: 2 },
      { text: '王', type: 'NAME', start: 0, end: 1 },
    ]);
    expect([...m.entries()]).toEqual([['张伟', 'NAME']]);
  });
});
