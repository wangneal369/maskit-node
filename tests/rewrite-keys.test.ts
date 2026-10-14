import { describe, expect, it } from 'vitest';
import { Masker } from '../electron/core/masker';
import { MappingStore } from '../electron/core/store';
import { maskRequestText } from '../electron/core/rewrite';

/**
 * 回归：OpenAI Responses 请求体顶层 input 是整段对话（协议骨架），不是工具参数。
 * 现场：NER 把 "su" 识别成人名，reasoning 项的 "summary" 键被改成 "{{NAME_xxxxxx}}mmary"，上游 400 unknown_parameter；
 * 就地替换的等价校验也没拦住（脱敏树本身就改了键名，两边一致）。
 */
describe('Responses 顶层 input 按协议骨架处理', () => {
  const body = {
    model: 'gpt-x',
    input: [
      { type: 'message', role: 'user', id: 'msg_su', content: [{ type: 'input_text', text: '请联系 su 处理' }] },
      { type: 'reasoning', id: 'rs_su', summary: [{ type: 'summary_text', text: 'su 的需求' }], encrypted_content: 'gAAAA_su' },
      { type: 'function_call', call_id: 'call_su', name: 'lookup_su', arguments: '{"su_id":"su"}' },
      { type: 'function_call_output', call_id: 'call_su', output: '结果：su' },
    ],
  };
  const NAME = /\{\{NAME_[a-z]{6}\}\}/;

  for (const [style, raw] of [
    ['紧凑', JSON.stringify(body)],
    ['带空格', JSON.stringify(body, null, 1)],
  ] as const) {
    it(`实体是键名 / 协议值的子串时不改协议骨架（${style}）`, () => {
      const masker = new Masker(new MappingStore());
      const r = maskRequestText(masker, raw, { entities: new Map([['su', 'NAME']]) });
      const out = JSON.parse(r.text);
      const [msg, reasoning, call, result] = out.input;

      expect(Object.keys(reasoning)).toEqual(['type', 'id', 'summary', 'encrypted_content']);
      expect(reasoning.id).toBe('rs_su');
      expect(reasoning.encrypted_content).toBe('gAAAA_su');
      expect(reasoning.summary[0].type).toBe('summary_text');
      expect(msg.id).toBe('msg_su');
      expect(msg.role).toBe('user');
      expect(call.name).toBe('lookup_su');
      expect(call.call_id).toBe('call_su');

      // 正文照常脱敏
      expect(msg.content[0].text).toMatch(new RegExp(`^请联系 ${NAME.source} 处理$`));
      expect(reasoning.summary[0].text).toMatch(NAME);
      expect(result.output).toMatch(NAME);
      // 工具参数仍是业务区：字符串参数里的值照常脱敏
      expect(call.arguments).toMatch(NAME);
    });
  }

  it('拉丁字母实体按整词匹配，中文实体仍按子串', () => {
    const masker = new Masker(new MappingStore());
    const entities = new Map([['su', 'NAME'], ['张伟', 'NAME']]);
    const out = masker.mask('issue summary su_id su. 联系张伟先生', undefined, entities);
    expect(out).toMatch(new RegExp(`^issue summary su_id ${NAME.source}\\. 联系${NAME.source}先生$`));
  });

  it('Anthropic tool_use.input 仍是业务区（键名也扫）', () => {
    const masker = new Masker(new MappingStore());
    const raw = JSON.stringify({
      model: 'claude-x',
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 't', input: { su: 'su' } }] }],
    });
    const r = maskRequestText(masker, raw, { entities: new Map([['su', 'NAME']]) });
    const input = JSON.parse(r.text).messages[0].content[0].input;
    const [k] = Object.keys(input);
    expect(k).toMatch(NAME);
    expect(input[k]).toMatch(NAME);
  });
});
