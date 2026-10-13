import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Masker, MappingStore } from '../electron/core';
import { Gateway, type GatewayEvent } from '../electron/gateway/proxy';

const PHONE = '13800138000';
const EMAIL = 'alice@corp-x.com';
const TARGET_PATH = '/v1/chat/completions';

interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  raw: Buffer;
}

let upstream: http.Server;
let upstreamPort = 0;
let received: Received[] = [];
let gateway: Gateway;
let events: GatewayEvent[] = [];

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

const TOKEN_RX = /\{\{[A-Z0-9]+_[a-z]{6}\}\}/g;

/** 模拟上游：JSON 模式回显收到的 user 文本；stream=true 时用 SSE 回显，并把占位符拆成两段 */
function mockUpstream(req: http.IncomingMessage, res: http.ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const body = raw.toString('utf8');
    received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, raw });
    if (req.url === '/echo-plain') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`plain:${body}`);
      return;
    }
    let content = '';
    let stream = false;
    try {
      const j = JSON.parse(body);
      content = j.messages?.[0]?.content ?? '';
      stream = !!j.stream;
    } catch {
      content = body;
    }
    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = `echo: ${content}`;
      const mid = text.indexOf('{{') + 5;
      const mk = (c: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: c } }] })}\n\n`;
      res.write(mk(text.slice(0, mid)));
      setTimeout(() => {
        res.write(mk(text.slice(mid)));
        res.end('data: [DONE]\n\n');
      }, 10);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `echo: ${content}` } }] }));
  });
}

async function startGateway(): Promise<number> {
  const port = await freePort();
  await gateway.start([{ name: 'mock', port, target: `http://127.0.0.1:${upstreamPort}`, paths: [TARGET_PATH] }]);
  return port;
}

function post(port: number, path: string, body: string, contentType = 'application/json'): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': contentType, 'content-length': Buffer.byteLength(body) } },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8'), headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function postRaw(port: number, path: string, body: Buffer, encoding: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': encoding, 'content-length': body.length } },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const chatBody = (content: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ model: 'm', messages: [{ role: 'user', content }], ...extra });

beforeEach(async () => {
  received = [];
  events = [];
  upstream = http.createServer(mockUpstream);
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
  gateway = new Gateway(new Masker(new MappingStore()));
  gateway.on('event', (e: GatewayEvent) => events.push(e));
});

afterEach(async () => {
  await gateway.stop();
  upstream.closeAllConnections();
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe('Gateway 端到端', () => {
  it('上游收到脱敏体，客户端拿到还原后的 JSON', async () => {
    const port = await startGateway();
    const r = await post(port, TARGET_PATH, chatBody(`手机 ${PHONE} 邮箱 ${EMAIL}`));
    expect(r.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].body).not.toContain(PHONE);
    expect(received[0].body).not.toContain(EMAIL);
    expect(received[0].body).toMatch(/\{\{PHONE_/);
    expect(JSON.parse(received[0].body).model).toBe('m');
    const out = JSON.parse(r.text);
    expect(out.choices[0].message.content).toBe(`echo: 手机 ${PHONE} 邮箱 ${EMAIL}`);
    expect(events).toHaveLength(1);
    expect(events[0].restored).toBe(2);
    expect(events[0].hits.map((h) => h.label).sort()).toEqual(['EMAIL', 'PHONE']);
    // 事件里不得落原文
    expect(JSON.stringify(events[0])).not.toContain(PHONE);
  });

  it('配置了出网代理时，本机上游仍直连', async () => {
    // 端口 1 上不会有代理：若本机上游误走代理，请求必然失败
    gateway.setEgressProxy('http://127.0.0.1:1');
    const port = await startGateway();
    const r = await post(port, TARGET_PATH, chatBody(`手机 ${PHONE}`));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).choices[0].message.content).toBe(`echo: 手机 ${PHONE}`);
  });

  it('无命中时请求体一字节不改', async () => {
    const port = await startGateway();
    const body = '{"model":"m",  "messages":[{"role":"user","content":"hello"}]}';
    await post(port, TARGET_PATH, body);
    expect(received[0].body).toBe(body);
  });

  it('SSE 响应：占位符被拆在两个事件里也能还原', async () => {
    const port = await startGateway();
    const r = await post(port, TARGET_PATH, chatBody(`手机 ${PHONE}`, { stream: true }));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(received[0].body).not.toContain(PHONE);
    const text = r.text.split('\n\n').filter((b) => b.startsWith('data: {'))
      .map((b) => JSON.parse(b.slice(6)).choices[0].delta.content).join('');
    expect(text).toBe(`echo: 手机 ${PHONE}`);
    expect(r.text).not.toContain('{{');
    expect(r.text).toContain('data: [DONE]');
    expect(events[0].stream).toBe(true);
  });

  it('非目标路径原样透传，不脱敏', async () => {
    const port = await startGateway();
    const body = chatBody(`手机 ${PHONE}`);
    const r = await post(port, '/v1/other', body);
    expect(r.status).toBe(200);
    expect(received[0].body).toBe(body);
    expect(received[0].url).toBe('/v1/other');
  });

  it('非 JSON content-type 的目标路径不脱敏（按设计透传）', async () => {
    const port = await startGateway();
    const r = await post(port, '/echo-plain', `phone ${PHONE}`, 'text/plain');
    expect(r.text).toBe(`plain:phone ${PHONE}`);
  });

  it('maskEnabled=false 时原样透传，响应也不还原', async () => {
    const port = await startGateway();
    gateway.maskEnabled = false;
    const body = chatBody(`手机 ${PHONE}`);
    const r = await post(port, TARGET_PATH, body);
    expect(received[0].body).toBe(body);
    expect(JSON.parse(r.text).choices[0].message.content).toBe(`echo: 手机 ${PHONE}`);
  });

  it('响应里模型自己编的未知占位符保持原样', async () => {
    const port = await startGateway();
    const r = await post(port, TARGET_PATH, chatBody('{{PHONE_bcdfgh}}'));
    expect(JSON.parse(r.text).choices[0].message.content).toBe('echo: {{PHONE_bcdfgh}}');
    expect(events[0].unresolved).toBe(1);
  });

  it('目标路径上请求体不是合法 JSON：fail-closed 返回 502，且不转发上游', async () => {
    const port = await startGateway();
    const r = await post(port, TARGET_PATH, `{"messages": [ 手机 ${PHONE}`);
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text).error.type).toBe('maskit_gateway_error');
    expect(received).toHaveLength(0);
    expect(events[0].error).toMatch(/^mask_failed/);
  });

  it('JSON 嵌套过深：fail-closed 返回 502', async () => {
    const port = await startGateway();
    let deep: unknown = 'x';
    for (let i = 0; i < 30; i++) deep = { a: deep };
    const r = await post(port, TARGET_PATH, JSON.stringify(deep));
    expect(r.status).toBe(502);
    expect(received).toHaveLength(0);
  });

  it('上游不可达返回 502', async () => {
    const dead = await freePort();
    const port = await freePort();
    await gateway.start([{ name: 'dead', port, target: `http://127.0.0.1:${dead}`, paths: [TARGET_PATH] }]);
    const r = await post(port, TARGET_PATH, chatBody('hi'));
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text).error.message).toContain('上游请求失败');
    expect(events[0].status).toBe(502);
  });

  it('stop 后端口释放，可重复 start', async () => {
    const port = await startGateway();
    expect(gateway.listening).toEqual([port]);
    await gateway.stop();
    expect(gateway.listening).toEqual([]);
    await gateway.start([{ name: 'again', port, target: `http://127.0.0.1:${upstreamPort}`, paths: [TARGET_PATH] }]);
    const r = await post(port, TARGET_PATH, chatBody('hi'));
    expect(r.status).toBe(200);
  });

  describe('压缩请求体', () => {
    const zstdCompress = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
    const codecs: [string, string, ((b: Buffer) => Buffer) | undefined][] = [
      ['gzip', 'gzip', (b) => zlib.gzipSync(b)],
      ['br', 'br', (b) => zlib.brotliCompressSync(b)],
      ['deflate', 'deflate', (b) => zlib.deflateSync(b)],
      ['raw deflate', 'deflate', (b) => zlib.deflateRawSync(b)],
      ['zstd', 'zstd', zstdCompress],
    ];
    for (const [name, enc, fn] of codecs) {
      (fn ? it : it.skip)(`${name}：解压后脱敏，上游收到明文脱敏体且无 content-encoding`, async () => {
        const port = await startGateway();
        const r = await postRaw(port, TARGET_PATH, fn!(Buffer.from(chatBody(`手机 ${PHONE}`))), enc);
        expect(r.status).toBe(200);
        expect(received).toHaveLength(1);
        expect(received[0].headers['content-encoding']).toBeUndefined();
        expect(received[0].body).not.toContain(PHONE);
        expect(received[0].body).toMatch(/\{\{PHONE_/);
        expect(JSON.parse(r.text).choices[0].message.content).toBe(`echo: 手机 ${PHONE}`);
      });
    }

    it('多重编码 gzip, br 按逆序解码', async () => {
      const port = await startGateway();
      const packed = zlib.brotliCompressSync(zlib.gzipSync(Buffer.from(chatBody(`手机 ${PHONE}`))));
      const r = await postRaw(port, TARGET_PATH, packed, 'gzip, br');
      expect(r.status).toBe(200);
      expect(received[0].body).not.toContain(PHONE);
    });

    it('无命中也转发解压后的明文体并去掉 content-encoding', async () => {
      const port = await startGateway();
      const body = chatBody('hello');
      await postRaw(port, TARGET_PATH, zlib.gzipSync(Buffer.from(body)), 'gzip');
      expect(received[0].body).toBe(body);
      expect(received[0].headers['content-encoding']).toBeUndefined();
    });

    it('未知编码 compress：fail-closed 502，不转发', async () => {
      const port = await startGateway();
      const r = await postRaw(port, TARGET_PATH, Buffer.from(chatBody(`手机 ${PHONE}`)), 'compress');
      expect(r.status).toBe(502);
      expect(received).toHaveLength(0);
      expect(events[0].error).toMatch(/^decode_failed/);
    });

    it('损坏的 gzip：fail-closed 502，不转发', async () => {
      const port = await startGateway();
      const bad = zlib.gzipSync(Buffer.from(chatBody('hello'))).subarray(0, 12);
      const r = await postRaw(port, TARGET_PATH, bad, 'gzip');
      expect(r.status).toBe(502);
      expect(received).toHaveLength(0);
      expect(events[0].error).toMatch(/^decode_failed/);
    });

    it('解压炸弹超过 32MB 上限：fail-closed 502', async () => {
      const port = await startGateway();
      const bomb = zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 0x20));
      expect(bomb.length).toBeLessThan(1024 * 1024);
      const r = await postRaw(port, TARGET_PATH, bomb, 'gzip');
      expect(r.status).toBe(502);
      expect(received).toHaveLength(0);
      expect(events[0].error).toMatch(/^decode_failed/);
    });

    it('非目标路径带 gzip：字节级原样透传并保留 content-encoding', async () => {
      const port = await startGateway();
      const packed = zlib.gzipSync(Buffer.from(chatBody(`手机 ${PHONE}`)));
      await postRaw(port, '/v1/other', packed, 'gzip');
      expect(received[0].headers['content-encoding']).toBe('gzip');
      expect(received[0].raw.equals(packed)).toBe(true);
    });

    it('maskEnabled=false：压缩体不解码，原样透传', async () => {
      const port = await startGateway();
      gateway.maskEnabled = false;
      const packed = zlib.gzipSync(Buffer.from(chatBody(`手机 ${PHONE}`)));
      await postRaw(port, TARGET_PATH, packed, 'gzip');
      expect(received[0].headers['content-encoding']).toBe('gzip');
      expect(received[0].raw.equals(packed)).toBe(true);
    });
  });
});

/** 原样发送请求体字节（不压缩），用于验证回写对排版的影响 */
function sendText(port: number, path: string, text: string) {
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
}

describe('请求回写与上游重试', () => {
  it('命中时就地替换：上游收到的字节除敏感值外与原文一致', async () => {
    const port = await startGateway();
    const raw = '{\n  "model": "m",\n  "messages": [ { "role": "user", "content": "电话 ' + PHONE + '" } ],\n  "temperature": 1e-05\n}';
    await sendText(port, TARGET_PATH, raw);
    const sent = received[0].body;
    const at = raw.indexOf(PHONE);
    expect(sent.slice(0, at)).toBe(raw.slice(0, at));
    expect(sent).toContain('1e-05');
    expect(sent).not.toContain(PHONE);
    expect(events[0].rewrite).toBe('splice');
  });

  it('重复键：被覆盖的敏感值也不会以明文上行', async () => {
    const port = await startGateway();
    await sendText(port, TARGET_PATH, `{"model":"m","messages":[{"role":"user","content":"${PHONE}","content":"safe"}]}`);
    expect(received[0].body).not.toContain(PHONE);
    expect(events[0].rewrite).toBe('reserialize');
  });

  it('连接被拒绝：重试一次后返回 502，并记录重试次数', async () => {
    const port = await freePort();
    const deadPort = await freePort();
    await gateway.start([{ name: 'dead', port, target: `http://127.0.0.1:${deadPort}`, paths: [TARGET_PATH] }]);
    const r = await post(port, TARGET_PATH, chatBody('hi'));
    expect(r.status).toBe(502);
    expect(events[0].retries).toBe(1);
  });
});
