import path from 'node:path';
import { app, Menu, Tray, nativeImage, type BrowserWindow } from 'electron';
import { logger } from 'ee-core/log';
import { getBaseDir } from 'ee-core/ps';
import { getMainWindow } from 'ee-core/electron';
import { gatewayService, HIDDEN_ARG } from './gateway';

/**
 * 系统托盘：关闭窗口时缩到托盘，网关继续在后台运行；只有托盘菜单「退出」才真正退出。
 * 托盘创建失败（部分 Linux 桌面没有托盘区）时退回普通行为：关窗即退出，避免窗口藏起来再也找不回。
 */
class TrayService {
  private tray: Tray | null = null;
  /** 真正退出中（托盘「退出」、自动更新安装、系统关机）：此时不再拦截关窗 */
  private quitting = false;
  private hintShown = false;
  private markReady!: () => void;
  /** 托盘初始化完成（无论成败）；窗口首次显示前要等它，才能决定是否以托盘方式启动 */
  readonly ready = new Promise<void>((resolve) => (this.markReady = resolve));

  /** 托盘可用且配置为关窗缩到托盘 */
  get closeToTray(): boolean {
    try {
      return this.tray !== null && gatewayService.getConfig().app.closeToTray;
    } catch {
      return false;
    }
  }

  /** 是否以托盘方式启动（开机自启带 --hidden；macOS 登录项用 wasOpenedAtLogin 判断） */
  get startHidden(): boolean {
    if (!this.closeToTray) return false;
    if (process.argv.includes(HIDDEN_ARG)) return true;
    try {
      return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
    } catch {
      return false;
    }
  }

  init(): void {
    try {
      this.setup();
    } catch (e) {
      this.tray?.destroy();
      this.tray = null;
      logger.error('[maskit] 创建系统托盘失败，关闭窗口将直接退出:', e);
    } finally {
      this.markReady();
    }
  }

  private setup(): void {
    this.tray = new Tray(this.icon());
    this.tray.setToolTip('Data Maskit');
    // Windows / Linux：单击托盘图标打开主界面；macOS 单击弹菜单是系统惯例
    if (process.platform !== 'darwin') this.tray.on('click', () => this.showWindow());
    // macOS：点程序坞图标重新打开窗口
    app.on('activate', () => this.showWindow());
    this.refresh();
    gatewayService.onChange(() => this.refresh());

    app.on('before-quit', () => {
      this.quitting = true;
    });
    this.attach(getMainWindow());
  }

  private attach(win: BrowserWindow): void {
    win.on('close', (e) => {
      if (this.quitting || !this.closeToTray) return;
      e.preventDefault();
      win.hide();
      this.showHintOnce();
    });
    // Windows 注销/关机：放行关窗，否则会卡住系统关机流程
    win.on('session-end', () => {
      this.quitting = true;
    });
  }

  /** 菜单里的脱敏状态随配置变化重建（仪表盘开关、配置导入都会触发） */
  refresh(): void {
    if (!this.tray) return;
    const cfg = gatewayService.getConfig();
    const menu = Menu.buildFromTemplate([
      { label: '打开主界面', click: () => this.showWindow() },
      { type: 'separator' },
      {
        label: '启用脱敏',
        type: 'checkbox',
        checked: cfg.maskEnabled,
        click: () => void this.toggleMask(),
      },
      { type: 'separator' },
      { label: '退出 Data Maskit', click: () => this.quit() },
    ]);
    this.tray.setContextMenu(menu);
    this.tray.setToolTip(cfg.maskEnabled ? 'Data Maskit · 脱敏已开启' : 'Data Maskit · 脱敏已关闭（原样透传）');
  }

  showWindow(): void {
    try {
      const win = getMainWindow();
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } catch (e) {
      logger.error('[maskit] 打开主界面失败:', e);
    }
  }

  quit(): void {
    this.quitting = true;
    app.quit();
  }

  private async toggleMask(): Promise<void> {
    const cfg = gatewayService.getConfig();
    try {
      await gatewayService.setConfig({ ...cfg, maskEnabled: !cfg.maskEnabled });
    } catch (e) {
      logger.error('[maskit] 托盘切换脱敏失败:', e);
      this.refresh();
    }
  }

  /** 首次缩到托盘时提示一次（仅 Windows 支持气泡），免得用户以为程序退出了网关也停了 */
  private showHintOnce(): void {
    if (this.hintShown || !this.tray || process.platform !== 'win32') return;
    this.hintShown = true;
    this.tray.displayBalloon({
      title: 'Data Maskit 仍在后台运行',
      content: '网关继续工作。右键托盘图标可打开主界面或退出。',
    });
  }

  /** macOS 菜单栏用 16px 图；Windows / Linux 用 32px，高分屏下更清晰（系统会按需缩放） */
  private icon() {
    const file = process.platform === 'darwin' ? 'tray.png' : 'logo-32.png';
    return nativeImage.createFromPath(path.join(getBaseDir(), 'public', 'images', file));
  }
}

export const trayService = new TrayService();
