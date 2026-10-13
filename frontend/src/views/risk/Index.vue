<template>
  <div class="page">
    <div class="row" style="margin-bottom:16px">
      <h1 class="page-title grow" style="margin:0">风险</h1>
      <button class="btn" @click="load">刷新</button>
    </div>

    <div v-if="loading && !events.length" class="card" style="text-align:center;padding:40px"><span class="sub">加载中...</span></div>
    <div v-else class="card" style="padding:0;overflow:hidden">
      <table class="table">
        <thead><tr>
          <th>时间</th><th>上游</th><th>请求</th><th>严重性</th><th>发现</th>
        </tr></thead>
        <tbody>
          <tr v-if="!events.length"><td colspan="5" class="sub" style="text-align:center;padding:24px">暂无风险事件</td></tr>
          <template v-for="ev in events" :key="ev.id">
            <tr class="clickable" @click="toggle(ev.id)">
              <td class="mono">{{ fmtTime(ev.time) }}</td>
              <td>{{ ev.upstream }}</td>
              <td class="mono">{{ ev.method }} {{ ev.path }}</td>
              <td><span class="badge" :class="severityClass(ev)">{{ severityLabel(ev) }}</span></td>
              <td>
                <span v-if="ev.findings?.length" class="sub">⚠ 风险 {{ ev.findings.length }}</span>
                <span v-if="ev.commands?.length" class="sub" style="margin-left:8px">⛔ 命令 {{ ev.commands.length }}</span>
              </td>
            </tr>
            <tr v-if="open === ev.id" class="detail">
              <td colspan="5">
                <!-- Findings -->
                <div v-if="ev.findings?.length" style="margin-bottom:12px">
                  <div class="sub" style="margin-bottom:6px;font-weight:600">发现的风险：</div>
                  <div v-for="(f, i) in ev.findings" :key="i" style="margin-bottom:8px;padding:8px;background:#fafbfd;border-radius:6px">
                    <div class="row" style="gap:8px;margin-bottom:4px">
                      <span class="badge" :class="f.severity.toLowerCase()">{{ severityLabelMap[f.severity] || f.severity }}</span>
                      <b>{{ f.title }}</b>
                    </div>
                    <div class="mono sub" style="white-space:pre-wrap;word-break:break-all">{{ f.evidence }}</div>
                  </div>
                </div>

                <!-- Commands -->
                <div v-if="ev.commands?.length">
                  <div class="sub" style="margin-bottom:6px;font-weight:600">检查到的命令：</div>
                  <div v-for="(c, i) in ev.commands" :key="i" style="margin-bottom:8px;padding:8px;background:#fafbfd;border-radius:6px">
                    <div class="row" style="gap:8px;margin-bottom:4px">
                      <span class="badge bad">{{ commandLabel(c.action) }}</span>
                      <b>{{ c.label }}</b>
                    </div>
                    <div class="mono sub" style="white-space:pre-wrap;word-break:break-all">{{ c.snippet }}</div>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div v-if="events.length && hasMore" class="row" style="justify-content:center;margin-top:12px">
      <button class="btn" :disabled="loadingMore" @click="loadMore">{{ loadingMore ? '加载中...' : '加载更早' }}</button>
    </div>
  </div>
</template>
<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { gw, onGatewayEvent } from '@/utils/gateway';
import { toast } from '@/utils/toast';

const PAGE = 50;
const CAP = 500;
const events = ref([]);
const hasMore = ref(true);
const loadingMore = ref(false);
const loading = ref(false);
const open = ref(null);
let offPush = () => {};

const severityLabelMap = { LOW: '低', MEDIUM: '中', HIGH: '高', CRITICAL: '严重' };

const toggle = (id) => { open.value = open.value === id ? null : id; };

const pad = (n) => String(n).padStart(2, '0');
function fmtTime(t) {
  const d = new Date(t);
  if (isNaN(d)) return String(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function highestSeverity(ev) {
  const sev = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  let max = 0;
  if (ev.findings?.length) {
    max = Math.max(max, ...ev.findings.map(f => sev[f.severity] || 0));
  }
  if (ev.commands?.length) {
    max = Math.max(max, 3); // commands count as HIGH
  }
  return max;
}

function severityLabel(ev) {
  const s = highestSeverity(ev);
  return severityLabelMap[['', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'][s]] || '-';
}

function severityClass(ev) {
  const s = highestSeverity(ev);
  return ['', 'ok', 'warn', 'bad', 'bad'][s] || '';
}

function commandLabel(action) {
  const m = { observe: '仅记录', rewrite: '已改写', block: '已阻断' };
  return m[action] || action;
}

async function load() {
  loading.value = true;
  try {
    const list = (await gw.flagged({ limit: PAGE })) || [];
    events.value = list.slice(0, CAP);
    hasMore.value = list.length >= PAGE;
  } catch (e) {
    toast(e?.message || String(e), false);
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  if (!events.value.length || loadingMore.value) return;
  const last = events.value[events.value.length - 1];
  loadingMore.value = true;
  try {
    const list = (await gw.flagged({ before: last.time, beforeSeq: last.seq, limit: PAGE })) || [];
    const seen = new Set(events.value.map((x) => x.id));
    const fresh = list.filter((x) => !seen.has(x.id));
    events.value = events.value.concat(fresh).slice(0, CAP);
    hasMore.value = fresh.length > 0 && list.length >= PAGE && events.value.length < CAP;
  } catch (e) {
    toast(e?.message || String(e), false);
  } finally {
    loadingMore.value = false;
  }
}

onMounted(() => {
  offPush = onGatewayEvent((ev) => {
    // Only prepend if this event has findings or commands
    if (!ev.findings?.length && !ev.commands?.length) return;
    const list = events.value.filter((x) => x.id !== ev.id);
    list.unshift(ev);
    events.value = list.slice(0, CAP);
  });
  load();
});

onBeforeUnmount(() => offPush());
</script>
<style lang="less" scoped>
.clickable {
  cursor: pointer;
  &:hover { background: #f7f9fc; }
}
.detail td {
  background: #fafbfd;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.sub {
  color: var(--text-sub);
  font-size: 12px;
}
</style>
