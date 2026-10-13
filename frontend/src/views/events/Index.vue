<template>
  <div class="page">
    <div class="row" style="margin-bottom:16px">
      <h1 class="page-title grow" style="margin:0">日志</h1>
      <span class="sub">已加载 {{ events.length }} 条<template v-if="total !== null"> / 共 {{ total }} 条</template>（实时更新）</span>
      <button class="btn" @click="load">刷新</button>
      <button class="btn danger" @click="doClear">清空日志</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <table class="table">
        <thead><tr>
          <th>时间</th><th>上游</th><th>请求</th><th>状态</th><th>耗时</th><th>流式</th><th>脱敏数</th><th>还原</th><th>错误</th>
        </tr></thead>
        <tbody>
          <tr v-if="!events.length"><td colspan="9" class="sub" style="text-align:center;padding:24px">暂无事件</td></tr>
          <template v-for="ev in events" :key="ev.id">
            <tr class="clickable" @click="toggle(ev.id)">
              <td class="mono">{{ fmtTime(ev.time) }}</td>
              <td>{{ ev.upstream }}</td>
              <td class="mono">{{ ev.method }} {{ ev.path }}</td>
              <td><span class="badge" :class="ev.status >= 400 || !ev.status ? 'bad' : 'ok'">{{ ev.status || '-' }}</span></td>
              <td>{{ ev.durationMs }} ms</td>
              <td>{{ ev.stream ? '是' : '否' }}</td>
              <td>{{ ev.hits?.length || 0 }}</td>
              <td>
                <span v-if="ev.unresolved" class="badge warn">未还原 {{ ev.unresolved }}</span>
                <span v-else-if="ev.restored" class="badge ok">已还原 {{ ev.restored }}</span>
                <span v-else class="sub">-</span>
              </td>
              <td style="color:var(--danger);max-width:160px;word-break:break-all">
                {{ ev.error || '' }}
                <span v-if="ev.findings?.length" class="badge warn" style="margin-left:8px">⚠ 风险 {{ ev.findings.length }}</span>
                <span v-if="ev.commands?.length" class="badge bad" style="margin-left:4px">⛔ 命令 {{ ev.commands.length }}</span>
              </td>
            </tr>
            <tr v-if="open === ev.id" class="detail">
              <td colspan="9">
                <div v-if="ev.model" class="sub" style="margin-bottom:6px">模型：<span class="mono">{{ ev.model }}</span></div>
                <div v-if="ev.usage" class="sub" style="margin-bottom:6px">
                  Tokens：<span class="mono">{{ ev.usage.input }} 输入 · {{ ev.usage.output }} 输出 · {{ ev.usage.cacheRead }} 缓存读 · {{ ev.usage.cacheWrite }} 缓存写</span>
                  <span v-if="ev.cost" style="margin-left:12px">费用：<span class="mono" style="color:var(--warn)">${{ ev.cost.toFixed(4) }}</span></span>
                </div>
                <div v-if="ev.signedBlocksSkipped" class="sub" style="margin-bottom:6px">跳过签名块：{{ ev.signedBlocksSkipped }}</div>
                <div v-if="!ev.hits?.length" class="sub">本次请求无命中</div>
                <div v-else class="row wrap">
                  <span v-for="(h, i) in ev.hits" :key="i" class="hit"><span class="badge">{{ h.label }}</span> <span class="mono">{{ h.token }}</span></span>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <div v-if="events.length" class="row" style="justify-content:center;margin-top:12px">
      <button v-if="hasMore" class="btn" :disabled="loadingMore" @click="loadMore">{{ loadingMore ? '加载中...' : '加载更早' }}</button>
      <span v-else class="sub">没有更早的记录</span>
    </div>
  </div>
</template>
<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { gw, onGatewayEvent } from '@/utils/gateway';
import { toast } from '@/utils/toast';

const PAGE = 200;
const CAP = 5000;
const events = ref([]);
const total = ref(null);
const hasMore = ref(true);
const loadingMore = ref(false);
const open = ref(null);
let off = () => {};

const toggle = (id) => { open.value = open.value === id ? null : id; };
const pad = (n) => String(n).padStart(2, '0');
function fmtTime(t) {
  const d = new Date(t);
  if (isNaN(d)) return String(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
async function loadTotal() {
  try { const s = await gw.status(); total.value = s?.storage ? s.storage.events : null; }
  catch { total.value = null; }
}
async function load() {
  try {
    const list = (await gw.events({ limit: PAGE })) || [];
    events.value = list.slice(0, CAP);
    hasMore.value = list.length >= PAGE;
    loadTotal();
  } catch (e) { toast(e?.message || String(e), false); }
}
async function loadMore() {
  const last = events.value[events.value.length - 1];
  if (!last || loadingMore.value) return;
  loadingMore.value = true;
  try {
    // 游标 (time, seq)：同一毫秒的事件跨页也不会漏；去重兜底实时推送与分页的重叠
    const list = (await gw.events({ before: last.time, beforeSeq: last.seq, limit: PAGE })) || [];
    const seen = new Set(events.value.map((x) => x.id));
    const fresh = list.filter((x) => !seen.has(x.id));
    events.value = events.value.concat(fresh).slice(0, CAP);
    // 一页全是重复（同一毫秒事件超过一页）时停止，避免无限「加载更早」
    hasMore.value = fresh.length > 0 && list.length >= PAGE && events.value.length < CAP;
  } catch (e) { toast(e?.message || String(e), false); }
  finally { loadingMore.value = false; }
}
async function doClear() {
  if (!window.confirm('确定清空全部日志？此操作不可恢复。')) return;
  try { await gw.clearEvents(); toast('日志已清空'); await load(); }
  catch (e) { toast(e?.message || String(e), false); }
}

onMounted(async () => {
  off = onGatewayEvent((ev) => {
    const list = events.value.filter((x) => x.id !== ev.id);
    list.unshift(ev);
    events.value = list.slice(0, CAP);
    if (total.value !== null) total.value += 1;
  });
  await load();
});
onBeforeUnmount(() => off());
</script>
<style lang="less" scoped>
.clickable { cursor: pointer; &:hover { background: #f7f9fc; } }
.detail td { background: #fafbfd; }
.hit { margin-right: 12px; }
</style>
