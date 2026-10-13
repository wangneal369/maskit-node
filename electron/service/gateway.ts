import path from 'node:path';
import { session } from 'electron';
import { logger } from 'ee-core/log';
import { getDataDir } from 'ee-core/ps';
import { getMainWindow } from 'ee-core/electron';
import { maskJson, Masker, MappingStore, Restorer } from '../core';
import { loadConfig, saveConfig, type AppConfig } from '../gateway/config';
import { Gateway, type GatewayEvent } from '../gateway/proxy';

const MAX_EVENTS = 200;

/**
 * 解析出网代理。'' = 自动：环境变量优先，其次系统代理（Electron 按系统设置/PAC 解析）。
 * undici 的 ProxyAgent 只支持 HTTP(S) 代理，SOCKS 退回直连并记日志。
 */
async function resolveEgressProxy(setting: string, probeUrl: string): Promise<string | null> {
  const v = setting.trim();
  if (v === 'direct') return null;
  if (v) return v;
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (env) return env;
  const rule = (await session.defaultSession.resolveProxy(probeUrl)).split(';')[0].trim();
  const m = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(rule);
  if (m) return `${m[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${m[2]}`;
  if (rule && rule !== 'DIRECT') logger.warn('[maskit] 不支持的系统代理类型，改为直连:', rule);
  return null;
}

/** 窗口未创建或已销毁时静默丢弃（getMainWindow 在窗口创建前会抛错） */
function pushToRenderer(channel: string, payload: unknown): void {
  try {
    const win = getMainWindow();
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  } catch {
    // 无窗口：事件仍保存在内存列表里，窗口打开后可拉取
  }
}

/**
 * 网关服务：持有映射表、脱敏器与代理实例，负责配置持久化与生命周期。
 */
class GatewayService {
  private readonly store = new MappingStore();
  private readonly masker = new Masker(this.store);
  private readonly gateway = new Gateway(this.masker);
  private readonly events: GatewayEvent[] = [];
  private config!: AppConfig;
  private lastError = '';

  constructor() {
    this.gateway.on('event', (ev: GatewayEvent) => {
      this.events.unshift(ev);
      this.events.length = Math.min(this.events.length, MAX_EVENTS);
      pushToRenderer('maskit/event', ev);
    });
  }

  private get configFile(): string {
    return path.join(getDataDir(), 'maskit-config.json');
  }

  async init(): Promise<void> {
    this.config = loadConfig(this.configFile);
    await this.apply();
    await this.start();
  }

  private async apply(): Promise<void> {
    this.masker.configure(this.config.mask);
    this.gateway.maskEnabled = this.config.maskEnabled;
    const probe = this.config.upstreams[0]?.target ?? 'https://api.openai.com';
    try {
      this.gateway.setEgressProxy(await resolveEgressProxy(this.config.egressProxy, probe));
    } catch (e) {
      logger.error('[maskit] 出网代理配置无效，改为直连:', e);
      this.gateway.setEgressProxy(null);
    }
    logger.info('[maskit] egress proxy:', this.gateway.egressProxy ?? 'direct');
  }

  async start(): Promise<void> {
    try {
      await this.gateway.start(this.config.upstreams);
      this.lastError = '';
      logger.info('[maskit] gateway listening on', this.gateway.listening);
    } catch (e) {
      this.lastError = (e as Error).message;
      logger.error('[maskit] gateway start failed:', e);
    }
  }

  async stop(): Promise<void> {
    await this.gateway.stop();
  }

  status() {
    return {
      maskEnabled: this.config.maskEnabled,
      listening: this.gateway.listening,
      egressProxy: this.gateway.egressProxy,
      upstreams: this.config.upstreams,
      mappings: this.store.size,
      lastError: this.lastError,
    };
  }

  getConfig(): AppConfig {
    return this.config;
  }

  /** 保存配置；端口/上游变化时重启监听。 */
  async setConfig(next: AppConfig): Promise<void> {
    const portsChanged = JSON.stringify(next.upstreams) !== JSON.stringify(this.config.upstreams);
    this.config = next;
    saveConfig(this.configFile, next);
    await this.apply();
    if (portsChanged) await this.start();
  }

  listEvents(): GatewayEvent[] {
    return this.events;
  }

  clearMappings(): void {
    this.store.clear();
  }

  /** 本地试验台：不出网，脱敏后立即往返还原，便于直观验证规则。 */
  playground(text: string) {
    const { body, hits } = maskJson(this.masker, { messages: [{ role: 'user', content: text }] });
    const masked = (body as { messages: { content: string }[] }).messages[0].content;
    const restored = new Restorer(this.store).restore(masked, '', false, true);
    return { masked, restored, roundTripOk: restored === text, hits };
  }
}

export const gatewayService = new GatewayService();
