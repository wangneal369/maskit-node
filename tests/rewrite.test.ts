import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MASK_CONFIG, Masker, MappingStore, deepEqual, hasDuplicateKeys, maskBody, maskJson, maskRequestText,
} from '../electron/core';

const PHONE = '13800138000';
const mk = (words: string[] = []) =>
  new Masker(new MappingStore(), { ...DEFAULT_MASK_CONFIG, customWords: words.map((word) => ({ word })) });

describe('hasDuplicateKeys', () => {
  it('同层重复键', () => {
    expect(hasDuplicateKeys('{"a":1,"a":2}')).toBe(true);
  });
  it('嵌套对象内重复键 / 数组内对象重复键', () => {
    expect(hasDuplicateKeys('{"x":{"y":1,"z":2,"y":3}}')).toBe(true);
    expect(hasDuplicateKeys('{"x":[{"k":1},{"k":2,"k":3}]}')).toBe(true);
  });
  it('转义写法按解码值比较：a 与 \\u0061', () => {
    expect(hasDuplicateKeys('{"a":1,"\\u0061":2}')).toBe(true);
    expect(hasDuplicateKeys('{"\\u5f20":1,"张":2}')).toBe(true);
  });
  it('不同层 / 不同对象的同名键不算重复', () => {
    expect(hasDuplicateKeys('{"a":{"a":1},"b":[{"a":1},{"a":2}]}')).toBe(false);
    expect(hasDuplicateKeys('{"messages":[{"role":"user","content":"x"},{"role":"assistant","content":"y"}]}')).toBe(false);
  });
  it('值里出现 "a": 字样不干扰扫描', () => {
    expect(hasDuplicateKeys('{"a":"he said \\"a\\":1, \\"a\\":2","b":"{\\"a\\":1,\\"a\\":2}"}')).toBe(false);
    expect(hasDuplicateKeys('{"a":"x","b":"a","a":"y"}')).toBe(true);
  });
  it('非法 JSON 不抛错返回 false', () => {
    expect(hasDuplicateKeys('{"a":1,"a')).toBe(false);
    expect(hasDuplicateKeys('hello world')).toBe(false);
    expect(hasDuplicateKeys('')).toBe(false);
    expect(hasDuplicateKeys('{"\\uZZZZ":1,"\\uZZZZ":2}')).toBe(false);
  });
});

describe('deepEqual', () => {
  it('键序无关、数组有序、类型严格', () => {
    expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: 1 }, { a: '1' })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: undefined }, { b: undefined })).toBe(false);
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});

describe('maskRequestText：重复键', () => {
  it('被覆盖的值不明文上行，走 reserialize', () => {
    const raw = `{"a":"${PHONE}","a":"safe"}`;
    const r = maskRequestText(mk(), raw);
    expect(r.text).not.toContain(PHONE);
    expect(r.method).toBe('reserialize');
    expect(r.changed).toBe(true);
  });
  it('嵌套重复键同样拦住', () => {
    const raw = `{"messages":[{"role":"user","content":"${PHONE}","content":"hi"}]}`;
    const r = maskRequestText(mk(), raw);
    expect(r.text).not.toContain(PHONE);
    expect(r.method).toBe('reserialize');
  });
  it('\\u0061 与 a 重复', () => {
    const raw = `{"a":"${PHONE}","\\u0061":"safe"}`;
    const r = maskRequestText(mk(), raw);
    expect(r.text).not.toContain(PHONE);
    expect(r.method).toBe('reserialize');
  });
  it('重复键且其它字段命中：不 splice', () => {
    const raw = `{"a":"${PHONE}","a":"safe","b":"13900139000"}`;
    const r = maskRequestText(mk(), raw);
    expect(r.text).not.toContain(PHONE);
    expect(r.text).not.toContain('13900139000');
    expect(r.method).toBe('reserialize');
  });
  it('无重复键的正常体不受影响', () => {
    const raw = '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}';
    const r = maskRequestText(mk(), raw);
    expect(r.method).toBe('unchanged');
    expect(r.text).toBe(raw);
  });
});

describe('maskRequestText：就地替换', () => {
  const body = (third: string) => `{
  "model": "gpt-4o",
  "temperature": 1e-05,
  "messages": [
    { "role": "user", "content": "你好" },
    { "role": "assistant", "content": "您好，请问有什么可以帮您？" },
    { "role": "user", "content": "${third}" }
  ]
}`;

  it('保留排版，仅在手机号位置有差异', () => {
    const raw = body(`我的手机是 ${PHONE}，谢谢`);
    const masker = mk();
    const r = maskRequestText(masker, raw);
    expect(r.method).toBe('splice');
    const at = raw.indexOf(PHONE);
    expect(r.text.slice(0, at)).toBe(raw.slice(0, at));
    expect(r.text).not.toContain(PHONE);
    // 数字字面量保持原样
    expect(r.text).toContain('"temperature": 1e-05');
    // 后缀同样保真
    expect(r.text.endsWith('，谢谢" }\n  ]\n}')).toBe(true);
    // 与整棵脱敏树等价
    const tree = maskJson(masker, JSON.parse(raw)).body;
    expect(deepEqual(JSON.parse(r.text), tree)).toBe(true);
    // 对比：整棵序列化会在 "model": 处就改了
    expect(JSON.stringify(tree).slice(0, 9)).not.toBe(raw.slice(0, 9));
  });

  it('\\u 转义的自定义词按转义形式替换', () => {
    const raw = '{"model":"m","messages":[{"role":"user","content":"\\u5f20\\u4e09\\u8bf4\\u8bdd"}]}';
    const r = maskRequestText(mk(['张三']), raw);
    expect(r.method).toBe('splice');
    expect(r.text).not.toContain('\\u5f20');
    expect(r.text).toMatch(/"content":"\{\{[A-Za-z_0-9]+\}\}\\u8bf4\\u8bdd"/);
    expect(JSON.parse(r.text).messages[0].content).not.toContain('张三');
  });

  it('大写十六进制转义也能替换', () => {
    const raw = '{"messages":[{"role":"user","content":"\\u5F20\\u4E09"}]}';
    const r = maskRequestText(mk(['张三']), raw);
    expect(r.text).not.toContain('5F20');
    expect(JSON.parse(r.text).messages[0].content).toMatch(/^\{\{/);
  });

  it('raw 字符形式的自定义词与 astral 字符', () => {
    const raw = '{"messages":[{"role":"user","content":"张三 \\ud83d\\ude00 你好"}]}';
    const r = maskRequestText(mk(['张三']), raw);
    expect(r.method).toBe('splice');
    expect(r.text).toContain('\\ud83d\\ude00');
    expect(r.text).not.toContain('张三');
  });

  it('短原文是长原文子串：长的优先不被切碎', () => {
    const raw = '{"messages":[{"role":"user","content":"张三丰 和 张三"}]}';
    const masker = mk(['张三', '张三丰']);
    const r = maskRequestText(masker, raw);
    const tree = maskJson(masker, JSON.parse(raw)).body;
    expect(deepEqual(JSON.parse(r.text), tree)).toBe(true);
    expect(r.text).not.toContain('张三');
  });

  it('数值型 PII：退回整棵序列化但仍脱敏', () => {
    const raw = `{"messages":[{"role":"user","content":"hi"}],"user":{"phone": ${PHONE}}}`;
    const r = maskRequestText(mk(), raw);
    expect(r.method).toBe('reserialize');
    expect(r.text).not.toContain(PHONE);
    expect(JSON.parse(r.text).user.phone).toMatch(/^\{\{PHONE_/);
  });

  it('数值型 PII 与字符串 PII 同时存在：校验拦下，不产出非法/明文体', () => {
    const raw = `{"messages":[{"role":"user","content":"${PHONE}"}],"user":{"phone": 13900139000}}`;
    const r = maskRequestText(mk(), raw);
    expect(r.method).toBe('reserialize');
    expect(r.text).not.toContain(PHONE);
    expect(r.text).not.toContain('13900139000');
    expect(() => JSON.parse(r.text)).not.toThrow();
  });

  it('业务区键名脱敏：结果必须正确（无明文、与脱敏树等价）', () => {
    const raw = `{"messages":[{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"f","arguments":"{}"}}]}],"tools":[{"input":{"${PHONE}":"v"}}]}`;
    const masker = mk();
    const r = maskRequestText(masker, raw);
    expect(r.text).not.toContain(PHONE);
    const tree = maskJson(masker, JSON.parse(raw)).body;
    expect(deepEqual(JSON.parse(r.text), tree)).toBe(true);
  });

  it('超过 128 个替换形式：退回整棵序列化', () => {
    const phones = Array.from({ length: 150 }, (_, i) => `1380013${String(1000 + i)}`);
    const raw = JSON.stringify({ messages: phones.map((p) => ({ role: 'user', content: `号码 ${p}` })) }, null, 2);
    const r = maskRequestText(mk(), raw);
    expect(r.hits.length).toBeGreaterThan(128);
    expect(r.method).toBe('reserialize');
    for (const p of phones) expect(r.text).not.toContain(p);
  });

  it('少量不同原文且重复出现：全部替换', () => {
    const raw = `{"messages": [{"role":"user","content":"${PHONE}"}, {"role":"user","content":"再说一遍 ${PHONE}"}]}`;
    const r = maskRequestText(mk(), raw);
    expect(r.method).toBe('splice');
    expect(r.text).not.toContain(PHONE);
    expect(r.text.startsWith('{"messages": [{"role":"user","content":"')).toBe(true);
  });

  it('无命中：unchanged 且 text 即原串', () => {
    const raw = body('没有敏感信息');
    const r = maskRequestText(mk(), raw);
    expect(r.method).toBe('unchanged');
    expect(r.changed).toBe(false);
    expect(r.text).toBe(raw);
  });

  it('非 JSON 文本整段扫描', () => {
    const r = maskRequestText(mk(), `call ${PHONE} now`);
    expect(r.text).not.toContain(PHONE);
    expect(r.changed).toBe(true);
  });
});

describe('maskBody（扩展链路）', () => {
  it('仍返回脱敏文本，且保留排版', () => {
    const raw = `{"messages": [{"role": "user", "content": "手机 ${PHONE}"}]}`;
    const r = maskBody(mk(), raw);
    expect(r.text).not.toContain(PHONE);
    expect(r.text.startsWith('{"messages": [{"role": "user", "content": "手机 ')).toBe(true);
    expect(r.hits.length).toBe(1);
  });
  it('重复键同样拦住', () => {
    const r = maskBody(mk(), `{"a":"${PHONE}","a":"safe"}`);
    expect(r.text).not.toContain(PHONE);
  });
  it('零命中原样返回', () => {
    const raw = '{"a": 1}';
    expect(maskBody(mk(), raw).text).toBe(raw);
  });
});
