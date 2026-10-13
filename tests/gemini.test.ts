import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MappingStore, Masker, Restorer, SseRestorer } from '../electron/core';
import { CommandScanner, normalizeCommandBlock, type CommandMode } from '../electron/core/command-block';
import { mapToolArgs } from '../electron/core/tool-args';
import { UsageCollector, modelFromJson, usageFromJson, findPrice } from '../electron/core/usage';
import { Gateway, matchPath, type GatewayEvent } from '../electron/gateway/proxy';
import { ResponseInspector } from '../electron/gateway/inspect';

const store = new MappingStore();
const EMAIL = store.tokenFor('alice@corp-x.com', 'EMAIL');
const DANGER = 'rm -rf /';

/** Gemini SSE 事件：只有 data 行，无 event 行 */
const gem = (parts: object[], extra: Record<string, unknown> = {}, cand: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, ...cand }], ...extra })}\r\n\r\n`;

function run(stream: string, hooks = {}): string {
  const s = new SseRestorer(new Restorer(store), hooks);
  return s.push(stream) + s.end();
}
function events(out: string): any[] {
  const res: any[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) if (line.startsWith('data:')) res.push(JSON.parse(line.slice(5).trim()));
  }
  return res;
}
const textOf = (out: string, thought = false) =>
  events(out)
    .flatMap((e) => e.candidates?.[0]?.content?.parts ?? [])
    .filter((p: any) => typeof p.text === 'string' && !!p.thought === thought)
    .map((p: any) => p.text)
    .join('');

describe('Gemini SSE', () => {
  it('占位符跨事件（每事件新 parts 数组）被还原', () => {
    const out = run(gem([{ text: '邮箱 ' + EMAIL.slice(0, 6) }]) + gem([{ text: EMAIL.slice(6) + ' 完' }], {}, { finishReason: 'STOP' }));
    expect(textOf(out)).toBe('邮箱 alice@corp-x.com 完');
    expect(out).not.toContain('{{');
  });

  it('同事件多个文本 part 共用通道，跨 part 的占位符也能还原', () => {
    const out = run(gem([{ text: 'a ' + EMAIL.slice(0, 4) }, { text: EMAIL.slice(4) + ' b' }]));
    expect(textOf(out)).toBe('a alice@corp-x.com b');
  });

  it('残留在 finishReason 事件前以合成事件吐出，且不重复 finishReason / usageMetadata', () => {
    const out = run(
      gem([{ text: 'abc {{' }]) + gem([{ text: '' }], { usageMetadata: { promptTokenCount: 3 } }, { finishReason: 'STOP' }),
    );
    expect(textOf(out)).toBe('abc {{');
    const evs = events(out);
    expect(evs.filter((e) => e.candidates[0].finishReason)).toHaveLength(1);
    expect(evs.filter((e) => e.usageMetadata)).toHaveLength(1);
  });

  it('thought 文本也还原，且与正文通道互不串扰', () => {
    const out = run(gem([{ text: '想 {{', thought: true }]) + gem([{ text: '答' }]) + gem([{ text: 'x', thought: true }]));
    expect(textOf(out, true)).toBe('想 {{x');
    expect(textOf(out)).toBe('答');
  });

  it('带 thoughtSignature 的 part 不还原', () => {
    const out = run(gem([{ text: EMAIL, thoughtSignature: 'sig' }]));
    expect(textOf(out)).toBe(EMAIL);
    const mixed = run(gem([{ text: EMAIL, thoughtSignature: 'sig' }, { text: EMAIL }]));
    expect(events(mixed)[0].candidates[0].content.parts.map((p: any) => p.text)).toEqual([EMAIL, 'alice@corp-x.com']);
  });

  it('functionCall.args 对象里的占位符被还原（含与文本同事件）', () => {
    const out = run(gem([{ text: 'hi' }, { functionCall: { name: 'send', args: { to: EMAIL } } }]));
    expect(events(out)[0].candidates[0].content.parts[1].functionCall.args).toEqual({ to: 'alice@corp-x.com' });
    const only = run(gem([{ functionCall: { name: 'send', args: { to: EMAIL } } }]));
    expect(events(only)[0].candidates[0].content.parts[0].functionCall.args.to).toBe('alice@corp-x.com');
  });

  it('改写模式：functionCall 危险命令被改写（文本同事件与独立事件）', () => {
    const scanner = new CommandScanner(normalizeCommandBlock({ mode: 'rewrite' }));
    for (const stream of [
      gem([{ functionCall: { name: 'bash', args: { command: DANGER } } }]),
      gem([{ text: 'ok' }, { functionCall: { name: 'bash', args: { command: DANGER } } }]),
    ]) {
      const insp = new ResponseInspector({ commands: scanner, auditEnabled: true, prices: {} }, '', undefined);
      const out = run(stream, insp.sseHooks());
      expect(out).not.toContain(DANGER);
      expect(JSON.stringify(events(out))).toContain('functionCall');
    }
  });

  it('块模式：functionCall 触发阻断', () => {
    const scanner = new CommandScanner(normalizeCommandBlock({ mode: 'block' }));
    const insp = new ResponseInspector({ commands: scanner, auditEnabled: true, prices: {} }, '', undefined);
    const s = new SseRestorer(new Restorer(store), insp.sseHooks());
    const out = s.push(gem([{ text: 'ok' }, { functionCall: { name: 'bash', args: { command: DANGER } } }]));
    expect(s.blocked).toBe(true);
    expect(out).not.toContain(DANGER);
  });
});

describe('Gemini 非流式与工具参数', () => {
  it('restoreTree 还原 text / functionCall.args，跳过带签名的 text', () => {
    const r = new Restorer(store);
    const out = r.restoreTree({
      candidates: [{ content: { parts: [{ text: EMAIL }, { text: EMAIL, thoughtSignature: 's' }, { functionCall: { name: 'f', args: { a: EMAIL } } }] } }],
    }) as any;
    const p = out.candidates[0].content.parts;
    expect(p[0].text).toBe('alice@corp-x.com');
    expect(p[1].text).toBe(EMAIL);
    expect(p[2].functionCall.args.a).toBe('alice@corp-x.com');
  });

  it('mapToolArgs 处理 functionCall.args 对象；改写非法 JSON 时清空为 {}', () => {
    const doc = { functionCall: { name: 'bash', args: { command: 'x' } } };
    expect((mapToolArgs(doc, (a) => a.replace('x', 'y')) as any).functionCall.args).toEqual({ command: 'y' });
    expect((mapToolArgs(doc, () => 'not json') as any).functionCall.args).toEqual({});
  });
});

describe('Gemini 用量', () => {
  const body = {
    candidates: [], modelVersion: 'gemini-2.5-flash',
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, cachedContentTokenCount: 400, thoughtsTokenCount: 50 },
  };
  it('usageFromJson / modelFromJson', () => {
    expect(usageFromJson(body)).toEqual({ input: 600, output: 250, cacheRead: 400, cacheWrite: 0 });
    expect(modelFromJson(body)).toBe('gemini-2.5-flash');
    expect(usageFromJson([{ candidates: [] }, body])).toEqual({ input: 600, output: 250, cacheRead: 400, cacheWrite: 0 });
  });
  it('UsageCollector 取最后一次累计值', () => {
    const c = new UsageCollector();
    c.feed({ modelVersion: 'gemini-2.5-pro', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 } });
    c.feed(body);
    expect(c.result()).toEqual({ input: 600, output: 250, cacheRead: 400, cacheWrite: 0 });
    expect(c.model()).toBe('gemini-2.5-pro');
  });
  it('参考价格存在', () => {
    expect(findPrice('gemini-2.5-pro')?.input).toBe(1.25);
    expect(findPrice('gemini-2.5-flash')?.cacheRead).toBe(0.075);
    expect(findPrice('gemini-2.0-flash')?.output).toBe(0.4);
  });
});

describe('matchPath 通配', () => {
  it('后缀 / 精确 / 尾部 * 前缀', () => {
    expect(matchPath('/v1/chat/completions', ['/chat/completions'])).toBe(true);
    expect(matchPath('/v1beta/models/gemini-2.5-pro:generateContent', ['/chat/completions'])).toBe(false);
    expect(matchPath('/v1beta/models/gemini-2.5-pro:generateContent', ['/v1beta/models/*'])).toBe(true);
    expect(matchPath('/x/v1beta/models/a', ['/v1beta/models/*'])).toBe(false);
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
  const masker = new Masker(store);
  gateway = new Gateway(masker);
  gateway.policy = { commands: new CommandScanner(normalizeCommandBlock({ mode })), auditEnabled: true, prices: {} };
  const evs: GatewayEvent[] = [];
  gateway.on('event', (e: GatewayEvent) => evs.push(e));
  const port = await freePort();
  await gateway.start([{ name: 'gem', port, target: `http://127.0.0.1:${upPort}`, paths: ['/v1beta/models/*'] }]);
  return { port, evs };
}
const post = async (port: number, path: string) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });
  return r.text();
};

describe('Gemini 网关端到端', () => {
  it('SSE：跨 TCP chunk 的占位符还原，用量与模型入事件', async () => {
    const full = gem([{ text: '邮箱 ' + EMAIL.slice(0, 7) }]) + gem([{ text: EMAIL.slice(7) }], {
      modelVersion: 'gemini-2.5-flash', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }, { finishReason: 'STOP' });
    const cut = full.indexOf('\r\n\r\n') + 10;
    const { port, evs } = await setup({ ct: 'text/event-stream', body: [full.slice(0, cut), full.slice(cut)] });
    const out = await post(port, '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect(textOf(out)).toBe('邮箱 alice@corp-x.com');
    expect(evs[0].stream).toBe(true);
    expect(evs[0].model).toBe('gemini-2.5-flash');
    expect(evs[0].usage).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  });

  it('非流式 JSON：还原并按改写模式处理 functionCall', async () => {
    const body = JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: EMAIL }, { functionCall: { name: 'bash', args: { command: DANGER } } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 }, modelVersion: 'gemini-2.0-flash',
    });
    const { port, evs } = await setup({ ct: 'application/json', body }, 'rewrite');
    const out = JSON.parse(await post(port, '/v1beta/models/gemini-2.0-flash:generateContent'));
    const p = out.candidates[0].content.parts;
    expect(p[0].text).toBe('alice@corp-x.com');
    expect(p[1].functionCall.args.command).not.toContain('rm -rf');
    expect(evs[0].commands?.[0].action).toBe('rewrite');
    expect(evs[0].usage?.output).toBe(2);
  });
});
