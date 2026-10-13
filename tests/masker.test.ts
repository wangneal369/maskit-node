import { describe, expect, it } from 'vitest';
import { DEFAULT_MASK_CONFIG, Masker, MappingStore, type MaskConfig } from '../electron/core';

const PH_RX = /^\{\{[A-Z0-9]{1,12}_[bcdfghjkmnpqrstvwxz]{6}\}\}$/;

function cfg(over: Partial<MaskConfig> & { rules?: Partial<MaskConfig['builtinRules']> } = {}): MaskConfig {
  return {
    builtinRules: { ...DEFAULT_MASK_CONFIG.builtinRules, ...over.rules },
    secretPrefixes: over.secretPrefixes ?? [...DEFAULT_MASK_CONFIG.secretPrefixes],
    customWords: over.customWords ?? [],
  };
}
const mk = (c?: MaskConfig) => new Masker(new MappingStore(), c ?? cfg());

/** 计算校验位正确的 18 位身份证 */
function makeIdCard(prefix17: string): string {
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const code = '10X98765432';
  const total = [...prefix17].reduce((s, c, i) => s + +c * w[i], 0);
  return prefix17 + code[total % 11];
}
/** 计算 Luhn 校验位，生成指定总长度的合法卡号 */
function makeCard(body: string): string {
  for (let d = 0; d < 10; d++) {
    const cand = body + d;
    let sum = 0;
    let dbl = false;
    for (let i = cand.length - 1; i >= 0; i--) {
      let x = +cand[i];
      if (dbl) x = x > 4 ? x * 2 - 9 : x * 2;
      sum += x;
      dbl = !dbl;
    }
    if (sum % 10 === 0) return cand;
  }
  throw new Error('unreachable');
}

describe('默认开启的规则', () => {
  it('API_KEY：sk- 前缀', () => {
    const m = mk();
    const out = m.mask('key=sk-abcdef1234567890 end');
    expect(out).not.toContain('sk-abcdef');
    expect(out).toMatch(/\{\{APIKEY_[bcdfghjkmnpqrstvwxz]{6}\}\}/);
  });

  it('API_KEY：ghp_ 前缀', () => {
    const out = mk().mask('token ghp_abcdefghijklmnopqrstuvwxyz0123 ok');
    expect(out).not.toContain('ghp_');
    expect(out).toContain('{{API_KEY_'.replace('API_KEY', 'APIKEY'));
  });

  it('CARD：16 位与 19 位 Luhn 合法卡号', () => {
    const c16 = makeCard('411111111111111');
    const c19 = makeCard('622202000000000001'.slice(0, 18));
    expect(c16).toHaveLength(16);
    expect(c19).toHaveLength(19);
    const m = mk();
    const out = m.mask(`a ${c16} b ${c19} c`);
    expect(out).not.toContain(c16);
    expect(out).not.toContain(c19);
    expect(out.match(/\{\{CARD_/g)).toHaveLength(2);
  });

  it('CONNSTR：只替换密码部分', () => {
    const out = mk().mask('mysql://root:Pass123@192.168.1.50:3306/db');
    expect(out).toMatch(/^mysql:\/\/root:\{\{CONNSTR_[a-z]{6}\}\}@192\.168\.1\.50:3306\/db$/);
    expect(out).not.toContain('Pass123');
  });

  it('CONNSTR：模板连接串豁免', () => {
    const s = 'postgres://user:password@host:5432/db';
    expect(mk().mask(s)).toBe(s);
  });

  it('EMAIL', () => {
    const out = mk().mask('联系 alice.w@example-corp.com 谢谢');
    expect(out).not.toContain('alice.w@');
    expect(out).toMatch(/\{\{EMAIL_[a-z]{6}\}\}/);
  });

  it('IDCARD：校验位正确的 18 位', () => {
    const id = makeIdCard('11010519491231002');
    const out = mk().mask(`身份证 ${id} 完`);
    expect(out).not.toContain(id);
    expect(out).toMatch(/\{\{IDCARD_/);
  });

  it('IDCARD：校验位错误不命中', () => {
    const id = makeIdCard('11010519491231002');
    const bad = id.slice(0, 17) + (id[17] === '0' ? '1' : '0');
    const out = mk().mask(`x ${bad} y`);
    expect(out).not.toMatch(/\{\{IDCARD_/);
  });

  it('LANDLINE', () => {
    const out = mk().mask('座机 010-62345678 请拨');
    expect(out).not.toContain('010-62345678');
    expect(out).toMatch(/\{\{LANDLINE_/);
    // 本地号首位为 1 不是合法座机（与 Python 版 _landline_ok 一致），不应命中
    expect(mk().mask('010-12345678')).toBe('010-12345678');
  });

  it('PHONE：普通与 +86 带分隔', () => {
    const m = mk();
    const a = m.mask('手机 13800138000 完');
    expect(a).not.toContain('13800138000');
    expect(a).toMatch(/\{\{PHONE_/);
    const b = m.mask('电话 +86 138-1234-5678 完');
    expect(b).not.toContain('138-1234-5678');
    expect(b).toMatch(/\{\{PHONE_/);
    expect(b).not.toContain('+86');
  });
});

describe('反例', () => {
  it.each([
    '版本 v1.2.3 与 10.2.3.4567',
    '随机数 1234567890123 不是卡号',
    '密钥 sk-demo 太短',
    '时间戳 1700000000000',
  ])('不误报：%s', (s) => {
    expect(mk().mask(s)).toBe(s);
  });
});

describe('占位符行为', () => {
  it('格式正则', () => {
    const m = mk();
    const out = m.mask('13800138000');
    expect(out).toMatch(PH_RX);
    expect(m.mask('a@b-corp.com')).toMatch(PH_RX);
  });

  it('同原文跨调用得到同一占位符', () => {
    const m = mk();
    const a = m.mask('我的手机 13800138000');
    const b = m.mask('再说一遍 13800138000 谢谢');
    const ta = a.match(/\{\{[^}]+\}\}/)![0];
    const tb = b.match(/\{\{[^}]+\}\}/)![0];
    expect(ta).toBe(tb);
  });

  it('已有占位符不被二次包裹', () => {
    const m = mk();
    const first = m.mask('13800138000');
    const again = m.mask(`历史: ${first} 与新的 alice@corp-x.com`);
    expect(again.startsWith(`历史: ${first} 与新的 {{EMAIL_`)).toBe(true);
    expect(again.match(/\{\{/g)).toHaveLength(2);
    expect(m.mask(first)).toBe(first);
  });

  it('hits 收集一次', () => {
    const m = mk();
    const hits = new Map();
    m.mask('13800138000 and 13800138000', hits);
    expect(hits.size).toBe(1);
  });
});

describe('自定义词', () => {
  it('字面量大小写不敏感，复用同一占位符', () => {
    const m = mk(cfg({ customWords: [{ word: 'AcmeCorp', label: 'ORG' }] }));
    const out = m.mask('AcmeCorp 与 acmecorp');
    const toks = out.match(/\{\{ORG_[a-z]{6}\}\}/g)!;
    expect(toks).toHaveLength(2);
    expect(toks[0]).toBe(toks[1]);
    expect(out).not.toMatch(/acmecorp/i);
  });

  it('re: 正则', () => {
    const m = mk(cfg({ customWords: [{ word: 're:PRJ-[0-9]{3}', label: 'PROJ' }] }));
    const out = m.mask('见 PRJ-123 和 PRJ-456');
    expect(out).not.toContain('PRJ-');
    expect(out.match(/\{\{PROJ_/g)).toHaveLength(2);
  });

  it('wholeWord 只匹配整词', () => {
    const m = mk(cfg({ customWords: [{ word: 'cat', label: 'W', wholeWord: true }] }));
    expect(m.mask('concatenate')).toBe('concatenate');
    expect(m.mask('a cat sat')).toMatch(/a \{\{W_[a-z]{6}\}\} sat/);
  });

  it('非 wholeWord 命中子串', () => {
    const m = mk(cfg({ customWords: [{ word: 'cat', label: 'W' }] }));
    expect(m.mask('concatenate')).toMatch(/\{\{W_/);
  });

  it('enabled=false 的词不生效', () => {
    const m = mk(cfg({ customWords: [{ word: 'secretproj', enabled: false }] }));
    expect(m.mask('secretproj')).toBe('secretproj');
  });
});

describe('规则开关', () => {
  it('关闭的规则不生效', () => {
    const m = mk(cfg({ rules: { PHONE: false } }));
    expect(m.mask('13800138000')).toBe('13800138000');
  });

  it('SECRET 默认关闭，开启后生效', () => {
    const text = '密码：Abc12345';
    expect(mk().mask(text)).toBe(text);
    const out = mk(cfg({ rules: { SECRET: true } })).mask(text);
    expect(out).not.toContain('Abc12345');
    expect(out).toMatch(/^密码：\{\{SECRET_[a-z]{6}\}\}$/);
  });
});
