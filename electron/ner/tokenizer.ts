/**
 * BERT WordPiece 分词器（按 HuggingFace tokenizer.json 实现，不依赖 transformers.js）。
 *
 * 管线与 `tokenizers` 库的 BertNormalizer + BertPreTokenizer + WordPiece 一致：
 *   清洗控制字符 → CJK 单字拆开 →（按配置）小写 / 去重音 → 空白与标点切词 → 最长匹配 WordPiece。
 * 每个 token 都带原文 UTF-16 偏移，实体可以精确映射回原字符串。
 *
 * 与 Python 版（tokenizers 库）的刻意差异：文本里字面出现的 `[CLS]`/`[SEP]` 之类**不会**被当成
 * 特殊 token，而按普通字符切分——用户文本不应有能力往模型输入里注入控制符。
 */

export interface TokenizerEncoding {
  ids: number[];
  /** 与 ids 对齐的 [start, end) UTF-16 偏移；[CLS]/[SEP] 为 [0, 0] */
  offsets: Array<[number, number]>;
}

interface NormalizerConfig {
  cleanText: boolean;
  handleChinese: boolean;
  lowercase: boolean;
  stripAccents: boolean;
}

/** 归一化后的一个“单元”：字符串片段 + 它对应的原文区间 */
interface Unit {
  s: string;
  a: number;
  b: number;
}

const MAX_CHARS_PER_WORD_DEFAULT = 100;

function isChineseCp(cp: number): boolean {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0x2a700 && cp <= 0x2b73f)
    || (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);
}

const PUNCT_UNICODE_RX = /^\p{P}$/u;
const WHITESPACE_RX = /^\s$/u;
const CONTROL_RX = /^[\p{Cc}\p{Cf}]$/u;
const MARK_RX = /^\p{Mn}$/u;

/** BERT 的标点：ASCII 标点（含 $+<=>^`|~ 这类符号）+ Unicode P* 类 */
function isPunct(ch: string, cp: number): boolean {
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return PUNCT_UNICODE_RX.test(ch);
}

export class BertTokenizer {
  private readonly vocab: Map<string, number>;
  private readonly unkId: number;
  private readonly clsId: number;
  private readonly sepId: number;
  private readonly prefix: string;
  private readonly maxCharsPerWord: number;
  private readonly norm: NormalizerConfig;

  constructor(json: unknown) {
    const t = json as {
      normalizer?: { clean_text?: boolean; handle_chinese_chars?: boolean; strip_accents?: boolean | null; lowercase?: boolean } | null;
      model?: { type?: string; vocab?: Record<string, number>; unk_token?: string; continuing_subword_prefix?: string; max_input_chars_per_word?: number };
    };
    if (!t || typeof t !== 'object' || !t.model || t.model.type !== 'WordPiece' || !t.model.vocab || typeof t.model.vocab !== 'object') {
      throw new Error('tokenizer.json 不是 WordPiece 分词器');
    }
    this.vocab = new Map(Object.entries(t.model.vocab));
    const unk = t.model.unk_token ?? '[UNK]';
    const need = (tok: string): number => {
      const id = this.vocab.get(tok);
      if (id === undefined) throw new Error(`词表缺少特殊 token ${tok}`);
      return id;
    };
    this.unkId = need(unk);
    this.clsId = need('[CLS]');
    this.sepId = need('[SEP]');
    this.prefix = t.model.continuing_subword_prefix ?? '##';
    this.maxCharsPerWord = t.model.max_input_chars_per_word ?? MAX_CHARS_PER_WORD_DEFAULT;
    const n = t.normalizer ?? {};
    const lowercase = n.lowercase ?? true;
    this.norm = {
      cleanText: n.clean_text ?? true,
      handleChinese: n.handle_chinese_chars ?? true,
      lowercase,
      // strip_accents 为 null/缺省时跟随 lowercase（BertNormalizer 的约定）
      stripAccents: n.strip_accents ?? lowercase,
    };
  }

  /** 编码一段文本：[CLS] + tokens + [SEP]。不截断（调用方负责窗口长度）。 */
  encode(text: string): TokenizerEncoding {
    const ids: number[] = [this.clsId];
    const offsets: Array<[number, number]> = [[0, 0]];
    for (const word of this.words(text)) this.wordPiece(word, ids, offsets);
    ids.push(this.sepId);
    offsets.push([0, 0]);
    return { ids, offsets };
  }

  /** 归一化 + 预分词：产出若干“词”（每个词是一串 Unit） */
  private words(text: string): Unit[][] {
    const out: Unit[][] = [];
    let cur: Unit[] = [];
    const flush = (): void => {
      if (cur.length) out.push(cur);
      cur = [];
    };
    const { cleanText, handleChinese, lowercase, stripAccents } = this.norm;

    let i = 0;
    while (i < text.length) {
      const cp = text.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      const a = i;
      i += ch.length;
      const b = i;

      if (cleanText) {
        if (cp === 0 || cp === 0xfffd) continue;
        if (ch === '\t' || ch === '\n' || ch === '\r' || WHITESPACE_RX.test(ch)) {
          flush();
          continue;
        }
        if (CONTROL_RX.test(ch)) continue;
      } else if (WHITESPACE_RX.test(ch)) {
        flush();
        continue;
      }

      if (handleChinese && isChineseCp(cp)) {
        flush();
        out.push([{ s: ch, a, b }]);
        continue;
      }

      let norm = ch;
      if (stripAccents) norm = [...norm.normalize('NFD')].filter((c) => !MARK_RX.test(c)).join('');
      if (lowercase) norm = norm.toLowerCase();
      if (!norm) continue;

      // 标点单独成词；一个原字符归一化后若展开成多个字符，它们共享同一原文区间
      for (const c of norm) {
        const ccp = c.codePointAt(0)!;
        if (isPunct(c, ccp)) {
          flush();
          out.push([{ s: c, a, b }]);
        } else {
          cur.push({ s: c, a, b });
        }
      }
    }
    flush();
    return out;
  }

  /** 最长匹配 WordPiece；任何一段匹配不上，整个词退化为单个 [UNK] */
  private wordPiece(word: Unit[], ids: number[], offsets: Array<[number, number]>): void {
    const wordStart = word[0].a;
    const wordEnd = word[word.length - 1].b;
    if (word.length > this.maxCharsPerWord) {
      ids.push(this.unkId);
      offsets.push([wordStart, wordEnd]);
      return;
    }
    const pieces: Array<[number, number, number]> = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let found = -1;
      while (start < end) {
        let sub = '';
        for (let k = start; k < end; k++) sub += word[k].s;
        if (start > 0) sub = this.prefix + sub;
        const id = this.vocab.get(sub);
        if (id !== undefined) {
          found = id;
          break;
        }
        end--;
      }
      if (found < 0) {
        ids.push(this.unkId);
        offsets.push([wordStart, wordEnd]);
        return;
      }
      pieces.push([found, word[start].a, word[end - 1].b]);
      start = end;
    }
    for (const [id, a, b] of pieces) {
      ids.push(id);
      offsets.push([a, b]);
    }
  }
}
