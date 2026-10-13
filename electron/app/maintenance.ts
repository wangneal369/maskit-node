/**
 * 运维辅助：配置备份命名、诊断信息脱敏、版本号比较。纯函数，不依赖 Electron。
 */
import type { AppConfig } from '../gateway/config';
import type { GatewayEvent } from '../gateway/proxy';

/** 配置备份保留份数（超出的最旧备份在写入新备份时删除） */
export const CONFIG_BACKUP_KEEP = 10;
/** 备份文件名白名单：还原时用它防止路径穿越 */
export const CONFIG_BACKUP_NAME_RE = /^maskit-config-[0-9-]+\.json$/;
/** 诊断包里保留的最近事件条数 */
export const DIAG_EVENTS_LIMIT = 50;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** maskit-config-YYYYMMDD-HHmmss-SSS.json（本机时区；定宽，字典序即时间序） */
export function configBackupFileName(d: Date): string {
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `maskit-config-${date}-${time}-${pad(d.getMilliseconds(), 3)}.json`;
}

export function isConfigBackupName(name: string): boolean {
  return CONFIG_BACKUP_NAME_RE.test(name);
}

/** 去掉 URL 中的代理密码（scheme://user:pass@host → scheme://user:***@host） */
export function redactProxyUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/:@]*):[^@/]*@/i, '$1:***@');
}

/**
 * 诊断用配置副本：扩展令牌与自定义词原文脱敏；代理密码去除。其余字段原样保留。
 */
export function redactConfig(c: AppConfig): Record<string, unknown> {
  const words = c.mask.customWords ?? [];
  const labels = [...new Set(words.map((w) => w.label).filter((l): l is string => !!l))];
  return {
    ...structuredClone(c),
    egressProxy: c.egressProxy ? redactProxyUrl(c.egressProxy) : c.egressProxy,
    ext: { ...c.ext, token: c.ext.token ? '***' : '' },
    mask: { ...structuredClone(c.mask), customWords: { count: words.length, labels } },
  };
}

/** 诊断用事件：占位符令牌不导出，只保留标签 */
export function redactEvent(ev: GatewayEvent): GatewayEvent {
  return { ...ev, hits: ev.hits.map((h) => ({ label: h.label, token: '' })) };
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 比较两个语义化版本号（允许前导 v，忽略构建元数据）。
 * 返回 1 / 0 / -1；任一方无法解析返回 null。预发布标识按字符串比较（足够用于本应用的发布节奏）。
 */
export function compareVersions(a: string, b: string): number | null {
  const x = VERSION_RE.exec(a.trim().replace(/^v/i, ''));
  const y = VERSION_RE.exec(b.trim().replace(/^v/i, ''));
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  const pa = x[4] ?? '';
  const pb = y[4] ?? '';
  if (pa === pb) return 0;
  // 无预发布标识的正式版高于预发布版
  if (!pa) return 1;
  if (!pb) return -1;
  return pa > pb ? 1 : -1;
}
