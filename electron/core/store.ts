/**
 * 占位符映射表：原文 ↔ 占位符。
 *
 * 全局复用窗口：同一原文在窗口内始终映射到同一占位符，
 * 多轮对话里「张三」第 1 轮和第 10 轮是同一个 {{TERM_xxx}}，模型推理不串号。
 * 还原只认本表签发过的占位符——查不到就原样保留，绝不猜。
 */
import { createHash, randomInt } from 'node:crypto';

/** 纯辅音：不与英文单词相交，且去掉 l/i/o 防与 1/0 形近。 */
export const TOKEN_ALPHABET = 'bcdfghjkmnpqrstvwxz';
/** 兼容存量 hex6 后缀 */
export const SUFFIX_PAT = '(?:[0-9a-f]{6}|[bcdfghjkmnpqrstvwxz]{6})';

export function safeLabel(label: string): string {
  return label.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12) || 'TERM';
}

export function tokenSuffix(token: string): string {
  return token.slice(-8, -2);
}

function randSuffix(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
  return s;
}

/** 自定义词的确定性后缀：跨重启稳定，利于上游前缀缓存命中。 */
export function deterministicSuffix(orig: string, used?: Set<string>): string {
  for (let counter = 0; ; counter++) {
    const h = createHash('sha256').update(`maskit_cw:${counter}:${orig}`, 'utf8').digest();
    let s = '';
    for (let i = 0; i < 6; i++) s += TOKEN_ALPHABET[h[i] % TOKEN_ALPHABET.length];
    if (!used?.has(s)) return s;
  }
}

interface Entry {
  orig: string;
  label: string;
  token: string;
  lastUsed: number;
  /** 自定义词：常驻，不参与 TTL/LRU 淘汰 */
  pinned: boolean;
}

export interface StoreOptions {
  maxEntries?: number;
  ttlMs?: number;
}

export class MappingStore {
  private readonly fwd = new Map<string, Entry>();
  private readonly rev = new Map<string, Entry>();
  private readonly bySuffix = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(opts: StoreOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 2000;
    this.ttlMs = opts.ttlMs ?? 24 * 3600 * 1000;
  }

  get size(): number {
    return this.fwd.size;
  }

  /** 取（或签发）原文对应的占位符。 */
  tokenFor(orig: string, label: string, pinned = false): string {
    const now = Date.now();
    const hit = this.fwd.get(orig);
    if (hit) {
      hit.lastUsed = now;
      // Map 保持插入序：删后重插 = 移到 LRU 尾部
      this.fwd.delete(orig);
      this.fwd.set(orig, hit);
      return hit.token;
    }
    const lab = safeLabel(label);
    let suffix = pinned ? deterministicSuffix(orig, new Set(this.bySuffix.keys())) : randSuffix();
    while (this.bySuffix.has(suffix)) suffix = randSuffix();
    const entry: Entry = { orig, label: lab, token: `{{${lab}_${suffix}}}`, lastUsed: now, pinned };
    this.fwd.set(orig, entry);
    this.rev.set(entry.token, entry);
    this.bySuffix.set(suffix, entry);
    this.prune(now);
    return entry.token;
  }

  /** 按完整占位符查原文；标签被模型改写时退回按后缀查。 */
  lookup(token: string): string | undefined {
    const e = this.rev.get(token) ?? this.bySuffix.get(tokenSuffix(token));
    if (!e) return undefined;
    e.lastUsed = Date.now();
    return e.orig;
  }

  /** 裸占位符（模型剥掉了花括号）只在标签与后缀都对得上时才还原。 */
  lookupBare(label: string, suffix: string): string | undefined {
    const e = this.bySuffix.get(suffix);
    return e && e.label === label ? e.orig : undefined;
  }

  clear(keepPinned = true): void {
    for (const e of [...this.fwd.values()]) {
      if (!keepPinned || !e.pinned) this.remove(e);
    }
  }

  private remove(e: Entry): void {
    this.fwd.delete(e.orig);
    this.rev.delete(e.token);
    this.bySuffix.delete(tokenSuffix(e.token));
  }

  private prune(now: number): void {
    for (const e of this.fwd.values()) {
      if (this.fwd.size <= this.maxEntries && now - e.lastUsed <= this.ttlMs) break;
      if (!e.pinned) this.remove(e);
    }
  }
}
