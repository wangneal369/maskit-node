/**
 * 应用内更新的纯逻辑（不依赖 electron / electron-updater，可单元测试）。
 */

export type UpdaterStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';

export interface UpdaterProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdaterState {
  supported: boolean;
  platformNote?: string;
  status: UpdaterStatus;
  version?: string;
  releaseNotes?: string;
  progress?: UpdaterProgress;
  error?: string;
}

export const MAC_NOTE = 'macOS 版本未签名，无法自动安装，请前往下载页更新';
export const DEV_NOTE = '开发模式不支持应用内更新';
export const LINUX_UNSUPPORTED_NOTE = '当前 Linux 安装形态不支持自动更新，请前往下载页更新';
export const LINUX_DEB_NOTE = 'Linux deb 更新安装时会弹出系统授权窗口，需要输入管理员密码';

/** 判定本平台是否支持应用内更新（与 CPU 架构无关：Windows 任意架构支持，Linux deb 任意架构支持，macOS 一律不支持）。packageType 来自 resources/package-type（仅 Linux fpm 包有） */
export function decideSupport(opts: {
  platform: string;
  packaged: boolean;
  packageType?: string | null;
}): { supported: boolean; platformNote?: string } {
  if (!opts.packaged) return { supported: false, platformNote: DEV_NOTE };
  if (opts.platform === 'darwin') return { supported: false, platformNote: MAC_NOTE };
  if (opts.platform === 'linux') {
    return opts.packageType === 'deb'
      ? { supported: true, platformNote: LINUX_DEB_NOTE }
      : { supported: false, platformNote: LINUX_UNSUPPORTED_NOTE };
  }
  if (opts.platform === 'win32') return { supported: true };
  return { supported: false, platformNote: LINUX_UNSUPPORTED_NOTE };
}

export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string; releaseNotes?: string }
  | { type: 'not-available'; version?: string }
  | { type: 'progress'; progress: UpdaterProgress }
  | { type: 'downloaded'; version?: string }
  | { type: 'error'; message: string };

export function initialState(support: { supported: boolean; platformNote?: string }): UpdaterState {
  return { supported: support.supported, platformNote: support.platformNote, status: 'idle' };
}

/** 状态归约：返回新对象，不修改入参 */
export function reduceState(s: UpdaterState, e: UpdaterEvent): UpdaterState {
  switch (e.type) {
    case 'checking':
      return { ...s, status: 'checking', error: undefined, progress: undefined };
    case 'available':
      return { ...s, status: 'available', version: e.version, releaseNotes: e.releaseNotes, error: undefined, progress: undefined };
    case 'not-available':
      return { ...s, status: 'not-available', version: e.version ?? s.version, releaseNotes: undefined, error: undefined, progress: undefined };
    case 'progress':
      return { ...s, status: 'downloading', progress: e.progress, error: undefined };
    case 'downloaded':
      return {
        ...s,
        status: 'downloaded',
        version: e.version ?? s.version,
        progress: s.progress ? { ...s.progress, percent: 100 } : undefined,
        error: undefined,
      };
    case 'error':
      return { ...s, status: 'error', error: e.message };
  }
}

/** 是否允许发起下载（available，或已知新版本但下载失败后重试） */
export function canDownload(s: UpdaterState): boolean {
  return s.supported && (s.status === 'available' || (s.status === 'error' && !!s.version));
}

/**
 * 把 electron-updater 的 releaseNotes（HTML 字符串 / {version,note}[] / null）压成纯文本。
 * 前端按纯文本渲染（不使用 v-html），这里再剥一次标签作为双保险。
 */
export function normalizeReleaseNotes(notes: unknown, maxLen = 4000): string | undefined {
  let raw = '';
  if (typeof notes === 'string') raw = notes;
  else if (Array.isArray(notes)) {
    raw = notes
      .map((n) => {
        const o = n as { version?: unknown; note?: unknown };
        const note = typeof o?.note === 'string' ? o.note : '';
        return o?.version ? `${String(o.version)}\n${note}` : note;
      })
      .join('\n\n');
  }
  const text = raw
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|ul|ol)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return undefined;
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}
