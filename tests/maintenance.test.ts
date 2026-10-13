import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { GatewayCore, type AppConfig, type GatewayEvent } from '../electron/app/gateway-core';
import { compareVersions, configBackupFileName, isConfigBackupName, redactProxyUrl } from '../electron/app/maintenance';
import { DEFAULT_EXT_CONFIG } from '../electron/gateway/ext-bridge';
import { EventHub, createPanelServer } from '../electron/server/panel';

const quiet = { info() {}, warn() {}, error() {} };
const TOKEN = 'maintenance-test-token-0123456789';

/** 申请一个当前空闲的端口（用完即释放） */
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

/** 临时数据目录：默认不监听任何上游端口，扩展桥接关闭，出网直连 */
function makeDataDir(overrides: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maskit-maint-'));
  const cfg = {
    upstreams: [],
    egressProxy: 'direct',
    ext: { ...DEFAULT_EXT_CONFIG, enabled: false },
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'maskit-config.json'), JSON.stringify(cfg));
  return dir;
}

const cores: GatewayCore[] = [];
const dirs: string[] = [];

/** 创建并初始化核心；测试结束统一释放 */
async function makeCore(
  overrides: Record<string, unknown> = {},
  extraEnv: { fetch?: typeof fetch; push?: (c: string, p: unknown) => void; version?: string } = {},
): Promise<{ core: GatewayCore; dataDir: string }> {
  const dataDir = makeDataDir(overrides);
  dirs.push(dataDir);
  const core = new GatewayCore({
    dataDir,
    version: extraEnv.version ?? '0.0.0-test',
    push: extraEnv.push ?? (() => undefined),
    logger: quiet,
    fetch: extraEnv.fetch,
  });
  cores.push(core);
  await core.init();
  return { core, dataDir };
}

afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** 本地 HTTP 服务：固定返回 404，用于验证“任何 HTTP 状态都算可达” */
function startLocalServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
  });
}

describe('自检 selfCheck', () => {
  it('返回固定结构，覆盖端口、存储、NER、出网、配置可写、磁盘', async () => {
    const livePort = await freePort();
    const { core } = await makeCore({
      upstreams: [{ name: 'live', port: livePort, target: 'http://127.0.0.1:1', paths: [] }],
    });
    const { items } = await core.selfCheck();
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));

    for (const item of items) {
      expect(typeof item.key).toBe('string');
      expect(typeof item.name).toBe('string');
      expect(typeof item.ok).toBe('boolean');
      expect(typeof item.detail).toBe('string');
    }
    expect(byKey['port:live'].ok).toBe(true);
    expect(byKey['storage'].ok).toBe(true);
    expect(byKey['ext']).toMatchObject({ ok: true, detail: '未启用' });
    expect(byKey['ner']).toMatchObject({ ok: true, detail: '未启用' });
    expect(byKey['egress']).toMatchObject({ ok: true, detail: '直连' });
    expect(byKey['config-writable'].ok).toBe(true);
    expect(byKey['disk']).toBeDefined();
  });

  it('上游端口未监听时该项 ok=false', async () => {
    const { core } = await makeCore({
      upstreams: [{ name: 'x', port: await freePort(), target: 'http://127.0.0.1:1', paths: [] }],
    });
    // 模拟未监听：停止网关后自检
    await core.stop();
    const { items } = await core.selfCheck();
    expect(items.find((i) => i.key === 'port:x')?.ok).toBe(false);
  });

  it('自检写入的临时文件会被清理', async () => {
    const { core, dataDir } = await makeCore();
    await core.selfCheck();
    const leftovers = fs.readdirSync(dataDir).filter((f) => f.startsWith('.selfcheck-'));
    expect(leftovers).toEqual([]);
  });
});

describe('上游连通性 testUpstreams', () => {
  it('本地服务返回 404 也算可达；连接被拒绝的上游失败并给出中文错误', async () => {
    const { server, port: srvPort } = await startLocalServer();
    const closedPort = await freePort(); // 释放后无人监听 = 连接被拒绝
    try {
      const livePort = await freePort();
      const deadPort = await freePort();
      const { core } = await makeCore({
        upstreams: [
          { name: 'live', port: livePort, target: `http://127.0.0.1:${srvPort}`, paths: [] },
          { name: 'dead', port: deadPort, target: `http://127.0.0.1:${closedPort}`, paths: [] },
        ],
      });
      const { results } = await core.testUpstreams();
      expect(results).toHaveLength(2);
      const live = results.find((r) => r.name === 'live')!;
      const dead = results.find((r) => r.name === 'dead')!;
      expect(live).toMatchObject({ ok: true, status: 404, target: `http://127.0.0.1:${srvPort}` });
      expect(typeof live.latencyMs).toBe('number');
      expect(dead.ok).toBe(false);
      expect(dead.error).toMatch(/^连接失败/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('诊断 diagnostics', () => {
  it('脱敏：扩展令牌、自定义词原文、占位符令牌、代理密码均不出现在输出中', async () => {
    const { core } = await makeCore({
      ext: { ...DEFAULT_EXT_CONFIG, enabled: false, token: 'SECRET-EXT-TOKEN-XYZ' },
      egressProxy: 'http://proxyuser:PROXYPW-XYZ@127.0.0.1:9',
      mask: {
        builtinRules: {},
        secretPrefixes: [],
        customWords: [
          { word: 'ALICE-REAL-NAME', label: '人名' },
          { word: 'BOB-REAL-NAME', label: '人名' },
          { word: 'ACME-COMPANY', label: '机构' },
        ],
      },
    });
    // 直接写入一条带占位符令牌的事件（真实请求路径的事件不含原文，但含 token）
    (core as unknown as { db: { insertEvent(e: GatewayEvent): number } }).db.insertEvent({
      id: 'e1',
      time: Date.now(),
      upstream: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      status: 200,
      durationMs: 1,
      stream: false,
      hits: [{ label: '手机号', token: 'PLACEHOLDER-TOKEN-SHOULD-HIDE' }],
      restored: 0,
      unresolved: 0,
      signedBlocksSkipped: 0,
    });

    const d = await core.diagnostics();
    const text = JSON.stringify(d);
    expect(text).not.toContain('SECRET-EXT-TOKEN-XYZ');
    expect(text).not.toContain('ALICE-REAL-NAME');
    expect(text).not.toContain('BOB-REAL-NAME');
    expect(text).not.toContain('ACME-COMPANY');
    expect(text).not.toContain('PLACEHOLDER-TOKEN-SHOULD-HIDE');
    expect(text).not.toContain('PROXYPW-XYZ');

    const cfg = d.config as unknown as {
      ext: { token: string };
      mask: { customWords: { count: number; labels: string[] } };
      upstreams: unknown[];
    };
    expect(cfg.ext.token).toBe('***');
    expect(cfg.mask.customWords).toEqual({ count: 3, labels: ['人名', '机构'] });
    expect(d.recentEvents[0].hits).toEqual([{ label: '手机号', token: '' }]);
    expect(d.recentEvents).toHaveLength(1);
  });

  it('包含版本、运行环境与自检结果的顶层结构', async () => {
    const { core } = await makeCore();
    const d = await core.diagnostics();
    expect(d.version).toBe('0.0.0-test');
    expect(d.platform).toBe(process.platform);
    expect(d.arch).toBe(process.arch);
    expect(d.node).toBe(process.version);
    expect(typeof d.generatedAt).toBe('string');
    expect(d.status).toBeDefined();
    expect(Array.isArray(d.selfCheck.items)).toBe(true);
  });

  it('redactProxyUrl 只去掉密码', () => {
    expect(redactProxyUrl('http://u:p@h:8080')).toBe('http://u:***@h:8080');
    expect(redactProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
  });
});

describe('版本检查 checkUpdate', () => {
  it('解析 tag_name（去掉 v 前缀）并比较版本，携带正确请求头', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
      });
      return new Response(
        JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://example.test/rel', published_at: '2026-01-01T00:00:00Z' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const { core } = await makeCore({}, { fetch: fakeFetch });
    const r = await core.checkUpdate();
    expect(r).toEqual({
      current: '0.0.0-test',
      latest: '9.9.9',
      hasUpdate: true,
      url: 'https://example.test/rel',
      publishedAt: '2026-01-01T00:00:00Z',
    });
    expect(calls[0].url).toBe('https://api.github.com/repos/wangneal369/maskit-node/releases/latest');
    expect(calls[0].headers.Accept).toBe('application/vnd.github+json');
    expect(calls[0].headers['User-Agent']).toBe('data-maskit');
  });

  it('不高于当前版本时 hasUpdate=false；网络失败不抛错', async () => {
    const older = (async () =>
      new Response(JSON.stringify({ tag_name: 'v1.0.0' }), { status: 200 })) as typeof fetch;
    const { core: c1 } = await makeCore({}, { fetch: older, version: '1.0.0' });
    expect((await c1.checkUpdate()).hasUpdate).toBe(false);
    const newer = (async () =>
      new Response(JSON.stringify({ tag_name: 'v1.0.1' }), { status: 200 })) as typeof fetch;
    const { core: c1b } = await makeCore({}, { fetch: newer, version: '1.0.0' });
    expect((await c1b.checkUpdate()).hasUpdate).toBe(true);

    const broken = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    }) as unknown as typeof fetch;
    const { core: c2 } = await makeCore({}, { fetch: broken });
    const r = await c2.checkUpdate();
    expect(r.hasUpdate).toBe(false);
    expect(r.error).toContain('ENOTFOUND');
  });

  it('checkUpdates 关闭时启动不联网；开启时后台检查并推送 maskit/update', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ tag_name: 'v9.9.9' }), { status: 200 });
    }) as typeof fetch;
    await makeCore({}, { fetch: fakeFetch });
    expect(calls).toBe(0);

    const pushed: [string, unknown][] = [];
    await makeCore(
      { app: { autostart: false, checkUpdates: true } },
      { fetch: fakeFetch, push: (c, p) => pushed.push([c, p]) },
    );
    // 后台任务，等待其完成
    for (let i = 0; i < 50 && pushed.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    expect(pushed[0][0]).toBe('maskit/update');
    expect((pushed[0][1] as { hasUpdate: boolean }).hasUpdate).toBe(true);
  });
});

describe('配置备份与还原', () => {
  const backupsOf = (dataDir: string) => {
    const dir = path.join(dataDir, 'backups');
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  };

  it('保存配置时备份旧文件，文件名符合白名单格式', async () => {
    const { core, dataDir } = await makeCore();
    const original = fs.readFileSync(path.join(dataDir, 'maskit-config.json'), 'utf8');
    const cfg = core.getConfig();
    await core.setConfig({ ...cfg, maskEnabled: false });
    const files = backupsOf(dataDir);
    expect(files).toHaveLength(1);
    expect(isConfigBackupName(files[0])).toBe(true);
    // 备份内容与保存前的旧文件逐字节一致
    expect(fs.readFileSync(path.join(dataDir, 'backups', files[0]), 'utf8')).toBe(original);
    const { backups } = core.listConfigBackups();
    expect(backups[0].name).toBe(files[0]);
    expect(backups[0].size).toBeGreaterThan(0);
  });

  it('最多保留 10 份，超出的最旧备份被裁剪', async () => {
    const { core, dataDir } = await makeCore();
    for (let i = 0; i < 12; i++) {
      await core.setConfig({ ...core.getConfig(), audit: { enabled: i % 2 === 0 } });
    }
    const files = backupsOf(dataDir);
    expect(files).toHaveLength(10);
    const { backups } = core.listConfigBackups();
    expect(backups).toHaveLength(10);
    // 新→旧
    const names = backups.map((b) => b.name);
    expect(names).toEqual([...names].sort().reverse());
  });

  it('文件名生成：定宽、本地时间、带毫秒', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5, 6);
    expect(configBackupFileName(d)).toBe('maskit-config-20260102-030405-006.json');
  });

  it('还原：非法名称（路径穿越等）被拒绝；合法名称还原成功且当前配置先被备份', async () => {
    const { core, dataDir } = await makeCore();
    await core.setConfig({ ...core.getConfig(), maskEnabled: false });
    const { backups } = core.listConfigBackups();
    const oldest = backups[backups.length - 1].name;

    await expect(core.restoreConfigBackup({ name: '../maskit-config-20260101-000000-000.json' })).rejects.toThrow('非法');
    await expect(core.restoreConfigBackup({ name: '..\\secret.json' })).rejects.toThrow('非法');
    await expect(core.restoreConfigBackup({ name: 'maskit-config-20990101-000000-000.json' })).rejects.toThrow('不存在');
    expect(core.getConfig().maskEnabled).toBe(false);

    const before = backupsOf(dataDir).length;
    const st = await core.restoreConfigBackup({ name: oldest });
    expect(st.maskEnabled).toBe(true);
    expect(core.getConfig().maskEnabled).toBe(true);
    expect(backupsOf(dataDir).length).toBe(before + 1);
  });
});

describe('配置导入导出', () => {
  it('导出后导入到新目录，内容往返一致（含扩展令牌）', async () => {
    const { core: a } = await makeCore({
      ext: { ...DEFAULT_EXT_CONFIG, enabled: false, token: 'tok-roundtrip-123' },
      mask: {
        builtinRules: {},
        secretPrefixes: [],
        customWords: [{ word: '项目代号', label: '项目' }],
      },
    });
    const exported = JSON.parse(JSON.stringify(a.exportConfig())) as AppConfig;
    expect(exported.ext.token).toBe('tok-roundtrip-123');

    const { core: b, dataDir: dirB } = await makeCore();
    await b.importConfig({ config: exported });
    expect(b.getConfig().ext.token).toBe('tok-roundtrip-123');
    expect(b.getConfig().mask.customWords).toEqual([{ word: '项目代号', label: '项目' }]);
    // 导入前的配置被备份
    expect(fs.readdirSync(path.join(dirB, 'backups'))).toHaveLength(1);
  });

  it('导入结构非法的配置被拒绝，且不改动当前配置', async () => {
    const { core } = await makeCore();
    const before = JSON.stringify(core.getConfig());
    await expect(core.importConfig({ config: 'not-an-object' })).rejects.toThrow('JSON 对象');
    await expect(core.importConfig({ config: { upstreams: 'x' } })).rejects.toThrow('upstreams');
    await expect(core.importConfig({ config: { mask: { customWords: 'x' } } })).rejects.toThrow('customWords');
    await expect(core.importConfig({ config: null })).rejects.toThrow();
    expect(JSON.stringify(core.getConfig())).toBe(before);
  });

  it('导入缺失字段时用默认值补齐', async () => {
    const { core } = await makeCore();
    await core.importConfig({ config: { maskEnabled: false } });
    expect(core.getConfig().maskEnabled).toBe(false);
    expect(core.getConfig().storage.maxEvents).toBeGreaterThan(0);
    expect(core.getConfig().mask.builtinRules).toBeDefined();
  });
});

describe('版本号比较 compareVersions', () => {
  it('语义化比较，忽略 v 前缀；非法版本返回 null', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.2.3', '1.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1);
    expect(compareVersions('abc', '1.0.0')).toBeNull();
  });
});

describe('面板 RPC 与诊断下载', () => {
  let server: http.Server;
  let port: number;
  let hub: EventHub;
  let core: GatewayCore;
  let dataDir: string;
  let webDist: string;
  let bundleDir: string;

  const req = (opts: { method?: string; path: string; body?: string }) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const r = http.request(
        {
          host: '127.0.0.1',
          port,
          method: opts.method ?? 'GET',
          path: opts.path,
          headers: { 'x-maskit-token': TOKEN, 'content-type': 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      r.on('error', reject);
      if (opts.body) r.write(opts.body);
      r.end();
    });

  it('selfCheck 经 RPC 返回 items；GET /api/diagnostics 以 JSON 附件下载；无令牌被拒绝', async () => {
    dataDir = makeDataDir();
    dirs.push(dataDir);
    webDist = path.join(dataDir, 'web');
    bundleDir = path.join(dataDir, 'bundle');
    fs.mkdirSync(webDist, { recursive: true });
    fs.mkdirSync(bundleDir, { recursive: true });
    hub = new EventHub();
    core = new GatewayCore({ dataDir, version: '0.0.0-test', push: hub.push, logger: quiet });
    cores.push(core);
    await core.init();
    server = createPanelServer({ core, hub, token: TOKEN, webDist, bundleDir });
    port = await freePort();
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
    try {
      const rpc = await req({ method: 'POST', path: '/api/selfCheck', body: '{}' });
      expect(rpc.status).toBe(200);
      const parsed = JSON.parse(rpc.body);
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.data.items)).toBe(true);
      expect(parsed.data.items.some((i: { key: string }) => i.key === 'storage')).toBe(true);

      const autostart = JSON.parse((await req({ method: 'POST', path: '/api/autostartStatus', body: '{}' })).body);
      expect(autostart.data).toEqual({ supported: false, enabled: false, reason: '服务端部署不支持' });

      const diag = await req({ path: '/api/diagnostics' });
      expect(diag.status).toBe(200);
      expect(String(diag.headers['content-type'])).toContain('application/json');
      expect(String(diag.headers['content-disposition'])).toContain('attachment');
      const body = JSON.parse(diag.body);
      expect(body.version).toBe('0.0.0-test');
      expect(Array.isArray(body.selfCheck.items)).toBe(true);

      const noToken = await new Promise<number>((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/diagnostics' }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        r.on('error', reject);
        r.end();
      });
      expect(noToken).toBe(401);
    } finally {
      hub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
