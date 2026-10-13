import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MappingStore, Masker, NdjsonRestorer, Restorer } from '../electron/core';
import { CommandScanner, normalizeCommandBlock, type CommandMode } from '../electron/core/command-block';
import { UsageCollector, modelFromJson, usageFromJson } from '../electron/core/usage';
import { ResponseInspector } from '../electron/gateway/inspect';
import { Gateway, type GatewayEvent } from '../electron/gateway/proxy';

const store = new MappingStore();
const EMAIL = store.tokenFor('alice@corp-x.com', 'EMAIL');
const DANGER = 'rm -rf /';

const chat = (content: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ model: 'llama3', created_at: 't', message: { role: 'assistant', content }, done: false, ...extra })}\n`;
const doneLine = (content = '') =>
  chat(content, { done: true, done_reason: 'stop', total_duration: 9, eval_count: 7, prompt_eval_count: 3 });

function run(stream: string, hooks = {}): string {
  const n = new NdjsonRestorer(new Restorer(store), hooks);
  return n.push(stream) + n.end();
}
const lines = (out: string) => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const contentOf = (out: string) => lines(out).map((l) => l.message?.content ?? '').join('');

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('NdjsonRestorer', () => {
  it('占位符跨行被还原', () => {
    const out = run(chat('邮箱 ' + EMAIL.slice(0, 6)) + chat(EMAIL.slice(6) + ' 完') + doneLine());
    expect(contentOf(out)).toBe('邮箱 alice@corp-x.com 完');
    expect(out).not.toContain('{{');
  });

  it('随机切分 TCP chunk（含行内、行尾、多字节）结果一致', () => {
    const stream = chat('你好 ' + EMAIL.slice(0, 5)) + chat(EMAIL.slice(5, 12)) + chat(EMAIL.slice(12) + ' 好') + doneLine();
    for (let seed = 1; seed <= 30; seed++) {
      const rnd = mulberry32(seed);
      const n = new NdjsonRestorer(new Restorer(store));
      let out = '';
      for (let i = 0; i < stream.length;) {
        const k = 1 + Math.floor(rnd() * 13);
        out += n.push(stream.slice(i, i + k));
        i += k;
      }
      out += n.end();
      expect(contentOf(out)).toBe('你好 alice@corp-x.com 好');
    }
  });

  it('残留在 done 行之前以合成行吐出，合成行不带统计字段且 done=false', () => {
    const out = run(chat('abc {{') + doneLine());
    const ls = lines(out);
    expect(contentOf(out)).toBe('abc {{');
    expect(ls).toHaveLength(3);
    expect(ls[1].message.content).toBe('{{');
    expect(ls[1].done).toBe(false);
    expect(ls[1].eval_count).toBeUndefined();
    expect(ls[2].done).toBe(true);
    expect(ls[2].eval_count).toBe(7);
  });

  it('end() 兜底：无 done 行且最后一行无换行', () => {
    const out = run(chat('abc {{').trimEnd());
    expect(contentOf(out)).toBe('abc {{');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('message.thinking 与 /api/generate 的 response 各走自己的通道', () => {
    const gen = (response: string, extra = {}) => `${JSON.stringify({ model: 'm', response, done: false, ...extra })}\n`;
    const out = run(gen('a ' + EMAIL.slice(0, 5)) + gen(EMAIL.slice(5)) + gen('', { done: true, eval_count: 2 }));
    expect(lines(out).map((l) => l.response).join('')).toBe('a alice@corp-x.com');
    const th = run(chat('x', { message: { role: 'assistant', content: 'x', thinking: '想 ' + EMAIL } }) + doneLine());
    expect(lines(th)[0].message.thinking).toBe('想 alice@corp-x.com');
  });

  it('tool_calls.function.arguments 对象被还原，改写模式下危险命令被改写', () => {
    const tool = (command: string) =>
      `${JSON.stringify({ model: 'm', message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: { command, to: EMAIL } } }] }, done: false })}\n`;
    const plain = run(tool('ls') + doneLine());
    expect(lines(plain)[0].message.tool_calls[0].function.arguments).toEqual({ command: 'ls', to: 'alice@corp-x.com' });

    const insp = new ResponseInspector(
      { commands: new CommandScanner(normalizeCommandBlock({ mode: 'rewrite' })), auditEnabled: true, prices: {} }, '', undefined,
    );
    const out = run(tool(DANGER) + doneLine(), insp.sseHooks());
    expect(out).not.toContain(DANGER);
  });

  it('块模式：阻断后停止并下发错误行', () => {
    const insp = new ResponseInspector(
      { commands: new CommandScanner(normalizeCommandBlock({ mode: 'block' })), auditEnabled: true, prices: {} }, '', undefined,
    );
    const n = new NdjsonRestorer(new Restorer(store), insp.sseHooks());
    const out = n.push(`${JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 'bash', arguments: { command: DANGER } } }] }, done: false })}\n`);
    expect(n.blocked).toBe(true);
    expect(out).not.toContain(DANGER);
    expect(out).toContain('maskit_command_blocked');
  });

  it('非 JSON 行与空行原样透传', () => {
    expect(run('oops\n\n')).toBe('oops\n\n');
  });
});

describe('Ollama 用量', () => {
  const body = { model: 'llama3', message: { role: 'assistant', content: 'x' }, done: true, prompt_eval_count: 12, eval_count: 34 };
  it('usageFromJson / modelFromJson / UsageCollector', () => {
    expect(usageFromJson(body)).toEqual({ input: 12, output: 34, cacheRead: 0, cacheWrite: 0 });
    expect(modelFromJson(body)).toBe('llama3');
    const c = new UsageCollector();
    c.feed(JSON.parse(chat('a')));
    c.feed(body);
    expect(c.result()).toEqual({ input: 12, output: 34, cacheRead: 0, cacheWrite: 0 });
    expect(c.model()).toBe('llama3');
  });
});

// ---------- 端到端 ----------
let upstream: http.Server | undefined;
let gateway: Gateway | undefined;
afterEach(async () => {
  await gateway?.stop();
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = undefined;
  gateway = undefined;
});
const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address() as net.AddressInfo;
    s.close(() => resolve(port));
  });
});

async function setup(reply: { ct: string; body: string | string[] }, mode: CommandMode = 'observe') {
  upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': reply.ct });
      if (Array.isArray(reply.body)) {
        for (const c of reply.body) res.write(c);
        res.end();
      } else res.end(reply.body);
    });
  });
  const upPort = await new Promise<number>((r) => upstream!.listen(0, '127.0.0.1', () => r((upstream!.address() as net.AddressInfo).port)));
  gateway = new Gateway(new Masker(store));
  gateway.policy = { commands: new CommandScanner(normalizeCommandBlock({ mode })), auditEnabled: true, prices: {} };
  const evs: GatewayEvent[] = [];
  gateway.on('event', (e: GatewayEvent) => evs.push(e));
  const port = await freePort();
  await gateway.start([{ name: 'ollama', port, target: `http://127.0.0.1:${upPort}`, paths: ['/api/chat', '/api/generate'] }]);
  return { port, evs };
}
const post = async (port: number) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] }),
  });
  return r.text();
};

describe('Ollama 网关端到端', () => {
  it('NDJSON 流：行被切在 TCP chunk 中间也能还原，用量入事件', async () => {
    const full = chat('邮箱 ' + EMAIL.slice(0, 7)) + chat(EMAIL.slice(7)) + doneLine();
    const cut = full.indexOf('\n') + 15;
    const { port, evs } = await setup({ ct: 'application/x-ndjson', body: [full.slice(0, cut), full.slice(cut)] });
    const out = await post(port);
    expect(contentOf(out)).toBe('邮箱 alice@corp-x.com');
    expect(evs[0].stream).toBe(true);
    expect(evs[0].model).toBe('llama3');
    expect(evs[0].usage).toEqual({ input: 3, output: 7, cacheRead: 0, cacheWrite: 0 });
  });

  it('非流式 JSON：还原 message.content 与 tool_calls', async () => {
    const body = JSON.stringify({
      model: 'llama3',
      message: { role: 'assistant', content: EMAIL, tool_calls: [{ function: { name: 'bash', arguments: { command: DANGER } } }] },
      done: true, prompt_eval_count: 1, eval_count: 2,
    });
    const { port, evs } = await setup({ ct: 'application/json', body }, 'rewrite');
    const out = JSON.parse(await post(port));
    expect(out.message.content).toBe('alice@corp-x.com');
    expect(out.message.tool_calls[0].function.arguments.command).not.toContain('rm -rf');
    expect(evs[0].usage?.output).toBe(2);
  });

  it('NDJSON 流块模式：返回错误行且不泄露命令', async () => {
    const l = `${JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 'bash', arguments: { command: DANGER } } }] }, done: false })}\n`;
    const { port, evs } = await setup({ ct: 'application/x-ndjson', body: [l, doneLine()] }, 'block');
    const out = await post(port);
    expect(out).toContain('maskit_command_blocked');
    expect(out).not.toContain('rm -rf');
    expect(evs[0].error).toBe('command_blocked');
  });
});
