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
import { Agent, fetch, ProxyAgent, type Dispatcher, type Response } from 'undici';
import { maskJson, Masker, Restorer, SseRestorer } from '../core';

export interface Upstream {
  name: string;
  port: number;
  /** 上游根地址，如 https://api.openai.com */
  target: string;
  /** 需要脱敏的路径（精确或后缀匹配），其余路径原样透传 */
  paths: string[];
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
  /** 当前出网代理（null = 直连） */
  egressProxy: string | null = null;
  private dispatcher: Dispatcher = new Agent();
  private readonly direct = new Agent();

  constructor(private readonly masker: Masker) {
    super();
  }

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
        server.listen(up.port, '127.0.0.1', () => resolve());
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
    if (isTarget && body.length) {
      try {
        const result = maskJson(this.masker, JSON.parse(body.toString('utf8')));
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
        const sse = new SseRestorer(restorer);
        const decoder = new TextDecoder();
        for await (const c of upstreamRes.body) {
          const out = sse.push(decoder.decode(c, { stream: true }));
          if (out) res.write(out);
        }
        res.end(sse.push(decoder.decode()) + sse.end());
      } else {
        const raw = Buffer.from(await upstreamRes.arrayBuffer()).toString('utf8');
        let out = raw;
        if (ct.includes('json')) {
          try {
            out = JSON.stringify(restorer.restoreTree(JSON.parse(raw)));
          } catch {
            out = restorer.restore(raw, '', false, true);
          }
        }
        res.writeHead(upstreamRes.status, resHeaders);
        res.end(out);
      }
    } catch (e) {
      ev.error = abort.signal.aborted ? 'client_cancelled' : `stream_failed: ${(e as Error).message}`;
      res.destroy();
    }
    ev.restored = restorer.stats.restored;
    ev.unresolved = restorer.stats.unresolved;
    this.finish(ev, started);
  }

  private finish(ev: GatewayEvent, started: number): void {
    ev.durationMs = Date.now() - started;
    this.emit('event', ev);
  }
}
