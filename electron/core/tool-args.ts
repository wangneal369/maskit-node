/**
 * 定位响应里的工具调用参数，统一交给回调处理（命令检测 / 改写）。
 *
 * 覆盖的形态：
 * - OpenAI Chat：`tool_calls[].function.arguments`、旧式 `function_call.arguments`（JSON 字符串）；
 * - OpenAI Responses：`output[]` 中 `type: function_call` 的 `arguments`，以及流里
 *   `response.function_call_arguments.done` / `response.output_item.done` / `response.completed`
 *   这些整包事件再次携带的完整参数——只拦增量不拦整包，危险命令会从这里漏出去；
 * - Anthropic：`type: tool_use` 块的 `input`（对象，序列化后处理再解析回去）；
 * - Gemini：`functionCall.args`（对象）；Ollama：`tool_calls[].function.arguments`（对象）。
 *   这两种都是「带 name 的对象里的 args / arguments 对象」，处理方式与 tool_use.input 相同。
 */

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 遍历 obj，对每处工具参数调用 fn(参数 JSON 文本) 并用返回值替换。
 * 返回新对象（不修改入参）；fn 返回原文本时保持原样。
 */
export function mapToolArgs(obj: unknown, fn: (args: string) => string, depth = 0): unknown {
  if (depth > 32) return obj;
  if (Array.isArray(obj)) return obj.map((v) => mapToolArgs(v, fn, depth + 1));
  if (!isRec(obj)) return obj;
  const out: Rec = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'arguments' && typeof v === 'string') {
      out[k] = fn(v);
    } else if (
      v !== undefined && (
        (k === 'input' && obj.type === 'tool_use')
        // Gemini functionCall / Ollama function：参数是对象，同级有字符串 name
        || ((k === 'args' || k === 'arguments') && isRec(v) && typeof obj.name === 'string')
      )
    ) {
      const text = JSON.stringify(v);
      const next = fn(text);
      if (next === text) {
        out[k] = v;
      } else {
        try {
          out[k] = JSON.parse(next);
        } catch {
          // 改写结果不是合法 JSON 时宁可清空参数，也不能把原危险参数放行
          out[k] = {};
        }
      }
    } else {
      out[k] = mapToolArgs(v, fn, depth + 1);
    }
  }
  return out;
}

/** 收集所有字符串叶子（审计用），总长到 limit 为止 */
export function collectText(obj: unknown, limit = 512 * 1024): string {
  const parts: string[] = [];
  let size = 0;
  const walk = (v: unknown, depth: number) => {
    if (size >= limit || depth > 32) return;
    if (typeof v === 'string') {
      parts.push(v);
      size += v.length;
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (isRec(v)) {
      for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  walk(obj, 0);
  return parts.join('\n').slice(0, limit);
}
