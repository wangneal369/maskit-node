import { ipc, isElectron } from '@/utils/ipcRenderer'
import { ipcApiRoute, pushEvents } from '@/api'

/** 调用网关频道；非 Electron 环境直接抛错（由调用方 try/catch） */
export async function call(channel, params) {
  if (!isElectron) throw new Error('未在 Electron 环境中运行')
  return await ipc.invoke(channel, params)
}

export const gw = {
  status: () => call(ipcApiRoute.gatewayStatus),
  getConfig: () => call(ipcApiRoute.gatewayGetConfig),
  setConfig: (cfg) => call(ipcApiRoute.gatewaySetConfig, JSON.parse(JSON.stringify(cfg))),
  restart: () => call(ipcApiRoute.gatewayRestart),
  events: (params) => call(ipcApiRoute.gatewayEvents, params),
  clearEvents: () => call(ipcApiRoute.gatewayClearEvents),
  clearMappings: () => call(ipcApiRoute.gatewayClearMappings),
  rotateExtToken: () => call(ipcApiRoute.gatewayRotateExtToken),
  openExtensionDir: () => call(ipcApiRoute.gatewayOpenExtensionDir),
  playground: (text) => call(ipcApiRoute.gatewayPlayground, { text }),
  exportSkillBundle: () => call(ipcApiRoute.gatewayExportSkillBundle),
  skillAgentsSnippet: () => call(ipcApiRoute.gatewaySkillAgentsSnippet),
}

/** 订阅推送事件，返回取消函数 */
export function onGatewayEvent(handler) {
  if (!isElectron) return () => {}
  const listener = (_e, ev) => handler(ev)
  ipc.on(pushEvents.gatewayEvent, listener)
  return () => ipc.removeListener(pushEvents.gatewayEvent, listener)
}

export const RULE_META = {
  PRIVATE_KEY: 'PEM 私钥（整块替换）',
  CONNSTR: '连接串密码（scheme://user:pass@host，只脱密码）',
  PHONE: '手机号（含分隔符 / +86 前缀）',
  EMAIL: '邮箱（含中文用户名）',
  LANDLINE: '座机（区号 + 7-8 位号码）',
  PLATE: '车牌（普通 / 新能源）',
  HKID: '港澳通行证（H 开头 8 位，易误伤）',
  IDCARD: '身份证（15 位 / 18 位，多重校验）',
  IP_PRIVATE: '内网 IP：192.168.x / 链路本地 / 100.64 段',
  IP_INTERNAL: '内网 IP：10.x / 172.16-31.x（易误伤版本号）',
  CARD: '银行卡（Luhn 校验）',
  IBAN: 'IBAN（mod-97 校验）',
  MAC: 'MAC 地址（易误伤）',
  API_KEY: 'GitHub / Google / Slack / Stripe 等 API Key',
  ACCESS_KEY: '云厂商 Access Key（AWS / 阿里云 / 腾讯云）',
  JWT: 'JWT 令牌',
  TOKEN: 'Bearer Token',
  SECRET: 'password= / token= / 密码： 等赋值凭据',
}
