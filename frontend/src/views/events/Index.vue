<template>
  <div class="page">
    <div class="row" style="margin-bottom:16px">
      <h1 class="page-title grow" style="margin:0">日志</h1>
      <span class="sub">最近 {{ events.length }} 条（上限 200，实时更新）</span>
      <button class="btn" @click="load">刷新</button>
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
              <td style="color:var(--danger);max-width:160px;word-break:break-all">{{ ev.error || '' }}</td>
            </tr>
            <tr v-if="open === ev.id" class="detail">
              <td colspan="9">
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
  </div>
</template>
<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { gw, onGatewayEvent } from '@/utils/gateway';
import { toast } from '@/utils/toast';

const CAP = 200;
const events = ref([]);
const open = ref(null);
let off = () => {};

const toggle = (id) => { open.value = open.value === id ? null : id; };
const pad = (n) => String(n).padStart(2, '0');
function fmtTime(t) {
  const d = new Date(t);
  if (isNaN(d)) return String(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
async function load() {
  try { events.value = ((await gw.events()) || []).slice(0, CAP); }
  catch (e) { toast(e?.message || String(e), false); }
}

onMounted(async () => {
  off = onGatewayEvent((ev) => {
    const list = events.value.filter((x) => x.id !== ev.id);
    list.unshift(ev);
    events.value = list.slice(0, CAP);
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
