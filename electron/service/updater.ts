import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { logger } from 'ee-core/log';
import { getMainWindow } from 'ee-core/electron';
import {
  canDownload,
  decideSupport,
  initialState,
  normalizeReleaseNotes,
  reduceState,
  type UpdaterEvent,
  type UpdaterState,
} from './updater-logic';

export const UPDATER_CHANNEL = 'maskit/updater';

/** 窗口未创建或已销毁时静默丢弃（前端打开后会主动拉取 state()） */
function pushToRenderer(channel: string, payload: unknown): void {
  try {
    const win = getMainWindow();
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  } catch {
    // 无窗口
  }
}

/** Linux fpm 包会在 resources/package-type 写入包类型（deb/rpm/…） */
function readPackageType(): string | null {
  try {
    return fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * 应用内更新（仅 Electron）。数据源：GitHub Release 的 latest*.yml（electron-builder publish=github 生成）。
 * 网络请求走 Electron net 模块，自动跟随系统代理；不经过网关的出网代理设置。
 * 隐私：构造时不发起任何请求，只有显式 check()（或开启 app.checkUpdates 后的启动检查）才联网。
 */
class UpdaterService {
  private st: UpdaterState = initialState({ supported: false });
  private wired = false;

  private ensureInit(): void {
    if (this.wired) return;
    this.wired = true;
    this.st = initialState(
      decideSupport({ platform: process.platform, packaged: app.isPackaged, packageType: readPackageType() }),
    );
    if (!this.st.supported) return;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    // 各架构的更新通道（如 arm64.yml）由打包时写入 app-update.yml 的 channel 决定，不是 prerelease：
    // 显式关掉这两项，避免任何配置/版本号变化把非 x64 用户引到预发布或允许降级到别的架构安装包
    // （electron-updater 只有在代码里给 autoUpdater.channel 赋值时才会自动开启 allowDowngrade，这里不赋值）
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = {
      info: (m?: unknown) => logger.info('[updater]', m),
      warn: (m?: unknown) => logger.warn('[updater]', m),
      error: (m?: unknown) => logger.error('[updater]', m),
      debug: (m: string) => logger.debug('[updater]', m),
    };
    autoUpdater.on('checking-for-update', () => this.dispatch({ type: 'checking' }));
    autoUpdater.on('update-available', (info) =>
      this.dispatch({ type: 'available', version: info.version, releaseNotes: normalizeReleaseNotes(info.releaseNotes) }),
    );
    autoUpdater.on('update-not-available', (info) => this.dispatch({ type: 'not-available', version: info?.version }));
    autoUpdater.on('download-progress', (p) =>
      this.dispatch({
        type: 'progress',
        progress: { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond },
      }),
    );
    autoUpdater.on('update-downloaded', (info) => this.dispatch({ type: 'downloaded', version: info.version }));
    autoUpdater.on('error', (err) => this.dispatch({ type: 'error', message: err?.message ?? String(err) }));
  }

  private dispatch(e: UpdaterEvent): void {
    this.st = reduceState(this.st, e);
    pushToRenderer(UPDATER_CHANNEL, this.st);
  }

  state(): UpdaterState {
    this.ensureInit();
    return this.st;
  }

  async check(): Promise<UpdaterState> {
    this.ensureInit();
    if (!this.st.supported) return this.st;
    if (this.st.status === 'checking' || this.st.status === 'downloading' || this.st.status === 'downloaded') return this.st;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      // 'error' 事件通常已派发；这里兜底保证状态一致
      if (this.st.status !== 'error') this.dispatch({ type: 'error', message: (e as Error).message });
    }
    return this.st;
  }

  async download(): Promise<UpdaterState> {
    this.ensureInit();
    if (!canDownload(this.st)) return this.st;
    this.dispatch({ type: 'progress', progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 } });
    try {
      await autoUpdater.downloadUpdate();
    } catch (e) {
      if (this.st.status !== 'error') this.dispatch({ type: 'error', message: (e as Error).message });
    }
    return this.st;
  }

  quitAndInstall(): { ok: boolean; error?: string } {
    this.ensureInit();
    if (!this.st.supported || this.st.status !== 'downloaded') return { ok: false, error: '尚未下载完成' };
    // 延迟一拍让 IPC 响应先返回；显示安装向导（未签名包更透明），安装后自动重启
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 200);
    return { ok: true };
  }

  /** 启动检查：仅在 app.checkUpdates 开启且平台支持时联网，不自动下载 */
  startupCheck(enabled: boolean): void {
    if (!enabled) return;
    this.ensureInit();
    if (!this.st.supported) return;
    void this.check();
  }
}

export const updaterService = new UpdaterService();
