<template>
  <div class="page" v-if="cfg">
    <div class="row" style="margin-bottom:16px">
      <h1 class="page-title grow" style="margin:0">浏览器扩展</h1>
      <button class="btn" :disabled="saving" @click="load">重置</button>
      <button class="btn primary" :disabled="saving" @click="save">保存</button>
    </div>

    <div class="card">
      <div class="card-title">桥接服务</div>
      <div class="row" style="margin-bottom:12px">
        <div class="switch" :class="{ on: cfg.ext.enabled }" @click="cfg.ext.enabled = !cfg.ext.enabled"></div>
        <div class="grow">
          <b>启用桥接</b>
          <div class="sub">开启后在本机监听端口，供浏览器扩展调用（仅 127.0.0.1）。</div>
        </div>
      </div>
      <div class="row" style="margin-bottom:12px">
        <b style="width:60px">端口</b>
        <input class="input mono" style="width:110px" type="number" v-model.number="cfg.ext.port" placeholder="5801" />
        <span class="sub">默认 5801，与扩展默认值一致。</span>
      </div>
      <div class="row" style="margin-bottom:12px">
        <div class="switch" :class="{ on: cfg.ext.blockWhenEngineDown }" @click="cfg.ext.blockWhenEngineDown = !cfg.ext.blockWhenEngineDown"></div>
        <div class="grow">
          <b>引擎不可达时阻断</b>
          <div class="sub">引擎未运行时，扩展拦截发往 AI 站点的请求，避免明文外泄。</div>
        </div>
      </div>
      <div class="row" style="margin-bottom:12px">
        <div class="switch" :class="{ on: cfg.ext.recordEvents }" @click="cfg.ext.recordEvents = !cfg.ext.recordEvents"></div>
        <div class="grow">
          <b>记录扩展事件</b>
          <div class="sub">把扩展侧的脱敏事件写入「日志」页。</div>
        </div>
      </div>
      <div class="status" :class="statusClass">{{ statusText }}</div>
    </div>

    <div class="card">
      <div class="card-title">访问令牌</div>
      <div class="sub" style="margin-bottom:8px">扩展通过请求头 X-Shield-Token 携带此令牌访问桥接服务，请勿泄露。</div>
      <div class="row">
        <div class="token mono grow">{{ tokenText }}</div>
        <button class="btn sm" :disabled="!cfg.ext.token" @click="showToken = !showToken">{{ showToken ? '隐藏' : '显示' }}</button>
        <button class="btn sm" :disabled="!cfg.ext.token" @click="copyToken">复制</button>
        <button class="btn sm danger" :disabled="rotating" @click="rotate">轮换令牌</button>
      </div>
      <div v-if="!cfg.ext.token" class="sub" style="margin-top:6px">令牌将在启用桥接并保存后自动生成。</div>
    </div>

    <div class="card">
      <div class="card-title">安装步骤</div>
      <ol class="steps">
        <li>
          <div class="row">
            <span class="grow">点击「打开扩展目录」，找到随应用附带的扩展文件夹。</span>
            <button class="btn sm primary" @click="openDir">打开扩展目录</button>
          </div>
          <div v-if="dirPath" class="sub mono">{{ dirPath }}</div>
        </li>
        <li>在 Chrome / Edge 地址栏打开 <span class="mono">chrome://extensions</span>，开启「开发者模式」，点击「加载已解压的扩展程序」，选择上一步的目录。</li>
        <li>打开扩展的「选项」页，引擎地址填 <span class="mono">{{ engineUrl }}</span>，并粘贴上方的访问令牌。</li>
        <li>已内置授权 ChatGPT / Claude / DeepSeek；其余站点请在扩展设置中添加。</li>
      </ol>
      <div class="sub">Firefox：可在 <span class="mono">about:debugging</span> 中通过「临时载入附加组件」加载该目录下的 manifest.json（重启浏览器后需重新加载）。</div>
    </div>
  </div>
  <div class="page" v-else><div class="sub">{{ err || '加载中...' }}</div></div>
</template>
<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { gw } from '@/utils/gateway';
import { toast } from '@/utils/toast';

const cfg = ref(null);
const st = ref(null);
const err = ref('');
const saving = ref(false);
const rotating = ref(false);
const showToken = ref(false);
const dirPath = ref('');
let timer = null;

const tokenText = computed(() => {
  const t = cfg.value?.ext.token || '';
  if (!t) return '（未生成）';
  return showToken.value ? t : '•'.repeat(Math.min(t.length, 32));
});

const engineUrl = computed(() => `http://127.0.0.1:${st.value?.ext?.port || cfg.value?.ext.port || 5801}`);

const statusClass = computed(() => {
  const e = st.value?.ext;
  if (e?.error) return 'bad';
  return e?.port ? 'ok' : 'off';
});
const statusText = computed(() => {
  const e = st.value?.ext;
  if (!e) return '状态未知';
  if (e.error) return '桥接错误：' + e.error;
  if (e.port) return `桥接服务运行中，监听 127.0.0.1:${e.port}`;
  return e.enabled ? '桥接服务未运行' : '桥接服务未启用';
});

async function refreshStatus() {
  try { st.value = await gw.status(); } catch { /* 忽略 */ }
}

async function load() {
  try { cfg.value = await gw.getConfig(); err.value = ''; await refreshStatus(); }
  catch (e) { err.value = e?.message || String(e); }
}

async function save() {
  const e = cfg.value.ext;
  if (!(Number.isInteger(e.port) && e.port > 0 && e.port < 65536)) return toast('端口需为 1-65535 的整数', false);
  saving.value = true;
  try {
    await gw.setConfig(cfg.value);
    cfg.value = await gw.getConfig(); // 启用后令牌可能刚生成
    await refreshStatus();
    toast('保存成功');
  } catch (e2) { toast('保存失败：' + (e2?.message || e2), false); }
  finally { saving.value = false; }
}

async function copyToken() {
  try { await navigator.clipboard.writeText(cfg.value.ext.token); toast('已复制令牌'); }
  catch { toast('复制失败，请先显示令牌后手动复制', false); }
}

async function rotate() {
  if (!window.confirm('轮换后旧令牌立即失效。\n之后必须到浏览器扩展的「选项」页粘贴新令牌，否则扩展将无法连接。\n\n确定要轮换吗？')) return;
  rotating.value = true;
  try {
    const next = await gw.rotateExtToken();
    cfg.value.ext.token = next.ext.token;
    await refreshStatus();
    toast('令牌已轮换，请更新扩展设置');
  } catch (e) { toast('轮换失败：' + (e?.message || e), false); }
  finally { rotating.value = false; }
}

async function openDir() {
  try {
    const r = await gw.openExtensionDir();
    dirPath.value = r.path || '';
    if (!r.ok) toast('打开失败：' + (r.error || '未知错误'), false);
  } catch (e) { toast('打开失败：' + (e?.message || e), false); }
}

onMounted(() => { load(); timer = setInterval(refreshStatus, 3000); });
onBeforeUnmount(() => clearInterval(timer));
</script>
<style lang="less" scoped>
.status {
  padding: 8px 12px; border-radius: 8px; font-size: 13px;
  &.ok { background: var(--ok-soft, #e8f7ee); color: var(--ok); }
  &.off { background: var(--bg); color: var(--text-sub); }
  &.bad { background: #fdecec; color: var(--danger); }
}
.token { padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; background: #fafbfd; word-break: break-all; }
.steps { margin: 0 0 12px; padding-left: 20px; li { margin-bottom: 10px; line-height: 1.7; } }
</style>
