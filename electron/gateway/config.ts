import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MASK_CONFIG, type MaskConfig } from '../core';
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
