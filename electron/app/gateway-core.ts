import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { maskJson, Masker, MappingStore, Restorer, type PersistedMapping } from '../core';
import { CommandScanner } from '../core/command-block';
import { loadConfig, normalizeConfig, parseConfigInput, saveConfig, type AppConfig } from '../gateway/config';
import { ExtBridge, generateExtToken } from '../gateway/ext-bridge';
import { Gateway, type GatewayEvent, type Upstream } from '../gateway/proxy';
import { MaskitDb } from '../storage/db';
import { NerService } from './ner-service';
import {
  CONFIG_BACKUP_KEEP,
  DIAG_EVENTS_LIMIT,
  compareVersions,
  configBackupFileName,
  isConfigBackupName,
  redactConfig,
  redactEvent,
  redactProxyUrl,
} from './maintenance';

export type { AppConfig, GatewayEvent };

/** 自检单项 */
export interface SelfCheckItem {
  key: string;
  name: string;
  ok: boolean;
  detail: string;
}

/** 上游连通性测试单项 */
export interface UpstreamTestResult {
  name: string;
  target: string;
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}

/** 版本检查结果 */
export interface UpdateCheckResult {
  current: string;
  latest?: string;
  hasUpdate: boolean;
  url?: string;
  publishedAt?: string;
  error?: string;
}

/** 配置备份条目 */
export interface ConfigBackupInfo {
  name: string;
  time: number;
  size: number;
}

const GITHUB_LATEST_RELEASE = 'https://api.github.com/repos/wangneal369/maskit-node/releases/latest';
const UPSTREAM_PROBE_TIMEOUT_MS = 8_000;
const UPDATE_CHECK_TIMEOUT_MS = 10_000;
/** 数据目录可用空间低于此值时自检报警 */
const MIN_FREE_BYTES = 100 * 1024 * 1024;

/** GatewayCore 的外部依赖（Electron 版与无头服务端各自注入） */
export interface GatewayEnv {
  /** 数据目录：配置与 SQLite 都放在这里 */
  dataDir: string;
  version: string;
  /** 向界面推送事件（Electron: webContents.send；服务端: SSE 广播） */
  push(channel: string, payload: unknown): void;
  /** 解析系统代理（仅 Electron 有；无头环境只认环境变量） */
  resolveSystemProxy?(url: string): Promise<string | null>;
  logger: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  /** 网关/扩展桥接监听地址，默认 127.0.0.1 */
  listenHost?: string;
  /** 非回环监听时扩展桥接额外接受的 Host 主机名 */
  publicHosts?: string[];
  /** 出网 HTTP 注入点（测试替换；默认走出网代理的 egressFetch） */
  fetch?: typeof globalThis.fetch;
}

/** 分页游标：上一页最老一条的 (time, seq) */
interface PageArgs {
  before?: number;
  beforeSeq?: number;
  limit?: number;
}

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
 * 网关核心：持有映射表、脱敏器与代理实例，负责配置持久化与生命周期。
 * 不依赖 Electron；外部能力通过 env 注入。
 */
export class GatewayCore {
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
  private readonly ext: ExtBridge;
  private readonly ner: NerService;
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

  constructor(private readonly env: GatewayEnv) {
    this.ext = new ExtBridge(this.masker, env.version);
    this.ner = new NerService(env.dataDir, this.gateway.egressFetch, env.logger);
    if (env.listenHost) {
      this.gateway.listenHost = env.listenHost;
      this.ext.listenHost = env.listenHost;
    }
    if (env.publicHosts) this.ext.publicHosts = env.publicHosts;
    const onEvent = (ev: GatewayEvent) => {
      // 先落库拿到序号，推给界面的事件才带完整分页游标 (time, seq)
      ev.seq = this.persistEvent(ev) ?? ++this.memSeq;
      this.events.unshift(ev);
      this.events.length = Math.min(this.events.length, MAX_EVENTS);
      this.env.push('maskit/event', ev);
    };
    this.gateway.on('event', onEvent);
    this.ext.on('event', onEvent);
  }

  private get configFile(): string {
    return path.join(this.env.dataDir, 'maskit-config.json');
  }

  private get backupDir(): string {
    return path.join(this.env.dataDir, 'backups');
  }

  /** 访问外网时使用的 fetch：优先注入项，否则走出网代理 */
  private get httpFetch(): typeof globalThis.fetch {
    return this.env.fetch ?? this.gateway.egressFetch;
  }

  async init(): Promise<void> {
    this.config = loadConfig(this.configFile);
    this.openDb();
    await this.apply();
    await this.start();
    // 后台检查版本，不阻塞启动；只有用户主动开启时才会访问网络
    if (this.config.app.checkUpdates) {
      void this.checkUpdate().then((r) => {
        if (r.hasUpdate) this.env.push('maskit/update', r);
      });
    }
  }

  /** 打开 SQLite 并恢复映射；任何失败都降级为纯内存，不影响代理。 */
  private openDb(): void {
    this.dbPath = path.join(this.env.dataDir, 'maskit.db');
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
        this.env.logger.info(`[maskit] 已从磁盘恢复 ${n} 条映射`);
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
      this.env.logger.error(`[maskit] 存储(${kind})失败，继续以内存模式运行:`, e);
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

  /**
   * 解析出网代理。'' = 自动：环境变量优先，其次系统代理（Electron 按系统设置/PAC 解析）。
   * undici 的 ProxyAgent 只支持 HTTP(S) 代理，SOCKS 退回直连并记日志。
   */
  private async resolveEgressProxy(setting: string, probeUrl: string): Promise<string | null> {
    const v = setting.trim();
    if (v === 'direct') return null;
    if (v) return v;
    const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (env) return env;
    if (!this.env.resolveSystemProxy) return null;
    return this.env.resolveSystemProxy(probeUrl);
  }

  private async apply(): Promise<void> {
    this.masker.configure(this.config.mask);
    this.gateway.maskEnabled = this.config.maskEnabled;
    this.gateway.policy = {
      commands: new CommandScanner(this.config.commandBlock),
      auditEnabled: this.config.audit.enabled,
      prices: this.config.prices,
    };
    const probe = this.config.upstreams[0]?.target ?? 'https://api.openai.com';
    try {
      this.gateway.setEgressProxy(await this.resolveEgressProxy(this.config.egressProxy, probe));
    } catch (e) {
      this.env.logger.error('[maskit] 出网代理配置无效，改为直连:', e);
      this.gateway.setEgressProxy(null);
    }
    this.env.logger.info('[maskit] egress proxy:', this.gateway.egressProxy ?? 'direct');
    // NER 与扩展桥接共用同一个识别适配器（引擎后台加载，不阻塞启动）
    const ner = await this.ner.apply(this.config.ner);
    this.gateway.ner = ner;
    this.ext.ner = ner;
    try {
      await this.ext.apply(this.config.ext);
      this.extError = '';
    } catch (e) {
      this.extError = (e as Error).message;
      this.env.logger.error('[maskit] 扩展桥接启动失败:', e);
    }
  }

  async start(): Promise<void> {
    try {
      await this.gateway.start(this.config.upstreams);
      this.lastError = '';
      this.env.logger.info('[maskit] gateway listening on', this.gateway.listening);
    } catch (e) {
      this.lastError = (e as Error).message;
      this.env.logger.error('[maskit] gateway start failed:', e);
    }
  }

  async stop(): Promise<void> {
    await Promise.all([this.gateway.stop(), this.ext.stop(), this.ner.unload()]);
    this.flushMappings();
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.dbOp('close', (db) => db.close());
    this.db = null;
  }

  status() {
    return {
      version: this.env.version,
      maskEnabled: this.config.maskEnabled,
      listening: this.gateway.listening,
      egressProxy: this.gateway.egressProxy,
      upstreams: this.config.upstreams,
      mappings: this.store.size,
      lastError: this.lastError,
      ext: { enabled: this.config.ext.enabled, port: this.ext.listeningPort, error: this.extError },
      storage: this.storageStatus(),
      ner: this.ner.status(),
    };
  }

  /** 下载 NER 模型（经出网代理，校验 SHA-256）；完成后按当前配置加载 */
  async downloadNerModel() {
    await this.ner.download();
    await this.apply();
    return this.status();
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
    this.backupConfigFile();
    this.config = normalizeConfig(next);
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
  listEvents(args?: PageArgs): GatewayEvent[] {
    return this.page(args, (db, p) => db.listEvents(p), () => true);
  }

  /** 风险列表：带审计发现或命中危险命令的事件，分页同 listEvents */
  listFlagged(args?: PageArgs): GatewayEvent[] {
    return this.page(args, (db, p) => db.listFlagged(p), (ev) => !!(ev.findings?.length || ev.commands?.length));
  }

  private page(
    args: PageArgs | undefined,
    query: (db: MaskitDb, p: { before?: number; beforeSeq?: number; limit: number }) => GatewayEvent[],
    memFilter: (ev: GatewayEvent) => boolean,
  ): GatewayEvent[] {
    const raw = Number(args?.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), EVENTS_MAX_LIMIT) : EVENTS_DEFAULT_LIMIT;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const before = num(args?.before);
    const beforeSeq = num(args?.beforeSeq);
    if (this.db) {
      try {
        return query(this.db, { before, beforeSeq, limit });
      } catch (e) {
        this.reportStorageError('events', e);
      }
    }
    const older = (ev: GatewayEvent) => ev.time < before! || (ev.time === before && beforeSeq !== undefined && (ev.seq ?? 0) < beforeSeq);
    return this.events.filter((ev) => memFilter(ev) && (before === undefined || older(ev))).slice(0, limit);
  }

  /** 用量统计：最近 days 天（按本机时区分日）；DB 不可用时返回空 */
  stats(days: number) {
    const d = Number.isFinite(days) ? Math.min(366, Math.max(1, Math.floor(days))) : 30;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (d - 1));
    if (this.db) {
      try {
        return this.db.stats({ sinceMs: start.getTime(), tzOffsetMin: -new Date().getTimezoneOffset() });
      } catch (e) {
        this.reportStorageError('stats', e);
      }
    }
    return { daily: [], byModel: [] };
  }

  clearEvents(): void {
    this.events.length = 0;
    this.dbOp('events', (db) => db.clearEvents());
  }

  clearMappings(): void {
    // store.clear() 会经 onClear 钩子同步清盘（保留常驻词，语义与内存一致）
    this.store.clear();
  }

  /** 列出配置备份，新→旧 */
  listConfigBackups(): { backups: ConfigBackupInfo[] } {
    return { backups: this.listBackupFiles() };
  }

  /**
   * 从备份还原配置。名称按白名单正则校验，杜绝路径穿越；
   * 还原本身走 setConfig，因此当前配置也会先被备份，还原可撤销。
   */
  async restoreConfigBackup(args: { name: string }): Promise<ReturnType<GatewayCore['status']>> {
    const name = String(args?.name ?? '');
    if (!isConfigBackupName(name)) throw new Error('非法的备份名称');
    const file = path.join(this.backupDir, name);
    if (!fs.existsSync(file)) throw new Error('备份文件不存在');
    const next = parseConfigInput(JSON.parse(fs.readFileSync(file, 'utf8')));
    await this.setConfig(next);
    return this.status();
  }

  /** 导出完整配置（含扩展令牌，属于用户自己的导出文件） */
  exportConfig(): AppConfig {
    return structuredClone(this.config);
  }

  /** 导入配置：校验结构 → 按默认值补齐 → setConfig（旧配置会先备份） */
  async importConfig(args: { config: unknown }): Promise<ReturnType<GatewayCore['status']>> {
    const next = parseConfigInput(args?.config);
    await this.setConfig(next);
    return this.status();
  }

  /** 写入新配置前备份旧文件，只保留最新 CONFIG_BACKUP_KEEP 份；失败只记日志，不阻断保存。 */
  private backupConfigFile(): void {
    if (!fs.existsSync(this.configFile)) return;
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      // 同一毫秒内多次保存时顺延时间戳，避免覆盖上一份备份
      let t = Date.now();
      let name = configBackupFileName(new Date(t));
      while (fs.existsSync(path.join(this.backupDir, name))) name = configBackupFileName(new Date(++t));
      fs.copyFileSync(this.configFile, path.join(this.backupDir, name));
      for (const old of this.listBackupFiles().slice(CONFIG_BACKUP_KEEP)) {
        fs.rmSync(path.join(this.backupDir, old.name), { force: true });
      }
    } catch (e) {
      this.env.logger.warn('[maskit] 配置备份失败:', e);
    }
  }

  private listBackupFiles(): ConfigBackupInfo[] {
    if (!fs.existsSync(this.backupDir)) return [];
    const out: ConfigBackupInfo[] = [];
    for (const name of fs.readdirSync(this.backupDir)) {
      if (!isConfigBackupName(name)) continue;
      const st = fs.statSync(path.join(this.backupDir, name));
      if (!st.isFile()) continue;
      out.push({ name, time: st.mtimeMs, size: st.size });
    }
    // 文件名定宽且字典序即时间序，倒序即新→旧
    return out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  }

  /** 运行自检：端口、扩展桥接、存储、NER、出网代理、配置目录可写性、磁盘空间。永不抛错。 */
  async selfCheck(): Promise<{ items: SelfCheckItem[] }> {
    const items: SelfCheckItem[] = [];
    for (const up of this.config.upstreams) {
      const listening = this.gateway.listening.includes(up.port);
      items.push({
        key: `port:${up.name}`,
        name: `上游端口 ${up.name}（:${up.port}）`,
        ok: listening,
        detail: listening ? `监听 ${this.gateway.listenHost}:${up.port}` : this.lastError || '未监听',
      });
    }

    const extPort = this.ext.listeningPort;
    if (this.config.ext.enabled) {
      items.push({
        key: 'ext',
        name: '浏览器扩展桥接',
        ok: extPort !== null,
        detail: extPort !== null ? `监听端口 ${extPort}` : this.extError || '未监听',
      });
    } else {
      items.push({ key: 'ext', name: '浏览器扩展桥接', ok: true, detail: '未启用' });
    }

    const st = this.storageStatus();
    items.push({
      key: 'storage',
      name: '本地存储（SQLite）',
      ok: st.enabled && !st.error,
      detail: st.enabled ? st.error || st.path : st.error || '数据库未打开，已降级为内存模式',
    });

    if (this.config.ner.enabled) {
      const ner = this.ner.status();
      const ok = ner.model.installed && ner.ready;
      const detail = !ner.model.installed
        ? '模型未安装'
        : ner.error || (ner.ready ? '已加载就绪' : ner.loading ? '加载中' : '未加载');
      items.push({ key: 'ner', name: '本地 NER', ok, detail });
    } else {
      items.push({ key: 'ner', name: '本地 NER', ok: true, detail: '未启用' });
    }

    const proxy = this.gateway.egressProxy;
    items.push({
      key: 'egress',
      name: '出网代理',
      ok: true,
      detail: proxy ? redactProxyUrl(proxy) : '直连',
    });

    items.push(this.checkConfigWritable());
    items.push(await this.checkDisk());
    return { items };
  }

  /** 在数据目录写入并删除一个临时文件，验证配置可保存 */
  private checkConfigWritable(): SelfCheckItem {
    const name = '配置目录可写';
    const probe = path.join(this.env.dataDir, `.selfcheck-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.mkdirSync(this.env.dataDir, { recursive: true });
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      return { key: 'config-writable', name, ok: true, detail: this.configFile };
    } catch (e) {
      try {
        fs.rmSync(probe, { force: true });
      } catch {
        // 临时文件清理失败不影响结论
      }
      return { key: 'config-writable', name, ok: false, detail: `写入失败：${(e as Error).message}` };
    }
  }

  /** 数据目录所在磁盘的可用空间（平台不支持 statfs 时只标注无法获取） */
  private async checkDisk(): Promise<SelfCheckItem> {
    const name = '数据目录剩余空间';
    try {
      if (typeof fs.promises.statfs !== 'function') throw new Error('当前 Node 版本不支持');
      const s = await fs.promises.statfs(this.env.dataDir);
      const free = Number(s.bavail) * Number(s.bsize);
      const ok = free >= MIN_FREE_BYTES;
      const gb = (free / 1024 ** 3).toFixed(1);
      return { key: 'disk', name, ok, detail: ok ? `${gb} GB 可用` : `${gb} GB 可用（低于 100 MB）` };
    } catch (e) {
      return { key: 'disk', name, ok: true, detail: `无法获取：${(e as Error).message}` };
    }
  }

  /** 逐个上游 GET 根地址测连通性：任何 HTTP 状态码都算可达，网络错误或超时才算失败。并行执行。 */
  async testUpstreams(): Promise<{ results: UpstreamTestResult[] }> {
    const results = await Promise.all(this.config.upstreams.map((up) => this.probeUpstream(up)));
    return { results };
  }

  private async probeUpstream(up: Upstream): Promise<UpstreamTestResult> {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_PROBE_TIMEOUT_MS);
    try {
      const res = await this.httpFetch(up.target, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
      void res.body?.cancel().catch(() => undefined);
      return { name: up.name, target: up.target, ok: true, status: res.status, latencyMs: Date.now() - started };
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause;
      const error = ctrl.signal.aborted
        ? `连接超时（${UPSTREAM_PROBE_TIMEOUT_MS / 1000} 秒）`
        : `连接失败：${cause?.code ?? (e as Error).message}`;
      return { name: up.name, target: up.target, ok: false, latencyMs: Date.now() - started, error };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 诊断包：版本、运行环境、状态、脱敏配置、最近事件（不含占位符令牌）与自检结果 */
  async diagnostics() {
    const s = this.status();
    return {
      generatedAt: new Date().toISOString(),
      version: this.env.version,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      status: { ...s, egressProxy: s.egressProxy ? redactProxyUrl(s.egressProxy) : s.egressProxy },
      config: redactConfig(this.config),
      recentEvents: this.listEvents({ limit: DIAG_EVENTS_LIMIT }).map(redactEvent),
      selfCheck: await this.selfCheck(),
    };
  }

  /**
   * 查询 GitHub 最新 Release 并与当前版本比较。从不抛错，失败写入 error 字段。
   */
  async checkUpdate(): Promise<UpdateCheckResult> {
    const current = this.env.version;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPDATE_CHECK_TIMEOUT_MS);
    try {
      const res = await this.httpFetch(GITHUB_LATEST_RELEASE, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'data-maskit' },
        signal: ctrl.signal,
      });
      if (!res.ok) return { current, hasUpdate: false, error: `GitHub 返回 HTTP ${res.status}` };
      const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; published_at?: unknown };
      const latest = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/i, '') : '';
      if (!latest) return { current, hasUpdate: false, error: '未获取到版本号' };
      const cmp = compareVersions(latest, current);
      if (cmp === null) return { current, latest, hasUpdate: false, error: '版本号无法解析' };
      return {
        current,
        latest,
        hasUpdate: cmp > 0,
        url: typeof body.html_url === 'string' ? body.html_url : undefined,
        publishedAt: typeof body.published_at === 'string' ? body.published_at : undefined,
      };
    } catch (e) {
      const reason = ctrl.signal.aborted ? '请求超时' : (e as Error).message;
      return { current, hasUpdate: false, error: `检查更新失败：${reason}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 本地试验台：不出网，脱敏后立即往返还原，便于直观验证规则。 */
  playground(text: string) {
    const { body, hits } = maskJson(this.masker, { messages: [{ role: 'user', content: text }] });
    const masked = (body as { messages: { content: string }[] }).messages[0].content;
    const restored = new Restorer(this.store).restore(masked, '', false, true);
    return { masked, restored, roundTripOk: restored === text, hits };
  }
}
