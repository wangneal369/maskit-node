import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MASK_CONFIG, Masker, MappingStore } from '../electron/core';
import { DEFAULT_EXT_CONFIG, ExtBridge } from '../electron/gateway/ext-bridge';
import { Gateway, type GatewayEvent, type GatewayNer } from '../electron/gateway/proxy';
import type { NerEntity } from '../electron/ner/engine';

const PATH = '/v1/chat/completions';
const TOKEN = 'ner-test-token';

const ent = (text: string, type: NerEntity['type'], start = 0): NerEntity => ({ text, type, start, end: start + text.length });

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

let upstream: http.Server;
let upstreamPort = 0;
let receivedBodies: string[] = [];
let gateway: Gateway;
let events: GatewayEvent[] = [];

beforeEach(async () => {
  receivedBodies = [];
  events = [];
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      receivedBodies.push(body);
      const content = JSON.parse(body).messages?.at(-1)?.content ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `收到：${content}` } }] }));
    });
  });
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

async function startGateway(paths = [PATH]): Promise<number> {
  const port = await freePort();
  await gateway.start([{ name: 'mock', port, target: `http://127.0.0.1:${upstreamPort}`, paths }]);
  return port;
}

function post(port: number, body: unknown): Promise<{ status: number; text: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: PATH, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const chat = (...contents: string[]) => ({ model: 'm', messages: contents.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content })) });

describe('Gateway + NER', () => {
  it('实体在上游侧被打码，下游自动还原；NER 收到未脱敏叶子（按文档顺序）', async () => {
    const seen: { texts: string[]; budget: number }[] = [];
    gateway.ner = {
      budgetMs: 1234,
      extract: async (texts, budgetMs) => {
        seen.push({ texts, budget: budgetMs });
        return { entities: [ent('张伟', 'NAME'), ent('腾讯公司', 'ORG')], truncated: false };
      },
    } satisfies GatewayNer;
    const port = await startGateway();
    const r = await post(port, chat('我是张伟，手机13800138000', '好的', '请问腾讯公司怎么走'));
    expect(r.status).toBe(200);
    expect(receivedBodies[0]).not.toMatch(/张伟|腾讯公司|13800138000/);
    expect(receivedBodies[0]).toMatch(/\{\{NAME_[a-z]{6}\}\}/);
    expect(receivedBodies[0]).toMatch(/\{\{ORG_[a-z]{6}\}\}/);
    expect(JSON.parse(r.text).choices[0].message.content).toBe('收到：请问腾讯公司怎么走');
    expect(seen).toHaveLength(1);
    expect(seen[0].texts).toEqual(['我是张伟，手机13800138000', '好的', '请问腾讯公司怎么走']);
    expect(seen[0].budget).toBe(1234);
    expect(events[0].ner).toEqual({ entities: 2, truncated: false });
    expect(events[0].hits.map((h) => h.label)).toEqual(expect.arrayContaining(['NAME', 'ORG', 'PHONE']));
  });

  it('NER 抛异常：请求照常放行（规则仍生效），错误记入事件', async () => {
    gateway.ner = { budgetMs: 100, extract: async () => { throw new Error('boom'); } };
    const port = await startGateway();
    const r = await post(port, chat('张伟 13800138000'));
    expect(r.status).toBe(200);
    expect(receivedBodies[0]).not.toContain('13800138000');
    expect(receivedBodies[0]).toContain('张伟');
    expect(events[0].ner).toEqual({ entities: 0, truncated: false, error: 'ner_failed: boom' });
    expect(events[0].error).toBeUndefined();
  });

  it('NER 返回 error / truncated：部分实体仍生效，降级信息进入事件', async () => {
    gateway.ner = { budgetMs: 100, extract: async () => ({ entities: [ent('张伟', 'NAME')], truncated: true, error: 'NER 推理异常：x' }) };
    const port = await startGateway();
    await post(port, chat('张伟和李娜'));
    expect(receivedBodies[0]).not.toContain('张伟');
    expect(receivedBodies[0]).toContain('李娜');
    expect(events[0].ner).toEqual({ entities: 1, truncated: true, error: 'NER 推理异常：x' });
  });

  it('未设置 ner：不产生 ner 字段，行为不变', async () => {
    const port = await startGateway();
    await post(port, chat('张伟 13800138000'));
    expect(events[0].ner).toBeUndefined();
    expect(receivedBodies[0]).toContain('张伟');
  });

  it('没有含汉字的叶子：不调用 NER', async () => {
    let called = 0;
    gateway.ner = { budgetMs: 100, extract: async () => { called++; return { entities: [], truncated: false }; } };
    const port = await startGateway();
    await post(port, chat('hello 13800138000'));
    expect(called).toBe(0);
    expect(events[0].ner).toEqual({ entities: 0, truncated: false });
  });

  it('非目标路径不跑 NER', async () => {
    let called = 0;
    gateway.ner = { budgetMs: 100, extract: async () => { called++; return { entities: [], truncated: false }; } };
    const port = await startGateway(['/other']);
    await post(port, chat('张伟'));
    expect(called).toBe(0);
  });
});

describe('ExtBridge + NER', () => {
  let bridge: ExtBridge;
  let port: number;
  const extEvents: GatewayEvent[] = [];

  beforeEach(async () => {
    extEvents.length = 0;
    const masker = new Masker();
    masker.configure({ ...DEFAULT_MASK_CONFIG });
    bridge = new ExtBridge(masker, '1.0.0');
    bridge.on('event', (e: GatewayEvent) => extEvents.push(e));
    port = await freePort();
    await bridge.apply({ ...DEFAULT_EXT_CONFIG, enabled: true, port, token: TOKEN });
  });
  afterEach(async () => {
    await bridge.stop();
  });

  const maskReq = async (text: string): Promise<{ status: number; json: { masked_text?: string } }> => {
    const res = await fetch(`http://127.0.0.1:${port}/api/ext/mask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shield-token': TOKEN },
      body: JSON.stringify({ text, host: 'chat.example' }),
    });
    return { status: res.status, json: (await res.json()) as { masked_text?: string } };
  };

  it('JSON 体与纯文本体都按实体打码', async () => {
    bridge.ner = { budgetMs: 100, extract: async () => ({ entities: [ent('张伟', 'NAME')], truncated: false }) };
    const a = await maskReq(JSON.stringify({ prompt: '你好张伟' }));
    expect(a.status).toBe(200);
    expect(a.json.masked_text).toMatch(/\{\{NAME_[a-z]{6}\}\}/);
    expect(a.json.masked_text).not.toContain('张伟');
    const b = await maskReq('纯文本 张伟');
    expect(b.json.masked_text).not.toContain('张伟');
    expect(extEvents[0].ner).toEqual({ entities: 1, truncated: false });
  });

  it('NER 失败不阻断 /mask，并产生带 ner.error 的事件（即便没有规则命中）', async () => {
    bridge.ner = { budgetMs: 100, extract: async () => { throw new Error('坏了'); } };
    const r = await maskReq('张伟说你好');
    expect(r.status).toBe(200);
    expect(r.json.masked_text).toBe('张伟说你好');
    expect(extEvents).toHaveLength(1);
    expect(extEvents[0].ner?.error).toContain('坏了');
  });
});
