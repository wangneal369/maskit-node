<template>
  <div class="page">
    <h1 class="page-title">系统</h1>

    <div class="card">
      <div class="row" style="margin-bottom:12px">
        <div class="card-title grow" style="margin:0">运行自检</div>
        <button class="btn" :disabled="busy.check" @click="runSelfCheck">{{ busy.check ? '检查中…' : '运行自检' }}</button>
      </div>
      <div v-if="checkItems === null" class="sub">检查引擎各组件的运行状态。</div>
      <div v-else-if="!checkItems.length" class="sub">没有返回自检项</div>
      <div v-else>
        <div v-for="it in checkItems" :key="it.key" class="check-item">
          <span class="badge" :class="it.ok ? 'ok' : 'bad'">{{ it.ok ? '✓' : '✗' }}</span>
          <b class="check-name">{{ it.name }}</b>
          <span class="sub mono grow check-detail">{{ it.detail }}</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:12px">
        <div class="card-title grow" style="margin:0">上游连通性</div>
        <button class="btn" :disabled="busy.upstream" @click="runTestUpstreams">{{ busy.upstream ? '测试中…' : '测试连通性' }}</button>
      </div>
      <div v-if="upstreams === null" class="sub">逐个探测已配置的上游地址。</div>
      <table v-else class="table">
        <thead><tr>
          <th>名称</th><th>地址</th><th>结果</th><th>状态码</th><th>耗时 (ms)</th><th>错误</th>
        </tr></thead>
        <tbody>
          <tr v-if="!upstreams.length"><td colspan="6" class="sub" style="text-align:center;padding:20px">没有配置上游</td></tr>
          <tr v-for="(r, i) in upstreams" :key="i">
            <td>{{ r.name }}</td>
            <td class="mono url-cell">{{ r.target }}</td>
            <td><span class="badge" :class="r.ok ? 'ok' : 'bad'">{{ r.ok ? '可达' : '失败' }}</span></td>
            <td class="mono">{{ r.status != null ? r.status : '-' }}</td>
            <td class="mono">{{ r.latencyMs != null ? r.latencyMs : '-' }}</td>
            <td class="err-cell">{{ r.error || '' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-title">诊断包</div>
      <div class="sub" style="margin-bottom:12px;line-height:1.7">包含版本、运行状态、脱敏后的配置（不含访问令牌与自定义敏感词原文）和最近 50 条日志，可用于反馈问题</div>
      <button class="btn primary" :disabled="busy.diag" @click="doDiagnostics">{{ busy.diag ? '导出中…' : '导出诊断包' }}</button>
    </div>

    <div class="card">
      <div class="card-title">更新</div>
      <div class="row wrap" style="margin-bottom:10px">
        <span>当前版本：<span class="mono">{{ version || (upd && upd.current) || '未知' }}</span></span>
        <button class="btn sm" :disabled="busy.update" @click="doCheckUpdate">{{ busy.update ? '检查中…' : '检查更新' }}</button>
      </div>
      <div v-if="upd">
        <div v-if="upd.error" class="err-line">检查失败：{{ upd.error }}</div>
        <div v-else-if="upd.hasUpdate" class="update-box row wrap">
          <span>发现新版本 <b class="mono">{{ tag(upd.latest) }}</b></span>
          <button class="btn sm primary" @click="openUrl(upd.url)">前往下载</button>
        </div>
        <div v-else class="sub">已是最新版本<template v-if="upd.latest">（最新 <span class="mono">{{ tag(upd.latest) }}</span>）</template></div>
      </div>
      <div class="row toggle-row" style="margin-top:14px">
        <div class="switch" :class="{ on: appCfg.checkUpdates }" @click="toggleApp('checkUpdates')"></div>
        <div class="grow">
          <b>启动时自动检查更新</b>
          <div class="sub" style="margin-top:4px">会访问 api.github.com</div>
        </div>
      </div>
    </div>

    <div v-if="isElectron" class="card">
      <div class="card-title">开机自启</div>
      <div class="row toggle-row">
        <div class="switch" :class="{ on: appCfg.autostart, disabled: autostartDisabled }" @click="toggleApp('autostart')"></div>
        <div class="grow">
          <b>开机时自动启动</b>
          <div class="sub" style="margin-top:4px">{{ autostartHint }}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:12px">
        <div class="card-title grow" style="margin:0">配置备份</div>
        <button class="btn sm" :disabled="busy.backup" @click="loadBackups">刷新</button>
        <button class="btn sm" :disabled="busy.exportCfg" @click="doExportConfig">{{ busy.exportCfg ? '导出中…' : '导出配置' }}</button>
        <button class="btn sm" :disabled="busy.importCfg" @click="doImportConfig">{{ busy.importCfg ? '导入中…' : '导入配置' }}</button>
      </div>
      <div class="warn-text">导出的配置文件包含访问令牌，请勿分享给他人或上传到公开位置。导入会覆盖当前全部配置。</div>
      <table class="table" style="margin-top:12px">
        <thead><tr><th>备份时间</th><th>大小</th><th style="width:90px"></th></tr></thead>
        <tbody>
          <tr v-if="!backups.length"><td colspan="3" class="sub" style="text-align:center;padding:20px">暂无备份</td></tr>
          <tr v-for="b in backups" :key="b.name">
            <td class="mono">{{ fmtTime(b.time) }}</td>
            <td class="mono">{{ fmtSize(b.size) }}</td>
            <td><button class="btn sm" :disabled="busy.backup" @click="restoreBackup(b)">恢复</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { gw } from '@/utils/gateway';
import { toast } from '@/utils/toast';
import { isElectron } from '@/utils/ipcRenderer';

const busy = reactive({
  check: false, upstream: false, diag: false, update: false,
  backup: false, exportCfg: false, importCfg: false,
});
const checkItems = ref(null);
const upstreams = ref(null);
const upd = ref(null);
const backups = ref([]);
const appCfg = ref({ autostart: false, checkUpdates: false });
const autostart = ref(null);

const errMsg = (e) => e?.message || String(e);
const pad = (n) => String(n).padStart(2, '0');
const tag = (v) => (v ? `v${String(v).replace(/^v/i, '')}` : '');

function fmtTime(t) {
  const d = new Date(t);
  if (isNaN(d)) return String(t ?? '-');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '-';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

const autostartDisabled = computed(() => !autostart.value || !autostart.value.supported);
const autostartHint = computed(() => {
  const a = autostart.value;
  if (!a) return '正在读取状态…';
  if (!a.supported) return a.reason || '当前环境不支持开机自启';
  return a.enabled ? '系统已登记开机自启' : '系统未登记开机自启';
});

/** 只允许 http(s) 链接，避免服务端返回的地址被注入 javascript: 等协议 */
function openUrl(u) {
  if (!/^https?:\/\//i.test(String(u || ''))) return toast('下载地址无效', false);
  window.open(u, '_blank', 'noopener');
}

async function runSelfCheck() {
  busy.check = true;
  try {
    const r = await gw.selfCheck();
    checkItems.value = r?.items || [];
  } catch (e) { toast('自检失败：' + errMsg(e), false); }
  finally { busy.check = false; }
}

async function runTestUpstreams() {
  busy.upstream = true;
  try {
    const r = await gw.testUpstreams();
    upstreams.value = r?.results || [];
  } catch (e) { toast('连通性测试失败：' + errMsg(e), false); }
  finally { busy.upstream = false; }
}

async function doDiagnostics() {
  busy.diag = true;
  try {
    const r = await gw.exportDiagnostics();
    if (r?.canceled) toast('已取消导出');
    else if (r?.ok) toast('诊断包已导出：' + (r.path || ''));
    else toast('导出失败：' + (r?.error || '未知错误'), false);
  } catch (e) { toast('导出失败：' + errMsg(e), false); }
  finally { busy.diag = false; }
}

async function doCheckUpdate() {
  busy.update = true;
  try {
    upd.value = await gw.checkUpdate();
  } catch (e) {
    upd.value = { current: upd.value?.current, hasUpdate: false, error: errMsg(e) };
  } finally { busy.update = false; }
}

async function loadAppSettings() {
  try {
    const c = await gw.getConfig();
    appCfg.value = { autostart: false, checkUpdates: false, ...(c.app || {}) };
  } catch (e) { toast('读取配置失败：' + errMsg(e), false); }
}

async function loadAutostart() {
  if (!isElectron) return;
  try { autostart.value = await gw.autostartStatus(); }
  catch (e) { autostart.value = { supported: false, enabled: false, reason: '读取失败：' + errMsg(e) }; }
}

/** 开关保存：getConfig → 修改 app 字段 → setConfig */
async function toggleApp(key) {
  if (key === 'autostart' && autostartDisabled.value) return;
  const next = !appCfg.value[key];
  try {
    const cfg = await gw.getConfig();
    cfg.app = { autostart: false, checkUpdates: false, ...(cfg.app || {}), [key]: next };
    await gw.setConfig(cfg);
    appCfg.value = { ...appCfg.value, [key]: next };
    toast('设置已保存');
    if (key === 'autostart') await loadAutostart();
  } catch (e) { toast('保存失败：' + errMsg(e), false); }
}

async function loadBackups() {
  busy.backup = true;
  try {
    const r = await gw.listConfigBackups();
    backups.value = r?.backups || [];
  } catch (e) { toast('读取备份失败：' + errMsg(e), false); }
  finally { busy.backup = false; }
}

async function refreshAfterConfigChange() {
  await Promise.all([loadBackups(), loadAppSettings(), loadAutostart()]);
}

async function restoreBackup(b) {
  if (!window.confirm(`确定恢复到 ${fmtTime(b.time)} 的备份？\n当前配置将被该备份覆盖。`)) return;
  busy.backup = true;
  try {
    await gw.restoreConfigBackup({ name: b.name });
    toast('已恢复配置');
    await refreshAfterConfigChange();
  } catch (e) { toast('恢复失败：' + errMsg(e), false); }
  finally { busy.backup = false; }
}

async function doExportConfig() {
  if (!window.confirm('导出的配置文件包含访问令牌，请勿分享给他人。\n确定继续导出？')) return;
  busy.exportCfg = true;
  try {
    const r = await gw.exportConfigFile();
    if (r?.canceled) toast('已取消导出');
    else if (r?.ok) toast('配置已导出：' + (r.path || ''));
    else toast('导出失败：' + (r?.error || '未知错误'), false);
  } catch (e) { toast('导出失败：' + errMsg(e), false); }
  finally { busy.exportCfg = false; }
}

async function doImportConfig() {
  if (!window.confirm('导入会覆盖当前全部配置（包括访问令牌）。\n确定继续？')) return;
  busy.importCfg = true;
  try {
    const r = await gw.importConfigFile();
    if (r?.canceled) toast('已取消导入');
    else if (r?.ok) {
      toast('配置已导入');
      await refreshAfterConfigChange();
    } else toast('导入失败：' + (r?.error || '未知错误'), false);
  } catch (e) { toast('导入失败：' + errMsg(e), false); }
  finally { busy.importCfg = false; }
}

const version = ref('');

onMounted(() => {
  loadAppSettings();
  loadAutostart();
  loadBackups();
  gw.status().then((s) => { version.value = s?.version || ''; }).catch(() => {});
});
</script>
<style lang="less" scoped>
.check-item {
  display: flex; align-items: center; gap: 10px; padding: 8px 0;
  border-bottom: 1px solid var(--border);
  &:last-child { border-bottom: none; }
}
.check-name { flex: none; min-width: 140px; }
.check-detail { word-break: break-all; }
.url-cell { word-break: break-all; max-width: 320px; }
.err-cell { color: var(--danger); word-break: break-all; max-width: 240px; }
.err-line { color: var(--danger); font-size: 13px; }
.warn-text {
  background: var(--warn-soft); color: var(--warn);
  padding: 8px 12px; border-radius: 8px; font-size: 13px; line-height: 1.6;
}
.update-box {
  background: var(--ok-soft); color: var(--ok);
  padding: 8px 12px; border-radius: 8px; font-size: 13px;
}
.toggle-row { align-items: flex-start; }
.switch.disabled { opacity: .5; cursor: not-allowed; }
</style>
