/**
 * 多端口反向代理网关。
 *
 * 每个 upstream 一个本地端口：客户端把 base_url 指向 http://127.0.0.1:<port>，
 * 本地到网关是明文 HTTP（无需装 CA），网关到上游走 HTTPS。
 * 不依赖 Electron，可单独跑在 Docker / 纯 Node 环境。
 */
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import { Agent, fetch, ProxyAgent, type Dispatcher, type Response } from 'undici';
import { maskJson, Masker, Restorer, SseRestorer } from '../core';
import type { AuditFinding } from '../core/audit';
import { CommandScanner, DEFAULT_COMMAND_BLOCK } from '../core/command-block';
import { modelFromJson, type Usage } from '../core/usage';
import { ResponseInspector, type CommandRecord, type InspectPolicy } from './inspect';
import type { NerEntity } from '../ner/engine';
import { entityMap, requestTexts } from '../ner/request-texts';

export interface Upstream {
  name: string;
  port: number;
  /** 上游根地址，如 https://api.openai.com */
  target: string;
  /** 需要脱敏的路径（精确或后缀匹配），其余路径原样透传 */
  paths: string[];
}

/** 本地 NER 适配（NerEngine.extractMany 即满足）；失败走 error 字段上报，绝不阻断请求 */
export interface GatewayNer {
  extract(texts: string[], budgetMs: number): Promise<{ entities: NerEntity[]; truncated: boolean; error?: string }>;
  /** 单个请求的 NER 总预算（毫秒） */
  budgetMs: number;
}

export interface GatewayEvent {
  id: string;
  time: number;
  upstream: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  stream: boolean;
  /** 只记标签与占位符，不落原文 */
  hits: { label: string; token: string }[];
  restored: number;
  unresolved: number;
  signedBlocksSkipped: number;
  error?: string;
  /** 落库序号（同一毫秒内的先后），与 time 一起组成分页游标；由服务层写入 */
  seq?: number;
  /** 经容错形态或标签兼容回退才还原成功的次数 */
  degraded?: number;
  model?: string;
  usage?: Usage;
  /** 估算费用（USD），无价格时缺省 */
  cost?: number;
  /** 被动审计发现 */
  findings?: AuditFinding[];
  /** 命中的危险命令 */
  commands?: CommandRecord[];
  /** 本地 NER 概况：失败/超时降级必须在这里可见（规则脱敏仍照常生效） */
  ner?: { entities: number; truncated: boolean; error?: string };
}

const MAX_BODY = 32 * 1024 * 1024;
/** 逐跳头与需要网关重算的头 */
const DROP_REQ_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization',
  'transfer-encoding', 'content-length', 'accept-encoding', 'upgrade', 'te', 'trailer', 'expect',
]);
const DROP_RES_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding']);

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request_body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 本机上游（如本地 Ollama）永远直连，不经出网代理 */
function isLoopback(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/**
 * 按 Content-Encoding 解压请求体（多个编码按应用顺序列出，需逆序解码）。
 * 未知编码 / 解压失败 / 超出 MAX_BODY 一律抛错，由调用方 fail-closed。
 */
function decodeRequestBody(body: Buffer, encodingHeader: string): Buffer {
  const encodings = encodingHeader.split(',').map((x) => x.trim().toLowerCase()).filter((x) => x && x !== 'identity');
  const opts = { maxOutputLength: MAX_BODY };
  let out = body;
  for (const enc of encodings.reverse()) {
    try {
      switch (enc) {
        case 'gzip':
        case 'x-gzip':
          out = zlib.gunzipSync(out, opts);
          break;
        case 'deflate':
          try {
            out = zlib.inflateSync(out, opts);
          } catch (e) {
            // 部分客户端发送无 zlib 头的 raw deflate；超限错误不回退
            if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw e;
            out = zlib.inflateRawSync(out, opts);
          }
          break;
        case 'br':
          out = zlib.brotliDecompressSync(out, opts);
          break;
        case 'zstd': {
          const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer, o: object) => Buffer }).zstdDecompressSync;
          if (typeof zstd !== 'function') throw new Error('当前运行时不支持 zstd');
          out = zstd(out, opts);
          break;
        }
        default:
          throw new Error(`不支持的 Content-Encoding: ${enc}`);
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`解压后超过 ${MAX_BODY / 1024 / 1024}MB 上限`);
      throw e;
    }
  }
  return out;
}

function matchPath(pathname: string, paths: string[]): boolean {
  return paths.some((p) => pathname === p || pathname.endsWith(p));
}

function sendJsonError(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { type: 'maskit_gateway_error', message } }));
}

export class Gateway extends EventEmitter {
  private servers = new Map<number, http.Server>();
  /** false = 原样透传（端口保持监听，客户端不会断网） */
  maskEnabled = true;
  /** 监听地址：默认仅回环；Docker/无头部署由服务端设为 0.0.0.0 */
  listenHost = '127.0.0.1';
  /** 本地 NER（null/undefined = 未启用）；只补充规则覆盖不到的人名/机构/地址 */
  ner?: GatewayNer | null;
  /** 当前出网代理（null = 直连） */
  egressProxy: string | null = null;
  private dispatcher: Dispatcher = new Agent();
  private readonly direct = new Agent();
  /** 响应检查策略：命令拦截、审计、价格（配置变更时整体替换） */
  policy: InspectPolicy = { commands: new CommandScanner(DEFAULT_COMMAND_BLOCK), auditEnabled: true, prices: {} };

  constructor(private readonly masker: Masker) {
    super();
  }

  /**
   * 经当前出网代理发起请求（模型下载、上游连通性测试）：与转发请求走同一条出网路径，
   * 用户配了代理时不会出现「网关能通、下载不通」。本机地址始终直连。
   */
  readonly egressFetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return fetch(url, {
      ...(init as object),
      dispatcher: isLoopback(url) ? this.direct : this.dispatcher,
    }) as unknown as Promise<globalThis.Response>;
  };

  /** 切换出网代理：国内网络通常需要经本机代理访问上游，Node 的 fetch 不会自动读系统代理 */
  setEgressProxy(url: string | null): void {
    const old = this.dispatcher;
    this.dispatcher = url ? new ProxyAgent(url) : new Agent();
    this.egressProxy = url;
    // 进行中的请求仍在用旧连接池，优雅关闭而非销毁
    old.close().catch(() => undefined);
  }

  get listening(): number[] {
    return [...this.servers.keys()];
  }

  async start(upstreams: Upstream[]): Promise<void> {
    await this.stop();
    for (const up of upstreams) {
      const server = http.createServer((req, res) => {
        this.handle(up, req, res).catch((e) => sendJsonError(res, 502, String(e?.message ?? e)));
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(up.port, this.listenHost, () => resolve());
      });
      this.servers.set(up.port, server);
    }
  }

  async stop(): Promise<void> {
    const all = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(all.map((s) => new Promise<void>((r) => {
      s.closeAllConnections();
      s.close(() => r());
    })));
  }

  private async handle(up: Upstream, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://local');
    const targetUrl = up.target.replace(/\/+$/, '') + url.pathname + url.search;
    const isTarget = this.maskEnabled && req.method === 'POST' && matchPath(url.pathname, up.paths)
      && String(req.headers['content-type'] ?? '').includes('json');

    const ev: GatewayEvent = {
      id: randomUUID(), time: started, upstream: up.name, method: req.method ?? 'GET', path: url.pathname,
      status: 0, durationMs: 0, stream: false, hits: [], restored: 0, unresolved: 0, signedBlocksSkipped: 0,
    };

    let body: Buffer = await readBody(req);
    const contentEncoding = String(req.headers['content-encoding'] ?? '').trim();
    if (isTarget && contentEncoding && body.length) {
      try {
        body = decodeRequestBody(body, contentEncoding);
      } catch (e) {
        // fail-closed：无法解码就无法脱敏，绝不把压缩体原样转发
        ev.error = `decode_failed: ${(e as Error).message}`;
        ev.status = 502;
        this.finish(ev, started);
        sendJsonError(res, 502, `Maskit 无法解码请求体（Content-Encoding: ${contentEncoding}），已阻断请求: ${(e as Error).message}`);
        return;
      }
    }
    let inspector: ResponseInspector | undefined;
    if (isTarget && body.length) {
      try {
        const requestText = body.toString('utf8');
        const parsed = JSON.parse(requestText);
        inspector = new ResponseInspector(this.policy, requestText, modelFromJson(parsed));
        // NER 在 maskJson 之前跑：它看的是未脱敏原文。失败/超时只降级（规则照常生效），并记入事件
        const entities = await this.runNer(parsed, ev);
        const result = maskJson(this.masker, parsed, entities ? { entities } : undefined);
        // 没命中就一个字节都不改，保住上游前缀缓存
        if (result.changed) body = Buffer.from(JSON.stringify(result.body), 'utf8');
        ev.hits = result.hits.map(({ label, token }) => ({ label, token }));
        ev.signedBlocksSkipped = result.signedBlocksSkipped;
      } catch (e) {
        // fail-closed：脱敏失败绝不明文透传
        ev.error = `mask_failed: ${(e as Error).message}`;
        ev.status = 502;
        this.finish(ev, started);
        sendJsonError(res, 502, `Maskit 脱敏失败，已阻断请求: ${(e as Error).message}`);
        return;
      }
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || DROP_REQ_HEADERS.has(k)) continue;
      // 目标路径已解压，转发的是明文体，必须去掉 content-encoding
      if (isTarget && k === 'content-encoding') continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    headers['accept-encoding'] = 'identity';

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : body,
        signal: abort.signal,
        redirect: 'manual',
        dispatcher: isLoopback(targetUrl) ? this.direct : this.dispatcher,
      });
    } catch (e) {
      ev.error = `upstream_failed: ${(e as Error).message}`;
      ev.status = 502;
      this.finish(ev, started);
      sendJsonError(res, 502, `上游请求失败: ${(e as Error).message}`);
      return;
    }

    ev.status = upstreamRes.status;
    const resHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((v, k) => {
      if (!DROP_RES_HEADERS.has(k)) resHeaders[k] = v;
    });
    const ct = upstreamRes.headers.get('content-type') ?? '';
    const restorer = new Restorer(this.masker.store);

    try {
      if (!isTarget || !upstreamRes.body) {
        res.writeHead(upstreamRes.status, resHeaders);
        if (upstreamRes.body) for await (const c of upstreamRes.body) res.write(c);
        res.end();
      } else if (ct.includes('text/event-stream')) {
        ev.stream = true;
        res.writeHead(upstreamRes.status, resHeaders);
        res.flushHeaders();
        const sse = new SseRestorer(restorer, inspector?.sseHooks());
        const decoder = new TextDecoder();
        for await (const c of upstreamRes.body) {
          const out = sse.push(decoder.decode(c, { stream: true }));
          if (out) res.write(out);
          // 危险命令阻断：错误事件已随 out 下发，停止读上游
          if (sse.blocked) break;
        }
        if (sse.blocked) {
          ev.error = 'command_blocked';
          res.end();
        } else {
          res.end(sse.push(decoder.decode()) + sse.end());
          if (sse.blocked) ev.error = 'command_blocked';
        }
      } else {
        const raw = Buffer.from(await upstreamRes.arrayBuffer()).toString('utf8');
        let out = raw;
        if (upstreamRes.status >= 400) inspector?.inspectError(upstreamRes.status, raw);
        if (ct.includes('json')) {
          try {
            const parsed = JSON.parse(raw);
            const restored = restorer.restoreTree(parsed);
            out = JSON.stringify(inspector ? inspector.inspectJson(restored, parsed) : restored);
          } catch {
            out = restorer.restore(raw, '', false, true);
          }
        }
        if (inspector?.blocked) {
          ev.error = 'command_blocked';
          ev.status = 503;
          sendJsonError(res, 503, 'Data Maskit 已阻断模型下发的危险命令（可在「规则 → 危险命令拦截」调整）');
        } else {
          res.writeHead(upstreamRes.status, resHeaders);
          res.end(out);
        }
      }
    } catch (e) {
      ev.error = abort.signal.aborted ? 'client_cancelled' : `stream_failed: ${(e as Error).message}`;
      res.destroy();
    }
    ev.restored = restorer.stats.restored;
    ev.unresolved = restorer.stats.unresolved;
    if (restorer.stats.degraded) ev.degraded = restorer.stats.degraded;
    inspector?.finish(ev);
    this.finish(ev, started);
  }

  private async runNer(parsed: unknown, ev: GatewayEvent): Promise<Map<string, string> | undefined> {
    const ner = this.ner;
    if (!ner) return undefined;
    const texts = requestTexts(parsed);
    if (!texts.length) {
      ev.ner = { entities: 0, truncated: false };
      return undefined;
    }
    try {
      const r = await ner.extract(texts, ner.budgetMs);
      const entities = entityMap(r.entities);
      ev.ner = { entities: entities.size, truncated: r.truncated, ...(r.error ? { error: r.error } : {}) };
      return entities;
    } catch (e) {
      ev.ner = { entities: 0, truncated: false, error: `ner_failed: ${(e as Error).message}` };
      return undefined;
    }
  }

  private finish(ev: GatewayEvent, started: number): void {
    ev.durationMs = Date.now() - started;
    this.emit('event', ev);
  }
}
