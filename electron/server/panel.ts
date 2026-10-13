/**
 * 无头控制面板服务（Node only，不得引入 electron / ee-core）。
 *
 * - 静态托管构建好的前端（SPA 回退）
 * - POST /api/<method>：JSON-RPC，参数即请求体，对应 Electron 控制器同名方法
 * - GET  /api/events/stream?token=：SSE 推送 maskit/event
 * - GET  /api/skill/bundle：Skill 包 zip 下载
 * - GET  /api/diagnostics：诊断 JSON 下载（已脱敏）
 * - GET  /healthz：免鉴权存活探针（只回 ok）
 *
 * 安全模型（对齐原项目 api_guard）：
 *  1. Host 校验：只接受 IP 字面量 / localhost / MASKIT_PUBLIC_HOST 里列出的主机名（任意端口），防 DNS 重绑定
 *  2. X-Maskit-Token 恒定时间比较（SSE 因 EventSource 无法设头，允许 ?token=）
 *  3. Origin 校验：带 Origin 头时必须与 Host 同源（防跨站 CSRF）
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { zipSync } from 'fflate';
import type { GatewayCore, AppConfig } from '../app/gateway-core';

export const TOKEN_HEADER = 'x-maskit-token';
const MAX_BODY = 8 * 1024 * 1024;
const SKILL_DIR = ['maskit-placeholders'];
/** Skill 包随包分发的文件（contract.md 是渲染源，不分发） */
const SKILL_FILES = ['SKILL.md', 'README.md', 'README_EN.md', 'templates/AGENTS.snippet.md'];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** 事件广播中心：GatewayCore 的 push 接到这里，再扇出给所有 SSE 连接 */
export class EventHub {
  private readonly clients = new Set<http.ServerResponse>();

  readonly push = (channel: string, payload: unknown): void => {
    if (!this.clients.size) return;
    const frame = `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.clients) res.write(frame);
  };

  add(res: http.ServerResponse): void {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  ping(): void {
    for (const res of this.clients) res.write(': ping\n\n');
  }

  closeAll(): void {
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  get size(): number {
    return this.clients.size;
  }
}

export interface PanelOptions {
  core: GatewayCore;
  hub: EventHub;
  token: string;
  /** 前端构建产物目录（含 index.html） */
  webDist: string;
  /** agent-bundle 目录（含 maskit-placeholders/） */
  bundleDir: string;
  /** 额外接受的 Host 主机名（反代域名等，不含端口） */
  publicHosts?: string[];
}

/** 摘要后恒定时间比较：长度不同也不会泄露早退时序 */
export function tokenEquals(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'bad_request') {
    super(message);
  }
}

/** 解析 Host 头里的主机名（小写，IPv6 保留方括号） */
function hostnameOf(hostHeader: string): string | null {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:/\s]+)(?::\d{1,5})?$/.exec(hostHeader.trim());
  return m ? m[1].toLowerCase() : null;
}

export function buildSkillBundle(bundleDir: string): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const f of SKILL_FILES) {
    files[`maskit-placeholders/${f}`] = fs.readFileSync(path.join(bundleDir, ...SKILL_DIR, f));
  }
  return zipSync(files);
}

type Handler = (core: GatewayCore, args: any, opts: PanelOptions) => unknown | Promise<unknown>;

/** RPC 方法白名单：与 electron/controller/gateway.ts 同名同语义 */
const RPC: Record<string, Handler> = {
  status: (c) => c.status(),
  getConfig: (c) => c.getConfig(),
  setConfig: async (c, args: AppConfig) => {
    if (!args || typeof args !== 'object') throw new HttpError(400, '配置必须是对象');
    await c.setConfig(args);
    return c.status();
  },
  restart: async (c) => {
    await c.start();
    return c.status();
  },
  events: (c, args) => c.listEvents(args),
  flagged: (c, args) => c.listFlagged(args),
  stats: (c, args) => c.stats(Number(args?.days ?? 30)),
  clearEvents: (c) => {
    c.clearEvents();
    return c.status();
  },
  clearMappings: (c) => {
    c.clearMappings();
    return c.status();
  },
  rotateExtToken: (c) => c.rotateExtToken(),
  downloadNerModel: (c) => c.downloadNerModel(),
  playground: (c, args) => c.playground(String(args?.text ?? '')),
  skillAgentsSnippet: (_c, _a, o) =>
    fs.readFileSync(path.join(o.bundleDir, ...SKILL_DIR, 'templates', 'AGENTS.snippet.md'), 'utf-8'),
  selfCheck: (c) => c.selfCheck(),
  testUpstreams: (c) => c.testUpstreams(),
  diagnostics: (c) => c.diagnostics(),
  checkUpdate: (c) => c.checkUpdate(),
  listConfigBackups: (c) => c.listConfigBackups(),
  restoreConfigBackup: async (c, args: { name: string }) => {
    return c.restoreConfigBackup({ name: String(args?.name ?? '') });
  },
  exportConfig: (c) => c.exportConfig(),
  importConfig: async (c, args: { config: unknown }) => {
    if (!args || typeof args !== 'object') throw new HttpError(400, '请求体必须包含 config 字段');
    await c.importConfig({ config: args.config });
    return c.status();
  },
  /** 服务端部署无登录项概念，固定返回不支持 */
  autostartStatus: () => ({ supported: false, enabled: false, reason: '服务端部署不支持' }),
};

export function createPanelServer(opts: PanelOptions): http.Server {
  const publicHosts = (opts.publicHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  const webRoot = path.resolve(opts.webDist);

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const hostOk = (req: http.IncomingMessage): boolean => {
    const name = hostnameOf(String(req.headers.host ?? ''));
    if (!name) return false;
    if (name === 'localhost' || name.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
    return publicHosts.includes(name);
  };

  /** 带 Origin 时必须与 Host 同源；无 Origin（curl、同源 GET）放行，token 仍是主防线 */
  const originOk = (req: http.IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(String(origin)).host.toLowerCase() === String(req.headers.host ?? '').toLowerCase();
    } catch {
      return false;
    }
  };

  const authed = (req: http.IncomingMessage, url: URL, allowQuery: boolean): boolean => {
    let tok = String(req.headers[TOKEN_HEADER] ?? '');
    if (!tok && allowQuery) tok = url.searchParams.get('token') ?? '';
    return tok.length > 0 && tokenEquals(tok, opts.token);
  };

  const readBody = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, '请求体过大', 'too_large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        if (!raw) return resolve(undefined);
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new HttpError(400, '请求体不是合法 JSON'));
        }
      });
      req.on('error', reject);
    });

  const serveStatic = (res: http.ServerResponse, pathname: string) => {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return json(res, 400, { ok: false, error: 'bad_request' });
    }
    let file = path.resolve(webRoot, '.' + path.posix.normalize('/' + rel));
    if (file !== webRoot && !file.startsWith(webRoot + path.sep)) return json(res, 403, { ok: false, error: 'forbidden' });
    let st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st?.isDirectory()) {
      file = path.join(file, 'index.html');
      st = fs.existsSync(file) ? fs.statSync(file) : null;
    }
    // SPA 回退：无扩展名的路径视为前端路由；缺失的带扩展名资源给真 404
    if (!st && !path.extname(rel)) {
      file = path.join(webRoot, 'index.html');
      st = fs.existsSync(file) ? fs.statSync(file) : null;
    }
    if (!st) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return void res.end('Not Found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': st.size,
      // 入口 HTML 不缓存，带哈希的 assets 可长缓存
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    fs.createReadStream(file).pipe(res);
  };

  const handleApi = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    const p = url.pathname;
    if (!hostOk(req)) return json(res, 403, { ok: false, error: 'host_rejected', message: '非法请求来源 Host' });
    const isSse = p === '/api/events/stream';
    if (!authed(req, url, isSse)) return json(res, 401, { ok: false, error: 'invalid_token', message: '无效请求令牌' });
    if (!originOk(req)) return json(res, 403, { ok: false, error: 'origin_rejected', message: '非同源请求' });

    if (req.method === 'GET' && isSse) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      opts.hub.add(res);
      return;
    }
    if (req.method === 'GET' && p === '/api/skill/bundle') {
      let zip: Uint8Array;
      try {
        zip = buildSkillBundle(opts.bundleDir);
      } catch (e) {
        return json(res, 500, { ok: false, error: 'bundle_missing', message: `Skill 包不可用：${(e as Error).message}` });
      }
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': zip.byteLength,
        'content-disposition': 'attachment; filename="maskit-placeholders.zip"',
        'cache-control': 'no-store',
      });
      return void res.end(Buffer.from(zip));
    }
    if (req.method === 'GET' && p === '/api/diagnostics') {
      let body: string;
      try {
        body = JSON.stringify(await opts.core.diagnostics(), null, 2);
      } catch (e) {
        return json(res, 500, { ok: false, error: 'internal_error', message: (e as Error).message });
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="maskit-diagnostics.json"',
        'cache-control': 'no-store',
      });
      return void res.end(body);
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' });

    const name = p.slice('/api/'.length);
    if (!Object.prototype.hasOwnProperty.call(RPC, name)) {
      const hint = name === 'openExtensionDir' ? '该操作仅桌面版可用' : `未知方法：${name}`;
      return json(res, 404, { ok: false, error: 'not_found', message: hint });
    }
    try {
      const args = await readBody(req);
      const data = await RPC[name](opts.core, args, opts);
      json(res, 200, { ok: true, data });
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { ok: false, error: e.code, message: e.message });
      json(res, 500, { ok: false, error: 'internal_error', message: (e as Error).message });
    }
  };

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    // 只有 /api/ 进安全防线；静态资源无状态无副作用，不含 token
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((e) => json(res, 500, { ok: false, error: 'internal_error', message: String(e?.message ?? e) }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'method_not_allowed' });
    serveStatic(res, url.pathname);
  });
}
