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
  };
}

/** 读配置：缺失字段用默认值补齐（新增规则开关时旧配置自动获得默认值）。 */
export function loadConfig(file: string): AppConfig {
  const def = defaultConfig();
  if (!fs.existsSync(file)) return def;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppConfig>;
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
  };
}

/** 启用了却没有令牌 = 扩展恒 403，所以启用时保证令牌存在。 */
export function normalizeExt(ext: ExtBridgeConfig): ExtBridgeConfig {
  return ext.enabled && !ext.token ? { ...ext, token: generateExtToken() } : ext;
}

export function saveConfig(file: string, config: AppConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
}
