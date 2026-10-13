/**
 * 无头服务入口（Docker / 服务器部署）。Node only：整个导入链不得出现 electron / ee-core。
 *
 * 环境变量：
 *  MASKIT_DATA_DIR      数据目录（配置、SQLite、面板令牌），默认 /data
 *  MASKIT_PANEL_HOST    面板监听地址，默认 127.0.0.1（Docker 镜像里设为 0.0.0.0）
 *  MASKIT_PANEL_PORT    面板端口，默认 18700
 *  MASKIT_LISTEN_HOST   网关与扩展桥接监听地址，默认 127.0.0.1（Docker 镜像里设为 0.0.0.0）
 *  MASKIT_TOKEN         面板/API 令牌（至少 16 位）；留空则首次启动生成并持久化，仅打印一次
 *  MASKIT_TOKEN_FILE    从文件读取令牌（Docker secret），优先于 MASKIT_TOKEN
 *  MASKIT_PUBLIC_HOST   额外接受的 Host 主机名（反代域名等，逗号分隔，不含端口）
 *  MASKIT_WEB_DIST      前端静态目录，默认 <bundle>/../public/dist
 *  MASKIT_BUNDLE_DIR    agent-bundle 目录，默认 <bundle>/../agent-bundle
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GatewayCore } from '../app/gateway-core';
import { EventHub, createPanelServer } from './panel';

const MIN_TOKEN_LEN = 16;

const stamp = () => new Date().toISOString();
const logger = {
  info: (...a: unknown[]) => console.log(stamp(), ...a),
  warn: (...a: unknown[]) => console.warn(stamp(), ...a),
  error: (...a: unknown[]) => console.error(stamp(), ...a),
};

/** 读取版本号：打包后读不到 package.json 时回退到 'headless' */
function readVersion(): string {
  if (process.env.MASKIT_VERSION) return process.env.MASKIT_VERSION;
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf-8')).version;
      if (typeof v === 'string') return v;
    } catch {
      // 继续尝试
    }
  }
  return 'headless';
}

/** 解析面板令牌：文件 > 环境变量 > 数据目录里持久化的 > 新生成（仅此时 generated=true） */
export function resolveToken(dataDir: string, env: NodeJS.ProcessEnv): { token: string; generated: boolean } {
  let token = '';
  if (env.MASKIT_TOKEN_FILE) token = fs.readFileSync(env.MASKIT_TOKEN_FILE, 'utf-8').replace(/[\r\n]+/g, '').trim();
  else token = (env.MASKIT_TOKEN ?? '').trim();
  if (token) {
    if (token.length < MIN_TOKEN_LEN) throw new Error(`MASKIT_TOKEN 太短（至少 ${MIN_TOKEN_LEN} 位）`);
    return { token, generated: false };
  }
  const file = path.join(dataDir, 'panel-token');
  try {
    const saved = fs.readFileSync(file, 'utf-8').trim();
    if (saved.length >= MIN_TOKEN_LEN) return { token: saved, generated: false };
  } catch {
    // 首次启动
  }
  token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return { token, generated: true };
}

async function main(): Promise<void> {
  const env = process.env;
  const dataDir = path.resolve(env.MASKIT_DATA_DIR || '/data');
  fs.mkdirSync(dataDir, { recursive: true });
  const panelHost = env.MASKIT_PANEL_HOST || '127.0.0.1';
  const panelPort = Number(env.MASKIT_PANEL_PORT || 18700);
  const listenHost = env.MASKIT_LISTEN_HOST || '127.0.0.1';
  const publicHosts = (env.MASKIT_PUBLIC_HOST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const webDist = path.resolve(env.MASKIT_WEB_DIST || path.join(__dirname, '..', 'public', 'dist'));
  const bundleDir = path.resolve(env.MASKIT_BUNDLE_DIR || path.join(__dirname, '..', 'agent-bundle'));

  const { token, generated } = resolveToken(dataDir, env);
  const hub = new EventHub();
  const core = new GatewayCore({
    dataDir,
    version: readVersion(),
    push: hub.push,
    logger,
    listenHost,
    publicHosts,
  });
  await core.init();

  const server = createPanelServer({ core, hub, token, webDist, bundleDir, publicHosts });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(panelPort, panelHost, () => resolve());
  });
  const ping = setInterval(() => hub.ping(), 20_000);
  ping.unref();
  logger.info(`[maskit] 控制面板已启动：http://${panelHost}:${panelPort}  数据目录：${dataDir}`);
  logger.info(`[maskit] 网关/扩展桥接监听地址：${listenHost}`);
  if (generated) {
    logger.info(`[maskit] 面板令牌（仅此一次打印，已保存到 ${path.join(dataDir, 'panel-token')}）：${token}`);
  }

  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    logger.info(`[maskit] 收到 ${sig}，正在退出…`);
    clearInterval(ping);
    hub.closeAll();
    server.closeAllConnections();
    server.close();
    await core.stop().catch((e) => logger.error('[maskit] 停止失败:', e));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  logger.error('[maskit] 启动失败:', e);
  process.exit(1);
});
