<template>
  <div class="page">
    <h1 class="page-title">概览</h1>

    <div class="card">
      <div class="row wrap">
        <div class="grow">
          <div class="card-title" style="margin:0">网关状态</div>
          <div class="sub" style="margin-top:4px">
            监听端口：<span class="mono">{{ status.listening.length ? status.listening.join(', ') : '无' }}</span>
            <span style="margin-left:16px">映射表条目：<b>{{ status.mappings }}</b></span>
            <span style="margin-left:16px">出网：<span class="mono">{{ status.egressProxy || '直连' }}</span></span>
          </div>
        </div>
        <span class="sub">脱敏开关</span>
        <div class="switch" :class="{ on: status.maskEnabled }" @click="toggleMask"></div>
        <button class="btn" :disabled="busy" @click="doRestart">重启网关</button>
        <button class="btn danger" :disabled="busy" @click="doClear">清空映射表</button>
      </div>
      <div v-if="status.lastError" class="badge bad" style="margin-top:10px;white-space:pre-wrap">{{ status.lastError }}</div>
    </div>

    <div class="card">
      <div class="card-title">上游入口</div>
      <div class="sub" style="margin-bottom:10px">
        将客户端的 Base URL 改为下方本地地址即可。OpenAI / DeepSeek 兼容接口需追加 <span class="mono">/v1</span> 后缀，Anthropic 无需后缀。
      </div>
      <div v-if="!status.upstreams.length" class="sub">暂无上游</div>
      <div v-for="u in status.upstreams" :key="u.name + u.port" class="up">
        <div class="row">
          <b>{{ u.name }}</b>
          <span class="sub grow mono">→ {{ u.target }}</span>
        </div>
        <div class="row" style="margin-top:6px">
          <code class="url grow">{{ baseUrl(u) }}</code>
          <button class="btn sm" @click="copy(baseUrl(u))">复制</button>
        </div>
        <div class="sub" style="margin-top:4px">{{ hint(u) }}</div>
      </div>
    </div>
  </div>
</template>
<script setup>
import { reactive, ref, onMounted, onBeforeUnmount } from 'vue';
import { gw } from '@/utils/gateway';
import { toast } from '@/utils/toast';

const status = reactive({ maskEnabled: true, listening: [], upstreams: [], mappings: 0, lastError: '' });
const busy = ref(false);
let timer = null;

const apply = (s) => { if (s) Object.assign(status, s); };
const baseUrl = (u) => `http://127.0.0.1:${u.port}`;
const hint = (u) => /anthropic/i.test(u.name + u.target)
  ? 'Anthropic：Base URL 无需后缀'
  : `OpenAI / DeepSeek 兼容：Base URL 使用 ${baseUrl(u)}/v1`;

async function refresh(silent = true) {
  try { apply(await gw.status()); }
  catch (e) { if (!silent) toast(e.message, false); }
}
async function guarded(fn, okMsg) {
  busy.value = true;
  try { apply(await fn()); if (okMsg) toast(okMsg); }
  catch (e) { toast(e?.message || String(e), false); }
  finally { busy.value = false; }
}
async function toggleMask() {
  try {
    const cfg = await gw.getConfig();
    cfg.maskEnabled = !cfg.maskEnabled;
    apply(await gw.setConfig(cfg));
    toast(cfg.maskEnabled ? '已开启脱敏' : '已关闭脱敏');
  } catch (e) { toast(e?.message || String(e), false); }
}
const doRestart = () => guarded(gw.restart, '网关已重启');
const doClear = () => {
  if (!window.confirm('确定清空映射表？清空后历史占位符将无法还原。')) return;
  guarded(gw.clearMappings, '映射表已清空');
};
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制：' + text); }
  catch { toast('复制失败', false); }
}

onMounted(() => { refresh(false); timer = setInterval(refresh, 3000); });
onBeforeUnmount(() => clearInterval(timer));
</script>
<style lang="less" scoped>
.up { padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; background: #fafbfd; }
.url { font-family: var(--mono); background: var(--primary-soft); color: var(--primary); padding: 4px 8px; border-radius: 6px; }
</style>
