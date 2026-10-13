
/**
 * 主进程与渲染进程通信频道定义
 * Definition of communication channels between main process and rendering process
 */
const ipcApiRoute = {
  gatewayStatus: 'controller/gateway/status',
  gatewayGetConfig: 'controller/gateway/getConfig',
  gatewaySetConfig: 'controller/gateway/setConfig',
  gatewayRestart: 'controller/gateway/restart',
  gatewayEvents: 'controller/gateway/events',
  gatewayClearMappings: 'controller/gateway/clearMappings',
  gatewayRotateExtToken: 'controller/gateway/rotateExtToken',
  gatewayOpenExtensionDir: 'controller/gateway/openExtensionDir',
  gatewayPlayground: 'controller/gateway/playground',
}

/** 主进程推送的事件名 */
const pushEvents = {
  gatewayEvent: 'maskit/event',
}

export {
  ipcApiRoute,
  pushEvents
}
