import { describe, expect, it } from 'vitest';
import { MappingStore, Restorer } from '../electron/core';

function setup() {
  const store = new MappingStore();
  const email = store.tokenFor('alice@example.com', 'EMAIL');
  const secret = store.tokenFor('sk-secret-key', 'SECRET');
  const connstr = store.tokenFor('Server=localhost;', 'CONNSTR');
  const ipPrivate = store.tokenFor('192.168.1.1', 'IP_PRIVATE');
  const ipInternal = store.tokenFor('10.0.0.1', 'IP_INTERNAL');
  return { store, email, secret, connstr, ipPrivate, ipInternal, r: new Restorer(store) };
}

describe('标签兼容性回退', () => {
  it('凭证族兼容回退（SECRET → CONNSTR）', () => {
    const { store, connstr } = setup();
    const orig = connstr.slice(2, -2); // 提取 CONNSTR_suffix
    const modifiedToken = `{{SECRET_${orig.split('_')[1]}}}`; // 改标签为 SECRET
    expect(store.lookup(modifiedToken)).toBe('Server=localhost;');
  });

  it('IP 族兼容回退（IP_PRIVATE → IP_INTERNAL）', () => {
    const { store, ipInternal } = setup();
    const orig = ipInternal.slice(2, -2);
    const modifiedToken = `{{IP_${orig.split('_')[1]}}}`; // 改标签为 IP
    expect(store.lookup(modifiedToken)).toBe('10.0.0.1');
  });

  it('标签不兼容时不回退', () => {
    const { store, email } = setup();
    const orig = email.slice(2, -2);
    const modifiedToken = `{{PHONE_${orig.split('_')[1]}}}`; // EMAIL 和 PHONE 不兼容
    expect(store.lookup(modifiedToken)).toBeUndefined();
  });

  it('restore 统计兼容回退为 degraded', () => {
    const { store, connstr } = setup();
    const r = new Restorer(store);
    const orig = connstr.slice(2, -2);
    const modifiedToken = `{{SECRET_${orig.split('_')[1]}}}`;
    const result = r.restore(`token: ${modifiedToken}`, '', false, true);
    expect(result).toBe('token: Server=localhost;');
    expect(r.stats.restored).toBe(1);
    expect(r.stats.degraded).toBe(1);
  });
});

describe('转义大括号形式', () => {
  it('单反斜杠转义：\\{\\{EMAIL_xxx\\}\\}', () => {
    const { r, email } = setup();
    const suffix = email.slice(-8, -2);
    const escaped = `\\{\\{EMAIL_${suffix}\\}\\}`;
    const result = r.restore(`addr: ${escaped}`, '', false, true);
    expect(result).toBe('addr: alice@example.com');
    expect(r.stats.restored).toBe(1);
    expect(r.stats.degraded).toBe(1);
  });

  it('双反斜杠转义：\\\\{\\\\{EMAIL_xxx\\\\}\\\\}', () => {
    const { r, email } = setup();
    const suffix = email.slice(-8, -2);
    const escaped = `\\\\{\\\\{EMAIL_${suffix}\\\\}\\\\}`;
    const result = r.restore(`addr: ${escaped}`, '', false, true);
    expect(result).toBe('addr: alice@example.com');
    expect(r.stats.restored).toBe(1);
    expect(r.stats.degraded).toBe(1);
  });

  it('转义形式无反斜杠时不匹配（纯双括号由 BRACED 处理）', () => {
    const { r, email } = setup();
    const result = r.restore(email, '', false, true);
    expect(result).toBe('alice@example.com');
    expect(r.stats.restored).toBe(1);
    expect(r.stats.degraded).toBe(0); // 精确匹配，不计 degraded
  });

  it('escape=true 对转义形式应用 JSON 转义', () => {
    const store = new MappingStore();
    const tok = store.tokenFor('line1\nline2', 'TERM');
    const r = new Restorer(store);
    const suffix = tok.slice(-8, -2);
    const escaped = `\\{\\{TERM_${suffix}\\}\\}`;
    const result = r.restore(`{"text":"${escaped}"}`, '', true, true);
    expect(JSON.parse(result)).toEqual({ text: 'line1\nline2' });
  });

  it('转义形式查不到占位符时计 unresolved', () => {
    const { r } = setup();
    const escaped = '\\{\\{UNKNOWN_bcdfgh\\}\\}';
    const result = r.restore(`x ${escaped} y`, '', false, true);
    expect(result).toBe(`x ${escaped} y`);
    expect(r.stats.unresolved).toBe(1);
  });
});

describe('单/半大括号形式', () => {
  it('单括号形式：{EMAIL_xxx}', () => {
    const { r, email } = setup();
    const suffix = email.slice(-8, -2);
    const single = `{EMAIL_${suffix}}`;
    const result = r.restore(`addr: ${single}`, '', false, true);
    expect(result).toBe('addr: alice@example.com');
    expect(r.stats.restored).toBe(1);
    expect(r.stats.degraded).toBe(1);
  });

  it('左半括号形式：{{EMAIL_xxx}', () => {
    const { r, email } = setup();
    const suffix = email.slice(-8, -2);
    const left = `{{EMAIL_${suffix}}`;
    const result = r.restore(`addr: ${left}`, '', false, true);
    expect(result).toBe('addr: alice@example.com');
    expect(r.stats.restored).toBe(1);
    expect(r.stats.degraded).toBe(1);
  });

  it('右半括号形式：{EMAIL_xxx}}', () => {
    const { r, email } = setup();
    const suffix = email.slice(-8, -2);
    const right = `{EMAIL_${suffix}}}`;
    const result = r.restore(`addr: ${right}`, '', false, true);
    expect(result).toBe('addr: alice@example.com');
    expect(r.stats.restored).toBe(1);
    expect(r.stats.degraded).toBe(1);
  });

  it('单/半大括号形式包含空白', () => {
    const { r, email } = setup();
    const suffix = email.slice(-8, -2);
    const withSpace = `{ EMAIL_${suffix} }`;
    const result = r.restore(`addr: ${withSpace}`, '', false, true);
    expect(result).toBe('addr: alice@example.com');
    expect(r.stats.restored).toBe(1);
    expect(r.stats.degraded).toBe(1);
  });

  it('单/半大括号形式查不到时原样保留，不计 unresolved', () => {
    const { r } = setup();
    const single = '{UNKNOWN_bcdfgh}';
    const result = r.restore(`addr: ${single}`, '', false, true);
    expect(result).toBe(`addr: ${single}`);
    expect(r.stats.unresolved).toBe(0); // 单/半括号不算 unresolved
    expect(r.stats.restored).toBe(0);
  });

  it('单/半大括号形式可能被误识别为其他语法（如 C 代码）', () => {
    const { r } = setup();
    const codeSnippet = 'func({int x}) { return x; }';
    const result = r.restore(codeSnippet, '', false, true);
    // 这里 {int x} 不是有效的占位符，应该原样保留
    expect(result).toContain('int x');
  });
});

describe('裸形式 + 标签兼容', () => {
  it('裸形式仅在标签匹配或兼容时还原', () => {
    const { r, secret } = setup();
    const bare = secret.slice(2, -2); // SECRET_xxx
    expect(r.restore(`x ${bare} y`, '', false, true)).toBe('x sk-secret-key y');
    expect(r.stats.restored).toBe(1);
    expect(r.stats.degraded).toBe(1); // 裸形式计为 degraded
  });

  it('裸形式标签不兼容时不还原', () => {
    const { r, email } = setup();
    const suffix = email.slice(-8, -2);
    const bare = `PHONE_${suffix}`; // EMAIL 和 PHONE 不兼容
    const result = r.restore(`x ${bare} y`, '', false, true);
    expect(result).toBe(`x ${bare} y`);
    expect(r.stats.restored).toBe(0);
  });
});

describe('原始值看起来像占位符时不双重还原', () => {
  it('原始值是 {placeholder} 格式时不被再次还原', () => {
    const store = new MappingStore();
    // 原始值本身看起来像个占位符
    const tok = store.tokenFor('{NESTED_bcdfgh}', 'TERM');
    const r = new Restorer(store);
    const result = r.restore(tok, '', false, true);
    // 应该还原成原始值 {NESTED_bcdfgh}，不应该尝试再次还原它
    expect(result).toBe('{NESTED_bcdfgh}');
    expect(r.stats.restored).toBe(1);
  });

  it('原始值中有 EMAIL_xxx 格式时不被还原', () => {
    const store = new MappingStore();
    const phoneNum = store.tokenFor('13800138000', 'PHONE');
    const tok = store.tokenFor(`号码是 EMAIL_${phoneNum.slice(-8, -2)}`, 'TERM');
    const r = new Restorer(store);
    const result = r.restore(tok, '', false, true);
    expect(result).toContain('EMAIL_');
    // 这里 EMAIL_ 是原始值的一部分，不应该被视为待还原的占位符
  });
});

describe('流式处理转义形式在 chunk 边界', () => {
  it('转义占位符在任意位置切割都能正确还原', () => {
    const { store, email } = setup();
    const suffix = email.slice(-8, -2);
    const escaped = `\\{\\{EMAIL_${suffix}\\}\\}`;
    const text = `地址: ${escaped}`;
    const expected = new Restorer(store).restore(text, '', false, true);

    for (let i = 0; i <= text.length; i++) {
      const r = new Restorer(store);
      const out = r.restore(text.slice(0, i), 'c') + r.restore(text.slice(i), 'c') + r.flush('c');
      expect(out, `split@${i}`).toBe(expected);
    }
  });

  it('双反斜杠转义占位符在 chunk 边界切割', () => {
    const { store, email } = setup();
    const suffix = email.slice(-8, -2);
    const escaped = `\\\\{\\\\{EMAIL_${suffix}\\\\}\\\\}`;
    const text = `地址: ${escaped}`;
    const expected = new Restorer(store).restore(text, '', false, true);

    for (let i = 0; i <= text.length; i++) {
      const r = new Restorer(store);
      const out = r.restore(text.slice(0, i), 'c') + r.restore(text.slice(i), 'c') + r.flush('c');
      expect(out, `split@${i}`).toBe(expected);
    }
  });
});

describe('替换顺序与不重复', () => {
  it('有括号 → 转义 → 单半括号 → 裸，顺序不变', () => {
    const store = new MappingStore();
    const email = store.tokenFor('test@example.com', 'EMAIL');
    const suffix = email.slice(-8, -2);

    const r = new Restorer(store);
    // 一个文本中混合多种形式
    const text = `{{ EMAIL_${suffix} }} and \\{\\{EMAIL_${suffix}\\}\\} and {EMAIL_${suffix}} and EMAIL_${suffix}`;
    const result = r.restore(text, '', false, true);

    // 4 种形式都应该被还原
    expect(result).not.toContain('EMAIL_');
    expect(result).toContain('test@example.com');
    expect((result.match(/test@example.com/g) || []).length).toBe(4);
    expect(r.stats.restored).toBe(4);
  });

  it('已替换的原始值不被二次还原', () => {
    const store = new MappingStore();
    // 创建一个包含占位符格式的原始值
    const placeholder = store.tokenFor('EMAIL_abcdef', 'TERM');
    const r = new Restorer(store);
    // 这个占位符的原始值是 EMAIL_abcdef
    const result = r.restore(placeholder, '', false, true);
    expect(result).toBe('EMAIL_abcdef');
    expect(r.stats.restored).toBe(1); // 只还原一次
  });
});

describe('degraded 计数器细节', () => {
  it('degraded 包括：转义 + 半括号 + 裸 + 兼容回退', () => {
    const { store, email, connstr } = setup();
    const r = new Restorer(store);

    const emailSuffix = email.slice(-8, -2);
    const connSuffix = connstr.slice(-8, -2);
    const connLabel = connstr.slice(2, -2).split('_')[0];

    const text = [
      `1. 有括号精确: {{EMAIL_${emailSuffix}}}`,
      `2. 转义: \\{\\{EMAIL_${emailSuffix}\\}\\}`,
      `3. 半括号: {EMAIL_${emailSuffix}}`,
      `4. 裸形式: EMAIL_${emailSuffix}`,
      `5. 兼容回退: {{SECRET_${connSuffix}}}`, // CONNSTR 存储，SECRET 查询
    ].join('; ');

    const result = r.restore(text, '', false, true);
    expect(r.stats.restored).toBe(5);
    // degraded 应该包括：转义(1) + 半括号(1) + 裸(1) + 兼容回退(1) = 4
    // 有括号精确不计 degraded
    expect(r.stats.degraded).toBe(4);
  });

  it('与签发 token 不逐字一致（内部空白、小写标签、标签补下划线）都计 degraded', () => {
    const { store, connstr } = setup();
    const suffix = connstr.slice(-8, -2);
    for (const form of [`{{ CONNSTR_${suffix} }}`, `{{connstr_${suffix}}}`, `{{CONN_STR_${suffix}}}`]) {
      const r = new Restorer(store);
      expect(r.restore(form, '', false, true)).not.toBe(form);
      expect(r.stats).toMatchObject({ restored: 1, degraded: 1, unresolved: 0 });
    }
  });
});

describe('单遍还原', () => {
  it('原文恰好是占位符形态时不会被二次还原', () => {
    const store = new MappingStore();
    const inner = store.tokenFor('13800138000', 'PHONE');
    // 一个自定义词的原文本身长得像另一个已签发占位符的裸形态
    const outer = store.tokenFor(inner.slice(2, -2), 'TERM', true);
    const r = new Restorer(store);
    expect(r.restore(outer, '', false, true)).toBe(inner.slice(2, -2));
    expect(r.stats.restored).toBe(1);
  });

  it('模型给标签补回下划线（{{API_KEY_x}}）仍能按凭据族还原', () => {
    const store = new MappingStore();
    const tok = store.tokenFor('sk-proj-abcdefgh12345678', 'API_KEY');
    const r = new Restorer(store);
    expect(r.restore(`{{API_KEY_${tok.slice(-8, -2)}}}`, '', false, true)).toBe('sk-proj-abcdefgh12345678');
  });
});
