/**
 * SSE 流式还原。
 *
 * 按事件（空行分隔）解析，只改「增量文本槽位」，其余字段逐字节透传；
 * 跨 chunk 的半截占位符由 Restorer 按通道扣留，通道结束时补发一个合成增量事件吐出残留。
 */
import type { Restorer } from './restorer';

type Path = (string | number)[];

interface Slot {
  channel: string;
  path: Path;
  escape: boolean;
}

interface Template {
  head: string[];
  data: string;
  path: Path;
  escape: boolean;
}

const EVENT_SEP_RX = /\r?\n\r?\n/;

function getAt(obj: unknown, path: Path): unknown {
  return path.reduce<unknown>((o, k) => (o as Record<string | number, unknown>)?.[k], obj);
}

function setAt(obj: unknown, path: Path, value: unknown): void {
  const parent = getAt(obj, path.slice(0, -1)) as Record<string | number, unknown>;
  parent[path[path.length - 1]] = value;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

function responsesChannel(data: Rec, kind: string): string {
  return `r${data.output_index ?? 0}.${data.content_index ?? 0}.${kind}`;
}

/** 列出事件里的增量文本槽位（每个字段独立通道）。 */
export function sseTextSlots(data: unknown): Slot[] {
  const slots: Slot[] = [];
  if (!isRec(data)) return slots;
  // OpenAI Chat Completions / Completions
  const choices = Array.isArray(data.choices) ? data.choices : [];
  choices.forEach((c, pos) => {
    if (!isRec(c)) return;
    const idx = typeof c.index === 'number' ? c.index : pos;
    const base: Path = ['choices', pos];
    const d = c.delta;
    if (isRec(d)) {
      if (isStr(d.content)) slots.push({ channel: `c${idx}.content`, path: [...base, 'delta', 'content'], escape: false });
      if (isStr(d.reasoning_content)) slots.push({ channel: `c${idx}.reason`, path: [...base, 'delta', 'reasoning_content'], escape: false });
      if (isStr(d.reasoning)) slots.push({ channel: `c${idx}.reason2`, path: [...base, 'delta', 'reasoning'], escape: false });
      const tcs = Array.isArray(d.tool_calls) ? d.tool_calls : [];
      tcs.forEach((tc, ti) => {
        if (!isRec(tc) || !isRec(tc.function) || !isStr(tc.function.arguments)) return;
        // 用协议里的 index 而非数组下标：并行工具调用每个 chunk 只带一个元素
        const no = typeof tc.index === 'number' ? tc.index : ti;
        slots.push({ channel: `c${idx}.tool${no}`, path: [...base, 'delta', 'tool_calls', ti, 'function', 'arguments'], escape: true });
      });
      if (isRec(d.function_call) && isStr(d.function_call.arguments)) {
        slots.push({ channel: `c${idx}.fcall`, path: [...base, 'delta', 'function_call', 'arguments'], escape: true });
      }
    }
    if (isStr(c.text)) slots.push({ channel: `c${idx}.text`, path: [...base, 'text'], escape: false });
  });
  const type = isStr(data.type) ? data.type : '';
  // Anthropic Messages：thinking_delta 不建槽位（签名覆盖的是占位符形态，还原会让下轮 400）
  if (type === 'content_block_delta' && isRec(data.delta)) {
    const blk = data.index ?? 0;
    if (isStr(data.delta.text)) slots.push({ channel: `a${blk}.text`, path: ['delta', 'text'], escape: false });
    if (isStr(data.delta.partial_json)) slots.push({ channel: `a${blk}.pj`, path: ['delta', 'partial_json'], escape: true });
  }
  // OpenAI Responses
  if (isStr(data.delta)) {
    if (type === 'response.output_text.delta') slots.push({ channel: responsesChannel(data, 'text'), path: ['delta'], escape: false });
    else if (type === 'response.reasoning_text.delta') slots.push({ channel: responsesChannel(data, 'reason'), path: ['delta'], escape: false });
    else if (type === 'response.function_call_arguments.delta') slots.push({ channel: responsesChannel(data, 'args'), path: ['delta'], escape: true });
  }
  return slots;
}

/** 本事件结束了哪些通道：null = 全部，[] = 无。 */
function terminalPrefixes(data: unknown): string[] | null {
  if (!isRec(data)) return [];
  const type = isStr(data.type) ? data.type : '';
  if (type === 'message_stop' || type === 'message_delta' || type === 'response.completed') return null;
  if (type === 'content_block_stop') return [`a${data.index ?? 0}.`];
  if (type === 'response.output_text.done') return [responsesChannel(data, 'text')];
  if (type === 'response.reasoning_text.done') return [responsesChannel(data, 'reason')];
  if (type === 'response.function_call_arguments.done') return [responsesChannel(data, 'args')];
  const out: string[] = [];
  const choices = Array.isArray(data.choices) ? data.choices : [];
  choices.forEach((c, pos) => {
    if (isRec(c) && c.finish_reason) out.push(`c${typeof c.index === 'number' ? c.index : pos}.`);
  });
  return out;
}

/** 由模板克隆一个只携带残留文本的增量事件：其它槽位清空，终止标记与用量去掉，防止重复计数。 */
function syntheticDelta(tpl: Template, text: string): unknown {
  const data = JSON.parse(tpl.data) as Rec;
  for (const s of sseTextSlots(data)) setAt(data, s.path, '');
  setAt(data, tpl.path, text);
  if (Array.isArray(data.choices)) {
    for (const c of data.choices) if (isRec(c) && 'finish_reason' in c) c.finish_reason = null;
  }
  delete data.usage;
  return data;
}

export class SseRestorer {
  private buf = '';
  private readonly templates = new Map<string, Template>();

  constructor(private readonly restorer: Restorer) {}

  /** 喂入一段解码后的文本，返回可立即下发的文本（不完整的事件留在缓冲区）。 */
  push(chunk: string): string {
    this.buf += chunk;
    let out = '';
    for (;;) {
      const m = EVENT_SEP_RX.exec(this.buf);
      if (!m) break;
      const block = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      out += this.handleEvent(block) + m[0];
    }
    return out;
  }

  /** 流结束：处理残留的半个事件，并吐出所有通道的扣留内容。 */
  end(): string {
    let out = this.buf ? this.handleEvent(this.buf) : '';
    this.buf = '';
    out += this.flushChannels(null);
    return out;
  }

  private handleEvent(block: string): string {
    const lines = block.split(/\r?\n/);
    const head = lines.filter((l) => !l.startsWith('data:'));
    const dataLines = lines.filter((l) => l.startsWith('data:'));
    if (!dataLines.length) return block;
    const raw = dataLines.map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (raw.trim() === '[DONE]') return this.flushChannels(null) + block;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return block;
    }
    const slots = sseTextSlots(data);
    const term = terminalPrefixes(data);
    const ends = (ch: string) => term === null || term.some((p) => ch.startsWith(p));
    // 先吐出「更早事件」扣留的残留：它们在本事件之前，顺序不能反
    const prefix = term === null || term.length
      ? this.flushChannels(term, new Set(slots.map((s) => s.channel)))
      : '';
    if (slots.length) {
      for (const s of slots) {
        const text = getAt(data, s.path) as string;
        this.templates.set(s.channel, { head, data: raw, path: s.path, escape: s.escape });
        // 本事件自身就是该通道的终点：直接 final，残留紧跟本段文本
        setAt(data, s.path, this.restorer.restore(text, s.channel, s.escape, ends(s.channel)));
      }
    } else {
      // 非增量事件（如 response.completed 携带完整结果）：整棵还原
      data = this.restorer.restoreTree(data);
    }
    return prefix + this.render(head, data);
  }

  /** 为已结束且有扣留的通道补发合成增量事件。 */
  private flushChannels(prefixes: string[] | null, except?: Set<string>): string {
    let out = '';
    for (const ch of this.restorer.pendingChannels()) {
      if (except?.has(ch)) continue;
      if (prefixes && !prefixes.some((p) => ch.startsWith(p))) continue;
      const tpl = this.templates.get(ch);
      if (!tpl) continue;
      const left = this.restorer.flush(ch, tpl.escape);
      if (!left) continue;
      out += `${this.render(tpl.head, syntheticDelta(tpl, left))}\n\n`;
    }
    return out;
  }

  private render(head: string[], data: unknown): string {
    return [...head, `data: ${JSON.stringify(data)}`].join('\n');
  }
}
