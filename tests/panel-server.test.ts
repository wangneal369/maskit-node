import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { GatewayCore } from '../electron/app/gateway-core';
import { Masker } from '../electron/core';
import { DEFAULT_EXT_CONFIG, ExtBridge } from '../electron/gateway/ext-bridge';
import { EventHub, createPanelServer } from '../electron/server/panel';

const TOKEN = 'unit-test-token-0123456789';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** 可自定义 Host/Origin 的请求（fetch 不允许改 Host） */
function raw(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

let tmp: string;
let webDist: string;
let bundleDir: string;
let core: GatewayCore;
let hub: EventHub;
let server: http.Server;
let port: number;

const rpc = (name: string, body?: unknown, headers: Record<string, string> = {}) =>
  raw(port, {
    method: 'POST',
    path: `/api/${name}`,
    headers: { 'content-type': 'application/json', 'x-maskit-token': TOKEN, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maskit-panel-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);
  // 不占用默认网关端口：上游置空、扩展桥接关闭
  fs.writeFileSync(
    path.join(dataDir, 'maskit-config.json'),
    JSON.stringify({ upstreams: [], egressProxy: 'direct', ext: { ...DEFAULT_EXT_CONFIG, enabled: false } }),
  );
  webDist = path.join(tmp, 'web');
  fs.mkdirSync(path.join(webDist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(webDist, 'index.html'), '<html>maskit-spa</html>');
  fs.writeFileSync(path.join(webDist, 'assets', 'a.js'), 'console.log(1)');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'top-secret');
  bundleDir = path.join(tmp, 'bundle');
  const skill = path.join(bundleDir, 'maskit-placeholders');
  fs.mkdirSync(path.join(skill, 'templates'), { recursive: true });
  for (const f of ['SKILL.md', 'README.md', 'README_EN.md', 'templates/AGENTS.snippet.md']) {
    fs.writeFileSync(path.join(skill, f), `# ${f}`);
  }

  hub = new EventHub();
  const quiet = { info() {}, warn() {}, error() {} };
  core = new GatewayCore({ dataDir, version: '0.0.0-test', push: hub.push, logger: quiet });
  await core.init();
  server = createPanelServer({ core, hub, token: TOKEN, webDist, bundleDir, publicHosts: ['maskit.example.com'] });
  port = await freePort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
});

afterAll(async () => {
  hub.closeAll();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await core.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('面板 HTTP 服务', () => {
  it('/healthz 免鉴权', async () => {
    const r = await raw(port, { path: '/healthz' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body.toString())).toEqual({ ok: true });
  });

  it('无令牌 / 错令牌 -> 401', async () => {
    const none = await raw(port, { method: 'POST', path: '/api/status' });
    expect(none.status).toBe(401);
    const bad = await rpc('status', undefined, { 'x-maskit-token': 'wrong-token-wrong-token' });
    expect(bad.status).toBe(401);
    expect(JSON.parse(bad.body.toString()).error).toBe('invalid_token');
  });

  it('跨源 Origin -> 403；同源 Origin 放行', async () => {
    const evil = await rpc('status', undefined, { origin: 'http://evil.example' });
    expect(evil.status).toBe(403);
    expect(JSON.parse(evil.body.toString()).error).toBe('origin_rejected');
    const same = await rpc('status', undefined, { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` });
    expect(same.status).toBe(200);
  });

  it('Host 为未知域名 -> 403（防 DNS 重绑定）；MASKIT_PUBLIC_HOST 列出的域名放行', async () => {
    const bad = await rpc('status', undefined, { host: 'evil.example:18700' });
    expect(bad.status).toBe(403);
    expect(JSON.parse(bad.body.toString()).error).toBe('host_rejected');
    const ok = await rpc('status', undefined, { host: 'maskit.example.com' });
    expect(ok.status).toBe(200);
  });

  it('status / getConfig / playground 往返', async () => {
    const st = JSON.parse((await rpc('status')).body.toString());
    expect(st.ok).toBe(true);
    expect(st.data.maskEnabled).toBe(true);
    expect(st.data.listening).toEqual([]);
    const cfg = JSON.parse((await rpc('getConfig')).body.toString());
    expect(cfg.data.upstreams).toEqual([]);
    const pg = JSON.parse((await rpc('playground', { text: '电话 13800138000' })).body.toString());
    expect(pg.data.roundTripOk).toBe(true);
    expect(pg.data.masked).not.toContain('13800138000');
  });

  it('未知方法 404、非法 JSON 400、openExtensionDir 不支持', async () => {
    expect((await rpc('nope')).status).toBe(404);
    expect((await rpc('openExtensionDir')).status).toBe(404);
    const r = await raw(port, {
      method: 'POST',
      path: '/api/playground',
      headers: { 'x-maskit-token': TOKEN, 'content-type': 'application/json' },
      body: '{bad',
    });
    expect(r.status).toBe(400);
  });

  it('SSE：令牌走查询串，能收到 maskit/event 推送', async () => {
    const noTok = await raw(port, { path: '/api/events/stream' });
    expect(noTok.status).toBe(401);

    const got = await new Promise<string>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: `/api/events/stream?token=${TOKEN}` }, (res) => {
        expect(res.statusCode).toBe(200);
        expect(String(res.headers['content-type'])).toContain('text/event-stream');
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString();
          if (buf.includes('event: maskit/event')) {
            req.destroy();
            resolve(buf);
          }
        });
        // 连接建立后（hub 已登记）再推送
        setTimeout(() => hub.push('maskit/event', { hello: 'world' }), 100);
      });
      req.on('error', (e) => (e as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(e));
      setTimeout(() => reject(new Error('SSE 超时')), 3000);
    });
    expect(got).toContain('data: {"hello":"world"}');
  });

  it('静态托管：SPA 回退、404、拒绝目录穿越', async () => {
    expect((await raw(port, { path: '/' })).body.toString()).toContain('maskit-spa');
    expect((await raw(port, { path: '/events' })).body.toString()).toContain('maskit-spa');
    const js = await raw(port, { path: '/assets/a.js' });
    expect(js.headers['content-type']).toContain('javascript');
    expect((await raw(port, { path: '/assets/missing.js' })).status).toBe(404);
    const trav = await raw(port, { path: '/..%2Fsecret.txt' });
    expect(trav.body.toString()).not.toContain('top-secret');
  });

  it('GET /api/skill/bundle 需令牌并返回 zip', async () => {
    expect((await raw(port, { path: '/api/skill/bundle' })).status).toBe(401);
    const r = await raw(port, { path: '/api/skill/bundle', headers: { 'x-maskit-token': TOKEN } });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    const files = Object.keys(unzipSync(new Uint8Array(r.body)));
    expect(files).toContain('maskit-placeholders/SKILL.md');
  });
});

describe('ExtBridge 非回环监听时的 Host 校验', () => {
  it('接受 IP 字面量与 publicHosts（任意映射端口），拒绝其他域名', async () => {
    const p = await freePort();
    const bridge = new ExtBridge(new Masker(), 'test');
    bridge.listenHost = '0.0.0.0';
    bridge.publicHosts = ['gw.example.com'];
    await bridge.apply({ ...DEFAULT_EXT_CONFIG, enabled: true, port: p, token: 'ext-token-ext-token' });
    try {
      const ping = (host: string) =>
        raw(p, { path: '/api/ext/ping', headers: { host, 'x-shield-token': 'ext-token-ext-token' } });
      expect((await ping('192.168.1.5:15801')).status).toBe(200);
      expect((await ping('gw.example.com:8443')).status).toBe(200);
      const bad = await ping('evil.example.com:5801');
      expect(bad.status).toBe(403);
      expect(JSON.parse(bad.body.toString()).error).toBe('host_rejected');
    } finally {
      await bridge.stop();
    }
  });

  it('默认回环监听仍只接受 127.0.0.1/localhost + 本端口', async () => {
    const p = await freePort();
    const bridge = new ExtBridge(new Masker(), 'test');
    await bridge.apply({ ...DEFAULT_EXT_CONFIG, enabled: true, port: p, token: 'ext-token-ext-token' });
    try {
      const r = await raw(p, { path: '/api/ext/ping', headers: { host: '192.168.1.5:5801', 'x-shield-token': 'ext-token-ext-token' } });
      expect(r.status).toBe(403);
    } finally {
      await bridge.stop();
    }
  });
});
