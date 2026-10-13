import { describe, expect, it } from 'vitest';
import { DEFAULT_BUILTIN_RULES, DEFAULT_SECRET_PREFIXES, Masker, MappingStore } from '../electron/core';

/**
 * SECRET（赋值凭据）规则的行为基线：默认关闭；开启后认「关键词 + 冒号/等号 + 值」，
 * 值至少 6 位且含数字或符号，避免误伤普通文字与代码。
 */
describe('SECRET 赋值凭据规则', () => {
  const make = (secret: boolean) => new Masker(new MappingStore(), {
    builtinRules: { ...DEFAULT_BUILTIN_RULES, SECRET: secret },
    secretPrefixes: DEFAULT_SECRET_PREFIXES,
    customWords: [],
  });

  it('默认关闭：「密码：456123」不脱敏', () => {
    expect(make(false).mask('密码：456123')).toBe('密码：456123');
  });

  it('开启后命中中英文赋值写法', () => {
    const m = make(true);
    for (const t of ['密码：456123', '口令：Abc@1234', 'password=hunter2000']) {
      expect(m.mask(t)).toMatch(/\{\{SECRET_/);
    }
  });

  it('开启后不误伤：无冒号/等号、值过短或无数字符号、代码里的调用', () => {
    const m = make(true);
    for (const t of ['密码是 456123', '数据库密码: abc', 'const token = getToken(x1)']) {
      expect(m.mask(t)).toBe(t);
    }
  });
});
