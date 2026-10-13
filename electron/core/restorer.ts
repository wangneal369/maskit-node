/**
 * 占位符还原。
 *
 * 每个响应一个 Restorer 实例：流式时按通道扣留行尾半截占位符，
 * 正文 delta 与工具参数 delta 互不串扰（共用缓冲会把上个字段的尾巴吐进下个字段）。
 */
import { PARTIAL_MAX, PARTIAL_RX, RESTORE_RX } from './placeholder';
import { normalizeLabel, type MappingStore } from './store';

/** 不还原的块：带签名的思考正文改成明文会让签名校验失败，下一轮历史回放必 400 */
const RESTORE_SKIP_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking', 'thinking_delta', 'signature_delta']);

export interface RestoreStats {
  restored: number;
  /** 形态明确是占位符（双花括号 / 转义）却查不到原文：模型编造或映射已过期 */
  unresolved: number;
  /** 经容错形态或标签兼容回退才还原成功的次数 */
  degraded: number;
}

/** RESTORE_RX 的分支序号：0 转义、1 标准双花括号、2 单/半花括号、3 裸形态 */
const ESCAPED = 0;
const BRACED = 1;

export class Restorer {
  private readonly pending = new Map<string, string>();
  readonly stats: RestoreStats = { restored: 0, unresolved: 0, degraded: 0 };

  constructor(private readonly store: MappingStore) {}

  /**
   * @param channel 流式通道；非流式传 '' 并置 final
   * @param escape  目标是 JSON 文本内部（tool arguments / partial_json），原文需按 JSON 转义
   * @param final   不再等后续 chunk，缓冲一次吐出
   */
  restore(text: string, channel = '', escape = false, final = false): string {
    const buf = (this.pending.get(channel) ?? '') + text;
    let confirmed = buf;
    this.pending.delete(channel);
    if (!final) {
      const m = PARTIAL_RX.exec(buf);
      if (m && m[0] && m[0].length <= PARTIAL_MAX) {
        confirmed = buf.slice(0, m.index);
        this.pending.set(channel, m[0]);
      }
    }
    if (!confirmed) return '';
    const enc = (s: string) => (escape ? JSON.stringify(s).slice(1, -1) : s);

    // 单遍替换：换回的原文不会再被扫描，杜绝「原文恰好长得像占位符」时的二次还原
    return confirmed.replace(RESTORE_RX, (whole: string, ...groups: (string | undefined)[]) => {
      const branch = [0, 2, 4, 6].findIndex((i) => groups[i] !== undefined);
      const label = groups[branch * 2]!;
      const suffix = groups[branch * 2 + 1]!;
      const hit = this.store.resolve(label, suffix);
      if (!hit) {
        // 只有「明确是占位符」的形态才计未还原；单花括号与裸形态可能只是普通文本
        if (branch === ESCAPED || branch === BRACED) this.stats.unresolved++;
        return whole;
      }
      this.stats.restored++;
      // 与签发时的 token 逐字一致才算原样还原，其余（改写标签、空白、转义、缺括号）都记为降级
      if (!hit.exact || whole !== `{{${normalizeLabel(label)}_${suffix.toLowerCase()}}}`) this.stats.degraded++;
      return enc(hit.orig);
    });
  }

  /** 通道结束：吐出该通道扣留的内容（已还原）；无扣留返回空串。 */
  flush(channel: string, escape = false): string {
    return this.pending.has(channel) ? this.restore('', channel, escape, true) : '';
  }

  pendingChannels(): string[] {
    return [...this.pending.keys()];
  }

  /** 非流式 JSON 响应：递归还原所有字符串叶子（跳过签名块）。 */
  restoreTree(obj: unknown, depth = 0): unknown {
    if (depth > 64) return obj;
    if (typeof obj === 'string') return this.restore(obj, '', false, true);
    if (Array.isArray(obj)) return obj.map((v) => this.restoreTree(v, depth + 1));
    if (obj && typeof obj === 'object') {
      const rec = obj as Record<string, unknown>;
      if (typeof rec.type === 'string' && RESTORE_SKIP_BLOCK_TYPES.has(rec.type)) return obj;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) out[k] = k === 'signature' ? v : this.restoreTree(v, depth + 1);
      return out;
    }
    return obj;
  }
}
