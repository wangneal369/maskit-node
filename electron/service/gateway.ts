import { session, app } from 'electron';
import { logger } from 'ee-core/log';
import { getDataDir } from 'ee-core/ps';
import { getMainWindow } from 'ee-core/electron';
import { GatewayCore, type AppConfig } from '../app/gateway-core';
import { updaterService } from './updater';

/** 开机自启时附带的参数：带它启动则只进托盘、不弹窗口 */
export const HIDDEN_ARG = '--hidden';

/** 窗口未创建或已销毁时静默丢弃（getMainWindow 在窗口创建前会抛错） */
function pushToRenderer(channel: string, payload: unknown): void {
  try {
    const win = getMainWindow();
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  } catch {
    // 无窗口：事件仍保存在内存列表里，窗口打开后可拉取
  }
}

/** 按 Electron 的系统代理设置/PAC 解析；SOCKS 等不支持的类型退回直连并记日志 */
async function resolveSystemProxy(url: string): Promise<string | null> {
  const rule = (await session.defaultSession.resolveProxy(url)).split(';')[0].trim();
  const m = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(rule);
  if (m) return `${m[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${m[2]}`;
  if (rule && rule !== 'DIRECT') logger.warn('[maskit] 不支持的系统代理类型，改为直连:', rule);
  return null;
}

/**
 * Electron 适配层：把 ee-core / electron 能力注入 GatewayCore，对外 API 与改造前一致。
 * 核心在首次使用时才创建（getDataDir 需等 ee-core 就绪）。
 */
class GatewayService {
  private _core: GatewayCore | null = null;
  private listeners = new Set<() => void>();

  private get core(): GatewayCore {
    if (!this._core) {
      this._core = new GatewayCore({
        dataDir: getDataDir(),
        version: app.getVersion(),
        push: pushToRenderer,
        resolveSystemProxy,
        logger,
      });
    }
    return this._core;
  }

  async init() {
    await this.core.init();
    this.syncAutostart();
    // 应用内更新：仅用户开启「启动时检查更新」且平台支持时联网检查，不自动下载
    updaterService.startupCheck(this.core.getConfig().app.checkUpdates);
  }
  start() { return this.core.start(); }
  stop() { return this.core.stop(); }
  status() { return this.core.status(); }
  getConfig() { return this.core.getConfig(); }
  async setConfig(next: AppConfig) {
    await this.core.setConfig(next);
    this.configChanged();
  }
  /** 配置变化订阅（托盘菜单据此刷新脱敏开关） */
  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }
  private configChanged(): void {
    this.syncAutostart();
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        logger.error('[maskit] 配置变化回调失败:', e);
      }
    }
  }
  rotateExtToken() { return this.core.rotateExtToken(); }
  downloadNerModel() { return this.core.downloadNerModel(); }
  listEvents(args?: Parameters<GatewayCore['listEvents']>[0]) { return this.core.listEvents(args); }
  listFlagged(args?: Parameters<GatewayCore['listFlagged']>[0]) { return this.core.listFlagged(args); }
  stats(days: number) { return this.core.stats(days); }
  clearEvents() { this.core.clearEvents(); }
  clearMappings() { this.core.clearMappings(); }
  playground(text: string) { return this.core.playground(text); }
  selfCheck() { return this.core.selfCheck(); }
  testUpstreams() { return this.core.testUpstreams(); }
  diagnostics() { return this.core.diagnostics(); }
  checkUpdate() { return this.core.checkUpdate(); }
  listConfigBackups() { return this.core.listConfigBackups(); }
  async restoreConfigBackup(args: { name: string }) {
    const st = await this.core.restoreConfigBackup(args);
    this.configChanged();
    return st;
  }
  exportConfig() { return this.core.exportConfig(); }
  async importConfig(args: { config: unknown }) {
    const st = await this.core.importConfig(args);
    this.configChanged();
    return st;
  }

  /**
   * 开机自启：仅打包版生效（开发期 electron 可执行文件不应被注册为登录项）。
   * 只在值变化时调用系统接口。登录项带 --hidden：开机自启只进托盘，不弹窗口。
   * Windows 必须用同样的 args 查询，否则查不到带参数注册的登录项。
   */
  private syncAutostart(): void {
    if (!app.isPackaged) {
      logger.info('[maskit] 开发模式，跳过开机自启设置');
      return;
    }
    try {
      const want = this.core.getConfig().app.autostart;
      const args = [HIDDEN_ARG];
      if (app.getLoginItemSettings({ args }).openAtLogin !== want) app.setLoginItemSettings({ openAtLogin: want, args });
    } catch (e) {
      logger.error('[maskit] 设置开机自启失败:', e);
    }
  }

  autostartStatus(): { supported: boolean; enabled: boolean; reason?: string } {
    if (!app.isPackaged) {
      return { supported: false, enabled: false, reason: '开发模式不支持，仅打包版可设置开机自启' };
    }
    return { supported: true, enabled: app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin };
  }
}

export const gatewayService = new GatewayService();
