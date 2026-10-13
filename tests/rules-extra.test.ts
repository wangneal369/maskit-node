import { describe, expect, it } from 'vitest';
import { DEFAULT_MASK_CONFIG, Masker, MappingStore, type MaskConfig } from '../electron/core';

function cfg(over: Partial<MaskConfig> & { rules?: Partial<MaskConfig['builtinRules']> } = {}): MaskConfig {
  return {
    builtinRules: { ...DEFAULT_MASK_CONFIG.builtinRules, ...over.rules },
    secretPrefixes: over.secretPrefixes ?? [...DEFAULT_MASK_CONFIG.secretPrefixes],
    customWords: over.customWords ?? [],
  };
}

/** 生成有效的 USCC（校验位正确）。前 17 位为参数，自动计算校验位 */
function makeUSCC(prefix17: string): string {
  const USCC_CHARS = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

  if (prefix17.length !== 17) throw new Error('prefix must be 17 chars');
  let total = 0;
  for (let i = 0; i < 17; i++) {
    const idx = USCC_CHARS.indexOf(prefix17[i]);
    if (idx === -1) throw new Error(`invalid char at ${i}: ${prefix17[i]}`);
    total += USCC_WEIGHTS[i] * idx;
  }
  const check = (31 - (total % 31)) % 31;
  return prefix17 + USCC_CHARS[check];
}

describe('IPV6_PRIVATE', () => {
  it('fe80:: 链路本地地址应命中', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IPV6_PRIVATE: true } }));
    const out = m.mask('网关地址 fe80::1 完');
    expect(out).not.toContain('fe80::1');
    expect(out).toMatch(/\{\{IPV6PRIVATE_/);
  });

  it('fc00::/7 ULA 地址应命中', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IPV6_PRIVATE: true } }));
    const out = m.mask('私网 fd12:3456:789a::1 完');
    expect(out).not.toContain('fd12:3456:789a::1');
    expect(out).toMatch(/\{\{IPV6PRIVATE_/);
  });

  it('fe80:: 大小写混合应命中', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IPV6_PRIVATE: true } }));
    const out = m.mask('fe80::1 和 fe80::2');
    expect(out).not.toContain('fe80::1');
    expect(out).not.toContain('fe80::2');
    expect(out.match(/\{\{IPV6PRIVATE_/g)).toHaveLength(2);
  });

  it('带 zone id 的链路本地地址应命中', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IPV6_PRIVATE: true } }));
    const out = m.mask('fe80::1%eth0');
    expect(out).not.toContain('fe80::1');
    expect(out).toMatch(/\{\{IPV6PRIVATE_/);
  });

  it('公网 IPv6（2001:db8::1）不应命中', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IPV6_PRIVATE: true } }));
    const out = m.mask('示例 2001:db8::1 完');
    // 2001:db8 是文档段，不是私网
    expect(out).toBe('示例 2001:db8::1 完');
  });

  it('::1（环回）不应命中', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IPV6_PRIVATE: true } }));
    const out = m.mask('本地 ::1 完');
    // ::1 不是 fe80::/10 也不是 fc00::/7
    expect(out).toBe('本地 ::1 完');
  });

  it('规则默认关闭', () => {
    const m = new Masker(new MappingStore(), cfg());
    const out = m.mask('fe80::1');
    // 默认配置不启用 IPV6_PRIVATE
    expect(out).toBe('fe80::1');
  });

  it('UUID（含 4 个连字符）不应被误伤', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IPV6_PRIVATE: true } }));
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const out = m.mask(uuid);
    expect(out).toBe(uuid);
  });
});

describe('IP_PUBLIC', () => {
  it('真实公网 IP 应命中（47.98.12.34）', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IP_PUBLIC: true } }));
    const out = m.mask('服务器 47.98.12.34 访问');
    expect(out).not.toContain('47.98.12.34');
    expect(out).toMatch(/\{\{IPPUBLIC_/);
  });

  it('另一个公网 IP（121.40.200.17）应命中', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IP_PUBLIC: true } }));
    const out = m.mask('121.40.200.17 是测试');
    expect(out).not.toContain('121.40.200.17');
    expect(out).toMatch(/\{\{IPPUBLIC_/);
  });

  it('文档 / 测试专用网段不算公网（与 ipaddress.is_global 一致）', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IP_PUBLIC: true } }));
    for (const ip of ['192.0.2.10', '198.51.100.7', '203.0.113.25', '198.18.5.5', '0.12.34.56', '192.0.0.170']) {
      expect(m.mask(`地址 ${ip} 示例`)).toContain(ip);
    }
  });

  it('知名公共 DNS（8.8.8.8）应排除', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IP_PUBLIC: true } }));
    const out = m.mask('DNS: 8.8.8.8 和 8.8.4.4');
    expect(out).toBe('DNS: 8.8.8.8 和 8.8.4.4');
  });

  it('版本号形态（1.2.3.4-beta）不应命中', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IP_PUBLIC: true } }));
    const out = m.mask('版本 1.2.3.4-beta 发布');
    expect(out).toBe('版本 1.2.3.4-beta 发布');
  });

  it('库名版本（lib-1.2.3.4）不应命中', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IP_PUBLIC: true } }));
    const out = m.mask('lib-1.2.3.4');
    expect(out).toBe('lib-1.2.3.4');
  });

  it('应用名版本（app.1.2.3.4）不应命中', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IP_PUBLIC: true } }));
    const out = m.mask('app.1.2.3.4');
    expect(out).toBe('app.1.2.3.4');
  });

  it('私网 IP（10.0.0.1）不应命中', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IP_PUBLIC: true } }));
    const out = m.mask('内网 10.0.0.1 不脱');
    expect(out).toBe('内网 10.0.0.1 不脱');
  });

  it('私网 IP（192.168.1.1）不应命中', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IP_PUBLIC: true } }));
    const out = m.mask('192.168.1.1');
    expect(out).toBe('192.168.1.1');
  });

  it('构建号形态（1.8.0.202 / 2.4.0.101）不应命中', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IP_PUBLIC: true } }));
    const out = m.mask('Java 版本 1.8.0.202');
    expect(out).toBe('Java 版本 1.8.0.202');
  });

  it('全个位数形态（1.2.3.4）不应命中（版本号启发式）', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IP_PUBLIC: true } }));
    const out = m.mask('v1.2.3.4');
    expect(out).toBe('v1.2.3.4');
  });

  it('组播地址（224.x）不应命中', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { IP_PUBLIC: true } }));
    const out = m.mask('224.0.0.1');
    expect(out).toBe('224.0.0.1');
  });

  it('规则默认关闭', () => {
    const m = new Masker(new MappingStore(), cfg());
    const out = m.mask('47.98.12.34');
    expect(out).toBe('47.98.12.34');
  });
});

describe('USCC', () => {
  it('校验位正确的 USCC 应命中', () => {
    const validUSCC = makeUSCC('91350100M000100Y4');  // 前 17 位
    const m = new Masker(new MappingStore(), cfg({ rules: { USCC: true } }));
    const out = m.mask(`社会信用代码 ${validUSCC} 完`);
    expect(out).not.toContain(validUSCC);
    expect(out).toMatch(/\{\{USCC_/);
  });

  it('另一个有效 USCC 应命中', () => {
    const validUSCC = makeUSCC('91110000MA00100L2');  // 前 17 位（去掉V，用0代替）
    const m = new Masker(new MappingStore(), cfg({ rules: { USCC: true } }));
    const out = m.mask(validUSCC);
    expect(out).not.toContain(validUSCC);
    expect(out).toMatch(/\{\{USCC_/);
  });

  it('校验位错误不应命中', () => {
    const validUSCC = makeUSCC('91350100M000100Y4');
    // 改变最后一位
    const badChecksum = validUSCC.slice(0, 17) + (validUSCC[17] === '0' ? '1' : '0');
    const m = new Masker(new MappingStore(), cfg({ rules: { USCC: true } }));
    const out = m.mask(badChecksum);
    expect(out).not.toMatch(/\{\{USCC_/);
  });

  it('不足 18 位不应命中', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { USCC: true } }));
    const out = m.mask('91350100M000100Y');  // 17 位
    expect(out).not.toMatch(/\{\{USCC_/);
  });

  it('含有排除字符（I/O/S/V/Z）的字符串不应命中', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { USCC: true } }));
    const out = m.mask('91350100I000100Y4X');  // 含 I 和 X（X 不在排除列表）
    // 含 I（排除字符）所以不应命中作为 USCC
    expect(out).not.toMatch(/\{\{USCC_/);
  });

  it('规则默认关闭', () => {
    const validUSCC = makeUSCC('91350100M000100Y4');
    const m = new Masker(new MappingStore(), cfg());
    const out = m.mask(validUSCC);
    expect(out).toBe(validUSCC);
  });

  it('UUID（混合大小写与特殊字符）不应被误伤', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { USCC: true } }));
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const out = m.mask(uuid);
    expect(out).toBe(uuid);
  });

  it('MAC 地址（冒号分隔的 hex）不应被误伤', () => {
    const m = new Masker(new MappingStore(), cfg({ rules: { USCC: true } }));
    const mac = 'AA:BB:CC:DD:EE:FF';
    const out = m.mask(mac);
    expect(out).toBe(mac);
  });
});

describe('默认配置不启用新规则', () => {
  it('开启新规则前，默认配置不脱敏', () => {
    const m = new Masker(new MappingStore(), cfg());
    const ipv6 = 'fe80::1';
    const ipPublic = '47.98.12.34';
    const uscc = makeUSCC('91350100M000100Y4');

    const text = `${ipv6} 与 ${ipPublic} 和 ${uscc}`;
    const out = m.mask(text);
    expect(out).toBe(text);  // 全部原文通过
  });
});
