import path from 'node:path';
import { shell } from 'electron';
import { getBaseDir, getExtraResourcesDir, isPackaged } from 'ee-core/ps';
import { gatewayService } from '../service/gateway';
import type { AppConfig } from '../gateway/config';

/**
 * 网关控制器：渲染进程通过 ipc channel `controller/gateway/<method>` 调用
 */
class GatewayController {
  async status() {
    return gatewayService.status();
  }

  async getConfig() {
    return gatewayService.getConfig();
  }

  async setConfig(args: AppConfig) {
    await gatewayService.setConfig(args);
    return gatewayService.status();
  }

  async restart() {
    await gatewayService.start();
    return gatewayService.status();
  }

  async events() {
    return gatewayService.listEvents();
  }

  async clearMappings() {
    gatewayService.clearMappings();
    return gatewayService.status();
  }

  async rotateExtToken() {
    return gatewayService.rotateExtToken();
  }

  /**
   * 在系统文件管理器中打开浏览器扩展目录。
   * 开发：<仓库>/extension；打包：<resources>/extension（与 extraResources 同级，
   * 由 cmd/builder*.json 的 extraResources 复制而来；macOS 为 Contents/Resources/extension）。
   */
  async openExtensionDir(): Promise<{ ok: boolean; path: string; error?: string }> {
    const dir = isPackaged()
      ? path.join(path.dirname(getExtraResourcesDir()), 'extension')
      : path.join(getBaseDir(), 'extension');
    try {
      const err = await shell.openPath(dir);
      return err ? { ok: false, path: dir, error: err } : { ok: true, path: dir };
    } catch (e) {
      return { ok: false, path: dir, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async playground(args: { text: string }) {
    return gatewayService.playground(args.text ?? '');
  }
}
export default GatewayController;
