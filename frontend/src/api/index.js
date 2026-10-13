
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
  gatewayClearEvents: 'controller/gateway/clearEvents',
  gatewayClearMappings: 'controller/gateway/clearMappings',
  gatewayRotateExtToken: 'controller/gateway/rotateExtToken',
  gatewayOpenExtensionDir: 'controller/gateway/openExtensionDir',
  gatewayPlayground: 'controller/gateway/playground',
  gatewayExportSkillBundle: 'controller/gateway/exportSkillBundle',
  gatewaySkillAgentsSnippet: 'controller/gateway/skillAgentsSnippet',
  gatewayStats: 'controller/gateway/stats',
  gatewayFlagged: 'controller/gateway/flagged',
  gatewayDownloadNerModel: 'controller/gateway/downloadNerModel',
  gatewaySelfCheck: 'controller/gateway/selfCheck',
  gatewayTestUpstreams: 'controller/gateway/testUpstreams',
  gatewayCheckUpdate: 'controller/gateway/checkUpdate',
  gatewayListConfigBackups: 'controller/gateway/listConfigBackups',
  gatewayRestoreConfigBackup: 'controller/gateway/restoreConfigBackup',
  gatewayExportConfig: 'controller/gateway/exportConfig',
  gatewayImportConfig: 'controller/gateway/importConfig',
  gatewayExportDiagnostics: 'controller/gateway/exportDiagnostics',
  gatewayExportConfigFile: 'controller/gateway/exportConfigFile',
  gatewayImportConfigFile: 'controller/gateway/importConfigFile',
  gatewayAutostartStatus: 'controller/gateway/autostartStatus',
}

/** 主进程推送的事件名 */
const pushEvents = {
  gatewayEvent: 'maskit/event',
  updateAvailable: 'maskit/update',
}

export {
  ipcApiRoute,
  pushEvents
}
