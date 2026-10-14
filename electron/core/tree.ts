/**
 * 请求体 JSON 递归脱敏。
 *
 * 业务区（工具参数等）内一律扫描；业务区外按「字段 + 父容器」判定协议位置并豁免，
 * 改写协议位置只会让上游报参数非法，保护不了任何东西。
 */
import type { Masker, MaskHit } from './masker';

const SKIP_SCALAR_KEYS = new Set([
  'model', 'object', 'finish_reason', 'stop_reason', 'citations', 'detail', 'encoding_format', 'media_type',
  // Ollama 消息里的图片 base64 数组 / Gemini 媒体类型：改写只会破图，保护不了任何东西
  'images', 'mimeType',
]);
const SKIP_SUBTREE_KEYS = new Set(['cache_control']);
// input / summary：OpenAI Responses 顶层 input 的条目（message / reasoning / function_call…）与 reasoning.summary 的条目
const ROLE_TYPE_PARENTS = new Set([
  'message', 'messages', 'content', 'contents', 'parts', 'block', 'blocks',
  'tools', 'tool', 'tool_calls', 'function', 'response_format', 'candidates', 'choices', 'output',
  'input', 'summary',
]);
const PROTOCOL_ID_PARENTS = new Set([
  'message', 'messages', 'content', 'contents', 'parts', 'block', 'blocks',
  'tool_calls', 'tool_use', 'response', 'output', 'data', 'object', 'candidates', 'choices', 'function_call',
  'input',
]);
const PROTOCOL_PARENTS = new Set([
  'function', 'functions', 'function_call', 'functionCall', 'tool_use', 'tools', 'tool', 'input',
  'image_url', 'inline_data', 'thumbnail', 'input_image', 'source', 'file',
  // Gemini 驼峰写法的媒体容器（data 为图片 / 文件 base64）
  'inlineData', 'fileData',
]);
const SKIP_KEYS = new Set(['id', 'tool_call_id', 'tool_use_id', 'name', 'url', 'data', 'b64_json']);
/** 工具调用关联 ID：不分业务区一律豁免，脱敏必然断链 */
const CORRELATION_ID_KEYS = new Set(['tool_call_id', 'tool_use_id', 'call_id']);
const BUSINESS_KEYS = new Set(['input', 'arguments', 'parameters', 'partial_json', 'documents']);
/**
 * 业务区判定。input 有两种含义：Anthropic tool_use.input 是工具参数（业务数据，键名也要扫）；
 * OpenAI Responses 的请求体顶层 input 是整段对话（协议骨架），当业务区会把 summary / type / id 等改坏，上游 400。
 */
function isBusinessKey(k: string, depth: number): boolean {
  return BUSINESS_KEYS.has(k) && !(k === 'input' && depth === 0);
}
const SKIP_NUMERIC_KEYS = new Set([
  'max_tokens', 'max_completion_tokens', 'max_tokens_to_sample', 'budget_tokens',
  'temperature', 'top_p', 'top_k', 'n', 'seed', 'index', 'created', 'logprobs',
  'top_logprobs', 'presence_penalty', 'frequency_penalty', 'best_of', 'timeout',
  'prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens',
  'cache_creation_input_tokens', 'cache_read_input_tokens', 'reasoning_tokens',
  'status_code', 'http_status', 'retry', 'attempt', 'weight', 'priority',
]);
/**
 * 带上游签名/密文的块：正文与签名必须原样上行，改任一侧都让上游校验失败（会话永久 400）。
 * Anthropic thinking / redacted_thinking 整块只读；OpenAI Responses 的 encrypted_content 只锁字段。
 */
const SIGNED_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking']);
/** 按结构判定（type + 字段），不按裸字段名：工具参数里同名字段是业务数据 */
function isSignedBlock(rec: Record<string, unknown>): boolean {
  return typeof rec.type === 'string' && SIGNED_BLOCK_TYPES.has(rec.type)
    && (rec.type === 'redacted_thinking' || typeof rec.signature === 'string');
}
function lockedFields(rec: Record<string, unknown>): Set<string> | undefined {
  return rec.type === 'reasoning' && 'encrypted_content' in rec ? new Set(['encrypted_content']) : undefined;
}
const MAX_DEPTH = 24;

type Json = unknown;

function leafExempt(key: string | undefined, parent: string | undefined, inBusiness: boolean): boolean {
  if (key === undefined) return false;
  if (CORRELATION_ID_KEYS.has(key)) return true;
  if (inBusiness) return false;
  if (SKIP_SCALAR_KEYS.has(key)) return true;
  if ((key === 'role' || key === 'type') && (parent === undefined || ROLE_TYPE_PARENTS.has(parent))) return true;
  if (SKIP_KEYS.has(key)) {
    if (key === 'name' && !PROTOCOL_PARENTS.has(parent ?? '')) return false;
    if ((key === 'url' || key === 'data' || key === 'b64_json') && !PROTOCOL_PARENTS.has(parent ?? '')) return false;
    if (key === 'id' && !PROTOCOL_ID_PARENTS.has(parent ?? '')) return false;
    return true;
  }
  return false;
}

export interface TreeMaskResult {
  body: Json;
  changed: boolean;
  hits: MaskHit[];
  signedBlocksSkipped: number;
}

export interface MaskJsonOptions {
  /** NER 实体：key = 实体原文，value = 标签（NAME/ORG/ADDR）；不传则只跑确定性规则 */
  entities?: ReadonlyMap<string, string>;
}

export function maskJson(masker: Masker, root: Json, opts?: MaskJsonOptions): TreeMaskResult {
  const hits = new Map<string, MaskHit>();
  const entities = opts?.entities;
  let changed = false;
  let signedBlocksSkipped = 0;

  const maskStr = (s: string): string => {
    const out = masker.mask(s, hits, entities);
    if (out !== s) changed = true;
    return out;
  };

  const walk = (obj: Json, key: string | undefined, parent: string | undefined, inBusiness: boolean, depth: number): Json => {
    // 深到扫不到不能静默直出：抛错由调用方 fail-closed 阻断
    if (depth > MAX_DEPTH) throw new Error('json_depth_exceeded');
    if (typeof obj === 'string') return leafExempt(key, parent, inBusiness) ? obj : maskStr(obj);
    if (typeof obj === 'number') {
      if ((key && SKIP_NUMERIC_KEYS.has(key)) || leafExempt(key, parent, inBusiness)) return obj;
      // {"phone": 13800138000} 这类数值型 PII：命中才整体换成占位符字符串
      const s = String(obj);
      const out = maskStr(s);
      return out === s ? obj : out;
    }
    if (Array.isArray(obj)) return obj.map((v) => walk(v, key, parent, inBusiness, depth + 1));
    if (obj && typeof obj === 'object') {
      if (!inBusiness && key && SKIP_SUBTREE_KEYS.has(key)) return obj;
      const rec = obj as Record<string, Json>;
      if (isSignedBlock(rec)) {
        signedBlocksSkipped++;
        return obj;
      }
      const locked = lockedFields(rec);
      const out: Record<string, Json> = {};
      for (const [k, v] of Object.entries(rec)) {
        if (locked?.has(k)) {
          out[k] = v;
          continue;
        }
        // 业务区内的键名也可能是数据（{"手机号": ...}），业务区外的键名是协议骨架
        const nk = inBusiness ? maskStr(k) : k;
        out[nk] = walk(v, k, key, inBusiness || isBusinessKey(k, depth), depth + 1);
      }
      return out;
    }
    return obj;
  };

  const body = walk(root, undefined, undefined, false, 0);
  return { body, changed, hits: [...hits.values()], signedBlocksSkipped };
}
