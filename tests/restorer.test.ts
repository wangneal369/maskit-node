import { describe, expect, it } from 'vitest';
import { MappingStore, Restorer } from '../electron/core';

function setup() {
  const store = new MappingStore();
  const email = store.tokenFor('alice@corp-x.com', 'EMAIL');
  const phone = store.tokenFor('13800138000', 'PHONE');
  return { store, email, phone, r: new Restorer(store) };
}

describe('Restorer 非流式', () => {
  it('完整还原', () => {
    const { r, email, phone } = setup();
    expect(r.restore(`mail ${email} tel ${phone}`, '', false, true)).toBe('mail alice@corp-x.com tel 13800138000');
    expect(r.stats.restored).toBe(2);
    expect(r.stats.unresolved).toBe(0);
  });

  it('容错：小写标签 + 内部空格', () => {
    const { r, email } = setup();
    const loose = email.replace('{{EMAIL_', '{{ email_').replace('}}', ' }}');
    expect(loose).toMatch(/^\{\{ email_[a-z]{6} \}\}$/);
    expect(r.restore(`x ${loose} y`, '', false, true)).toBe('x alice@corp-x.com y');
  });

  it('裸形态仅还原签发过的', () => {
    const { r, email } = setup();
    const bare = email.slice(2, -2);
    expect(bare).toMatch(/^EMAIL_[a-z]{6}$/);
    expect(r.restore(`用 ${bare} 发`, '', false, true)).toBe('用 alice@corp-x.com 发');
    // 未签发的裸形态原样保留
    const r2 = new Restorer(new MappingStore());
    expect(r2.restore(`用 ${bare} 发`, '', false, true)).toBe(`用 ${bare} 发`);
    // 标签对不上也不还原
    expect(r.restore(`PHONE_${bare.slice(6)}`, '', false, true)).toBe(`PHONE_${bare.slice(6)}`);
  });

  it('未知占位符原样保留并计入 unresolved', () => {
    const { r } = setup();
    const unk = '{{EMAIL_bcdfgh}}';
    expect(r.restore(`a ${unk} b`, '', false, true)).toBe(`a ${unk} b`);
    expect(r.stats.unresolved).toBe(1);
    expect(r.stats.restored).toBe(0);
  });

  it('escape=true 按 JSON 转义', () => {
    const store = new MappingStore();
    const tok = store.tokenFor('say "hi"\nbye', 'TERM');
    const r = new Restorer(store);
    const out = r.restore(`{"a":"${tok}"}`, '', true, true);
    expect(JSON.parse(out)).toEqual({ a: 'say "hi"\nbye' });
    expect(out).not.toContain('\n');
  });

  it('restoreTree 递归，跳过 thinking 块与 signature', () => {
    const { r, email } = setup();
    const think = { type: 'thinking', thinking: email, signature: email };
    const out = r.restoreTree({
      a: [{ type: 'text', text: email }],
      b: think,
      signature: email,
    }) as any;
    expect(out.a[0].text).toBe('alice@corp-x.com');
    expect(out.b).toEqual(think);
    expect(out.signature).toBe(email);
  });
});

describe('Restorer 流式', () => {
  it('在任意位置切成两段，结果与一次性还原一致', () => {
    const { store, email, phone } = setup();
    const text = `请联系 ${email}，电话 ${phone}。{{ end }} 结束`;
    const expected = new Restorer(store).restore(text, '', false, true);
    expect(expected).toContain('alice@corp-x.com');
    for (let i = 0; i <= text.length; i++) {
      const r = new Restorer(store);
      const out = r.restore(text.slice(0, i), 'c') + r.restore(text.slice(i), 'c') + r.flush('c');
      expect(out, `split@${i}`).toBe(expected);
    }
  });

  it('逐字符喂入结果一致', () => {
    const { store, email } = setup();
    const text = `a ${email} b ${email}`;
    const r = new Restorer(store);
    let out = '';
    for (const ch of text) out += r.restore(ch, 'c');
    out += r.flush('c');
    expect(out).toBe('a alice@corp-x.com b alice@corp-x.com');
  });

  it('通道互不串扰', () => {
    const { store, email } = setup();
    const r = new Restorer(store);
    const half = email.slice(0, 5);
    expect(r.restore(`x${half}`, 'a')).toBe('x');
    expect(r.restore('hello', 'b')).toBe('hello');
    expect(r.restore(email.slice(5), 'a')).toBe('alice@corp-x.com');
  });

  it('escape 通道跨 chunk 同样按 JSON 转义', () => {
    const store = new MappingStore();
    const tok = store.tokenFor('a"b', 'TERM');
    const r = new Restorer(store);
    const out = r.restore(tok.slice(0, 4), 'p', true) + r.restore(tok.slice(4), 'p', true) + r.flush('p', true);
    expect(out).toBe('a\\"b');
  });

  it('flush 无扣留返回空串，有扣留则吐出', () => {
    const { r } = setup();
    expect(r.flush('x')).toBe('');
    expect(r.restore('abc {{', 'x')).toBe('abc ');
    expect(r.flush('x')).toBe('{{');
  });
});
