// 把无头服务端打成单文件 dist-server/main.cjs（Docker / 服务器部署用）。
// 用法：node scripts/build-server.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'electron/server/main.ts')],
  outfile: path.join(root, 'dist-server/main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: false,
  logLevel: 'info',
  // 原生模块无法打进 bundle，运行时镜像里单独安装
  external: ['onnxruntime-node'],
});
