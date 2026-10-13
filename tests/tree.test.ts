import { describe, expect, it } from 'vitest';
import { Masker, MappingStore, maskJson } from '../electron/core';

const mk = () => new Masker(new MappingStore());
const PHONE = '13800138000';
const run = (body: unknown) => maskJson(mk(), body);

describe('maskJson', () => {
  it('OpenAI chat：role/model 不动，content 脱敏', () => {
    const r = run({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: `我的手机 ${PHONE}` },
      ],
    }) as { body: any; changed: boolean };
    expect(r.changed).toBe(true);
    expect(r.body.model).toBe('gpt-4o');
    expect(r.body.messages[0].role).toBe('system');
    expect(r.body.messages[1].role).toBe('user');
    expect(r.body.messages[1].content).not.toContain(PHONE);
    expect(r.body.messages[1].content).toMatch(/\{\{PHONE_/);
  });

  it('tool_calls.arguments 脱敏，tool_call_id 不动', () => {
    const r = run({
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1', type: 'function',
            function: { name: 'send', arguments: JSON.stringify({ to: 'bob@corp-x.com' }) },
          }],
        },
        { role: 'tool', tool_call_id: 'call_abc13800138000x', content: 'ok' },
      ],
    }).body as any;
    const args = r.messages[0].tool_calls[0].function.arguments as string;
    expect(args).not.toContain('bob@corp-x.com');
    expect(args).toMatch(/EMAIL_/);
    expect(r.messages[0].tool_calls[0].function.name).toBe('send');
    expect(r.messages[0].tool_calls[0].id).toBe('call_1');
    expect(r.messages[1].tool_call_id).toBe('call_abc13800138000x');
  });

  it('Anthropic thinking 块（含 signature）整块不动', () => {
    const thinking = { type: 'thinking', thinking: `用户手机 ${PHONE}`, signature: 'sig-' + PHONE };
    const r = run({
      messages: [{ role: 'assistant', content: [thinking, { type: 'text', text: `号码 ${PHONE}` }] }],
    });
    const content = (r.body as any).messages[0].content;
    expect(content[0]).toEqual(thinking);
    expect(content[1].text).not.toContain(PHONE);
    expect(r.signedBlocksSkipped).toBe(1);
  });

  it('cache_control 子树不动', () => {
    const cc = { type: 'ephemeral', note: PHONE };
    const r = run({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: cc }] }] });
    expect((r.body as any).messages[0].content[0].cache_control).toEqual(cc);
    expect(r.changed).toBe(false);
  });

  it('工具 input 里的数值型手机号被脱敏', () => {
    const r = run({
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'call', input: { phone: 13800138000 } }],
      }],
    });
    const blk = (r.body as any).messages[0].content[0];
    expect(typeof blk.input.phone).toBe('string');
    expect(blk.input.phone).toMatch(/^\{\{PHONE_/);
    expect(blk.id).toBe('toolu_1');
    expect(r.changed).toBe(true);
  });

  it('业务区外的 max_tokens 等数值不动', () => {
    const r = run({ max_tokens: 13800138000, temperature: 0.5, messages: [] });
    expect((r.body as any).max_tokens).toBe(13800138000);
    expect(r.changed).toBe(false);
  });

  it('无命中 changed=false 且内容等价', () => {
    const body = { model: 'm', messages: [{ role: 'user', content: 'hello world' }] };
    const r = run(body);
    expect(r.changed).toBe(false);
    expect(r.body).toEqual(body);
    expect(r.hits).toEqual([]);
  });

  it('hits 返回标签与占位符', () => {
    const r = run({ messages: [{ role: 'user', content: `${PHONE} ${PHONE}` }] });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].label).toBe('PHONE');
    expect(r.hits[0].orig).toBe(PHONE);
  });

  it('深度超过 24 抛错（fail-closed）', () => {
    let deep: any = 'x';
    for (let i = 0; i < 30; i++) deep = { a: deep };
    expect(() => run(deep)).toThrow('json_depth_exceeded');
  });

  it('深度恰为边界内不抛错', () => {
    let deep: any = 'x';
    for (let i = 0; i < 20; i++) deep = { a: deep };
    expect(() => run(deep)).not.toThrow();
  });
});

describe('多协议媒体字段豁免', () => {
  it('Gemini inlineData / Ollama images 的 base64 不被规则改写，正文照常脱敏', () => {
    const masker = new Masker(new MappingStore());
    // 一段恰好含 Luhn 合法 16 位数字的「base64」
    const b64 = 'iVBOR+4111111111111111/AAAA';
    // 前提：这串数据单独扫描时确实会被卡号规则命中，豁免才有意义
    expect(masker.mask(b64)).not.toBe(b64);
    const gemini = { contents: [{ role: 'user', parts: [{ text: '电话 13800138000' }, { inlineData: { mimeType: 'image/png', data: b64 } }] }] };
    const g = maskJson(masker, gemini).body as typeof gemini;
    expect((g.contents[0].parts[1] as { inlineData: { data: string } }).inlineData.data).toBe(b64);
    expect((g.contents[0].parts[0] as { text: string }).text).not.toContain('13800138000');
    const ollama = { model: 'llama3', messages: [{ role: 'user', content: '电话 13800138000', images: [b64] }] };
    const o = maskJson(masker, ollama).body as typeof ollama;
    expect(o.messages[0].images[0]).toBe(b64);
    expect(o.messages[0].content).not.toContain('13800138000');
  });
});
