import path from 'node:path';
import { app, session } from 'electron';
import { logger } from 'ee-core/log';
import { getDataDir } from 'ee-core/ps';
import { getMainWindow } from 'ee-core/electron';
import { maskJson, Masker, MappingStore, Restorer, type PersistedMapping } from '../core';
import { loadConfig, normalizeExt, normalizeStorage, saveConfig, type AppConfig } from '../gateway/config';
import { ExtBridge, generateExtToken } from '../gateway/ext-bridge';
import { Gateway, type GatewayEvent } from '../gateway/proxy';
import { MaskitDb } from '../storage/db';

/** 内存兜底事件列表上限（DB 不可用时 events() 仍可用） */
const MAX_EVENTS = 200;
/** 映射 lastUsed 批量落盘间隔 */
const FLUSH_INTERVAL_MS = 30_000;
/** 新增映射的写盘去抖 */
const ADD_DEBOUNCE_MS = 1_000;
/** 每插入这么多条事件后裁剪一次 */
const TRIM_EVERY = 100;
const MAPPING_TTL_MS = 24 * 3600 * 1000;
const RESTORE_LIMIT = 2000;
const EVENTS_DEFAULT_LIMIT = 200;
const EVENTS_MAX_LIMIT = 1000;

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
  private readonly store = new MappingStore({
    persist: {
      onAdd: (e) => this.queueAdd(e),
      onRemove: (tokens) => this.dbOp('mappings', (db) => {
        for (const t of tokens) this.pendingAdd.delete(t);
        if (this.mappingsPersistable()) db.deleteMappings(tokens);
      }),
      onClear: (keepPinned) => this.dbOp('mappings', (db) => {
        // 先把待写缓冲落盘再清，保证 keepPinned 时常驻词不丢
        this.flushMappings();
        if (this.mappingsPersistable()) db.clearMappings(keepPinned);
      }),
    },
  });
  private readonly masker = new Masker(this.store);
  private readonly gateway = new Gateway(this.masker);
  private readonly ext = new ExtBridge(this.masker, app.getVersion());
  private readonly events: GatewayEvent[] = [];
  private config!: AppConfig;
  private lastError = '';
  private extError = '';
  private db: MaskitDb | null = null;
  private dbPath = '';
  private storageError = '';
  private readonly loggedKinds = new Set<string>();
  private readonly pendingAdd = new Map<string, PersistedMapping>();
  private addTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private insertedSinceTrim = 0;
  /** DB 不可用时的内存序号 */
  private memSeq = 0;

  constructor() {
    const onEvent = (ev: GatewayEvent) => {
      // 先落库拿到序号，推给界面的事件才带完整分页游标 (time, seq)
      ev.seq = this.persistEvent(ev) ?? ++this.memSeq;
      this.events.unshift(ev);
      this.events.length = Math.min(this.events.length, MAX_EVENTS);
      pushToRenderer('maskit/event', ev);
    };
    this.gateway.on('event', onEvent);
    this.ext.on('event', onEvent);
  }

  private get configFile(): string {
    return path.join(getDataDir(), 'maskit-config.json');
  }

  async init(): Promise<void> {
    this.config = loadConfig(this.configFile);
    this.openDb();
    await this.apply();
    await this.start();
  }

  /** 打开 SQLite 并恢复映射；任何失败都降级为纯内存，不影响代理。 */
  private openDb(): void {
    this.dbPath = path.join(getDataDir(), 'maskit.db');
    try {
      this.db = new MaskitDb(this.dbPath);
    } catch (e) {
      this.db = null;
      this.reportStorageError('open', e);
      return;
    }
    this.dbOp('restore', (db) => {
      if (this.config.storage.persistMappings) {
        const rows = db.loadMappings(Date.now() - MAPPING_TTL_MS, RESTORE_LIMIT);
        const n = this.store.restore(rows);
        logger.info(`[maskit] 已从磁盘恢复 ${n} 条映射`);
      }
      db.trimEvents(this.config.storage.maxEvents);
    });
    this.flushTimer = setInterval(() => this.flushMappings(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  private mappingsPersistable(): boolean {
    return this.db !== null && this.config.storage.persistMappings;
  }

  /** 同一类错误只记一次日志；storageError 持续暴露给 status()。 */
  private reportStorageError(kind: string, e: unknown): void {
    this.storageError = `${kind}: ${(e as Error).message}`;
    if (!this.loggedKinds.has(kind)) {
      this.loggedKinds.add(kind);
      logger.error(`[maskit] 存储(${kind})失败，继续以内存模式运行:`, e);
    }
  }

  private dbOp(kind: string, fn: (db: MaskitDb) => void): void {
    if (!this.db) return;
    try {
      fn(this.db);
    } catch (e) {
      this.reportStorageError(kind, e);
    }
  }

  /** 新映射先进缓冲，短去抖后批量 upsert */
  private queueAdd(e: PersistedMapping): void {
    if (!this.mappingsPersistable()) return;
    this.pendingAdd.set(e.token, e);
    if (!this.addTimer) {
      this.addTimer = setTimeout(() => this.flushMappings(), ADD_DEBOUNCE_MS);
      this.addTimer.unref();
    }
  }

  /** 把新增缓冲 + lastUsed 变动一并写盘 */
  private flushMappings(): void {
    if (this.addTimer) {
      clearTimeout(this.addTimer);
      this.addTimer = null;
    }
    if (!this.mappingsPersistable()) {
      this.pendingAdd.clear();
      this.store.markClean();
      return;
    }
    const rows = new Map(this.pendingAdd);
    for (const d of this.store.exportDirty()) rows.set(d.token, d);
    if (!rows.size) return;
    this.dbOp('mappings', (db) => {
      db.upsertMappings([...rows.values()]);
      this.pendingAdd.clear();
      this.store.markClean([...rows.keys()]);
    });
  }

  /** 写入事件并返回落库序号；DB 不可用返回 undefined */
  private persistEvent(ev: GatewayEvent): number | undefined {
    let seq: number | undefined;
    this.dbOp('events', (db) => {
      seq = db.insertEvent(ev);
      if (++this.insertedSinceTrim >= TRIM_EVERY) {
        this.insertedSinceTrim = 0;
        db.trimEvents(this.config.storage.maxEvents);
      }
    });
    return seq;
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
    try {
      await this.ext.apply(this.config.ext);
      this.extError = '';
    } catch (e) {
      this.extError = (e as Error).message;
      logger.error('[maskit] 扩展桥接启动失败:', e);
    }
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
    await Promise.all([this.gateway.stop(), this.ext.stop()]);
    this.flushMappings();
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.dbOp('close', (db) => db.close());
    this.db = null;
  }

  status() {
    return {
      maskEnabled: this.config.maskEnabled,
      listening: this.gateway.listening,
      egressProxy: this.gateway.egressProxy,
      upstreams: this.config.upstreams,
      mappings: this.store.size,
      lastError: this.lastError,
      ext: { enabled: this.config.ext.enabled, port: this.ext.listeningPort, error: this.extError },
      storage: this.storageStatus(),
    };
  }

  private storageStatus() {
    let events = this.events.length;
    let persistedMappings = 0;
    if (this.db) {
      try {
        events = this.db.countEvents();
        persistedMappings = this.db.countMappings();
      } catch (e) {
        this.reportStorageError('count', e);
      }
    }
    return {
      enabled: this.db !== null,
      path: this.dbPath,
      error: this.storageError,
      events,
      persistedMappings,
    };
  }

  getConfig(): AppConfig {
    return this.config;
  }

  /** 保存配置；端口/上游变化时重启监听。 */
  async setConfig(next: AppConfig): Promise<void> {
    const portsChanged = JSON.stringify(next.upstreams) !== JSON.stringify(this.config.upstreams);
    const wasPersist = this.config.storage.persistMappings;
    this.config = { ...next, ext: normalizeExt(next.ext), storage: normalizeStorage(next.storage) };
    saveConfig(this.configFile, this.config);
    this.applyStorage(wasPersist);
    await this.apply();
    if (portsChanged) await this.start();
  }

  /** 持久化开关/上限变化：关 = 删盘上全部映射行（含常驻），开 = 写入当前内存里符合条件的条目 */
  private applyStorage(wasPersist: boolean): void {
    const now = this.config.storage.persistMappings;
    if (wasPersist && !now) {
      this.pendingAdd.clear();
      this.store.markClean();
      this.dbOp('mappings', (db) => db.clearMappings(false));
    } else if (!wasPersist && now) {
      this.dbOp('mappings', (db) => db.upsertMappings(this.store.entries()));
    }
    this.dbOp('events', (db) => db.trimEvents(this.config.storage.maxEvents));
  }

  /** 轮换扩展令牌：旧令牌立即失效，用户需在扩展设置里更新 */
  async rotateExtToken(): Promise<AppConfig> {
    await this.setConfig({ ...this.config, ext: { ...this.config.ext, token: generateExtToken() } });
    return this.config;
  }

  /** 新→旧分页；游标为上一页最老一条的 (time, seq)。DB 不可用时退回内存列表。 */
  listEvents(args?: { before?: number; beforeSeq?: number; limit?: number }): GatewayEvent[] {
    const raw = Number(args?.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), EVENTS_MAX_LIMIT) : EVENTS_DEFAULT_LIMIT;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const before = num(args?.before);
    const beforeSeq = num(args?.beforeSeq);
    if (this.db) {
      try {
        return this.db.listEvents({ before, beforeSeq, limit });
      } catch (e) {
        this.reportStorageError('events', e);
      }
    }
    const older = (ev: GatewayEvent) => ev.time < before! || (ev.time === before && beforeSeq !== undefined && (ev.seq ?? 0) < beforeSeq);
    const list = before === undefined ? this.events : this.events.filter(older);
    return list.slice(0, limit);
  }

  clearEvents(): void {
    this.events.length = 0;
    this.dbOp('events', (db) => db.clearEvents());
  }

  clearMappings(): void {
    // store.clear() 会经 onClear 钩子同步清盘（保留常驻词，语义与内存一致）
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
