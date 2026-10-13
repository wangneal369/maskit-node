/**
 * 占位符还原（对应 Python 版 restore / _restore_tree）。
 *
 * 每个响应一个 Restorer 实例：流式时按通道扣留行尾半截占位符，
 * 正文 delta 与工具参数 delta 互不串扰（共用缓冲会把上个字段的尾巴吐进下个字段）。
 */
import {
  BARE_PLACEHOLDER_RX, BRACED_PLACEHOLDER_RX, PARTIAL_MAX, PARTIAL_RX,
} from './placeholder';
import type { MappingStore } from './store';

/** 不还原的块：带签名的思考正文改成明文会让签名校验失败，下一轮历史回放必 400 */
const RESTORE_SKIP_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking', 'thinking_delta', 'signature_delta']);

export interface RestoreStats {
  restored: number;
  unresolved: number;
}

export class Restorer {
  private readonly pending = new Map<string, string>();
  readonly stats: RestoreStats = { restored: 0, unresolved: 0 };

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

    let out = confirmed.replace(BRACED_PLACEHOLDER_RX, (whole, label: string, suffix: string) => {
      const orig = this.store.lookup(`{{${label.toUpperCase()}_${suffix.toLowerCase()}}}`);
      if (orig === undefined) {
        this.stats.unresolved++;
        return whole;
      }
      this.stats.restored++;
      return enc(orig);
    });
    out = out.replace(BARE_PLACEHOLDER_RX, (whole, label: string, suffix: string) => {
      const orig = this.store.lookupBare(label, suffix);
      if (orig === undefined) return whole;
      this.stats.restored++;
      return enc(orig);
    });
    return out;
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
