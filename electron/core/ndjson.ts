/**
 * NDJSON 流式还原（Ollama `/api/chat`、`/api/generate`）。
 *
 * 一行一个 JSON 对象，按 `\n` 分帧；只改「文本槽位」，其余字段整树还原后逐行重新序列化。
 * 跨行的半截占位符由 Restorer 按通道扣留；`done: true` 是所有通道的终点，
 * 残留在 done 行之前以合成行吐出（克隆该通道最后一行，仅保留残留文本，去掉统计字段）。
 */
import type { Restorer } from './restorer';
import { getAt, setAt, type SseHooks } from './sse';
import { mapToolArgs } from './tool-args';

type Path = (string | number)[];
type Rec = Record<string, unknown>;

interface Slot {
  channel: string;
  path: Path;
}

interface Template {
  data: string;
  path: Path;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

/** 阻断时下发的错误行（Ollama 流内错误的标准形态是 {"error": "..."}） */
const BLOCK_LINE = `${JSON.stringify({ error: 'Data Maskit 已阻断模型下发的危险命令（maskit_command_blocked）' })}\n`;

/** 合成行里要去掉的统计字段：保留会让客户端重复累计 */
const STAT_FIELDS = [
  'total_duration', 'load_duration', 'prompt_eval_count', 'prompt_eval_duration',
  'eval_count', 'eval_duration', 'done_reason', 'context',
];

/** 列出一行里的文本槽位（每个字段独立通道） */
export function ndjsonTextSlots(data: unknown): Slot[] {
  const slots: Slot[] = [];
  if (!isRec(data)) return slots;
  if (isRec(data.message)) {
    if (isStr(data.message.content)) slots.push({ channel: 'o.message.content', path: ['message', 'content'] });
    if (isStr(data.message.thinking)) slots.push({ channel: 'o.message.thinking', path: ['message', 'thinking'] });
  }
  if (isStr(data.response)) slots.push({ channel: 'o.response', path: ['response'] });
  if (isStr(data.thinking)) slots.push({ channel: 'o.thinking', path: ['thinking'] });
  return slots;
}

export class NdjsonRestorer {
  private buf = '';
  private readonly templates = new Map<string, Template>();
  private isBlocked = false;

  constructor(private readonly restorer: Restorer, private readonly hooks: SseHooks = {}) {}

  /** 已因危险命令阻断：调用方应停止转发并结束响应 */
  get blocked(): boolean {
    return this.isBlocked;
  }

  /** 喂入一段解码后的文本，返回可立即下发的文本（不完整的行留在缓冲区）。 */
  push(chunk: string): string {
    if (this.isBlocked) return '';
    this.buf += chunk;
    let out = '';
    for (;;) {
      const i = this.buf.indexOf('\n');
      if (i < 0) break;
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      const handled = this.handleLine(line);
      if (this.isBlocked) return out + BLOCK_LINE;
      out += `${handled}\n`;
    }
    return out;
  }

  /** 流结束：处理没有换行结尾的最后一行，并吐出所有通道的扣留内容。 */
  end(): string {
    if (this.isBlocked) return '';
    let out = this.buf ? this.handleLine(this.buf) : '';
    this.buf = '';
    const tail = this.isBlocked ? '' : this.flushChannels();
    if (tail && out && !out.endsWith('\n')) out += '\n';
    return this.isBlocked ? BLOCK_LINE : out + tail;
  }

  private handleLine(raw: string): string {
    const cr = raw.endsWith('\r') ? '\r' : '';
    const body = cr ? raw.slice(0, -1) : raw;
    if (!body.trim()) return raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return raw;
    }
    if (!isRec(parsed)) return raw;
    this.hooks.onData?.(parsed);

    const slots = ndjsonTextSlots(parsed);
    const done = parsed.done === true;
    // 先吐出「更早行」扣留的残留（顺序不能反），作为合成行排在 done 行之前；
    // 仅当 done 行本身在该通道带有非空文本（可能续接半截占位符）时，才交给下面带 final 的还原
    const prefix = done
      ? this.flushChannels(new Set(slots.filter((s) => getAt(parsed, s.path) !== '').map((s) => s.channel)))
      : '';

    // 槽位走流式扣留，其余字段整树还原：先清空槽位，避免整树还原重复计数
    const texts = slots.map((s) => getAt(parsed, s.path) as string);
    for (const s of slots) setAt(parsed, s.path, '');
    let data = this.restorer.restoreTree(parsed);
    // 工具参数（对象，整行完整）：闸门模式过闸，否则只上报供「仅记录」终态扫描
    if (body.includes('"arguments"')) {
      data = mapToolArgs(data, (args) => {
        if (this.hooks.toolGate) return this.applyGate('o.tool', args);
        this.hooks.onText?.('o.tool', args, true);
        return args;
      });
    }
    slots.forEach((s, i) => {
      this.templates.set(s.channel, { data: body, path: s.path });
      const restored = this.restorer.restore(texts[i], s.channel, false, done);
      if (restored) this.hooks.onText?.(s.channel, restored, false);
      setAt(data, s.path, restored);
    });
    return prefix + JSON.stringify(data) + cr;
  }

  /** 交给闸门；阻断时置位并返回空串（调用方随后下发错误行并停止） */
  private applyGate(channel: string, args: string): string {
    if (!args || !this.hooks.toolGate) return args;
    this.hooks.onText?.(channel, args, true);
    const r = this.hooks.toolGate(channel, args);
    if (r.block) {
      this.isBlocked = true;
      return '';
    }
    return r.text;
  }

  /** 为有扣留的通道补发合成行（每行以 \n 结尾）。 */
  private flushChannels(except?: Set<string>): string {
    let out = '';
    for (const ch of this.restorer.pendingChannels()) {
      if (except?.has(ch)) continue;
      const tpl = this.templates.get(ch);
      if (!tpl) continue;
      const left = this.restorer.flush(ch, false);
      if (!left) continue;
      this.hooks.onText?.(ch, left, false);
      out += `${JSON.stringify(this.synthetic(tpl, left))}\n`;
    }
    return out;
  }

  /** 由模板克隆只携带残留文本的行：其它槽位清空，done 置 false，统计字段与工具调用去掉。 */
  private synthetic(tpl: Template, text: string): unknown {
    const data = JSON.parse(tpl.data) as Rec;
    for (const s of ndjsonTextSlots(data)) setAt(data, s.path, '');
    setAt(data, tpl.path, text);
    if ('done' in data) data.done = false;
    for (const k of STAT_FIELDS) delete data[k];
    if (isRec(data.message)) delete data.message.tool_calls;
    return data;
  }
}
