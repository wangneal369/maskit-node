import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NerModelManager } from '../electron/ner/model-manager';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function makeZip(files: Record<string, string>, prefix = ''): Uint8Array {
  const o: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) o[prefix + k] = strToU8(v);
  return zipSync(o);
}

const GOOD = makeZip({ 'model_quantized.onnx': 'onnx-bytes', 'tokenizer.json': '{}', 'config.json': '{}', 'LICENSE': 'x' });

let server: http.Server;
let url = '';
let served: Uint8Array = GOOD;
let dataDir = '';

beforeEach(async () => {
  served = GOOD;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maskit-nm-'));
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': served.length });
    res.end(Buffer.from(served));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/m.zip`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const mgr = (sha256: string, maxBytes = 1024 * 1024) => new NerModelManager(dataDir, fetch, { url, sha256, maxBytes });

describe('NerModelManager', () => {
  it('初始状态：未安装', () => {
    const st = mgr('x').status();
    expect(st.installed).toBe(false);
    expect(st.dir).toBe(path.join(dataDir, 'models', 'ner_mini_zh'));
  });

  it('哈希正确 → 安装成功，状态为 installed，并回报进度', async () => {
    const m = mgr(sha(GOOD));
    const progress: Array<[number, number]> = [];
    await m.download((a, b) => progress.push([a, b]));
    const st = m.status();
    expect(st.installed).toBe(true);
    expect(st.sizeBytes).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(m.modelDir(), 'model_quantized.onnx'), 'utf8')).toBe('onnx-bytes');
    expect(progress.at(-1)![0]).toBe(GOOD.length);
    // 没有遗留临时目录
    expect(fs.readdirSync(path.dirname(m.modelDir()))).toEqual(['ner_mini_zh']);
  });

  it('哈希错误 → 报错，且不留任何“已安装”痕迹', async () => {
    const m = mgr('0'.repeat(64));
    await expect(m.download()).rejects.toThrow('SHA-256 不匹配');
    expect(m.status().installed).toBe(false);
    expect(fs.existsSync(m.modelDir())).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'models'))).toBe(false); // 校验在落盘之前，连目录都不会建
  });

  it('包内缺必需文件 → 报错，不安装', async () => {
    served = makeZip({ 'config.json': '{}' });
    const m = mgr(sha(served));
    await expect(m.download()).rejects.toThrow('不完整');
    expect(m.status().installed).toBe(false);
    expect(fs.existsSync(m.modelDir())).toBe(false);
  });

  it('包内带目录前缀 / 路径穿越条目：只取文件名，不会写到目录外', async () => {
    served = makeZip({ 'model_quantized.onnx': 'a', 'tokenizer.json': '{}', 'config.json': '{}', '../../evil.txt': 'e' }, 'ner/');
    const m = mgr(sha(served));
    await m.download();
    expect(m.status().installed).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'evil.txt'))).toBe(false);
    expect(fs.existsSync(path.join(m.modelDir(), 'evil.txt'))).toBe(true);
  });

  it('超过体积上限 → 中止', async () => {
    const m = mgr(sha(GOOD), 10);
    await expect(m.download()).rejects.toThrow('超过上限');
    expect(m.status().installed).toBe(false);
  });

  it('重装：旧模型被原子替换；失败的重装不破坏已装模型', async () => {
    const m = mgr(sha(GOOD));
    await m.download();
    const bad = new NerModelManager(dataDir, fetch, { url, sha256: '1'.repeat(64), maxBytes: 1 << 20 });
    await expect(bad.download()).rejects.toThrow();
    expect(m.status().installed).toBe(true);
    await m.download();
    expect(m.status().installed).toBe(true);
  });

  it('目录存在但文件缺失 → 状态带 error，不算已安装', () => {
    const m = mgr('x');
    fs.mkdirSync(m.modelDir(), { recursive: true });
    fs.writeFileSync(path.join(m.modelDir(), 'config.json'), '{}');
    const st = m.status();
    expect(st.installed).toBe(false);
    expect(st.error).toContain('不完整');
  });

  it('下载源不可达 / HTTP 错误 → 中文错误', async () => {
    const bad = new NerModelManager(dataDir, fetch, { url: 'http://127.0.0.1:1/x.zip', sha256: 'x', maxBytes: 1 << 20 });
    await expect(bad.download()).rejects.toThrow('模型下载失败');
    expect(bad.status().error).toContain('模型下载失败');
  });
});
