/**
 * electron-builder afterPack 钩子：按目标平台/架构裁剪 onnxruntime-node 的原生二进制。
 *
 * onnxruntime-node 把所有平台的预编译库都放在 bin/napi-v6/<platform>/<arch>/（合计约 290MB），
 * 而 electron-builder 的 `files` 过滤只能按平台排除、无法按架构排除（同一份配置要同时服务 x64 与 arm64）。
 * 这里在打包完成后、生成安装包之前，只保留与目标完全匹配的那一个目录，其余全部删除。
 *
 * 另外 linux/x64 上 `npm ci` 会按 onnxruntime-node 的 install 脚本额外下载 CUDA/TensorRT 执行器
 * （libonnxruntime_providers_*.so，数百 MB）；NER 固定使用 CPU 执行器，这些库一律删除。
 *
 * 目标架构没有预编译二进制时（例如 macOS x64）会把所有目录删光：NER 运行时在该架构上报告不可用，应用本身照常启动
 * （engine.ts 对 `await import('onnxruntime-node')` 做了 try/catch）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('builder-util');

/** 递归计算目录大小（字节），仅用于日志 */
function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    total += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
  }
  return total;
}

const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';

/** electron-builder 的 platform 名 -> Node 的 process.platform */
const PLATFORM_MAP = { windows: 'win32', win32: 'win32', mac: 'darwin', darwin: 'darwin', linux: 'linux' };

/** electron-builder 的 Arch 名 -> Node 的 process.arch（ia32/x64/armv7l/arm64/universal） */
const ARCH_MAP = { x64: 'x64', ia32: 'ia32', arm64: 'arm64', armv7l: 'arm', universal: 'universal' };

function findUnpackedRoots(context) {
  const { appOutDir, electronPlatformName } = context;
  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') {
    const app = `${context.packager.appInfo.productFilename}.app`;
    return [path.join(appOutDir, app, 'Contents', 'Resources', 'app.asar.unpacked')];
  }
  return [path.join(appOutDir, 'resources', 'app.asar.unpacked')];
}

exports.default = async function afterPack(context) {
  const platform = PLATFORM_MAP[context.electronPlatformName] || context.electronPlatformName;
  const archName = Arch[context.arch];
  const arch = ARCH_MAP[archName] || archName;

  for (const root of findUnpackedRoots(context)) {
    const binRoot = path.join(root, 'node_modules', 'onnxruntime-node', 'bin');
    if (!fs.existsSync(binRoot)) continue;
    const before = dirSize(binRoot);

    for (const napi of fs.readdirSync(binRoot)) {
      const napiDir = path.join(binRoot, napi);
      if (!fs.statSync(napiDir).isDirectory()) continue;
      for (const plat of fs.readdirSync(napiDir)) {
        const platDir = path.join(napiDir, plat);
        for (const a of fs.readdirSync(platDir)) {
          if (plat === platform && a === arch) continue;
          fs.rmSync(path.join(platDir, a), { recursive: true, force: true });
        }
        // 保留的平台目录若已被清空（目标架构无预编译库），连同平台目录一起移除
        if (fs.readdirSync(platDir).length === 0) fs.rmdirSync(platDir);
      }
    }

    // linux 上 npm ci 可能额外下载了 CUDA/TensorRT 执行器，NER 只用 CPU
    if (platform === 'linux') {
      const keep = path.join(binRoot, 'napi-v6', 'linux', arch);
      if (fs.existsSync(keep)) {
        for (const f of fs.readdirSync(keep)) {
          if (/^libonnxruntime_providers_/.test(f)) fs.rmSync(path.join(keep, f), { force: true });
        }
      }
    }

    const left = fs.existsSync(binRoot) ? fs.readdirSync(binRoot).flatMap((n) => {
      const d = path.join(binRoot, n);
      return fs.readdirSync(d).flatMap((p) => fs.readdirSync(path.join(d, p)).map((a) => `${n}/${p}/${a}`));
    }) : [];
    console.log(
      `  • afterPack: onnxruntime-node 目标 ${platform}/${arch}，保留 [${left.join(', ') || '无（NER 在该架构不可用）'}]，` +
        `${mb(before)} -> ${mb(dirSize(binRoot))}`,
    );
  }
};
