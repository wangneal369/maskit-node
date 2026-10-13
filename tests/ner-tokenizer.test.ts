import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BertTokenizer } from '../electron/ner/tokenizer';

const REAL_TOKENIZER = 'E:/projects/aiProject/ner-model-check/ner/tokenizer.json';

/** 内联小词表：不依赖模型文件，行为与 BERT-base-chinese 的 cased 配置一致 */
function mini(opts: { lowercase?: boolean; strip_accents?: boolean | null } = {}): BertTokenizer {
  const toks = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '你', '好', '北', '京', 'hello', 'Hello', 'world', '##world', 'un', '##aff', '##able',
    ',', '.', '!', '1', '2', '3', '[', ']', 'cafe', 'e', '-', '$'];
  const vocab: Record<string, number> = {};
  toks.forEach((t, i) => { vocab[t] = i; });
  return new BertTokenizer({
    normalizer: { type: 'BertNormalizer', clean_text: true, handle_chinese_chars: true, strip_accents: opts.strip_accents ?? null, lowercase: opts.lowercase ?? false },
    model: { type: 'WordPiece', unk_token: '[UNK]', continuing_subword_prefix: '##', max_input_chars_per_word: 100, vocab },
  });
}

/** 用 offsets 把 token 还原成原文片段 */
const slices = (tk: BertTokenizer, text: string): string[] => {
  const e = tk.encode(text);
  return e.offsets.map(([a, b]) => text.slice(a, b));
};

describe('BertTokenizer', () => {
  it('首尾是 [CLS]/[SEP]，偏移为 0,0', () => {
    const e = mini().encode('你好');
    expect(e.ids[0]).toBe(2);
    expect(e.ids[e.ids.length - 1]).toBe(3);
    expect(e.offsets[0]).toEqual([0, 0]);
    expect(e.offsets[e.offsets.length - 1]).toEqual([0, 0]);
  });

  it('CJK 逐字成 token，混排 ASCII/标点的偏移准确', () => {
    const tk = mini();
    const text = '你好,hello world.北京!';
    expect(slices(tk, text)).toEqual(['', '你', '好', ',', 'hello', 'world', '.', '北', '京', '!', '']);
    const e = tk.encode(text);
    // 偏移必须是原文中的真实位置
    const [a, b] = e.offsets[4];
    expect(text.slice(a, b)).toBe('hello');
    expect([a, b]).toEqual([3, 8]);
  });

  it('WordPiece 最长匹配，续接片段带 ## 且偏移相邻', () => {
    const tk = mini();
    const text = 'unaffable';
    const e = tk.encode(text);
    expect(e.ids.slice(1, -1)).toEqual([12, 13, 14]);
    expect(e.offsets.slice(1, -1)).toEqual([[0, 2], [2, 5], [5, 9]]);
  });

  it('匹配不上的词整体退化为一个 [UNK]，偏移覆盖整词', () => {
    const tk = mini();
    const text = '你zzz好';
    const e = tk.encode(text);
    expect(e.ids.slice(1, -1)).toEqual([4, 1, 5]);
    expect(e.offsets[2]).toEqual([1, 4]);
  });

  it('超长单词（>100 字符）直接 [UNK]', () => {
    const tk = mini();
    const w = 'a'.repeat(101);
    const e = tk.encode(w);
    expect(e.ids.slice(1, -1)).toEqual([1]);
    expect(e.offsets[1]).toEqual([0, 101]);
  });

  it('空白与控制字符被吞掉，不影响后续偏移', () => {
    const tk = mini();
    const text = '你\t\n  好\u0000\u200b北';
    expect(slices(tk, text).slice(1, -1)).toEqual(['你', '好', '北']);
  });

  it('按配置小写 / 去重音，偏移仍指向原文', () => {
    const lower = mini({ lowercase: true });
    const text = 'Hello Café';
    // lowercase=true 时 strip_accents 缺省跟随 → é 变 e，"café" → "cafe"
    const e = lower.encode(text);
    expect(e.ids.slice(1, -1)).toEqual([8, 23]);
    expect(e.offsets.slice(1, -1)).toEqual([[0, 5], [6, 10]]);
    // cased 配置保留大小写
    const cased = mini({ lowercase: false });
    expect(cased.encode('Hello').ids[1]).toBe(9);
  });

  it('字面量 [CLS]/[SEP] 不会被当成特殊 token（防注入）', () => {
    const tk = mini();
    const e = tk.encode('[SEP]');
    // 切成 [ UNK ]：中间的 SEP 不在词表 → UNK；首尾只有真正的 CLS/SEP
    expect(e.ids.filter((x) => x === 3)).toHaveLength(1);
    expect(e.ids.filter((x) => x === 2)).toHaveLength(1);
    expect(e.ids.slice(1, -1)).toEqual([21, 1, 22]);
  });

  it('代理对（emoji / 生僻字）按 UTF-16 偏移，不拆开', () => {
    const tk = mini();
    const text = '你😀好';
    const sl = slices(tk, text).slice(1, -1);
    expect(sl[0]).toBe('你');
    expect(sl[sl.length - 1]).toBe('好');
    expect(sl.join('')).toBe('你😀好'.replace(/\s/g, ''));
  });

  it('非 WordPiece 的 tokenizer.json 报中文错误', () => {
    expect(() => new BertTokenizer({ model: { type: 'BPE' } })).toThrow('不是 WordPiece');
    expect(() => new BertTokenizer(null)).toThrow();
  });
});

describe.skipIf(!fs.existsSync(REAL_TOKENIZER))('真实 tokenizer.json', () => {
  const tk = () => new BertTokenizer(JSON.parse(fs.readFileSync(REAL_TOKENIZER, 'utf8')));

  it('中文 + 数字 + 英文混排：每个非特殊 token 的片段都落在原文内且互不回退', () => {
    const text = '请联系张伟，电话13800138000，邮箱 Alice@Corp.com，住中关村大街1号。';
    const e = tk().encode(text);
    let prev = 0;
    for (const [a, b] of e.offsets.slice(1, -1)) {
      expect(a).toBeGreaterThanOrEqual(prev);
      expect(b).toBeGreaterThan(a);
      prev = b;
    }
    const joined = e.offsets.slice(1, -1).map(([a, b]) => text.slice(a, b)).join('');
    expect(joined).toBe(text.replace(/\s/g, ''));
  });

  it('汉字逐字切分', () => {
    const text = '张伟';
    const e = tk().encode(text);
    expect(e.offsets.slice(1, -1)).toEqual([[0, 1], [1, 2]]);
  });
});
