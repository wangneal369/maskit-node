/**
 * 本地 NER 引擎：基于 BERT-base-chinese（OntoNotes 标签集）的 ONNX 量化模型，
 * 识别人名 (NAME) / 机构 (ORG) / 地址 (ADDR)。移植自 Python 引擎 engine/ner_engine.py，
 * 里面几乎每个常量都是踩坑换来的，改动前请先读原文件的注释。
 *
 * 成本模型（Python 实测）：耗时随字数近似线性，约 0.25ms/字。脱敏在主链路上，所以本模块自带硬边界：
 *   · 长文本分段（≤4000 字/段）+ 滑窗（400 字窗 / 350 步长，保证 BERT 序列 < 512）；
 *   · 单次调用时间上限 + 调用方给的 deadline；
 *   · 按文本摘要缓存（只存位置三元组，不留原文）；
 *   · 任何失败都可见：推理异常通过返回值的 error 字段上报，而不是静默降级。
 */
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BertTokenizer } from './tokenizer';

type Ort = typeof import('onnxruntime-node');
type OrtSession = import('onnxruntime-node').InferenceSession;
type OrtTensor = import('onnxruntime-node').Tensor;

export type NerLabel = 'NAME' | 'ORG' | 'ADDR';
export interface NerEntity { text: string; type: NerLabel; start: number; end: number }
export interface NerResult { entities: NerEntity[]; truncated: boolean; error?: string }

// ── 常量（口径与 Python 一致）────────────────────────────────────────────────
/** 单次识别的文本上限，超过则分段（段长，也是缓存粒度） */
const MAX_TEXT_CHARS = 4000;
/** 分段时相邻段的回看重叠：实体正好落在切点上时，能在另一段里被完整看到 */
const LONG_SEG_OVERLAP = 64;
const SEG_SNAP = 64;
/** 网格间距 = 段长 - 回看 - 吸附，三者相加恰好 = MAX_TEXT_CHARS，保证每段都 ≤ MAX */
const SEG_GRID = Math.max(1, MAX_TEXT_CHARS - LONG_SEG_OVERLAP - SEG_SNAP);
const SEG_BOUNDARY_RX = /[\n。！？；]/g;
/** 滑窗：400 字一窗、350 步长（50 字重叠）。每个 token 至少占 1 个字符，故 ≤ 402 个 token，远低于 512 */
const CHUNK_SIZE = 400;
const STRIDE = 350;
const MAX_SEQ_LEN = 512;
/** 单次调用（一段文本）的推理时间上限；须 ≥ 一段 4000 字文本能跑完的耗时并留余量，否则会形成“超时→不缓存→下轮重推”的稳态 */
const CALL_BUDGET_MS = 10_000;
const CACHE_MAX = 32768;
const CACHE_MAX_CHARS = 20_000_000;

const CJK_RX = /[\u4e00-\u9fff]/;

const ADDR_TAGS = new Set(['GPE', 'LOC', 'FAC']);
/** 行政区后缀：整段以此结尾且无门牌细节 → 只是“地名”不是“地址” */
const ADMIN_SUFFIXES = ['自治区', '特别行政区', '自治州', '自治县', '地区', '省', '市', '县', '区', '国'];
/** 门牌/街道/楼栋细节：出现任一即认为是具体地址，必须打码 */
const ADDR_DETAIL = ['路', '街', '道', '巷', '弄', '号', '楼', '室', '栋', '幢', '座', '单元',
  '院', '园', '村', '镇', '乡', '大厦', '广场', '小区', '花园', '公馆', '层', '段'];
const ORG_SUFFIXES = ['医院', '诊所', '卫生院', '妇幼保健院', '中医院', '大学', '学院', '学校',
  '分公司', '支行', '分行', '有限责任公司', '有限公司', '公司', '集团',
  '委员会', '事务所', '局', '厅', '处', '部', '院', '所', '中心', '实验室'];
const ADDR_TAIL_RX = /^[0-9A-Za-z一二三四五六七八九十\-号栋幢层楼室单元座段]+/;
const ADDR_BREAKS = ['，', '。', '！', '？', ';', ','];

/** 整段只是一个行政区名（无门牌/街道细节）→ 不当地址：“北京”“广东省”这类脱敏了也保护不了任何东西 */
function isBareRegion(s: string): boolean {
  if (!s || s.length > 10) return false;
  if (/\d/.test(s)) return false;
  if (ADDR_DETAIL.some((c) => s.includes(c))) return false;
  if (ADMIN_SUFFIXES.some((x) => s.endsWith(x))) return true;
  // “北京”“上海”这类不带后缀的裸城市名：足够短才算地名，再长可能是“海淀中关村”这种需要打码的片区
  return s.length <= 4;
}

function mapCategory(tag: string): NerLabel | null {
  if (tag === 'PERSON') return 'NAME';
  if (tag === 'ORG') return 'ORG';
  if (ADDR_TAGS.has(tag)) return 'ADDR';
  return null;
}

// ── 线程数：按“实际可用核数”自适应 ─────────────────────────────────────────────
function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'ascii').trim();
  } catch {
    return null;
  }
}

/** 容器 CPU 配额（核数，可为小数）；无配额返回 null */
function cgroupCpuQuota(): number | null {
  const v2 = readText('/sys/fs/cgroup/cpu.max');
  if (v2 !== null) {
    const [q, p] = v2.split(/\s+/);
    if (q && q !== 'max') {
      const quota = Number(q);
      const period = Number(p ?? 100000);
      return quota > 0 && period > 0 ? quota / period : null;
    }
    return null;
  }
  const q1 = readText('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
  const p1 = readText('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  if (q1 !== null && p1 !== null) {
    const quota = Number(q1);
    const period = Number(p1);
    return quota > 0 && period > 0 ? quota / period : null;
  }
  return null;
}

/**
 * 本进程实际可用核数：亲和性与 cgroup 配额取小，至少 1。
 * 不能直接用宿主核数：`--cpus=2` 的容器跑在 16 核宿主上时会开出 4 个互相抢核的线程，比单线程还慢。
 */
export function effectiveCpuCount(): number {
  let cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const quota = cgroupCpuQuota();
  if (quota) cores = Math.min(cores, Math.max(1, Math.ceil(quota)));
  return Math.max(1, cores || 1);
}

/** ONNX 每次推理的线程数：默认 min(4, 可用核数)，弱机上开多了只会互相抢核 */
export function intraThreads(): number {
  return Math.min(4, Math.max(1, effectiveCpuCount()));
}

// ── 结果缓存 ────────────────────────────────────────────────────────────────
type Triple = [number, number, NerLabel];

// 缓存键是进程密钥摘要：不把原文留在内存里，也不给跨进程关联留口子。值只存位置三元组。
const CACHE_KEY = randomBytes(32);
/** 任何会改变实体的改动（模型/分词/分段/规则口径）都必须 +1 */
const DETECT_VERSION = 'ner-ts-v1';

interface RawEntity { type: NerLabel; start: number; end: number }
interface TokenPreds { preds: number[]; offsets: Array<[number, number]> }

export class NerEngine {
  private readonly cache = new Map<string, { len: number; ents: Triple[] }>();
  private cacheChars = 0;
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly cacheSalt: string;
  /** 缓存与推理统计，供诊断 */
  readonly stats = { hit: 0, miss: 0, windows: 0 };

  private constructor(
    private readonly ort: Ort,
    private readonly session: OrtSession,
    private readonly tokenizer: BertTokenizer,
    private readonly id2label: ReadonlyMap<number, string>,
    readonly threads: number,
    modelDir: string,
  ) {
    this.cacheSalt = `${DETECT_VERSION}\0${modelDir}\0`;
  }

  /** 加载模型目录（model_quantized.onnx / tokenizer.json / config.json）。缺失或损坏时抛带中文原因的错误。 */
  static async load(modelDir: string): Promise<NerEngine> {
    const files = ['model_quantized.onnx', 'tokenizer.json', 'config.json'];
    const missing = files.filter((f) => !fs.existsSync(path.join(modelDir, f)));
    if (missing.length) throw new Error(`NER 模型文件缺失（${modelDir}）：${missing.join('、')}`);

    let tokenizer: BertTokenizer;
    try {
      tokenizer = new BertTokenizer(JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8')));
    } catch (e) {
      throw new Error(`NER 分词器文件损坏（tokenizer.json）：${(e as Error).message}`);
    }
    const id2label = new Map<number, string>();
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(modelDir, 'config.json'), 'utf8')) as { id2label?: Record<string, string> };
      for (const [k, v] of Object.entries(cfg.id2label ?? {})) id2label.set(Number(k), String(v));
      if (!id2label.size) throw new Error('缺少 id2label');
    } catch (e) {
      throw new Error(`NER 模型配置损坏（config.json）：${(e as Error).message}`);
    }

    let ort: Ort;
    try {
      ort = await import('onnxruntime-node');
    } catch (e) {
      throw new Error(`NER 运行时（onnxruntime-node）无法加载，可能当前平台不受支持或安装包不完整：${(e as Error).message}`);
    }
    const threads = intraThreads();
    let session: OrtSession;
    try {
      session = await ort.InferenceSession.create(path.join(modelDir, 'model_quantized.onnx'), {
        intraOpNumThreads: threads,
        graphOptimizationLevel: 'all',
        executionProviders: ['cpu'],
        // 关掉线程池空转：默认每次推理结束后忙等约 1 秒，请求间隔里白烧 CPU（Python 版实测）
        extra: { session: { intra_op: { allow_spinning: '0' } } },
      });
    } catch (e) {
      throw new Error(`NER 模型加载失败（model_quantized.onnx 可能已损坏）：${(e as Error).message}`);
    }
    const engine = new NerEngine(ort, session, tokenizer, id2label, threads, path.resolve(modelDir));
    // 预热：把图优化与内存池分配的开销花在加载阶段，而不是第一个用户请求上；顺便验证模型真能跑
    const warm = await engine.extract('预热一下', Date.now() + 30_000);
    if (warm.error) {
      await engine.dispose();
      throw new Error(`NER 模型加载失败：${warm.error}`);
    }
    return engine;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cache.clear();
    this.cacheChars = 0;
    await this.tail.catch(() => undefined);
    await this.session.release();
  }

  /**
   * 识别一段文本；超过 deadline（Date.now() 毫秒时间戳）停止并 truncated=true。
   * 返回的 start/end 是 text 内的 UTF-16 偏移。
   */
  async extract(text: string, deadline: number): Promise<NerResult> {
    if (this.disposed) return { entities: [], truncated: false, error: 'NER 引擎已释放' };
    if (!text || text.trim().length < 2) return { entities: [], truncated: false };
    // 纯英文/代码无需识别：本模型只认中文实体，BERT 子词切碎英文反而会误报
    if (!CJK_RX.test(text)) return { entities: [], truncated: false };
    if (text.length > MAX_TEXT_CHARS) return this.extractLong(text, deadline);
    return this.extractSegment(text, deadline);
  }

  /**
   * 批量识别，最新消息优先（从最后一条往前）。共享一份总预算：预算耗尽后，
   * 缓存命中的文本仍然照常返回（零成本），未命中的跳过并置 truncated。
   * 返回按“类型+实体原文”去重的列表；其 start/end 是它首次出现的那条文本内的偏移。
   */
  async extractMany(texts: string[], budgetMs: number): Promise<NerResult> {
    const deadline = Date.now() + Math.max(0, budgetMs);
    const seen = new Set<string>();
    const done = new Set<string>();
    const out: NerEntity[] = [];
    let truncated = false;
    let error: string | undefined;
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i];
      if (typeof t !== 'string' || done.has(t)) continue;
      done.add(t);
      const r = await this.extract(t, deadline);
      if (r.truncated) truncated = true;
      if (r.error && !error) error = r.error;
      for (const e of r.entities) {
        const k = `${e.type}\0${e.text}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(e);
      }
    }
    return { entities: out, truncated, ...(error ? { error } : {}) };
  }

  // ── 分段 ──────────────────────────────────────────────────────────────────
  /** 长文本切点（升序，不含 0 与 len）。切点只由前缀决定，尾部追加不会移动已有切点——历史重发时前面各段缓存照常命中。 */
  private longSegCuts(text: string): number[] {
    const cuts: number[] = [];
    const total = text.length;
    let pos = SEG_GRID;
    while (pos < total) {
      SEG_BOUNDARY_RX.lastIndex = pos;
      const m = SEG_BOUNDARY_RX.exec(text);
      const cut = m && m.index < Math.min(total, pos + SEG_SNAP) ? m.index + 1 : pos;
      if (cut >= total) break;
      cuts.push(cut);
      pos = cut + SEG_GRID;
    }
    return cuts;
  }

  private async extractLong(text: string, deadline: number): Promise<NerResult> {
    const out: NerEntity[] = [];
    const overlap = Math.min(LONG_SEG_OVERLAP, MAX_TEXT_CHARS >> 1);
    const total = text.length;
    let prev = 0;
    let truncated = false;
    let error: string | undefined;
    for (const cut of [...this.longSegCuts(text), total]) {
      if (cut <= prev) continue;
      // 起点回看 overlap 字（切点已吸附到换行/句末，这是第二道保险）
      const start = prev === 0 ? 0 : this.avoidSplit(text, Math.max(0, prev - overlap));
      const seg = text.slice(start, this.avoidSplit(text, cut));
      // 预算耗尽后仍继续：缓存命中的段零成本，未命中的段会立即返回 truncated，不会起推理
      const r = await this.extract(seg, deadline);
      if (r.truncated) truncated = true;
      if (r.error && !error) error = r.error;
      for (const e of r.entities) {
        out.push({ type: e.type, start: e.start + start, end: e.end + start, text: e.text });
      }
      prev = cut;
    }
    return { entities: mergeOverlaps(out, text), truncated, ...(error ? { error } : {}) };
  }

  /** 切点不能落在代理对中间 */
  private avoidSplit(text: string, i: number): number {
    if (i > 0 && i < text.length) {
      const c = text.charCodeAt(i);
      if (c >= 0xdc00 && c <= 0xdfff) return i - 1;
    }
    return i;
  }

  // ── 单段（≤ MAX_TEXT_CHARS）识别 ───────────────────────────────────────────
  private async extractSegment(text: string, deadline: number): Promise<NerResult> {
    const fp = createHmac('sha256', CACHE_KEY).update(this.cacheSalt).update(text).digest('hex');
    const cached = this.cache.get(fp);
    if (cached) {
      this.stats.hit++;
      // LRU：命中后移到尾部。值只有位置，text 从当前文本即时切出（摘要相等 = 文本逐字节相同）
      this.cache.delete(fp);
      this.cache.set(fp, cached);
      return { entities: cached.ents.map(([s, e, t]) => ({ type: t, start: s, end: e, text: text.slice(s, e) })), truncated: false };
    }
    this.stats.miss++;
    const dl = Math.min(deadline, Date.now() + CALL_BUDGET_MS);
    if (Date.now() >= dl) return { entities: [], truncated: true };

    const { raw, complete, error } = await this.exclusive(() => this.decodeChunks(text, dl));
    const entities = refine(text, raw);
    // 只有完整跑完的结果才入缓存（含负缓存）：残缺结果缓存下来等于让该文本此后永久欠脱敏
    if (complete && !error) this.cachePut(fp, text.length, entities);
    return { entities, truncated: !complete, ...(error ? { error } : {}) };
  }

  private cachePut(key: string, len: number, ents: NerEntity[]): void {
    const old = this.cache.get(key);
    if (old) {
      this.cacheChars -= old.len;
      this.cache.delete(key);
    }
    this.cache.set(key, { len, ents: ents.map((e): Triple => [e.start, e.end, e.type]) });
    this.cacheChars += len;
    while (this.cache.size && (this.cache.size > CACHE_MAX || this.cacheChars > CACHE_MAX_CHARS)) {
      const k = this.cache.keys().next().value!;
      this.cacheChars -= this.cache.get(k)!.len;
      this.cache.delete(k);
    }
  }

  /** ONNX 会话一次只跑一个推理：多请求并发时线程数会乘性叠加，反而更慢 */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => { release = r; });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** 滑窗推理。complete 必须如实回报：超时/推理异常都会带着残缺实体收手 */
  private async decodeChunks(text: string, deadline: number): Promise<{ raw: RawEntity[]; complete: boolean; error?: string }> {
    const raw: RawEntity[] = [];
    const total = text.length;
    let pos = 0;
    while (pos < total) {
      if (Date.now() >= deadline) return { raw, complete: false };
      const chunk = text.slice(pos, this.avoidSplit(text, Math.min(total, pos + CHUNK_SIZE)));
      if (!chunk) break;

      // 不含汉字的窗口不可能产出中文实体；窗口间有 50 字重叠，跨窗实体一定会在相邻窗口完整出现，跳过不会漏
      if (CJK_RX.test(chunk)) {
        try {
          this.stats.windows++;
          this.collect(pos, await this.infer(chunk), raw);
        } catch (e) {
          // 单窗推理失败：收手并上报，返回已识别的部分
          return { raw, complete: false, error: `NER 推理异常：${(e as Error).message}` };
        }
      }
      if (pos + CHUNK_SIZE >= total) break;
      pos += STRIDE;
    }
    // 最后一窗跑完时若已越过 deadline，不当作完整结果（调用方据此决定是否缓存）
    return { raw, complete: Date.now() <= deadline };
  }

  /** 返回每个 token 的预测标签 id，与 tokenizer 偏移对齐 */
  private async infer(chunk: string): Promise<TokenPreds> {
    let { ids, offsets } = this.tokenizer.encode(chunk);
    if (ids.length > MAX_SEQ_LEN) {
      // 理论不会发生（窗口 400 字 → ≤402 token），兜底保证不超模型上限
      ids = [...ids.slice(0, MAX_SEQ_LEN - 1), ids[ids.length - 1]];
      offsets = [...offsets.slice(0, MAX_SEQ_LEN - 1), [0, 0]];
    }
    const n = ids.length;
    const tensor = (fill: (i: number) => number): OrtTensor => {
      const arr = new BigInt64Array(n);
      for (let i = 0; i < n; i++) arr[i] = BigInt(fill(i));
      return new this.ort.Tensor('int64', arr, [1, n]);
    };
    const all: Record<string, OrtTensor> = {
      input_ids: tensor((i) => ids[i]),
      attention_mask: tensor(() => 1),
      token_type_ids: tensor(() => 0),
    };
    const feeds: Record<string, OrtTensor> = {};
    for (const name of this.session.inputNames) if (all[name]) feeds[name] = all[name];
    const out = await this.session.run(feeds);
    const logits = out[this.session.outputNames[0]];
    const data = logits.data as Float32Array;
    const labels = Number(logits.dims[logits.dims.length - 1]);
    if (!labels || data.length < n * labels) throw new Error('模型输出形状与输入不符');
    const preds: number[] = new Array(n);
    for (let t = 0; t < n; t++) {
      let best = 0;
      let bv = -Infinity;
      const base = t * labels;
      for (let k = 0; k < labels; k++) {
        const v = data[base + k];
        if (v > bv) {
          bv = v;
          best = k;
        }
      }
      preds[t] = best;
    }
    return { preds, offsets };
  }

  /** BIOES 解码（与 Python 一致）：非法/未知标签收尾并跳过，宁可漏一个实体也不抛异常 */
  private collect(pos: number, r: TokenPreds, raw: RawEntity[]): void {
    let curr: RawEntity | null = null;
    const flush = (): void => {
      if (curr) raw.push(curr);
      curr = null;
    };
    for (let i = 0; i < r.preds.length; i++) {
      const [s, e] = r.offsets[i];
      if (s === e) continue;
      const lbl = this.id2label.get(r.preds[i]) ?? 'O';
      const absS = pos + s;
      const absE = pos + e;
      if (lbl === 'O') {
        flush();
        continue;
      }
      // 形态守卫：要求 "B-XXX" 这种长度 ≥3 且第 2 位是 '-'
      if (lbl.length < 3 || lbl[1] !== '-') {
        flush();
        continue;
      }
      const prefix = lbl[0];
      const cat = mapCategory(lbl.slice(2));
      if (!cat) {
        flush();
        continue;
      }
      if (prefix === 'B' || prefix === 'S') {
        flush();
        curr = { type: cat, start: absS, end: absE };
        if (prefix === 'S') flush();
      } else if (prefix === 'I' || prefix === 'E') {
        const c = curr as RawEntity | null;
        if (c && c.type === cat) {
          c.end = absE;
          if (prefix === 'E') flush();
        } else {
          flush();
          curr = { type: cat, start: absS, end: absE };
          if (prefix === 'E') flush();
        }
      } else {
        flush();
      }
    }
    flush();
  }
}

/** 重叠裁剪：同一实体在相邻段各识别一次，保留靠前更长的；跨切点的取并集，尾部裁剪而不是整条丢（丢了会漏尾巴） */
function mergeOverlaps(ents: NerEntity[], text: string): NerEntity[] {
  if (!ents.length) return [];
  ents.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: NerEntity[] = [];
  for (let ent of ents) {
    const last = out[out.length - 1];
    if (last && ent.start < last.end) {
      if (ent.end <= last.end) continue;
      ent = { ...ent, start: last.end, text: text.slice(last.end, ent.end) };
    }
    out.push(ent);
  }
  return out;
}

/** 原始片段 → 最终实体：去重裁剪、后缀吸附、FP 过滤、相邻地址缝合 */
function refine(text: string, rawEntities: RawEntity[]): NerEntity[] {
  if (!rawEntities.length) return [];
  const sorted = [...rawEntities].sort((a, b) => a.start - b.start || b.end - a.end);
  // 去重与区间排序。重叠时裁剪而不是整条丢弃：丢弃会让 [lastEnd, end) 既不属于任何实体也不被打码
  const deduped: RawEntity[] = [];
  let lastEnd = -1;
  for (let ent of sorted) {
    if (ent.start < lastEnd) {
      if (ent.end <= lastEnd) continue;
      ent = { ...ent, start: lastEnd };
    }
    deduped.push(ent);
    lastEnd = ent.end;
  }

  const refined: RawEntity[] = [];
  for (const ent of deduped) {
    let { start, end } = ent;
    if (ent.type === 'ORG') {
      const tail = text.slice(end, end + 12);
      for (const sfx of ORG_SUFFIXES) {
        if (tail.startsWith(sfx)) {
          end += sfx.length;
          break;
        }
      }
    } else if (ent.type === 'ADDR') {
      // 门牌与楼栋吸附
      const m = ADDR_TAIL_RX.exec(text.slice(end, end + 20));
      if (m) end += m[0].length;
    }
    // 收窄两端空白，免得把空格/换行一起换成占位符（还原后会丢排版）
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    const entText = text.slice(start, end);
    // 过滤极短或无意义实体；跨行/制表的不是实体
    if (entText.length <= 1) continue;
    if (/[\n\r\t]/.test(entText)) continue;
    if (ent.type === 'ADDR' && isBareRegion(entText)) continue;
    refined.push({ type: ent.type, start, end });
  }

  // 后缀吸附发生在去重之后，可能越过下一个实体的起点：按起点重排并裁剪重叠
  refined.sort((a, b) => a.start - b.start || b.end - a.end);
  const trimmed: RawEntity[] = [];
  for (let ent of refined) {
    const last = trimmed[trimmed.length - 1];
    if (last && ent.start < last.end) {
      if (ent.end <= last.end) continue;
      ent = { ...ent, start: last.end };
    }
    trimmed.push(ent);
  }

  // 相邻同类地址缝合（相距 ≤6 字符且无标点中断）
  const merged: RawEntity[] = [];
  for (const ent of trimmed) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === 'ADDR' && ent.type === 'ADDR') {
      const gap = text.slice(prev.end, ent.start);
      if (gap.length <= 6 && !ADDR_BREAKS.some((p) => gap.includes(p))) {
        prev.end = ent.end;
        continue;
      }
    }
    merged.push({ ...ent });
  }
  return merged
    .map((e) => ({ type: e.type, start: e.start, end: e.end, text: text.slice(e.start, e.end) }))
    .filter((e) => e.text.length >= 2);
}
