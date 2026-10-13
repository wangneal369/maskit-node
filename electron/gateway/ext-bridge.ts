/**
 * 浏览器扩展桥接服务（遵循 /api/ext/* 协议，扩展无需改动即可接入）。
 *
 * 扩展 SW 是唯一调用方：页面发出的请求体经 /api/ext/mask 打码后出网，
 * 回包按块经 /api/ext/restore 流式还原。只监听 127.0.0.1。
 *
 * 失败语义（与扩展侧约定）：
 * - 打码失败 → 带 blocking:true，扩展阻断请求，绝不明文出网；
 * - 令牌错 / 桥接关闭 → 403 不带 blocking，扩展按「直通」处理并红标提示；
 * - 还原方向恒透传：任何失败都把原文交回。
 */
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { maskBody, Restorer, SseRestorer, type Masker } from '../core';
import type { GatewayEvent } from './proxy';
import { maskOoxml } from './ooxml';

/** 与扩展 shared.js 的 EXT_PROTOCOL_VERSION 对齐：/api/ext/* 契约变化时才 +1 */
export const EXT_PROTOCOL_VERSION = 1;
const EXT_ORIGIN_SCHEMES = ['chrome-extension://', 'moz-extension://', 'safari-web-extension://'];
const MAX_BODY = 32 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 500;
const MAX_STREAMS_PER_SESSION = 16;

export interface ExtBridgeConfig {
  enabled: boolean;
  port: number;
  token: string;
  /** 引擎不可达时扩展是否阻断请求（扩展侧读 ping 里的这个开关） */
  blockWhenEngineDown: boolean;
  recordEvents: boolean;
}

export const DEFAULT_EXT_CONFIG: ExtBridgeConfig = {
  enabled: false,
  port: 5801,
  token: '',
  blockWhenEngineDown: false,
  recordEvents: true,
};

export function generateExtToken(): string {
  return randomBytes(18).toString('base64url');
}

interface StreamState {
  restorer: Restorer;
  sse?: SseRestorer;
}

interface Session {
  lastUsed: number;
  streams: Map<string, StreamState>;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.error));
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, { ok: false, error: 'payload_too_large', blocking: true, limit_bytes: MAX_BODY }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function tokenEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export class ExtBridge extends EventEmitter {
  private server: http.Server | null = null;
  private config: ExtBridgeConfig = { ...DEFAULT_EXT_CONFIG };
  private readonly sessions = new Map<string, Session>();
  private readonly stats = { mask: 0, restore: 0 };

  constructor(private readonly masker: Masker, private readonly version: string) {
    super();
  }

  get listeningPort(): number | null {
    return this.server ? this.config.port : null;
  }

  /** 端口变化或启停时重建监听；其余字段即时生效。 */
  async apply(config: ExtBridgeConfig): Promise<void> {
    const needRestart = !this.server || config.port !== this.config.port;
    this.config = { ...config };
    if (!config.enabled) {
      await this.stop();
      return;
    }
    if (!needRestart) return;
    await this.stop();
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => this.send(res, 500, { ok: false, error: 'engine_error', message: String(e) }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', () => resolve());
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.sessions.clear();
    if (!s) return;
    await new Promise<void>((r) => {
      s.closeAllConnections();
      s.close(() => r());
    });
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    if (path === '/healthz') return this.send(res, 200, { ok: true });

    // DNS 重绑定防护：Host 必须是本机回环地址
    const port = this.config.port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(String(req.headers.host ?? ''))) {
      return this.send(res, 403, { ok: false, error: 'host_rejected' });
    }
    // 网页上下文的 Origin 一律拒绝；扩展 SW 的 POST 带 chrome-extension:// 等来源
    const origin = String(req.headers.origin ?? '');
    if (origin && !EXT_ORIGIN_SCHEMES.some((s) => origin.toLowerCase().startsWith(s))) {
      return this.send(res, 403, { ok: false, error: 'origin_rejected' });
    }
    // ext_token 为空时恒拒绝：不允许「没设令牌就全放行」
    const token = String(req.headers['x-shield-token'] ?? '');
    if (!this.config.token || !tokenEquals(token, this.config.token)) {
      return this.send(res, 403, { ok: false, error: 'invalid_token', message: '无效请求令牌' });
    }

    try {
      if (req.method === 'GET' && path === '/api/ext/ping') return this.ping(res);
      if (req.method !== 'POST') return this.send(res, 404, { ok: false, error: 'not_found' });
      if (req.headers['transfer-encoding'] && path !== '/api/ext/restore') {
        // 分块体无法预先判定大小，打码方向一律拒绝（带 blocking，扩展阻断而非直通）
        return this.send(res, 413, { ok: false, error: 'payload_too_large', blocking: true, limit_bytes: MAX_BODY });
      }
      const raw = await readBody(req);
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(raw || '{}');
      } catch {
        data = {};
      }
      switch (path) {
        case '/api/ext/mask': return this.mask(res, data);
        case '/api/ext/restore': return this.restore(res, data);
        case '/api/ext/mask-file': return this.maskFile(res, data);
        case '/api/ext/warn': return this.warn(res, data);
        default: return this.send(res, 404, { ok: false, error: 'not_found' });
      }
    } catch (e) {
      if (e instanceof HttpError) return this.send(res, e.status, e.body);
      throw e;
    }
  }

  private ping(res: http.ServerResponse): void {
    this.send(res, 200, {
      ok: true,
      version: this.version,
      ext_protocol: EXT_PROTOCOL_VERSION,
      block_when_down: this.config.blockWhenEngineDown,
      record_events: this.config.recordEvents,
      stats: { ...this.stats },
    });
  }

  /** 复用扩展传来的有效 sid（同一标签页多轮对话），否则签发新的；客户端不能自造 sid。 */
  private session(sid: unknown, create: boolean): [string, Session] | null {
    const now = Date.now();
    for (const [k, s] of this.sessions) {
      if (now - s.lastUsed > SESSION_TTL_MS) this.sessions.delete(k);
    }
    if (typeof sid === 'string' && this.sessions.has(sid)) {
      const s = this.sessions.get(sid)!;
      s.lastUsed = now;
      return [sid, s];
    }
    if (!create) return null;
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    const id = `ext:${randomBytes(8).toString('hex')}`;
    const s: Session = { lastUsed: now, streams: new Map() };
    this.sessions.set(id, s);
    return [id, s];
  }

  private mask(res: http.ServerResponse, data: Record<string, unknown>): void {
    const text = data.text;
    if (typeof text !== 'string' || !text) return this.send(res, 400, { ok: false, error: 'bad_request', blocking: true });
    const started = Date.now();
    const [sid] = this.session(data.sid, true)!;
    try {
      const r = maskBody(this.masker, text);
      this.stats.mask++;
      if (r.hits.length) {
        this.record({
          method: 'EXT', path: '/ext/mask', host: data.host, started,
          hits: r.hits.map(({ label, token }) => ({ label, token })), signedBlocksSkipped: r.signedBlocksSkipped,
        });
      }
      this.send(res, 200, { ok: true, masked_text: r.text, sid });
    } catch (e) {
      // 打码失败无条件阻断：绝不明文出网
      this.record({ method: 'EXT', path: '/ext/mask', host: data.host, started, status: 503, error: `mask_failed: ${(e as Error).message}` });
      this.send(res, 503, { ok: false, error: 'engine_error', blocking: true });
    }
  }

  private maskFile(res: http.ServerResponse, data: Record<string, unknown>): void {
    const filename = typeof data.filename === 'string' ? data.filename.trim() : '';
    const b64 = data.base64;
    if (typeof b64 !== 'string' || !b64 || !filename) {
      return this.send(res, 400, { ok: false, error: 'bad_request', blocking: true });
    }
    const started = Date.now();
    const [sid] = this.session(data.sid, true)!;
    try {
      const r = maskOoxml(Buffer.from(b64, 'base64'), filename, this.masker);
      this.stats.mask++;
      if (r.hits) this.record({ method: 'EXT', path: `/ext/mask-file:${filename}`, host: data.host, started, hitCount: r.hits });
      this.send(res, 200, { ok: true, base64: Buffer.from(r.bytes).toString('base64'), sid, hit_count: r.hits });
    } catch (e) {
      this.record({ method: 'EXT', path: `/ext/mask-file:${filename}`, host: data.host, started, status: 503, error: `mask_failed: ${(e as Error).message}` });
      this.send(res, 503, { ok: false, error: 'engine_error', blocking: true });
    }
  }

  private restore(res: http.ServerResponse, data: Record<string, unknown>): void {
    const text = data.text;
    const streamId = typeof data.stream_id === 'string' ? data.stream_id.trim() : '';
    if (typeof text !== 'string' || typeof data.sid !== 'string' || !data.sid.startsWith('ext:') || !streamId) {
      return this.send(res, 400, { ok: false, error: 'bad_request' });
    }
    const final = !!data.final;
    const ct = String(data.content_type ?? '').toLowerCase();
    const found = this.session(data.sid, false);
    // 会话不存在 → 原样返回，绝不还原（防止借任意自造 sid 查映射表）
    if (!found) return this.send(res, 200, { ok: true, text });
    const [, s] = found;

    let st = s.streams.get(streamId);
    if (!st) {
      if (s.streams.size >= MAX_STREAMS_PER_SESSION) s.streams.delete(s.streams.keys().next().value!);
      const restorer = new Restorer(this.masker.store);
      st = { restorer, sse: ct.includes('text/event-stream') ? new SseRestorer(restorer) : undefined };
      s.streams.set(streamId, st);
    }

    let out: string;
    try {
      if (st.sse) {
        out = st.sse.push(text) + (final ? st.sse.end() : '');
      } else {
        // 非 SSE：JSON / NDJSON 文本里的还原值必须按 JSON 转义
        const escape = ct.includes('json') || !!data.escape;
        out = st.restorer.restore(text, `ext:${streamId}`, escape, final);
      }
    } catch {
      // 还原方向恒透传
      out = text;
    }
    if (final) {
      s.streams.delete(streamId);
      this.stats.restore++;
      const { restored, unresolved } = st.restorer.stats;
      if (restored || unresolved) {
        this.record({ method: 'EXT', path: '/ext/restore', host: data.host, started: Date.now(), restored, unresolved, stream: !!st.sse });
      }
    }
    this.send(res, 200, { ok: true, text: out });
  }

  /** 扩展上报「命中对话 URL 但 body 类型无法打码」：只收元数据，不收正文。 */
  private warn(res: http.ServerResponse, data: Record<string, unknown>): void {
    this.record({
      method: 'EXT', path: String(data.path ?? '/ext/warn').slice(0, 200), host: data.host, started: Date.now(),
      status: 0, error: `unsupported_content_type: ${String(data.content_type ?? '').slice(0, 80)}`,
    });
    this.send(res, 200, { ok: true });
  }

  private record(e: {
    method: string; path: string; host: unknown; started: number; status?: number; error?: string;
    hits?: GatewayEvent['hits']; signedBlocksSkipped?: number; restored?: number; unresolved?: number;
    stream?: boolean; hitCount?: number;
  }): void {
    if (!this.config.recordEvents) return;
    const ev: GatewayEvent = {
      id: randomUUID(),
      time: e.started,
      upstream: `ext:${String(e.host ?? '').slice(0, 120)}`,
      method: e.method,
      path: e.path,
      status: e.status ?? 200,
      durationMs: Date.now() - e.started,
      stream: !!e.stream,
      hits: e.hits ?? Array.from({ length: e.hitCount ?? 0 }, () => ({ label: 'FILE', token: '' })),
      restored: e.restored ?? 0,
      unresolved: e.unresolved ?? 0,
      signedBlocksSkipped: e.signedBlocksSkipped ?? 0,
      error: e.error,
    };
    this.emit('event', ev);
  }
}
