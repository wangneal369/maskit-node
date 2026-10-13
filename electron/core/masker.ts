/**
 * 文本脱敏（确定性部分：前缀凭据 → 自定义词 → 内置规则）。
 */
import { mapOutsidePlaceholders } from './placeholder';
import {
  buildPrefixRegex, DEFAULT_BUILTIN_RULES, DEFAULT_SECRET_PREFIXES, RULE_MARKERS, RULE_MARKERS_CI, RULES,
  type Rule, type RuleLabel,
} from './rules';
import { MappingStore } from './store';

export interface CustomWord {
  /** 普通词按字面量（大小写不敏感）；以 `re:` 开头按正则 */
  word: string;
  label?: string;
  enabled?: boolean;
  /** 整词匹配（仅对 ASCII 边界生效） */
  wholeWord?: boolean;
}

export interface MaskConfig {
  builtinRules: Record<RuleLabel, boolean>;
  secretPrefixes: string[];
  customWords: CustomWord[];
}

export interface MaskHit {
  label: string;
  token: string;
  orig: string;
}

export const DEFAULT_MASK_CONFIG: MaskConfig = {
  builtinRules: { ...DEFAULT_BUILTIN_RULES },
  secretPrefixes: [...DEFAULT_SECRET_PREFIXES],
  customWords: [],
};

const ESC_RX = /[.*+?^${}()|[\]\\]/g;
/** 单字词边界含汉字，避免「密」打中「密码」 */
const SINGLE_BOUND = 'A-Za-z0-9_\\u4e00-\\u9fff';
const WHOLE_BOUND = 'A-Za-z0-9_';

interface WordPlan {
  rx: RegExp;
  /** 字面量：小写命中 → [原始词, 标签]；正则型：固定标签 */
  literal?: Map<string, [string, string]>;
  label?: string;
}

function buildWordPlans(words: CustomWord[]): WordPlan[] {
  const plans: WordPlan[] = [];
  const literal = new Map<string, [string, string]>();
  const parts: string[] = [];
  const active = words.filter((w) => w.enabled !== false && w.word.trim());
  // 长词优先，避免短词先吃掉长词的一部分
  for (const w of [...active].sort((a, b) => b.word.length - a.word.length)) {
    const label = w.label || 'TERM';
    if (w.word.startsWith('re:')) {
      try {
        plans.push({ rx: new RegExp(w.word.slice(3), 'g'), label });
      } catch {
        // 坏正则只毁它自己，不影响整张词表
      }
      continue;
    }
    const esc = w.word.replace(ESC_RX, '\\$&');
    const bound = w.word.length === 1 ? SINGLE_BOUND : w.wholeWord ? WHOLE_BOUND : '';
    parts.push(bound ? `(?<![${bound}])${esc}(?![${bound}])` : esc);
    literal.set(w.word.toLowerCase(), [w.word, label]);
  }
  if (parts.length) plans.unshift({ rx: new RegExp(parts.join('|'), 'gi'), literal });
  return plans;
}

/** 位于 scheme://userinfo 内部：EMAIL 必须避让，否则「口令尾@host」被当邮箱吃掉留下半截明文。 */
const IN_CONN_USERINFO_RX = /:\/\/[^\s@/]*$/;

export class Masker {
  private config: MaskConfig = DEFAULT_MASK_CONFIG;
  private prefixRx: RegExp | null = buildPrefixRegex(DEFAULT_SECRET_PREFIXES);
  private wordPlans: WordPlan[] = [];

  constructor(readonly store: MappingStore = new MappingStore(), config?: MaskConfig) {
    if (config) this.configure(config);
  }

  configure(config: MaskConfig): void {
    this.config = config;
    this.prefixRx = buildPrefixRegex(config.secretPrefixes);
    this.wordPlans = buildWordPlans(config.customWords);
  }

  /**
   * 脱敏单段文本；hits 收集本次命中（同一原文只记一次）。
   * entities：NER 识别出的实体（key = 实体原文，value = 标签 NAME/ORG/ADDR），
   * 在全部确定性规则之后替换，占位符内部不动；不传则行为与旧版完全一致。
   */
  mask(text: string, hits?: Map<string, MaskHit>, entities?: ReadonlyMap<string, string>): string {
    if (!text) return text;
    const hit = (orig: string, label: string, pinned = false): string => {
      const token = this.store.tokenFor(orig, label, pinned);
      if (hits && !hits.has(orig)) hits.set(orig, { label, token, orig });
      return token;
    };

    const prefixRx = this.prefixRx;
    if (this.config.builtinRules.API_KEY && prefixRx) {
      text = mapOutsidePlaceholders(text, (c) => c.replace(prefixRx, (m) => hit(m, 'API_KEY')));
    }

    for (const plan of this.wordPlans) {
      text = mapOutsidePlaceholders(text, (c) => c.replace(plan.rx, (m) => {
        if (plan.literal) {
          // 大小写变体统一用词表原始 key（ACME/acme 复用同一占位符）
          const [orig, label] = plan.literal.get(m.toLowerCase()) ?? [m, 'TERM'];
          return hit(orig, label, true);
        }
        // 正则型：原文是命中文本本身，每个命中各自建映射
        return m ? hit(m, plan.label ?? 'TERM', true) : m;
      }));
    }

    let lower: string | undefined;
    for (const rule of RULES) {
      if (!this.config.builtinRules[rule.label]) continue;
      const markers = RULE_MARKERS[rule.label];
      if (markers) {
        // 大小写不敏感的规则（如 IPv6 十六进制）按小写文本比对标记；小写副本惰性生成一次
        const hay = RULE_MARKERS_CI.has(rule.label) ? (lower ??= text.toLowerCase()) : text;
        if (!markers.some((mk) => hay.includes(mk))) continue;
      }
      const next = mapOutsidePlaceholders(text, (c) => applyRule(c, rule, hit));
      if (next !== text) {
        text = next;
        lower = undefined; // 文本变了，小写副本作废
      }
    }

    const ent = entities && entities.size ? entityPlan(entities) : null;
    if (ent) {
      text = mapOutsidePlaceholders(text, (c) => c.replace(ent.rx, (m) => hit(m, ent.labels.get(m) ?? 'NAME')));
    }
    return text;
  }
}

/** 实体最短长度：单字实体（常见字/姓氏）误伤面太大，与 Python 引擎口径一致 */
const MIN_ENTITY_CHARS = 2;

interface EntityPlan {
  rx: RegExp;
  labels: ReadonlyMap<string, string>;
}

/**
 * 实体合并正则按 Map 对象缓存：maskJson 对每个字符串叶子各调一次 mask，
 * 每叶子重建一次正则就是 O(叶子数 × 实体数)（Python 版踩过的坑）。
 * 一条正则、最长优先的交替，对每个叶子只扫一遍。
 */
const entityPlans = new WeakMap<ReadonlyMap<string, string>, EntityPlan | null>();

function entityPlan(entities: ReadonlyMap<string, string>): EntityPlan | null {
  let plan = entityPlans.get(entities);
  if (plan !== undefined) return plan;
  const words = [...entities.keys()].filter((w) => w.length >= MIN_ENTITY_CHARS).sort((a, b) => b.length - a.length);
  plan = words.length
    ? { rx: new RegExp(words.map((w) => w.replace(ESC_RX, '\\$&')).join('|'), 'g'), labels: entities }
    : null;
  entityPlans.set(entities, plan);
  return plan;
}

function applyRule(text: string, rule: Rule, hit: (orig: string, label: string) => string): string {
  let out = '';
  let last = 0;
  rule.rx.lastIndex = 0;
  for (const m of text.matchAll(rule.rx)) {
    const orig = m[rule.group];
    if (orig === undefined) continue;
    if (rule.validate && !rule.validate(orig, m as unknown as RegExpExecArray, text)) continue;
    if (rule.label === 'EMAIL' && IN_CONN_USERINFO_RX.test(text.slice(Math.max(0, m.index - 256), m.index))) continue;
    const token = hit(orig, rule.label);
    const [gs, ge] = rule.group === 0 ? [m.index, m.index + m[0].length] : m.indices![rule.group]!;
    out += text.slice(last, gs) + token;
    last = ge;
  }
  return last === 0 ? text : out + text.slice(last);
}
