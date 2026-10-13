/**
 * 占位符映射表：原文 ↔ 占位符。
 *
 * 全局复用窗口：同一原文在窗口内始终映射到同一占位符，
 * 多轮对话里「张三」第 1 轮和第 10 轮是同一个 {{TERM_xxx}}，模型推理不串号。
 * 还原只认本表签发过的占位符——查不到就原样保留，绝不猜。
 */
import { createHash, randomInt } from 'node:crypto';
import { isCredentialLabel } from './credential-labels';

/** 凭证族标签：SECRET, PASSWORD, PASSWD, PWD, TOKEN, APIKEY, ACCESSKEY, PRIVATEKEY, CONNSTR */
const CREDENTIAL_FAMILY = new Set(['SECRET', 'PASSWORD', 'PASSWD', 'PWD', 'TOKEN', 'APIKEY', 'ACCESSKEY', 'PRIVATEKEY', 'CONNSTR']);

/** IP 族标签：IPPRIVATE, IPINTERNAL, IP */
const IP_FAMILY = new Set(['IPPRIVATE', 'IPINTERNAL', 'IP']);

/** 纯辅音：不与英文单词相交，且去掉 l/i/o 防与 1/0 形近。 */
export const TOKEN_ALPHABET = 'bcdfghjkmnpqrstvwxz';
/** 兼容存量 hex6 后缀 */
export const SUFFIX_PAT = '(?:[0-9a-f]{6}|[bcdfghjkmnpqrstvwxz]{6})';

export function safeLabel(label: string): string {
  return label.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12) || 'TERM';
}

/**
 * 规范化标签：大写 + 移除非字母数字。
 * 用于后缀回退时的标签兼容性检查。
 */
export function normalizeLabel(label: string): string {
  return label.toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

/**
 * 检查两个标签是否兼容：
 * - 相等；或
 * - 都在凭证族；或
 * - 都在 IP 族
 */
export function areLabelsCompatible(label1: string, label2: string): boolean {
  const norm1 = normalizeLabel(label1);
  const norm2 = normalizeLabel(label2);
  if (norm1 === norm2) return true;
  if (CREDENTIAL_FAMILY.has(norm1) && CREDENTIAL_FAMILY.has(norm2)) return true;
  if (IP_FAMILY.has(norm1) && IP_FAMILY.has(norm2)) return true;
  return false;
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

/** 可持久化的映射条目（与 Entry 同形，对外暴露用） */
export interface PersistedMapping {
  token: string;
  orig: string;
  label: string;
  lastUsed: number;
  pinned: boolean;
}

/**
 * 持久化钩子：store 本身不依赖 SQLite/Electron，只在变更时回调。
 * 凭证类标签的条目永远不会触发这些回调（隐私硬约束）。
 */
export interface StorePersistHooks {
  onAdd(e: PersistedMapping): void;
  onRemove(tokens: string[]): void;
  onClear(keepPinned: boolean): void;
}

export interface StoreOptions {
  maxEntries?: number;
  ttlMs?: number;
  persist?: StorePersistHooks;
}

export class MappingStore {
  private readonly fwd = new Map<string, Entry>();
  private readonly rev = new Map<string, Entry>();
  private readonly bySuffix = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly persist?: StorePersistHooks;
  /** lastUsed 变动但尚未落盘的占位符（仅非凭证） */
  private readonly touched = new Set<string>();

  constructor(opts: StoreOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 2000;
    this.ttlMs = opts.ttlMs ?? 24 * 3600 * 1000;
    this.persist = opts.persist;
  }

  /** 当前全部条目（LRU 旧→新），供外部整体写盘。 */
  entries(): PersistedMapping[] {
    return [...this.fwd.values()].map(toPersisted);
  }

  /** 自上次 markClean 以来 lastUsed 有变动、且仍在表中的非凭证条目。 */
  exportDirty(): PersistedMapping[] {
    const out: PersistedMapping[] = [];
    for (const t of this.touched) {
      const e = this.rev.get(t);
      if (e && !isCredentialLabel(e.label)) out.push(toPersisted(e));
    }
    return out;
  }

  /** 标记已落盘；不传则清空全部脏标记。 */
  markClean(tokens?: string[]): void {
    if (!tokens) this.touched.clear();
    else for (const t of tokens) this.touched.delete(t);
  }

  /**
   * 启动时批量装载持久化条目：重建 fwd/rev/bySuffix，按 lastUsed 升序插入以保持 LRU 序；
   * 跳过凭证标签、已过期的非常驻条目、与现有条目冲突者；超 maxEntries 则淘汰最旧非常驻。
   * 不触发 onAdd（本来就在盘上）；因超限被淘汰的会触发 onRemove。返回成功装载（含随后被淘汰）的条数。
   */
  restore(entries: PersistedMapping[]): number {
    const now = Date.now();
    const sorted = [...entries].sort((a, b) => a.lastUsed - b.lastUsed);
    let n = 0;
    for (const r of sorted) {
      if (isCredentialLabel(r.label)) continue;
      if (!r.pinned && now - r.lastUsed > this.ttlMs) continue;
      const suffix = tokenSuffix(r.token);
      if (this.fwd.has(r.orig) || this.rev.has(r.token) || this.bySuffix.has(suffix)) continue;
      const entry: Entry = { orig: r.orig, label: r.label, token: r.token, lastUsed: r.lastUsed, pinned: r.pinned };
      this.fwd.set(entry.orig, entry);
      this.rev.set(entry.token, entry);
      this.bySuffix.set(suffix, entry);
      n++;
    }
    this.prune(now);
    return n;
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
      this.touch(hit);
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
    if (this.persist && !isCredentialLabel(lab)) this.persist.onAdd(toPersisted(entry));
    this.prune(now);
    return entry.token;
  }

  /**
   * 按「标签 + 后缀」解析原文，所有还原形态共用这一个入口。
   * - 精确命中（归一化后的标签与签发时一致）→ exact = true；
   * - 否则按后缀反查，但**标签必须兼容**（相等，或同属凭据族 / IP 族）：
   *   只看后缀会在撞后缀或模型改写标签时把 A 的原文填进 B 的位置，属于静默填错值。
   */
  resolve(label: string, suffix: string): { orig: string; exact: boolean } | undefined {
    const lab = normalizeLabel(label);
    const suf = suffix.toLowerCase();
    const exact = this.rev.get(`{{${lab}_${suf}}}`);
    const e = exact ?? this.bySuffix.get(suf);
    if (!e || (!exact && !areLabelsCompatible(lab, e.label))) return undefined;
    e.lastUsed = Date.now();
    this.touch(e);
    return { orig: e.orig, exact: !!exact };
  }

  /** 按完整占位符查原文（标签被改写时按兼容规则回退到后缀）。 */
  lookup(token: string): string | undefined {
    const m = /^\{\{([A-Za-z0-9_]{1,12})_([0-9a-z]{6})\}\}$/.exec(token);
    return m ? this.resolve(m[1], m[2])?.orig : undefined;
  }

  /** 裸占位符（模型剥掉了花括号）：同样只在标签兼容时还原。 */
  lookupBare(label: string, suffix: string): string | undefined {
    return this.resolve(label, suffix)?.orig;
  }

  clear(keepPinned = true): void {
    for (const e of [...this.fwd.values()]) {
      if (!keepPinned || !e.pinned) this.remove(e);
    }
    this.persist?.onClear(keepPinned);
  }

  private touch(e: Entry): void {
    if (this.persist && !isCredentialLabel(e.label)) this.touched.add(e.token);
  }

  private remove(e: Entry): void {
    this.fwd.delete(e.orig);
    this.rev.delete(e.token);
    this.bySuffix.delete(tokenSuffix(e.token));
    this.touched.delete(e.token);
  }

  private prune(now: number): void {
    const removed: string[] = [];
    for (const e of [...this.fwd.values()]) {
      if (this.fwd.size <= this.maxEntries && now - e.lastUsed <= this.ttlMs) break;
      if (!e.pinned) {
        this.remove(e);
        if (!isCredentialLabel(e.label)) removed.push(e.token);
      }
    }
    if (removed.length) this.persist?.onRemove(removed);
  }
}

function toPersisted(e: Entry): PersistedMapping {
  return { token: e.token, orig: e.orig, label: e.label, lastUsed: e.lastUsed, pinned: e.pinned };
}
