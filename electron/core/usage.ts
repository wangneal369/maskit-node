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
 * 从非流式 JSON 响应提取用量。
 * 支持格式：
 * - OpenAI chat: usage.prompt_tokens / completion_tokens + prompt_tokens_details.cached_tokens
 * - OpenAI Responses: usage.input_tokens / output_tokens + input_tokens_details.cached_tokens
 * - Anthropic: usage.input_tokens / output_tokens + cache_read_input_tokens / cache_creation_input_tokens
 * - Gemini: usageMetadata.promptTokenCount / candidatesTokenCount / cachedContentTokenCount / thoughtsTokenCount
 * - Ollama: 顶层 prompt_eval_count / eval_count
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
  const gem = usageFromGemini(b.usageMetadata);
  if (gem) return gem;
  const oll = usageFromOllama(b);
  if (oll) return oll;
  const usage = b.usage as Record<string, unknown> | undefined;

  if (!usage || typeof usage !== 'object') return undefined;

  // OpenAI chat 格式（prompt_tokens / completion_tokens）
  if ('prompt_tokens' in usage && 'completion_tokens' in usage) {
    const input = Number(usage.prompt_tokens) || 0;
    const output = Number(usage.completion_tokens) || 0;
    // OpenAI 的 cached_tokens 包含在 prompt_tokens 里
    const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    const cacheRead = Number(details?.cached_tokens) || 0;
    return { input: Math.max(0, input - cacheRead), output, cacheRead, cacheWrite: 0 };
  }

  // Anthropic 格式：有 cache_read_input_tokens 或 cache_creation_input_tokens
  if ('cache_read_input_tokens' in usage || 'cache_creation_input_tokens' in usage) {
    const input = Number(usage.input_tokens) || 0;
    const output = Number(usage.output_tokens) || 0;
    const cacheRead = Number(usage.cache_read_input_tokens) || 0;
    // cache_creation_input_tokens 是输入中创建缓存的部分，计入 input 的定价
    const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
    return { input, output, cacheRead, cacheWrite };
  }

  // OpenAI Responses 格式（input_tokens / output_tokens + input_tokens_details）
  if ('input_tokens' in usage && 'output_tokens' in usage) {
    const input = Number(usage.input_tokens) || 0;
    const output = Number(usage.output_tokens) || 0;
    // Responses 格式也可能有 input_tokens_details
    const details = usage.input_tokens_details as Record<string, unknown> | undefined;
    const cacheRead = Number(details?.cached_tokens) || 0;
    return { input: Math.max(0, input - cacheRead), output, cacheRead, cacheWrite: 0 };
  }

  return undefined;
}

/**
 * 流式用量收集器。
 * 逐个 SSE data 对象喂入，结束后调用 result() 获取累计用量。
 * 支持格式：
 * - OpenAI chat: 末尾 chunk 的 usage
 * - OpenAI Responses: message_start.message.usage（input） + message_delta.usage.output_tokens（取最后一次）
 * - Anthropic: message_start.message.usage（input+cache）+ message_delta.usage.output_tokens（累加）
 */
export class UsageCollector {
  private u: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private m?: string;

  feed(data: unknown): void {
    if (typeof data !== 'object' || data === null) return;

    const d = data as Record<string, unknown>;

    // 提取并保存模型名（优先级：message.model > response.model > 响应的 model）
    if (typeof d.message === 'object' && d.message !== null) {
      const msg = d.message as Record<string, unknown>;
      this.m = this.m || (typeof msg.model === 'string' ? msg.model : undefined);
    }
    if (typeof d.response === 'object' && d.response !== null) {
      const resp = d.response as Record<string, unknown>;
      this.m = this.m || (typeof resp.model === 'string' ? resp.model : undefined);
    }
    this.m = this.m || (typeof d.model === 'string' ? d.model : undefined);
    this.m = this.m || (typeof d.modelVersion === 'string' ? d.modelVersion : undefined);

    // Gemini：每个 chunk 的 usageMetadata 是累计值，取最后一次；Ollama：终止行的 eval 计数
    const gem = usageFromGemini(d.usageMetadata) ?? usageFromOllama(d);
    if (gem) {
      this.u = gem;
      return;
    }

    // OpenAI chat: 末尾 chunk 的 usage（每个 delta 都可能有，但通常只有最后一个）
    if (d.type === 'content_block_delta' || (typeof d.usage === 'object' && d.usage !== null)) {
      const usage = d.usage as Record<string, unknown> | undefined;
      if (usage && 'prompt_tokens' in usage && 'completion_tokens' in usage) {
        const promptTokens = Number(usage.prompt_tokens) || 0;
        this.u.output = Number(usage.completion_tokens) || 0;
        const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
        const cacheRead = Number(details?.cached_tokens) || 0;
        this.u.cacheRead = cacheRead;
        // OpenAI chat: cached_tokens 包含在 prompt_tokens 里，需要减掉
        this.u.input = Math.max(0, promptTokens - cacheRead);
      }
    }

    // OpenAI Responses: message_start 有初始 input（检查是否有 input_tokens_details 来区分 Anthropic）
    if (d.type === 'message_start' && typeof d.message === 'object' && d.message !== null) {
      const msg = d.message as Record<string, unknown>;
      const usage = msg.usage as Record<string, unknown> | undefined;
      // 优先识别 OpenAI Responses（有 input_tokens_details 或没有 Anthropic 特有字段）
      if (usage && 'input_tokens' in usage && !('cache_read_input_tokens' in usage)) {
        const inputTokens = Number(usage.input_tokens) || 0;
        const details = usage.input_tokens_details as Record<string, unknown> | undefined;
        const cacheRead = Number(details?.cached_tokens) || 0;
        this.u.cacheRead = cacheRead;
        // OpenAI Responses: 同样需要减掉 cached_tokens
        this.u.input = Math.max(0, inputTokens - cacheRead);
      }
      // Anthropic: 有 cache_read_input_tokens 或 cache_creation_input_tokens
      else if (usage && ('cache_read_input_tokens' in usage || 'cache_creation_input_tokens' in usage)) {
        if ('input_tokens' in usage) {
          this.u.input = Number(usage.input_tokens) || 0;
        }
        if ('cache_read_input_tokens' in usage) {
          this.u.cacheRead = Number(usage.cache_read_input_tokens) || 0;
        }
        if ('cache_creation_input_tokens' in usage) {
          this.u.cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
        }
      }
    }

    // OpenAI Responses 与 Anthropic: message_delta.usage.output_tokens（取最后一次，非累加）
    if (d.type === 'message_delta' && typeof d.delta === 'object' && d.delta !== null) {
      const delta = d.delta as Record<string, unknown>;
      const usage = delta.usage as Record<string, unknown> | undefined;
      if (usage && 'output_tokens' in usage) {
        this.u.output = Number(usage.output_tokens) || 0;
      }
    }
  }

  result(): Usage | undefined {
    return this.u.input || this.u.output ? { ...this.u } : undefined;
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
