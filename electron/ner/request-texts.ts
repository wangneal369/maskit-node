/**
 * 从请求体里取出需要送 NER 的文本叶子（按文档顺序），以及把识别结果折成 masker 要的实体表。
 *
 * 只跳过最确定的协议位置（宁宽勿严，业务区里同名字段仍是数据）：role/type/model/关联 id、cache_control 子树、
 * 带签名的 thinking 块——这些位置 maskJson 不会改写，识别了也白费推理时间。
 * 多取一点没有害处（实体表只会让 masker 在“它本来就会扫的叶子”里替换），所以这里宁宽勿严。
 */
import type { NerEntity } from './engine';

const SKIP_KEYS = new Set([
  'role', 'type', 'model', 'object', 'finish_reason', 'stop_reason', 'media_type',
  'tool_call_id', 'tool_use_id', 'call_id',
]);
const SKIP_SUBTREE_KEYS = new Set(['cache_control']);
const MAX_DEPTH = 24;
const CJK_RX = /[\u4e00-\u9fff]/;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

/** 请求体里含汉字的字符串叶子，按文档顺序（messages 里越靠后的越新） */
export function requestTexts(body: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key: string | undefined, depth: number): void => {
    // 深度超限不在这里报错：maskJson 会抛 json_depth_exceeded 并 fail-closed
    if (depth > MAX_DEPTH) return;
    if (typeof v === 'string') {
      if (!(key && SKIP_KEYS.has(key)) && v.length >= 2 && CJK_RX.test(v)) out.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key, depth + 1);
    } else if (isRec(v)) {
      if (key && SKIP_SUBTREE_KEYS.has(key)) return;
      if ((v.type === 'thinking' && typeof v.signature === 'string') || v.type === 'redacted_thinking') return;
      for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
    }
  };
  walk(body, undefined, 0);
  return out;
}

/** 实体 → masker 用的“原文 → 标签”表；同一原文被识别成不同类型时先出现的（更新的消息里的）为准 */
export function entityMap(entities: readonly NerEntity[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entities) if (e.text.length >= 2 && !m.has(e.text)) m.set(e.text, e.type);
  return m;
}
