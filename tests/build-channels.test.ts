import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '..');
const bin = require(path.join(root, 'cmd', 'bin.js')) as { build: Record<string, { args?: string[] }> };
const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(root, 'cmd', f), 'utf8'));

const channelOf = (cmd: string): string | undefined =>
  bin.build[cmd].args?.find((a) => a.startsWith('-c.publish.channel='))?.split('=')[1];

describe('按架构拆分的更新通道（锁定打包配置约定）', () => {
  it('x64 Windows、macOS、Linux 不写 channel（保持 latest*.yml，老用户继续更新）', () => {
    expect(channelOf('win64')).toBeUndefined();
    expect(channelOf('mac_arm64')).toBeUndefined();
    expect(channelOf('mac')).toBeUndefined();
    expect(channelOf('linux')).toBeUndefined();
    // Linux 的架构后缀由 electron-builder / electron-updater 内置（latest-linux-arm64.yml），不应再叠加 channel
    expect(channelOf('linux_arm64')).toBeUndefined();
  });
  it('Windows arm64 使用独立 channel', () => {
    expect(channelOf('win_arm64')).toBe('arm64');
  });
  it('不再提供 32 位构建', () => {
    const text = JSON.stringify(bin.build);
    expect(text).not.toMatch(/ia32|armv7l/);
  });
  it('各 builder 配置的 publish 是对象（数组无法被 -c.publish.channel 覆盖）并挂了 afterPack', () => {
    for (const f of ['builder.json', 'builder-mac-arm64.json', 'builder-linux.json']) {
      const cfg = readJson(f);
      expect(Array.isArray(cfg.publish), f).toBe(false);
      expect(cfg.publish.provider, f).toBe('github');
      expect(cfg.afterPack, f).toBe('./cmd/after-pack.cjs');
    }
  });
  it('Windows 配置不再按路径排除 win32/arm64（由 afterPack 按架构裁剪）', () => {
    expect(readJson('builder.json').files.join('\n')).not.toMatch(/win32/);
  });
});

describe('afterPack：onnxruntime-node 按目标架构裁剪', () => {
  const { Arch } = require('builder-util') as { Arch: Record<string | number, string | number> };
  const afterPack = require(path.join(root, 'cmd', 'after-pack.cjs')).default as (ctx: unknown) => Promise<void>;

  function fixture(unpackedParent: string): string {
    const base = path.join(unpackedParent, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
    for (const d of ['win32/x64', 'win32/arm64', 'linux/x64', 'linux/arm64', 'darwin/arm64']) {
      fs.mkdirSync(path.join(base, d), { recursive: true });
      fs.writeFileSync(path.join(base, d, 'onnxruntime_binding.node'), 'x');
    }
    fs.writeFileSync(path.join(base, 'linux/x64', 'libonnxruntime_providers_cuda.so'), 'x');
    fs.writeFileSync(path.join(base, 'linux/x64', 'libonnxruntime.so.1'), 'x');
    return base;
  }
  const left = (base: string) =>
    fs.readdirSync(base).flatMap((p) => fs.readdirSync(path.join(base, p)).map((a) => `${p}/${a}`)).sort();

  const run = async (platformName: string, archName: string, resourcesRel: string[]) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maskit-afterpack-'));
    try {
      const base = fixture(path.join(tmp, ...resourcesRel));
      await afterPack({
        appOutDir: tmp,
        electronPlatformName: platformName,
        arch: Arch[archName],
        packager: { appInfo: { productFilename: 'DataMaskit' } },
      });
      return { result: left(base), filesX: fs.existsSync(path.join(base, 'linux/x64')) ? fs.readdirSync(path.join(base, 'linux/x64')).sort() : [] };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true }); // 仅清理本测试自己创建的临时目录
    }
  };

  it('Windows x64 只留 win32/x64', async () => {
    const r = await run('win32', 'x64', ['resources']);
    expect(r.result).toEqual(['win32/x64']);
  });
  it('Windows arm64 只留 win32/arm64', async () => {
    const r = await run('win32', 'arm64', ['resources']);
    expect(r.result).toEqual(['win32/arm64']);
  });
  it('Linux arm64 只留 linux/arm64；Linux x64 额外删 CUDA 执行器', async () => {
    expect((await run('linux', 'arm64', ['resources'])).result).toEqual(['linux/arm64']);
    const x = await run('linux', 'x64', ['resources']);
    expect(x.result).toEqual(['linux/x64']);
    expect(x.filesX).toEqual(['libonnxruntime.so.1', 'onnxruntime_binding.node']);
  });
  it('macOS arm64 保留 darwin/arm64；macOS x64 无预编译库，全部清空', async () => {
    const mac = ['DataMaskit.app', 'Contents', 'Resources'];
    expect((await run('darwin', 'arm64', mac)).result).toEqual(['darwin/arm64']);
    expect((await run('darwin', 'x64', mac)).result).toEqual([]);
  });
});
