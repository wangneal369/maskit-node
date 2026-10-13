import path from 'node:path';
import fs from 'node:fs';
import { shell, dialog, app } from 'electron';
import { zipSync } from 'fflate';
import { getBaseDir, getExtraResourcesDir, isPackaged } from 'ee-core/ps';
import { gatewayService } from '../service/gateway';
import type { AppConfig } from '../gateway/config';

/**
 * 随应用分发的资源目录（extension、agent-bundle）。
 * 开发：<仓库>/<name>；打包：<resources>/<name>（与 extraResources 同级，由 cmd/builder*.json 复制）。
 */
function resourceDir(...name: string[]): string {
  const base = isPackaged() ? path.dirname(getExtraResourcesDir()) : getBaseDir();
  return path.join(base, ...name);
}

const SKILL_DIR = ['agent-bundle', 'maskit-placeholders'];
/** Skill 包随包分发的文件（contract.md 是渲染源，不分发） */
const SKILL_FILES = ['SKILL.md', 'README.md', 'README_EN.md', 'templates/AGENTS.snippet.md'];

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

  /** 新→旧；默认 limit 200、上限 1000；before 为上一页最老事件的 time */
  async events(args?: { before?: number; beforeSeq?: number; limit?: number }) {
    return gatewayService.listEvents(args);
  }

  async clearEvents() {
    gatewayService.clearEvents();
    return gatewayService.status();
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
    const dir = resourceDir('extension');
    try {
      const err = await shell.openPath(dir);
      return err ? { ok: false, path: dir, error: err } : { ok: true, path: dir };
    } catch (e) {
      return { ok: false, path: dir, error: errMsg(e) };
    }
  }

  async playground(args: { text: string }) {
    return gatewayService.playground(args.text ?? '');
  }

  /** 导出编程助手 Skill 包（zip 顶层目录 maskit-placeholders/，与 Release 资产内容一致） */
  async exportSkillBundle(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
    try {
      const files: Record<string, Uint8Array> = {};
      for (const f of SKILL_FILES) {
        files[`maskit-placeholders/${f}`] = fs.readFileSync(resourceDir(...SKILL_DIR, f));
      }
      const result = await dialog.showSaveDialog({
        defaultPath: path.join(app.getPath('downloads'), 'maskit-placeholders.zip'),
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(result.filePath, zipSync(files));
      return { ok: true, path: result.filePath };
    } catch (e) {
      return { ok: false, error: `导出失败：${errMsg(e)}` };
    }
  }

  /** AGENTS.md 片段文本（给无法安装 Skill 的宿主粘贴用） */
  async skillAgentsSnippet(): Promise<string> {
    return fs.readFileSync(resourceDir(...SKILL_DIR, 'templates', 'AGENTS.snippet.md'), 'utf-8');
  }
}
export default GatewayController;
