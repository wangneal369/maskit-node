import path from 'node:path';
import fs from 'node:fs';
import { shell, dialog, app } from 'electron';
import { zipSync } from 'fflate';
import { getBaseDir, getExtraResourcesDir, isPackaged } from 'ee-core/ps';
import { gatewayService } from '../service/gateway';
import { updaterService } from '../service/updater';
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

/** 本机时间戳 YYYYMMDD-HHmmss，用于导出文件默认名 */
function fileStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

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

  async flagged(args?: { before?: number; beforeSeq?: number; limit?: number }) {
    return gatewayService.listFlagged(args);
  }

  async stats(args?: { days?: number }) {
    return gatewayService.stats(Number(args?.days ?? 30));
  }

  async clearMappings() {
    gatewayService.clearMappings();
    return gatewayService.status();
  }

  async downloadNerModel() {
    return gatewayService.downloadNerModel();
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

  async selfCheck() {
    return gatewayService.selfCheck();
  }

  async testUpstreams() {
    return gatewayService.testUpstreams();
  }

  async diagnostics() {
    return gatewayService.diagnostics();
  }

  /** 保存诊断 JSON（默认放在下载目录，文件内容已脱敏） */
  async exportDiagnostics(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
    try {
      const data = await gatewayService.diagnostics();
      const result = await dialog.showSaveDialog({
        defaultPath: path.join(app.getPath('downloads'), `maskit-diagnostics-${fileStamp(new Date())}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf-8');
      return { ok: true, path: result.filePath };
    } catch (e) {
      return { ok: false, error: `导出失败：${errMsg(e)}` };
    }
  }

  async checkUpdate() {
    return gatewayService.checkUpdate();
  }

  /** 应用内更新状态（supported=false 时前端退回 GitHub API 检查 + 前往下载） */
  async updaterState() {
    return updaterService.state();
  }

  async updaterCheck() {
    return updaterService.check();
  }

  async updaterDownload() {
    return updaterService.download();
  }

  async updaterInstall() {
    return updaterService.quitAndInstall();
  }

  async listConfigBackups() {
    return gatewayService.listConfigBackups();
  }

  async restoreConfigBackup(args: { name: string }) {
    return gatewayService.restoreConfigBackup(args);
  }

  async autostartStatus() {
    return gatewayService.autostartStatus();
  }

  async exportConfig() {
    return gatewayService.exportConfig();
  }

  async importConfig(args: { config: unknown }) {
    await gatewayService.importConfig(args);
    return gatewayService.status();
  }

  /** 导出完整配置为 JSON 文件（含扩展令牌，请妥善保管） */
  async exportConfigFile(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
    try {
      const data = gatewayService.exportConfig();
      const result = await dialog.showSaveDialog({
        defaultPath: path.join(app.getPath('downloads'), 'maskit-config.json'),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf-8');
      return { ok: true, path: result.filePath };
    } catch (e) {
      return { ok: false, error: `导出失败：${errMsg(e)}` };
    }
  }

  /** 从 JSON 文件导入配置；校验失败时不改动当前配置 */
  async importConfigFile(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      const file = result.filePaths[0];
      if (result.canceled || !file) return { ok: false, canceled: true };
      const config = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
      await gatewayService.importConfig({ config });
      return { ok: true, path: file };
    } catch (e) {
      return { ok: false, error: `导入失败：${errMsg(e)}` };
    }
  }
}
export default GatewayController;
