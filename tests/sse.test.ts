import { describe, expect, it } from 'vitest';
import { MappingStore, Restorer, SseRestorer } from '../electron/core';

const store = new MappingStore();
const EMAIL = store.tokenFor('alice@corp-x.com', 'EMAIL');
const PHONE = store.tokenFor('13800138000', 'PHONE');
const QUOTE = store.tokenFor('a"b', 'TERM');

const openai = (content: string, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null, ...extra }] })}\n\n`;
const anth = (type: string, payload: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
const textDelta = (index: number, text: string) => anth('content_block_delta', { index, delta: { type: 'text_delta', text } });

/** 一次性喂入并收尾 */
function run(stream: string): string {
  const s = new SseRestorer(new Restorer(store));
  return s.push(stream) + s.end();
}
/** 按给定切分分块喂入 */
function runChunks(stream: string, chunks: string[]): string {
  const s = new SseRestorer(new Restorer(store));
  let out = '';
  for (const c of chunks) out += s.push(c);
  return out + s.end();
}
/** 解析输出里所有 data 事件 */
function events(out: string): any[] {
  const res: any[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') continue;
      res.push(JSON.parse(d));
    }
  }
  return res;
}
const openaiText = (out: string) => events(out).map((e) => e.choices?.[0]?.delta?.content ?? '').join('');
const anthText = (out: string, key = 'text') => events(out).map((e) => e.delta?.[key] ?? '').join('');

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomSplit(s: string, seed: number): string[] {
  const rnd = mulberry32(seed);
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    const n = 1 + Math.floor(rnd() * 17);
    parts.push(s.slice(i, i + n));
    i += n;
  }
  return parts;
}

describe('OpenAI chat 流', () => {
  it('占位符跨两个事件被还原', () => {
    const stream = openai('邮箱 ' + EMAIL.slice(0, 6)) + openai(EMAIL.slice(6) + ' 完') + 'data: [DONE]\n\n';
    const out = run(stream);
    expect(openaiText(out)).toBe('邮箱 alice@corp-x.com 完');
    expect(out).not.toContain('{{');
    expect(out.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('结尾残留 {{ 在 [DONE] 前被吐出而不是丢失', () => {
    const out = run(openai('abc {{') + 'data: [DONE]\n\n');
    expect(openaiText(out)).toBe('abc {{');
    expect(out.indexOf('{{')).toBeLessThan(out.indexOf('[DONE]'));
  });

  it('残留在 finish_reason 事件上被吐出，合成事件不重复 finish_reason/usage', () => {
    const fin = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 3 } };
    const out = run(openai('abc {{') + `data: ${JSON.stringify(fin)}\n\n` + 'data: [DONE]\n\n');
    expect(openaiText(out)).toBe('abc {{');
    const evs = events(out);
    expect(evs.filter((e) => e.choices?.[0]?.finish_reason === 'stop')).toHaveLength(1);
    expect(evs.filter((e) => e.usage)).toHaveLength(1);
  });

  it('end() 兜底吐出残留（无 [DONE]）', () => {
    expect(openaiText(run(openai('abc {{')))).toBe('abc {{');
  });

  it('tool_calls.arguments 按 JSON 转义还原', () => {
    const mkTc = (args: string) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] })}\n\n`;
    const full = `{"q":"${QUOTE}"}`;
    const out = run(mkTc(full.slice(0, 9)) + mkTc(full.slice(9)) + 'data: [DONE]\n\n');
    const args = events(out).map((e) => e.choices[0].delta.tool_calls[0].function.arguments).join('');
    expect(JSON.parse(args)).toEqual({ q: 'a"b' });
  });

  it('CRLF 分隔符', () => {
    const stream = (openai('x ' + EMAIL.slice(0, 5)) + openai(EMAIL.slice(5))).replace(/\n\n/g, '\r\n\r\n');
    const out = run(stream);
    expect(openaiText(out)).toBe('x alice@corp-x.com');
    expect(out).toContain('\r\n\r\n');
  });

  it('非 JSON 的 data 行与注释行原样透传', () => {
    const stream = ': keep-alive\n\ndata: not json\n\n';
    expect(run(stream)).toBe(stream);
  });
});

describe('Anthropic 流', () => {
  it('text_delta 拆分 + content_block_stop', () => {
    const stream = anth('message_start', { message: { id: 'm' } })
      + anth('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      + textDelta(0, '你好 ' + PHONE.slice(0, 7)) + textDelta(0, PHONE.slice(7) + '!')
      + anth('content_block_stop', { index: 0 })
      + anth('message_stop', {});
    expect(anthText(run(stream))).toBe('你好 13800138000!');
  });

  it('content_block_stop 时吐出残留 {{，且位于 stop 之前', () => {
    const stream = textDelta(0, 'abc {{') + anth('content_block_stop', { index: 0 }) + anth('message_stop', {});
    const out = run(stream);
    expect(anthText(out)).toBe('abc {{');
    expect(out.indexOf('{{')).toBeLessThan(out.indexOf('content_block_stop'));
  });

  it('thinking_delta / signature_delta 不还原', () => {
    const think = (t: string) => anth('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: t } });
    const stream = think(`想 ${EMAIL}`)
      + anth('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: EMAIL } })
      + anth('content_block_stop', { index: 0 });
    expect(run(stream)).toBe(stream);
  });

  it('partial_json 按 JSON 转义还原', () => {
    const pj = (s: string) => anth('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: s } });
    const full = `{"k":"${QUOTE}"}`;
    const out = run(pj(full.slice(0, 8)) + pj(full.slice(8)) + anth('content_block_stop', { index: 1 }));
    expect(JSON.parse(anthText(out, 'partial_json'))).toEqual({ k: 'a"b' });
  });

  it('不同 content block 通道互不串扰', () => {
    const stream = textDelta(0, 'a {{') + textDelta(1, 'b')
      + anth('content_block_stop', { index: 0 }) + anth('content_block_stop', { index: 1 });
    const texts = events(run(stream)).filter((e) => e.type === 'content_block_delta');
    expect(texts.filter((e) => e.index === 0).map((e) => e.delta.text).join('')).toBe('a {{');
    expect(texts.filter((e) => e.index === 1).map((e) => e.delta.text).join('')).toBe('b');
  });
});

describe('OpenAI Responses 流', () => {
  it('output_text.delta 拆分 + done 时 flush', () => {
    const d = (t: string) => anth('response.output_text.delta', { output_index: 0, content_index: 0, delta: t });
    const done = anth('response.output_text.done', { output_index: 0, content_index: 0, text: '' });
    const out = run(d('x ' + EMAIL.slice(0, 4)) + d(EMAIL.slice(4) + ' {{') + done);
    const text = events(out).filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
    expect(text).toBe('x alice@corp-x.com {{');
  });
});

describe('任意分块边界', () => {
  const stream = 'data: ' + JSON.stringify({ id: 'a' }) + '\n\n'
    + openai('邮箱 ' + EMAIL.slice(0, 3)) + openai(EMAIL.slice(3, 9)) + openai(EMAIL.slice(9) + ' 电话 ' + PHONE)
    + openai('，引号 ' + QUOTE.slice(0, 5)) + openai(QUOTE.slice(5) + ' 末尾 {{') + 'data: [DONE]\n\n';
  const expected = '邮箱 alice@corp-x.com 电话 13800138000，引号 a"b 末尾 {{';

  it('基准：整块喂入', () => {
    expect(openaiText(run(stream))).toBe(expected);
  });

  it.each([1, 2, 3, 7, 42, 1234, 99999])('随机切块 seed=%i（含切在 SSE 行中间）', (seed) => {
    const out = runChunks(stream, randomSplit(stream, seed));
    expect(openaiText(out)).toBe(expected);
    expect(out.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('逐字符喂入', () => {
    expect(openaiText(runChunks(stream, [...stream]))).toBe(expected);
  });

  it('Anthropic 随机切块', () => {
    const a = anth('message_start', { message: {} })
      + textDelta(0, '甲 ' + EMAIL.slice(0, 4)) + textDelta(0, EMAIL.slice(4) + ' 乙 {{')
      + anth('content_block_stop', { index: 0 }) + anth('message_stop', {});
    for (const seed of [5, 6, 7, 8]) {
      expect(anthText(runChunks(a, randomSplit(a, seed)))).toBe('甲 alice@corp-x.com 乙 {{');
    }
  });
});
