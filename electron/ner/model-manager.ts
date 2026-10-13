/**
 * NER 模型的下载 / 校验 / 安装。
 *
 * 模型包托管在 GitHub Release（models-ner-v1），下载后必须过 SHA-256 才算数；
 * 解压先落临时目录，校验通过再整体改名到 <dataDir>/models/ner_mini_zh，
 * 绝不会把半解压的目录留成“已安装”。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';

export interface NerModelStatus {
  installed: boolean;
  dir: string;
  sizeBytes?: number;
  error?: string;
  downloading?: { received: number; total: number };
}

export const NER_MODEL_URL = 'https://github.com/wangneal369/maskit-node/releases/download/models-ner-v1/ner_mini_zh.zip';
export const NER_MODEL_SHA256 = '0facde7498f077f30e51228762e4be6d8794d2b5d03a7649ca9ddb82ff8dc27a';
/** 下载体积硬上限：超过即中止（防止被劫持成无限流） */
export const NER_MODEL_MAX_BYTES = 200 * 1024 * 1024;
/** 解压后允许的总大小（zip 炸弹防护） */
const MAX_UNZIPPED_BYTES = 400 * 1024 * 1024;
/** 安装完成必须具备的文件 */
const REQUIRED_FILES = ['model_quantized.onnx', 'tokenizer.json', 'config.json'];

export interface NerModelSource {
  url: string;
  sha256: string;
  maxBytes: number;
}

type FetchFn = typeof fetch;

export class NerModelManager {
  private downloading: { received: number; total: number } | null = null;
  private lastError: string | undefined;
  private inflight: Promise<void> | null = null;

  /**
   * @param fetchImpl 调用方提供（已绑定网关出网代理的 undici fetch）
   * @param source 仅测试用：覆盖下载地址 / 摘要 / 体积上限
   */
  constructor(
    private readonly dataDir: string,
    private readonly fetchImpl: FetchFn,
    private readonly source: NerModelSource = { url: NER_MODEL_URL, sha256: NER_MODEL_SHA256, maxBytes: NER_MODEL_MAX_BYTES },
  ) {}

  modelDir(): string {
    return path.join(this.dataDir, 'models', 'ner_mini_zh');
  }

  status(): NerModelStatus {
    const dir = this.modelDir();
    const st: NerModelStatus = { installed: false, dir };
    if (this.downloading) st.downloading = { ...this.downloading };
    let size = 0;
    for (const f of REQUIRED_FILES) {
      try {
        const s = fs.statSync(path.join(dir, f));
        if (!s.isFile() || s.size <= 0) throw new Error('empty');
        size += s.size;
      } catch {
        // 目录存在但文件不全 = 损坏，不能当作已安装
        if (fs.existsSync(dir)) st.error = `模型目录不完整（缺少 ${f}），请重新下载`;
        if (!st.error && this.lastError) st.error = this.lastError;
        return st;
      }
    }
    st.installed = true;
    st.sizeBytes = size;
    return st;
  }

  /** 下载 → 校验 SHA-256 → 解压到临时目录 → 原子改名。并发调用共享同一次下载。 */
  download(onProgress?: (received: number, total: number) => void): Promise<void> {
    if (this.inflight) return this.inflight;
    this.lastError = undefined;
    const p = this.doDownload(onProgress).catch((e) => {
      this.lastError = (e as Error).message;
      throw e;
    }).finally(() => {
      this.downloading = null;
      this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private async doDownload(onProgress?: (received: number, total: number) => void): Promise<void> {
    const { url, sha256, maxBytes } = this.source;
    const report = (received: number, total: number): void => {
      this.downloading = { received, total };
      onProgress?.(received, total);
    };
    report(0, 0);

    let res: Response;
    try {
      res = await this.fetchImpl(url, { redirect: 'follow' });
    } catch (e) {
      throw new Error(`模型下载失败：无法连接下载源（${(e as Error).message}）`);
    }
    if (!res.ok || !res.body) throw new Error(`模型下载失败：下载源返回 HTTP ${res.status}`);

    const declared = Number(res.headers.get('content-length') ?? 0) || 0;
    if (declared > maxBytes) {
      await res.body.cancel().catch(() => undefined);
      throw new Error(`模型下载中止：文件声明大小 ${(declared / 1048576).toFixed(0)}MB 超过上限 ${(maxBytes / 1048576).toFixed(0)}MB`);
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    const hash = createHash('sha256');
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`模型下载中止：实际体积超过上限 ${(maxBytes / 1048576).toFixed(0)}MB`);
        }
        hash.update(value);
        chunks.push(value);
        report(received, declared || received);
      }
    } catch (e) {
      if ((e as Error).message.startsWith('模型下载中止')) throw e;
      throw new Error(`模型下载失败：传输中断（${(e as Error).message}）`);
    }
    report(received, received);

    const digest = hash.digest('hex');
    if (digest !== sha256.toLowerCase()) {
      throw new Error(`模型校验失败：SHA-256 不匹配（期望 ${sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…），已丢弃下载内容`);
    }

    const zipBytes = Buffer.concat(chunks);
    chunks.length = 0;
    this.install(zipBytes);
  }

  /** 解压到临时目录，验证必需文件齐全，再原子改名为正式目录 */
  private install(zipBytes: Buffer): void {
    const finalDir = this.modelDir();
    const parent = path.dirname(finalDir);
    fs.mkdirSync(parent, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(parent, '.ner_mini_zh.tmp-'));
    const backup = `${finalDir}.old-${process.pid}-${Date.now()}`;
    let swapped = false;
    try {
      let files: Record<string, Uint8Array>;
      try {
        files = unzipSync(new Uint8Array(zipBytes), {
          // 声明的解压后大小先过一遍，防 zip 炸弹
          filter: (f) => {
            if (f.originalSize > MAX_UNZIPPED_BYTES) throw new Error(`压缩包内文件 ${f.name} 过大`);
            return true;
          },
        });
      } catch (e) {
        throw new Error(`模型解压失败：压缩包损坏（${(e as Error).message}）`);
      }
      let total = 0;
      for (const [name, data] of Object.entries(files)) {
        if (name.endsWith('/')) continue;
        // 只取文件名：忽略压缩包内的目录层级，彻底杜绝 ../ 路径穿越
        const base = path.posix.basename(name.replace(/\\/g, '/'));
        if (!base || base === '.' || base === '..') continue;
        total += data.length;
        if (total > MAX_UNZIPPED_BYTES) throw new Error('模型解压失败：解压后体积异常');
        fs.writeFileSync(path.join(tmp, base), data);
      }
      const missing = REQUIRED_FILES.filter((f) => !fs.existsSync(path.join(tmp, f)));
      if (missing.length) throw new Error(`模型包内容不完整：缺少 ${missing.join('、')}`);

      // 原子替换：旧目录先挪开，新目录改名就位；任一步失败都回滚旧目录
      if (fs.existsSync(finalDir)) {
        fs.renameSync(finalDir, backup);
        swapped = true;
      }
      try {
        fs.renameSync(tmp, finalDir);
      } catch (e) {
        if (swapped) fs.renameSync(backup, finalDir);
        swapped = false;
        throw e;
      }
      if (swapped) fs.rmSync(backup, { recursive: true, force: true });
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }
}
