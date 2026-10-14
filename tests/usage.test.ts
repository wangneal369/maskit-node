import { describe, expect, it } from 'vitest';
import {
  type Usage,
  type ModelPrice,
  DEFAULT_MODEL_PRICES,
  usageFromJson,
  UsageCollector,
  modelFromJson,
  findPrice,
  costOf,
} from '../electron/core/usage';

describe('usageFromJson', () => {
  it('OpenAI chat 格式：prompt_tokens / completion_tokens（需减去 cached_tokens）', () => {
    const resp = {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    };
    const u = usageFromJson(resp);
    expect(u).toEqual({ input: 80, output: 50, cacheRead: 20, cacheWrite: 0 });
  });

  it('OpenAI chat 格式：无缓存信息', () => {
    const resp = {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
      },
    };
    const u = usageFromJson(resp);
    expect(u).toEqual({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0 });
  });

  it('OpenAI Responses 格式：input_tokens / output_tokens', () => {
    const resp = {
      usage: {
        input_tokens: 120,
        output_tokens: 40,
        input_tokens_details: { cached_tokens: 30 },
      },
    };
    const u = usageFromJson(resp);
    expect(u).toEqual({ input: 90, output: 40, cacheRead: 30, cacheWrite: 0 });
  });

  it('Anthropic 格式：input_tokens / output_tokens + cache_read_input_tokens + cache_creation_input_tokens', () => {
    const resp = {
      usage: {
        input_tokens: 150,
        output_tokens: 60,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 25,
      },
    };
    const u = usageFromJson(resp);
    expect(u).toEqual({ input: 150, output: 60, cacheRead: 40, cacheWrite: 25 });
  });

  it('无效格式返回 undefined', () => {
    expect(usageFromJson(null)).toBeUndefined();
    expect(usageFromJson({ usage: {} })).toBeUndefined();
    expect(usageFromJson({ data: 123 })).toBeUndefined();
  });

  it('缓存 token 不能超过输入（夹紧到 0）', () => {
    const resp = {
      usage: {
        prompt_tokens: 50,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 60 },
      },
    };
    const u = usageFromJson(resp);
    expect(u?.input).toBe(0); // max(0, 50 - 60) = 0
  });
});

describe('UsageCollector', () => {
  it('OpenAI chat stream：中间 chunk usage 为 null，末尾 chunk 带 usage', () => {
    const col = new UsageCollector();
    col.feed({ object: 'chat.completion.chunk', model: 'gpt-4o', choices: [{ delta: { content: 'hi' } }], usage: null });
    col.feed({
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 10 } },
    });
    expect(col.result()).toEqual({ input: 90, output: 50, cacheRead: 10, cacheWrite: 0 });
    expect(col.model()).toBe('gpt-4o');
  });

  it('DeepSeek stream：缓存命中在 prompt_cache_hit_tokens', () => {
    const col = new UsageCollector();
    col.feed({
      model: 'deepseek-chat',
      choices: [],
      usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_cache_hit_tokens: 960, prompt_cache_miss_tokens: 40 },
    });
    expect(col.result()).toEqual({ input: 40, output: 20, cacheRead: 960, cacheWrite: 0 });
  });

  it('OpenAI Responses stream：response.completed 里的 response.usage（Codex）', () => {
    const col = new UsageCollector();
    col.feed({ type: 'response.created', response: { id: 'resp_1', model: 'gpt-5', usage: null } });
    col.feed({ type: 'response.in_progress', response: { id: 'resp_1', usage: null } });
    col.feed({ type: 'response.output_text.delta', delta: 'hi' });
    col.feed({
      type: 'response.completed',
      response: {
        id: 'resp_1',
        model: 'gpt-5',
        usage: {
          input_tokens: 12000,
          input_tokens_details: { cached_tokens: 11000 },
          output_tokens: 800,
          output_tokens_details: { reasoning_tokens: 600 },
          total_tokens: 12800,
        },
      },
    });
    expect(col.result()).toEqual({ input: 1000, output: 800, cacheRead: 11000, cacheWrite: 0 });
    expect(col.model()).toBe('gpt-5');
  });

  it('OpenAI Responses stream：response.incomplete 同样计入', () => {
    const col = new UsageCollector();
    col.feed({ type: 'response.incomplete', response: { usage: { input_tokens: 10, output_tokens: 5 } } });
    expect(col.result()).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  });

  it('Anthropic stream：message_start 输入 + 缓存，message_delta 顶层 usage 的累计输出', () => {
    const col = new UsageCollector();
    col.feed({
      type: 'message_start',
      message: {
        model: 'claude-sonnet-4-5',
        usage: { input_tokens: 180, cache_read_input_tokens: 30, cache_creation_input_tokens: 20, output_tokens: 1 },
      },
    });
    col.feed({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } });
    col.feed({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 60 } });
    col.feed({ type: 'message_delta', delta: {}, usage: { output_tokens: 62 } }); // 累计值：取最后一次
    expect(col.result()).toEqual({ input: 180, output: 62, cacheRead: 30, cacheWrite: 20 });
  });

  it('Anthropic stream：message_delta 带输入 / 缓存累计值时覆盖', () => {
    const col = new UsageCollector();
    col.feed({ type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 0, output_tokens: 1 } } });
    col.feed({ type: 'message_delta', delta: {}, usage: { input_tokens: 7, cache_read_input_tokens: 900, output_tokens: 40 } });
    expect(col.result()).toEqual({ input: 7, output: 40, cacheRead: 900, cacheWrite: 0 });
  });

  it('全部命中缓存（输入 0）也要计入', () => {
    const col = new UsageCollector();
    col.feed({ type: 'response.completed', response: { usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 500 }, output_tokens: 0 } } });
    expect(col.result()).toEqual({ input: 0, output: 0, cacheRead: 500, cacheWrite: 0 });
  });

  it('提取模型名：message.model > response.model > 顶层 model', () => {
    const col = new UsageCollector();
    col.feed({
      type: 'message_start',
      message: {
        model: 'claude-opus-4',
      },
    });
    expect(col.model()).toBe('claude-opus-4');

    const col2 = new UsageCollector();
    col2.feed({
      response: { model: 'gpt-4o' },
      model: 'gpt-4o-mini',
    });
    expect(col2.model()).toBe('gpt-4o');

    const col3 = new UsageCollector();
    col3.feed({ model: 'deepseek-chat' });
    expect(col3.model()).toBe('deepseek-chat');
  });

  it('无有效用量返回 undefined', () => {
    const col = new UsageCollector();
    col.feed({ type: 'content_block_start' });
    expect(col.result()).toBeUndefined();
  });
});

describe('modelFromJson', () => {
  it('优先从 message.model 提取', () => {
    const resp = {
      message: { model: 'claude-sonnet-4' },
      model: 'fallback',
    };
    expect(modelFromJson(resp)).toBe('claude-sonnet-4');
  });

  it('次优从 response.model 提取', () => {
    const resp = {
      response: { model: 'gpt-4.1' },
      model: 'fallback',
    };
    expect(modelFromJson(resp)).toBe('gpt-4.1');
  });

  it('最后从顶层 model 提取', () => {
    expect(modelFromJson({ model: 'deepseek-reasoner' })).toBe('deepseek-reasoner');
  });

  it('无模型信息返回 undefined', () => {
    expect(modelFromJson({ data: 'no model' })).toBeUndefined();
    expect(modelFromJson(null)).toBeUndefined();
  });
});

describe('findPrice', () => {
  it('精确匹配', () => {
    const p = findPrice('gpt-4o');
    expect(p).toEqual(DEFAULT_MODEL_PRICES['gpt-4o']);
  });

  it('去掉日期后缀再匹配', () => {
    const p1 = findPrice('gpt-4o-2025-04-14');
    expect(p1).toEqual(DEFAULT_MODEL_PRICES['gpt-4o']);

    const p2 = findPrice('claude-opus-4-20250514');
    expect(p2).toEqual(DEFAULT_MODEL_PRICES['claude-opus-4']);
  });

  it('去掉版本后缀再匹配', () => {
    const p1 = findPrice('gpt-4o-latest');
    expect(p1).toEqual(DEFAULT_MODEL_PRICES['gpt-4o']);

    const p2 = findPrice('claude-sonnet-4-preview');
    expect(p2).toEqual(DEFAULT_MODEL_PRICES['claude-sonnet-4']);
  });

  it('最长前缀匹配', () => {
    // claude-opus-4-extra-suffix 应该匹配到 claude-opus-4
    const p = findPrice('claude-opus-4-extra-suffix');
    expect(p).toEqual(DEFAULT_MODEL_PRICES['claude-opus-4']);
  });

  it('override 优先于默认表', () => {
    const override = { 'gpt-4o': { input: 999, output: 999 } };
    const p = findPrice('gpt-4o', override);
    expect(p?.input).toBe(999);
  });

  it('未知模型返回 undefined', () => {
    expect(findPrice('unknown-model-xyz')).toBeUndefined();
    expect(findPrice('')).toBeUndefined();
  });
});

describe('costOf', () => {
  it('基础费用计算', () => {
    const usage: Usage = { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0 };
    const price: ModelPrice = { input: 5, output: 15 };
    const cost = costOf(usage, price);
    expect(cost).toBe(5 + 7.5); // 5 + 15*500_000/1_000_000
  });

  it('包含缓存读费用（Anthropic 模式）', () => {
    const usage: Usage = { input: 1_000_000, output: 500_000, cacheRead: 200_000, cacheWrite: 0 };
    const price: ModelPrice = { input: 3, output: 15, cacheRead: 0.3 };
    const cost = costOf(usage, price);
    // 3 (input) + 7.5 (output) + 0.06 (cacheRead)
    expect(cost).toBeCloseTo(3 + 7.5 + 0.06, 5);
  });

  it('包含缓存写费用', () => {
    const usage: Usage = { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 100_000 };
    const price: ModelPrice = { input: 3, output: 15, cacheWrite: 3.75 };
    const cost = costOf(usage, price);
    // 3 + 7.5 + 0.375
    expect(cost).toBeCloseTo(3 + 7.5 + 0.375, 5);
  });

  it('无价格信息返回 undefined', () => {
    const usage: Usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };
    const price: ModelPrice | undefined = undefined;
    const cost = price ? costOf(usage, price) : undefined;
    expect(cost).toBeUndefined();
  });
});

describe('DEFAULT_MODEL_PRICES 覆盖率', () => {
  it('包含主流模型', () => {
    const models = [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'claude-opus-4',
      'claude-sonnet-4',
      'claude-3-5-haiku',
      'claude-haiku-4-5',
      'deepseek-chat',
      'deepseek-reasoner',
    ];
    for (const m of models) {
      expect(DEFAULT_MODEL_PRICES[m], `缺少模型 ${m} 的定价`).toBeDefined();
    }
  });

  it('所有价格 > 0', () => {
    for (const [model, price] of Object.entries(DEFAULT_MODEL_PRICES)) {
      expect(price.input, `${model} input 价格无效`).toBeGreaterThan(0);
      expect(price.output, `${model} output 价格无效`).toBeGreaterThan(0);
      if (price.cacheRead) expect(price.cacheRead).toBeGreaterThan(0);
      if (price.cacheWrite) expect(price.cacheWrite).toBeGreaterThan(0);
    }
  });
});
