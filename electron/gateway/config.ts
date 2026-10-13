import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MASK_CONFIG, type MaskConfig } from '../core';
import { DEFAULT_COMMAND_BLOCK, normalizeCommandBlock, type CommandBlockConfig } from '../core/command-block';
import type { ModelPrice } from '../core/usage';
import { DEFAULT_EXT_CONFIG, generateExtToken, type ExtBridgeConfig } from './ext-bridge';
import type { Upstream } from './proxy';

export interface AppConfig {
  maskEnabled: boolean;
  /** 出网代理：'' = 自动（环境变量 → 系统代理），'direct' = 直连，其余为代理 URL */
  egressProxy: string;
  upstreams: Upstream[];
  mask: MaskConfig;
  /** 浏览器扩展桥接 */
  ext: ExtBridgeConfig;
  /** 本地持久化（SQLite） */
  storage: StorageConfig;
  /** 危险命令拦截 */
  commandBlock: CommandBlockConfig;
  /** 被动审计（只标记不拦截） */
  audit: { enabled: boolean };
  /** 用户覆盖的模型价格（USD / 1M tokens），优先于内置参考价 */
  prices: Record<string, ModelPrice>;
  /** 本地语义实体识别（人名 / 机构 / 地址），需先下载模型 */
  ner: NerConfig;
  /** 应用行为 */
  app: AppBehaviorConfig;
}

export interface NerConfig {
  enabled: boolean;
  /** 单个请求的识别总预算（毫秒），超出的文本不再识别并在事件里标注 */
  budgetMs: number;
}

export interface AppBehaviorConfig {
  /** 开机自启（仅桌面版） */
  autostart: boolean;
  /** 启动时检查新版本（访问 GitHub Releases API，默认关闭） */
  checkUpdates: boolean;
}

export const DEFAULT_NER_CONFIG: NerConfig = { enabled: false, budgetMs: 800 };
export const DEFAULT_APP_BEHAVIOR: AppBehaviorConfig = { autostart: false, checkUpdates: false };

export function normalizeNer(n: Partial<NerConfig> | undefined): NerConfig {
  const b = Number(n?.budgetMs);
  return {
    enabled: n?.enabled === true,
    budgetMs: Number.isFinite(b) ? Math.min(10000, Math.max(100, Math.floor(b))) : DEFAULT_NER_CONFIG.budgetMs,
  };
}

export function normalizeAppBehavior(a: Partial<AppBehaviorConfig> | undefined): AppBehaviorConfig {
  return { autostart: a?.autostart === true, checkUpdates: a?.checkUpdates === true };
}

/** 价格覆盖：只保留非负数字，模型名去空白；非法条目丢弃 */
export function normalizePrices(raw: unknown): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  if (!raw || typeof raw !== 'object') return out;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  for (const [model, p] of Object.entries(raw as Record<string, Partial<ModelPrice>>)) {
    const name = model.trim();
    const input = num(p?.input);
    const output = num(p?.output);
    if (!name || input === undefined || output === undefined) continue;
    out[name] = { input, output };
    const cr = num(p?.cacheRead);
    const cw = num(p?.cacheWrite);
    if (cr !== undefined) out[name].cacheRead = cr;
    if (cw !== undefined) out[name].cacheWrite = cw;
  }
  return out;
}

export interface StorageConfig {
  /** 占位符映射是否落盘（凭证类永不落盘） */
  persistMappings: boolean;
  /** 事件历史保留条数上限 */
  maxEvents: number;
}

export const DEFAULT_STORAGE_CONFIG: StorageConfig = { persistMappings: true, maxEvents: 5000 };

export function normalizeStorage(s: Partial<StorageConfig> | undefined): StorageConfig {
  const n = Number(s?.maxEvents);
  return {
    persistMappings: s?.persistMappings ?? DEFAULT_STORAGE_CONFIG.persistMappings,
    maxEvents: Number.isFinite(n) ? Math.min(100000, Math.max(100, Math.floor(n))) : DEFAULT_STORAGE_CONFIG.maxEvents,
  };
}

export const DEFAULT_UPSTREAMS: Upstream[] = [
  { name: 'openai', port: 18701, target: 'https://api.openai.com', paths: ['/v1/chat/completions', '/v1/completions', '/v1/responses'] },
  { name: 'deepseek', port: 18702, target: 'https://api.deepseek.com', paths: ['/v1/chat/completions', '/v1/completions', '/chat/completions'] },
  { name: 'anthropic', port: 18703, target: 'https://api.anthropic.com', paths: ['/v1/messages'] },
];

export function defaultConfig(): AppConfig {
  return {
    maskEnabled: true,
    egressProxy: '',
    upstreams: structuredClone(DEFAULT_UPSTREAMS),
    mask: structuredClone(DEFAULT_MASK_CONFIG),
    ext: { ...DEFAULT_EXT_CONFIG },
    storage: { ...DEFAULT_STORAGE_CONFIG },
    commandBlock: structuredClone(DEFAULT_COMMAND_BLOCK),
    audit: { enabled: true },
    prices: {},
    ner: { ...DEFAULT_NER_CONFIG },
    app: { ...DEFAULT_APP_BEHAVIOR },
  };
}

/** 保存前统一规范化：外部（界面）传入的配置不可信 */
export function normalizeConfig(c: AppConfig): AppConfig {
  return {
    ...c,
    ext: normalizeExt(c.ext),
    storage: normalizeStorage(c.storage),
    commandBlock: normalizeCommandBlock(c.commandBlock),
    audit: { enabled: c.audit?.enabled !== false },
    prices: normalizePrices(c.prices),
    ner: normalizeNer(c.ner),
    app: normalizeAppBehavior(c.app),
  };
}

/** 读配置：缺失字段用默认值补齐（新增规则开关时旧配置自动获得默认值）。 */
export function loadConfig(file: string): AppConfig {
  if (!fs.existsSync(file)) return defaultConfig();
  return mergeConfig(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppConfig>);
}

/** 把原始配置对象按默认值补齐（读盘、导入、还原备份共用）。 */
export function mergeConfig(raw: Partial<AppConfig>): AppConfig {
  const def = defaultConfig();
  return {
    maskEnabled: raw.maskEnabled ?? def.maskEnabled,
    egressProxy: raw.egressProxy ?? def.egressProxy,
    upstreams: raw.upstreams ?? def.upstreams,
    mask: {
      builtinRules: { ...def.mask.builtinRules, ...raw.mask?.builtinRules },
      secretPrefixes: raw.mask?.secretPrefixes ?? def.mask.secretPrefixes,
      customWords: raw.mask?.customWords ?? def.mask.customWords,
    },
    ext: normalizeExt({ ...def.ext, ...raw.ext }),
    storage: normalizeStorage({ ...def.storage, ...raw.storage }),
    commandBlock: normalizeCommandBlock(raw.commandBlock),
    audit: { enabled: raw.audit?.enabled !== false },
    prices: normalizePrices(raw.prices),
    ner: normalizeNer(raw.ner),
    app: normalizeAppBehavior(raw.app),
  };
}

const CONFIG_SECTIONS = ['mask', 'ext', 'storage', 'commandBlock', 'audit', 'ner', 'app'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 导入 / 还原前的结构校验：只拦截会导致运行时崩溃或语义错乱的类型错误。
 * 缺失的字段仍由 mergeConfig 用默认值补齐。
 */
export function assertImportableConfig(raw: unknown): void {
  if (!isPlainObject(raw)) throw new Error('配置必须是 JSON 对象');
  for (const k of CONFIG_SECTIONS) {
    if (raw[k] !== undefined && !isPlainObject(raw[k])) throw new Error(`配置项 ${k} 必须是对象`);
  }
  if (raw.egressProxy !== undefined && typeof raw.egressProxy !== 'string') throw new Error('egressProxy 必须是字符串');
  if (raw.maskEnabled !== undefined && typeof raw.maskEnabled !== 'boolean') throw new Error('maskEnabled 必须是布尔值');
  if (raw.prices !== undefined && !isPlainObject(raw.prices)) throw new Error('prices 必须是对象');
  if (raw.upstreams !== undefined) {
    if (!Array.isArray(raw.upstreams)) throw new Error('upstreams 必须是数组');
    for (const u of raw.upstreams) {
      if (!isPlainObject(u) || typeof u.name !== 'string' || !Number.isInteger(u.port) || typeof u.target !== 'string' || !Array.isArray(u.paths)) {
        throw new Error('upstreams 中存在格式不正确的条目');
      }
    }
  }
  const mask = raw.mask as Record<string, unknown> | undefined;
  if (mask?.customWords !== undefined && !Array.isArray(mask.customWords)) throw new Error('mask.customWords 必须是数组');
  if (mask?.secretPrefixes !== undefined && !Array.isArray(mask.secretPrefixes)) throw new Error('mask.secretPrefixes 必须是数组');
}

/** 导入 / 还原入口：先校验结构，再按默认值补齐并规范化。 */
export function parseConfigInput(raw: unknown): AppConfig {
  assertImportableConfig(raw);
  return normalizeConfig(mergeConfig(raw as Partial<AppConfig>));
}

/** 启用了却没有令牌 = 扩展恒 403，所以启用时保证令牌存在。 */
export function normalizeExt(ext: ExtBridgeConfig): ExtBridgeConfig {
  return ext.enabled && !ext.token ? { ...ext, token: generateExtToken() } : ext;
}

export function saveConfig(file: string, config: AppConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
}
