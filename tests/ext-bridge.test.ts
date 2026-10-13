import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { DEFAULT_MASK_CONFIG, Masker } from '../electron/core';
import { DEFAULT_EXT_CONFIG, EXT_PROTOCOL_VERSION, ExtBridge, type ExtBridgeConfig } from '../electron/gateway/ext-bridge';

const TOKEN = 'test-token-123';
const PHONE = '13800138000';

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

let bridge: ExtBridge;
let masker: Masker;
let port: number;
let cfg: ExtBridgeConfig;
const base = () => `http://127.0.0.1:${port}`;

beforeEach(async () => {
  masker = new Masker();
  masker.configure({ ...DEFAULT_MASK_CONFIG, customWords: [{ word: 'a"b', label: 'TERM' }] });
  bridge = new ExtBridge(masker, '9.9.9');
  port = await freePort();
  cfg = { ...DEFAULT_EXT_CONFIG, enabled: true, port, token: TOKEN };
  await bridge.apply(cfg);
});

afterEach(async () => {
  await bridge.stop();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base() + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shield-token': TOKEN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function maskText(text: string, extra: Record<string, unknown> = {}) {
  const r = await post('/api/ext/mask', { text, ...extra });
  expect(r.status).toBe(200);
  return r.json as { masked_text: string; sid: string };
}

/** 用自定义 Host 发请求（fetch 不允许改 Host） */
function rawRequest(path: string, headers: Record<string, string>): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('ExtBridge 鉴权与来源校验', () => {
  it('缺失令牌 → 403 invalid_token', async () => {
    const res = await fetch(`${base()}/api/ext/ping`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe('invalid_token');
  });

  it('错误令牌 → 403 invalid_token', async () => {
    const res = await fetch(`${base()}/api/ext/ping`, { headers: { 'x-shield-token': 'nope' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe('invalid_token');
  });

  it('令牌配置为空时恒拒绝', async () => {
    await bridge.apply({ ...cfg, token: '' });
    const res = await fetch(`${base()}/api/ext/ping`, { headers: { 'x-shield-token': '' } });
    expect(res.status).toBe(403);
  });

  it('网页 Origin → 403 origin_rejected（即使令牌正确）', async () => {
    const r = await rawRequest('/api/ext/ping', { 'x-shield-token': TOKEN, origin: 'https://evil.com', host: `127.0.0.1:${port}` });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('origin_rejected');
  });

  it('扩展 Origin 放行', async () => {
    const r = await rawRequest('/api/ext/ping', { 'x-shield-token': TOKEN, origin: 'chrome-extension://abc', host: `127.0.0.1:${port}` });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
  });

  it('非回环 Host → 403 host_rejected（DNS 重绑定防护）', async () => {
    const r = await rawRequest('/api/ext/ping', { 'x-shield-token': TOKEN, host: 'evil.com' });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('host_rejected');
  });

  it('/healthz 无需令牌', async () => {
    const res = await fetch(`${base()}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('ping 返回协议版本与配置', async () => {
    const res = await fetch(`${base()}/api/ext/ping`, { headers: { 'x-shield-token': TOKEN } });
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.ext_protocol).toBe(1);
    expect(j.ext_protocol).toBe(EXT_PROTOCOL_VERSION);
    expect(j.version).toBe('9.9.9');
    expect(j.block_when_down).toBe(false);
    expect(j.record_events).toBe(true);
  });

  it('未知路径与非 POST → 404', async () => {
    expect((await post('/api/ext/nope', {})).status).toBe(404);
    const res = await fetch(`${base()}/api/ext/mask`, { headers: { 'x-shield-token': TOKEN } });
    expect(res.status).toBe(404);
  });
});

describe('ExtBridge /api/ext/mask', () => {
  it('JSON 体：手机号被打码，签发 ext: 前缀 sid', async () => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: `call ${PHONE}` }] });
    const j = await maskText(body);
    expect(j.masked_text).not.toContain(PHONE);
    expect(j.masked_text).toMatch(/\{\{PHONE_[a-z]{6}\}\}/);
    expect(JSON.parse(j.masked_text).messages[0].role).toBe('user');
    expect(j.sid.startsWith('ext:')).toBe(true);
  });

  it('非 JSON 文本也能打码', async () => {
    const j = await maskText(`plain ${PHONE} text`);
    expect(j.masked_text).toMatch(/^plain \{\{PHONE_[a-z]{6}\}\} text$/);
  });

  it('复用有效 sid，自造 sid 不被接受', async () => {
    const a = await maskText(`x ${PHONE}`);
    const b = await maskText('hello', { sid: a.sid });
    expect(b.sid).toBe(a.sid);
    const c = await maskText('hello', { sid: 'ext:forged' });
    expect(c.sid).not.toBe('ext:forged');
    expect(c.sid.startsWith('ext:')).toBe(true);
  });

  it('空文本 → 400 且带 blocking', async () => {
    for (const body of [{ text: '' }, {}, { text: 5 }]) {
      const r = await post('/api/ext/mask', body);
      expect(r.status).toBe(400);
      expect(r.json.blocking).toBe(true);
    }
  });

  it('非法 JSON 请求体 → 400 blocking（不放行）', async () => {
    const r = await post('/api/ext/mask', '{not json');
    expect(r.status).toBe(400);
    expect(r.json.blocking).toBe(true);
  });

  it('分块传输的打码请求 → 413 blocking', async () => {
    const r = await new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/ext/mask', method: 'POST', headers: { 'x-shield-token': TOKEN, 'transfer-encoding': 'chunked' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify({ text: PHONE }));
      req.end();
    });
    expect(r.status).toBe(413);
    expect(r.json.blocking).toBe(true);
  });
});

describe('ExtBridge /api/ext/restore', () => {
  const sse = (content: string) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;

  it('SSE：占位符被拆在多个事件里，分块还原后拼接出原文', async () => {
    const { masked_text, sid } = await maskText(`tel ${PHONE}`);
    const token = /\{\{PHONE_[a-z]{6}\}\}/.exec(masked_text)![0];
    const cut1 = 4;
    const cut2 = 9;
    const parts = [`ans: ${token.slice(0, cut1)}`, token.slice(cut1, cut2), `${token.slice(cut2)} ok`];
    const stream = parts.map(sse);
    let out = '';
    for (let i = 0; i < stream.length; i++) {
      const r = await post('/api/ext/restore', {
        sid, stream_id: 's1', text: stream[i], content_type: 'text/event-stream; charset=utf-8', final: false,
      });
      expect(r.status).toBe(200);
      out += r.json.text;
    }
    const last = await post('/api/ext/restore', { sid, stream_id: 's1', text: 'data: [DONE]\n\n', content_type: 'text/event-stream', final: true });
    out += last.json.text;
    expect(out).toContain(PHONE);
    expect(out).not.toMatch(/PHONE_[a-z]{6}/);
    const texts = [...out.matchAll(/^data: (\{.*\})$/gm)].map((m) => JSON.parse(m[1]).choices[0].delta.content).join('');
    expect(texts).toBe(`ans: ${PHONE} ok`);
  });

  it('未知 sid → 原样返回，绝不还原', async () => {
    const { masked_text } = await maskText(`tel ${PHONE}`);
    const r = await post('/api/ext/restore', { sid: 'ext:deadbeef', stream_id: 's', text: masked_text, final: true });
    expect(r.status).toBe(200);
    expect(r.json.text).toBe(masked_text);
    expect(r.json.text).not.toContain(PHONE);
  });

  it('缺少 stream_id / 非 ext: sid → 400', async () => {
    const { sid } = await maskText(`tel ${PHONE}`);
    expect((await post('/api/ext/restore', { sid, text: 'x', final: true })).status).toBe(400);
    expect((await post('/api/ext/restore', { sid: 'abc', stream_id: 's', text: 'x', final: true })).status).toBe(400);
  });

  it('application/json：还原值按 JSON 转义（含引号的自定义词）', async () => {
    const { masked_text, sid } = await maskText('say a"b now');
    const token = /\{\{TERM_[a-z]{6}\}\}/.exec(masked_text)![0];
    expect(masked_text).not.toContain('a"b');
    const r = await post('/api/ext/restore', {
      sid, stream_id: 'j1', text: `{"t":"${token}"}`, content_type: 'application/json', final: true,
    });
    expect(r.json.text).toBe('{"t":"a\\"b"}');
    expect(JSON.parse(r.json.text).t).toBe('a"b');
  });

  it('非 JSON 内容类型：原样还原不转义', async () => {
    const { masked_text, sid } = await maskText('say a"b now');
    const token = /\{\{TERM_[a-z]{6}\}\}/.exec(masked_text)![0];
    const r = await post('/api/ext/restore', { sid, stream_id: 'p1', text: `x ${token}`, content_type: 'text/plain', final: true });
    expect(r.json.text).toBe('x a"b');
  });
});

describe('ExtBridge /api/ext/mask-file', () => {
  const docx = () =>
    zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'word/document.xml': strToU8(
        `<w:document xmlns:w="w"><w:p><w:r><w:t>1380013</w:t></w:r><w:r><w:t>8000</w:t></w:r></w:p></w:document>`,
      ),
    });

  it('docx base64 → 打码后的 base64 + hit_count + sid', async () => {
    const r = await post('/api/ext/mask-file', { filename: 'a.docx', base64: Buffer.from(docx()).toString('base64') });
    expect(r.status).toBe(200);
    expect(r.json.hit_count).toBeGreaterThan(0);
    expect(r.json.sid.startsWith('ext:')).toBe(true);
    const files = unzipSync(new Uint8Array(Buffer.from(r.json.base64, 'base64')));
    const xml = Buffer.from(files['word/document.xml']).toString('utf8');
    expect(xml).not.toContain(PHONE);
    expect(xml).toMatch(/\{\{PHONE_[a-z]{6}\}\}/);
  });

  it('无敏感内容 → hit_count 0，字节原样', async () => {
    const raw = zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="w"><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:document>') });
    const r = await post('/api/ext/mask-file', { filename: 'a.docx', base64: Buffer.from(raw).toString('base64') });
    expect(r.json.hit_count).toBe(0);
    expect(r.json.base64).toBe(Buffer.from(raw).toString('base64'));
  });

  it('缺参 → 400 blocking', async () => {
    const r = await post('/api/ext/mask-file', { filename: 'a.docx' });
    expect(r.status).toBe(400);
    expect(r.json.blocking).toBe(true);
  });
});

describe('ExtBridge 事件与启停', () => {
  it('recordEvents：事件不含明文', async () => {
    const events: any[] = [];
    bridge.on('event', (e) => events.push(e));
    const { masked_text, sid } = await maskText(`tel ${PHONE}`, { host: 'chatgpt.com' });
    const token = /\{\{PHONE_[a-z]{6}\}\}/.exec(masked_text)![0];
    await post('/api/ext/restore', { sid, stream_id: 'e1', text: token, content_type: 'text/plain', final: true });
    await post('/api/ext/warn', { host: 'chatgpt.com', path: '/x', content_type: 'multipart/form-data' });
    expect(events.length).toBeGreaterThanOrEqual(3);
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(PHONE);
    const m = events.find((e) => e.path === '/ext/mask');
    expect(m.upstream).toBe('ext:chatgpt.com');
    expect(m.hits[0].label).toBe('PHONE');
    const rs = events.find((e) => e.path === '/ext/restore');
    expect(rs.restored).toBe(1);
    expect(events.find((e) => e.path === '/x').error).toMatch(/unsupported_content_type/);
  });

  it('recordEvents=false 不发事件', async () => {
    await bridge.apply({ ...cfg, recordEvents: false });
    const events: any[] = [];
    bridge.on('event', (e) => events.push(e));
    await maskText(`tel ${PHONE}`);
    expect(events).toEqual([]);
  });

  it('apply({enabled:false}) 停止监听', async () => {
    expect(bridge.listeningPort).toBe(port);
    await bridge.apply({ ...cfg, enabled: false });
    expect(bridge.listeningPort).toBeNull();
    await expect(fetch(`${base()}/healthz`)).rejects.toThrow();
  });

  it('修改端口后在新端口监听、旧端口关闭', async () => {
    const p2 = await freePort();
    await bridge.apply({ ...cfg, port: p2 });
    expect((await fetch(`http://127.0.0.1:${p2}/healthz`)).status).toBe(200);
    await expect(fetch(`${base()}/healthz`)).rejects.toThrow();
  });
});
