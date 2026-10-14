/**
 * LLM API 用量统计与定价计算。
 * 支持 OpenAI (ChatGPT/GPT-4/o3/o4/gpt-5)、Anthropic (Claude)、DeepSeek 响应格式。
 */

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelPrice {
  /** USD per 1M tokens */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * 主流模型参考价（USD / 1M tokens）：官方公开标价，仅用于估算，以服务商账单为准。
 * 价格会变动，用户可在「规则 → 模型价格」覆盖；本表不联网更新。
 * findPrice 走「精确 → 去日期/版本后缀 → 最长前缀」，所以细分型号要单列（如 opus-4-5 与 opus-4 价格不同）。
 */
export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  // OpenAI（cacheRead = 缓存命中的输入价）
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075 },
  'gpt-4.1': { input: 2, output: 8, cacheRead: 0.5 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheRead: 0.1 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cacheRead: 0.025 },
  'o3': { input: 2, output: 8, cacheRead: 0.5 },
  'o4-mini': { input: 1.1, output: 4.4, cacheRead: 0.275 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005 },

  // Anthropic（cacheWrite 为 5 分钟缓存写入价）
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },

  // Google Gemini（参考 ≤200K 上下文档价格；超长上下文另有更高单价，此处不区分）
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.31 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.075 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4, cacheRead: 0.025 },

  // DeepSeek（cacheRead = 缓存命中价）
  'deepseek-chat': { input: 0.28, output: 0.42, cacheRead: 0.028 },
  'deepseek-reasoner': { input: 0.28, output: 0.42, cacheRead: 0.028 },
};

/** Gemini usageMetadata：promptTokenCount 含缓存；输出含思考 token。无该字段返回 undefined */
function usageFromGemini(meta: unknown): Usage | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const m = meta as Record<string, unknown>;
  if (!('promptTokenCount' in m) && !('candidatesTokenCount' in m)) return undefined;
  const cacheRead = Number(m.cachedContentTokenCount) || 0;
  const input = Math.max(0, (Number(m.promptTokenCount) || 0) - cacheRead);
  const output = (Number(m.candidatesTokenCount) || 0) + (Number(m.thoughtsTokenCount) || 0);
  return { input, output, cacheRead, cacheWrite: 0 };
}

/** Ollama：终止行 / 非流式响应顶层的 prompt_eval_count / eval_count */
function usageFromOllama(d: Record<string, unknown>): Usage | undefined {
  if (!('eval_count' in d) && !('prompt_eval_count' in d)) return undefined;
  return { input: Number(d.prompt_eval_count) || 0, output: Number(d.eval_count) || 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * 把各家 usage 对象统一成 Usage。约定：input 只算「未命中缓存」的输入，命中部分进 cacheRead。
 * - OpenAI chat：prompt_tokens 含缓存命中（prompt_tokens_details.cached_tokens；DeepSeek 为 prompt_cache_hit_tokens）
 * - OpenAI Responses：input_tokens 含缓存命中（input_tokens_details.cached_tokens）
 * - Anthropic：input_tokens 本就不含缓存，另有 cache_read_input_tokens / cache_creation_input_tokens
 * 输出 token 已含推理 token（completion_tokens / output_tokens 的口径）。
 */
export function normalizeUsage(raw: unknown): Usage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const n = (v: unknown) => Number(v) || 0;
  const details = (k: string) => (typeof u[k] === 'object' && u[k] !== null ? (u[k] as Record<string, unknown>) : undefined);

  if ('prompt_tokens' in u || 'completion_tokens' in u) {
    const cacheRead = n(details('prompt_tokens_details')?.cached_tokens) || n(u.prompt_cache_hit_tokens);
    return { input: Math.max(0, n(u.prompt_tokens) - cacheRead), output: n(u.completion_tokens), cacheRead, cacheWrite: 0 };
  }
  if ('cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u) {
    return {
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cacheRead: n(u.cache_read_input_tokens),
      cacheWrite: n(u.cache_creation_input_tokens),
    };
  }
  if ('input_tokens' in u || 'output_tokens' in u) {
    const cacheRead = n(details('input_tokens_details')?.cached_tokens);
    return { input: Math.max(0, n(u.input_tokens) - cacheRead), output: n(u.output_tokens), cacheRead, cacheWrite: 0 };
  }
  return undefined;
}

function isEmpty(u: Usage): boolean {
  return !u.input && !u.output && !u.cacheRead && !u.cacheWrite;
}

/**
 * 从非流式 JSON 响应提取用量（OpenAI chat / Responses、Anthropic、DeepSeek、Gemini、Ollama）。
 * 拿不到返回 undefined。
 */
export function usageFromJson(body: unknown): Usage | undefined {
  // Gemini 的流式 JSON（非 SSE）是对象数组：用量在最后一个带 usageMetadata 的元素里
  if (Array.isArray(body)) {
    for (let i = body.length - 1; i >= 0; i--) {
      const u = usageFromJson(body[i]);
      if (u) return u;
    }
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;
  const u = usageFromGemini(b.usageMetadata) ?? usageFromOllama(b) ?? normalizeUsage(b.usage);
  return u && !isEmpty(u) ? u : undefined;
}

/**
 * 流式用量收集器：逐个 SSE / NDJSON 数据对象喂入，结束后 result() 取用量。
 * - OpenAI chat / DeepSeek：带 usage 的 chunk（通常是最后一个，需 stream_options.include_usage）
 * - OpenAI Responses：response.completed / response.incomplete / response.failed 事件的 response.usage
 * - Anthropic：message_start.message.usage（输入 + 缓存）+ message_delta 顶层 usage（output_tokens 为累计值，取最后一次；
 *   新版 API 在 message_delta 里也可能带输入 / 缓存的累计值，出现即覆盖）
 * - Gemini：每个 chunk 的 usageMetadata 是累计值，取最后一次；Ollama：终止行的 eval 计数
 */
export class UsageCollector {
  private u: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private m?: string;

  feed(data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    const d = data as Record<string, unknown>;
    const msg = typeof d.message === 'object' && d.message !== null ? (d.message as Record<string, unknown>) : undefined;
    const resp = typeof d.response === 'object' && d.response !== null ? (d.response as Record<string, unknown>) : undefined;

    // 模型名：message.model > response.model > 顶层 model > Gemini modelVersion
    this.m ||= [msg?.model, resp?.model, d.model, d.modelVersion].find((v): v is string => typeof v === 'string' && v !== '');

    const whole = usageFromGemini(d.usageMetadata) ?? usageFromOllama(d);
    if (whole) {
      this.u = whole;
      return;
    }

    // Anthropic message_start：输入与缓存（output_tokens 此时只是占位的 1，留给 message_delta）
    if (d.type === 'message_start' && msg) {
      const u = normalizeUsage(msg.usage);
      if (u) this.u = { ...u, output: Math.max(this.u.output, u.output) };
      return;
    }

    // Anthropic message_delta：usage 在事件顶层，字段都是累计值
    if (d.type === 'message_delta') {
      const usage = d.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === 'object') {
        if ('output_tokens' in usage) this.u.output = Number(usage.output_tokens) || 0;
        if (Number(usage.input_tokens)) this.u.input = Number(usage.input_tokens);
        if (Number(usage.cache_read_input_tokens)) this.u.cacheRead = Number(usage.cache_read_input_tokens);
        if (Number(usage.cache_creation_input_tokens)) this.u.cacheWrite = Number(usage.cache_creation_input_tokens);
      }
      return;
    }

    // OpenAI Responses：终态事件里的 response.usage 是整次请求的最终用量
    if (resp && resp.usage) {
      const u = normalizeUsage(resp.usage);
      if (u && !isEmpty(u)) this.u = u;
      return;
    }

    // OpenAI chat / DeepSeek：带 usage 的 chunk（中间 chunk 的 usage 为 null）
    const u = normalizeUsage(d.usage);
    if (u && !isEmpty(u)) this.u = u;
  }

  result(): Usage | undefined {
    return isEmpty(this.u) ? undefined : { ...this.u };
  }

  model(): string | undefined {
    return this.m;
  }
}

/**
 * 从请求体或响应头提取模型名。
 * 优先级：响应的 model / message.model / response.model > 请求体的 model
 */
export function modelFromJson(body: unknown): string | undefined {
  if (Array.isArray(body)) {
    for (const x of body) {
      const m = modelFromJson(x);
      if (m) return m;
    }
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;

  const b = body as Record<string, unknown>;

  // 优先从响应结构（message / response）提取模型名
  if (typeof b.message === 'object' && b.message !== null) {
    const msg = b.message as Record<string, unknown>;
    if (typeof msg.model === 'string') return msg.model;
  }

  if (typeof b.response === 'object' && b.response !== null) {
    const resp = b.response as Record<string, unknown>;
    if (typeof resp.model === 'string') return resp.model;
  }

  // 最后尝试顶层 model 字段
  if (typeof b.model === 'string') return b.model;

  // Gemini 响应：modelVersion
  if (typeof b.modelVersion === 'string') return b.modelVersion;

  return undefined;
}

/**
 * 匹配模型价格。
 * 匹配策略（按优先级）：
 * 1. 精确匹配
 * 2. 去掉日期后缀（-2025-04-14、-20250514）后匹配
 * 3. 去掉版本后缀（-latest、-v1）后匹配
 * 4. 最长前缀匹配（e.g., gpt-4 → gpt-4.1）
 * overrides 优先于默认表，都不中返回 undefined。
 */
export function findPrice(model: string, overrides?: Record<string, ModelPrice>): ModelPrice | undefined {
  const table: Record<string, ModelPrice> = { ...DEFAULT_MODEL_PRICES, ...overrides };
  if (!model) return undefined;

  // 1. 精确匹配
  if (model in table) return table[model];

  // 2. 去掉日期后缀（-2025-04-14 或 -20250514）
  let stripped = model.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '');
  if (stripped !== model && stripped in table) return table[stripped];

  // 3. 去掉版本后缀（-latest、-v1 等）
  stripped = model.replace(/-(?:latest|v\d+|preview)$/i, '');
  if (stripped !== model && stripped in table) return table[stripped];

  // 4. 最长前缀匹配
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (model.startsWith(key)) return table[key];
  }

  return undefined;
}

/**
 * 计算费用（USD）。
 * 说明：
 * - OpenAI 的 cached_tokens 已包含在 prompt_tokens 里，input 部分计费 = input - cacheRead
 * - Anthropic 的 input_tokens 不包含缓存部分，cacheRead 单独计费
 * - 为简化，Usage.input 统一表示「非缓存输入」（提取时 OpenAI 的 cached 已从 input 减掉）
 * - 没有价格返回 undefined
 */
export function costOf(usage: Usage, price: ModelPrice): number | undefined {
  if (!price) return undefined;
  const inputCost = (usage.input * price.input) / 1_000_000;
  const outputCost = (usage.output * price.output) / 1_000_000;
  const cacheReadCost = price.cacheRead ? (usage.cacheRead * price.cacheRead) / 1_000_000 : 0;
  const cacheWriteCost = price.cacheWrite ? (usage.cacheWrite * price.cacheWrite) / 1_000_000 : 0;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
