/**
 * 本地 NER 的生命周期：模型下载、按配置加载 / 卸载引擎，并给网关提供识别适配器。
 *
 * 加载在后台进行（约数百毫秒）：开启 NER 后到加载完成前的请求会等待加载，
 * 加载失败时识别返回带 error 的空结果——规则脱敏照常，失败在事件里可见，不静默降级。
 */
import { NerEngine, type NerResult } from '../ner/engine';
import { NerModelManager, type NerModelStatus } from '../ner/model-manager';
import type { NerConfig } from '../gateway/config';
import type { GatewayNer } from '../gateway/proxy';

export interface NerServiceStatus {
  enabled: boolean;
  /** 引擎已加载可用 */
  ready: boolean;
  loading: boolean;
  error: string;
  model: NerModelStatus;
}

export class NerService {
  private readonly manager: NerModelManager;
  private engine: NerEngine | null = null;
  private loading: Promise<NerEngine | null> | null = null;
  private error = '';
  private cfg: NerConfig = { enabled: false, budgetMs: 800 };

  constructor(dataDir: string, fetchImpl: typeof globalThis.fetch, private readonly logger: { error(...a: unknown[]): void }) {
    this.manager = new NerModelManager(dataDir, fetchImpl);
  }

  /** 应用配置：开启且模型已安装 → 返回识别适配器（引擎后台加载）；否则卸载并返回 null */
  async apply(cfg: NerConfig): Promise<GatewayNer | null> {
    this.cfg = cfg;
    if (!cfg.enabled || !this.manager.status().installed) {
      await this.unload();
      return null;
    }
    // 配置变更是重试加载的时机；之后加载失败不再逐请求重试（损坏的模型每次都会白白耗时）
    this.error = '';
    void this.ensureLoaded();
    return {
      budgetMs: cfg.budgetMs,
      extract: async (texts, budgetMs): Promise<NerResult> => {
        const engine = this.engine ?? (this.error ? null : await this.ensureLoaded());
        if (!engine) return { entities: [], truncated: true, error: this.error || 'NER 引擎不可用' };
        return engine.extractMany(texts, budgetMs);
      },
    };
  }

  /** 下载并校验模型；完成后若已开启 NER 则立即加载 */
  async download(): Promise<void> {
    this.error = '';
    await this.manager.download();
    if (this.cfg.enabled) await this.ensureLoaded();
  }

  status(): NerServiceStatus {
    return {
      enabled: this.cfg.enabled,
      ready: this.engine !== null,
      loading: this.loading !== null,
      error: this.error,
      model: this.manager.status(),
    };
  }

  async unload(): Promise<void> {
    const e = this.engine;
    this.engine = null;
    if (e) await e.dispose().catch(() => undefined);
  }

  private ensureLoaded(): Promise<NerEngine | null> {
    if (this.engine) return Promise.resolve(this.engine);
    this.loading ??= NerEngine.load(this.manager.modelDir())
      .then((engine) => {
        this.engine = engine;
        this.error = '';
        return engine;
      })
      .catch((e: unknown) => {
        this.error = `NER 加载失败：${(e as Error).message}`;
        this.logger.error('[maskit]', this.error);
        return null;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }
}
