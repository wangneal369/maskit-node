import { reactive } from 'vue'
import { ipc, isElectron } from '@/utils/ipcRenderer'
import { ipcApiRoute, pushEvents } from '@/api'

// ---------- 浏览器（Docker / 无头）模式：fetch + 令牌 ----------
const TOKEN_KEY = 'maskit_token'

/** 登录态：App.vue 据此显示令牌登录页 */
export const auth = reactive({ token: localStorage.getItem(TOKEN_KEY) || '', needLogin: false })
if (!isElectron && !auth.token) auth.needLogin = true

export function setToken(t) {
  auth.token = t
  auth.needLogin = !t
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else localStorage.removeItem(TOKEN_KEY)
  reconnectEvents()
}

function invalidateToken() {
  auth.token = ''
  auth.needLogin = true
  localStorage.removeItem(TOKEN_KEY)
  closeEvents()
}

async function httpFetch(path, init = {}) {
  if (!auth.token) {
    auth.needLogin = true
    throw new Error('未登录：请先输入访问令牌')
  }
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.headers || {}), 'X-Maskit-Token': auth.token },
  })
  if (res.status === 401) {
    invalidateToken()
    throw new Error('访问令牌无效，请重新登录')
  }
  return res
}

/** 调用网关：Electron 走 IPC（channel 形如 controller/gateway/<method>），浏览器走 POST /api/<method> */
export async function call(channel, params) {
  if (isElectron) return await ipc.invoke(channel, params)
  const method = String(channel).split('/').pop()
  const res = await httpFetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params ?? null),
  })
  let body
  try { body = await res.json() } catch { throw new Error(`服务端返回异常（HTTP ${res.status}）`) }
  if (!res.ok || !body.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`)
  return body.data
}

/** 把 Blob 交给浏览器下载 */
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

/** 从 Content-Disposition 取文件名 */
function filenameFrom(cd) {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd || '')
  if (!m) return ''
  try { return decodeURIComponent(m[1]) } catch { return m[1] }
}

/** 浏览器下载带令牌的接口：带令牌 fetch → blob → <a download> */
async function downloadAuthed(path, fallbackName) {
  const res = await httpFetch(path)
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { msg = (await res.json()).message || msg } catch { /* 非 JSON */ }
    return { ok: false, error: msg }
  }
  const name = filenameFrom(res.headers.get('Content-Disposition')) || fallbackName
  saveBlob(await res.blob(), name)
  return { ok: true, path: `${name}（浏览器下载目录）` }
}

/** 浏览器导出配置：exportConfig() → JSON 文件下载 */
async function exportConfigBrowser() {
  try {
    const config = await call(ipcApiRoute.gatewayExportConfig)
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const name = `maskit-config-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`
    saveBlob(new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }), name)
    return { ok: true, path: `${name}（浏览器下载目录）` }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** 弹出文件选择框，取消时 resolve(null) */
function pickJsonFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    let picked = false
    input.onchange = () => {
      picked = true
      resolve(input.files?.[0] || null)
    }
    input.addEventListener('cancel', () => { if (!picked) resolve(null) })
    input.click()
  })
}

/** 浏览器导入配置：读取 JSON 文件 → importConfig({ config }) */
async function importConfigBrowser() {
  const file = await pickJsonFile()
  if (!file) return { ok: false, canceled: true }
  let config
  try { config = JSON.parse(await file.text()) }
  catch { return { ok: false, error: '所选文件不是合法的 JSON' } }
  try {
    await call(ipcApiRoute.gatewayImportConfig, { config })
    return { ok: true, path: file.name }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
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
  exportSkillBundle: () => (isElectron ? call(ipcApiRoute.gatewayExportSkillBundle) : downloadAuthed('/api/skill/bundle', 'maskit-placeholders.zip')),
  skillAgentsSnippet: () => call(ipcApiRoute.gatewaySkillAgentsSnippet),
  stats: (params) => call(ipcApiRoute.gatewayStats, params),
  flagged: (params) => call(ipcApiRoute.gatewayFlagged, params),

  // ---- 语义识别（NER）模型 ----
  /** 长耗时（约 78MB），进度请轮询 status().ner.model.downloading */
  downloadNerModel: () => call(ipcApiRoute.gatewayDownloadNerModel),

  // ---- 系统页 ----
  selfCheck: () => call(ipcApiRoute.gatewaySelfCheck),
  testUpstreams: () => call(ipcApiRoute.gatewayTestUpstreams),
  checkUpdate: () => call(ipcApiRoute.gatewayCheckUpdate),
  listConfigBackups: () => call(ipcApiRoute.gatewayListConfigBackups),
  restoreConfigBackup: (params) => call(ipcApiRoute.gatewayRestoreConfigBackup, params),
  exportConfig: () => call(ipcApiRoute.gatewayExportConfig),
  /** @param {object} config 配置对象 */
  importConfig: (config) => call(ipcApiRoute.gatewayImportConfig, { config }),
  /** 诊断包：Electron 另存为对话框；浏览器下载 GET /api/diagnostics */
  exportDiagnostics: () => (isElectron ? call(ipcApiRoute.gatewayExportDiagnostics) : downloadAuthed('/api/diagnostics', 'maskit-diagnostics.json')),
  /** 配置文件导出（仅 Electron 原生；浏览器下载 JSON） */
  exportConfigFile: () => (isElectron ? call(ipcApiRoute.gatewayExportConfigFile) : exportConfigBrowser()),
  /** 配置文件导入（仅 Electron 原生；浏览器读取 JSON 后导入） */
  importConfigFile: () => (isElectron ? call(ipcApiRoute.gatewayImportConfigFile) : importConfigBrowser()),
  /** 开机自启状态（仅 Electron） */
  autostartStatus: () => call(ipcApiRoute.gatewayAutostartStatus),
}

// ---------- 实时事件 ----------
const handlers = new Set()
const updateHandlers = new Set()
let source = null

function closeEvents() {
  if (source) source.close()
  source = null
}

function hasSubscribers() {
  return handlers.size > 0 || updateHandlers.size > 0
}

function openEvents() {
  if (source || !auth.token || !hasSubscribers()) return
  // EventSource 无法设置请求头，令牌走查询串（仅同源 SSE；服务端日志不记录查询串）
  source = new EventSource(`/api/events/stream?token=${encodeURIComponent(auth.token)}`)
  source.addEventListener('maskit/event', (m) => {
    let ev
    try { ev = JSON.parse(m.data) } catch { return }
    handlers.forEach((h) => h(ev))
  })
  source.addEventListener(pushEvents.updateAvailable, (m) => {
    let info
    try { info = JSON.parse(m.data) } catch { return }
    updateHandlers.forEach((h) => h(info))
  })
  // 浏览器会自动重连；令牌失效时重连会一直 401，这里主动探测一次
  source.onerror = () => {
    if (source && source.readyState === EventSource.CLOSED) {
      closeEvents()
      gw.status().then(() => setTimeout(openEvents, 2000)).catch(() => {})
    }
  }
}

function reconnectEvents() {
  closeEvents()
  openEvents()
}

/** 订阅推送事件，返回取消函数 */
export function onGatewayEvent(handler) {
  if (isElectron) {
    const listener = (_e, ev) => handler(ev)
    ipc.on(pushEvents.gatewayEvent, listener)
    return () => ipc.removeListener(pushEvents.gatewayEvent, listener)
  }
  handlers.add(handler)
  openEvents()
  return () => {
    handlers.delete(handler)
    if (!hasSubscribers()) closeEvents()
  }
}

/** 订阅新版本推送（payload 为 checkUpdate 结果），返回取消函数 */
export function onUpdateAvailable(handler) {
  if (isElectron) {
    const listener = (_e, info) => handler(info)
    ipc.on(pushEvents.updateAvailable, listener)
    return () => ipc.removeListener(pushEvents.updateAvailable, listener)
  }
  updateHandlers.add(handler)
  openEvents()
  return () => {
    updateHandlers.delete(handler)
    if (!hasSubscribers()) closeEvents()
  }
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
  IP_PUBLIC: '公网 IPv4（排除私网、保留段、文档示例段与知名公共 DNS）',
  IPV6_PRIVATE: 'IPv6 私网（fe80::/10 链路本地、fc00::/7 ULA）',
  CARD: '银行卡（Luhn 校验）',
  IBAN: 'IBAN（mod-97 校验）',
  USCC: '统一社会信用代码（18 位，校验位校验）',
  MAC: 'MAC 地址（易误伤）',
  API_KEY: 'GitHub / Google / Slack / Stripe 等 API Key',
  ACCESS_KEY: '云厂商 Access Key（AWS / 阿里云 / 腾讯云）',
  JWT: 'JWT 令牌',
  TOKEN: 'Bearer Token',
  SECRET: 'password= / token= / 密码： 等赋值凭据',
}
