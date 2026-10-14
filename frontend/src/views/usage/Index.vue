<template>
  <div class="page">
    <div class="row" style="margin-bottom:16px">
      <h1 class="page-title grow" style="margin:0">用量</h1>
      <div class="row" style="gap:6px;align-items:center">
        <span class="sub">查询时间范围</span>
        <button v-for="d in [7, 30, 90]" :key="d" class="btn" :class="{ primary: days === d }" @click="days = d">{{ d }}天</button>
      </div>
    </div>

    <div v-if="loading" class="card" style="text-align:center;padding:40px"><span class="sub">加载中...</span></div>
    <template v-else-if="err">
      <div class="card" style="text-align:center;padding:40px"><span class="badge bad">{{ err }}</span></div>
    </template>
    <template v-else-if="data">
      <!-- 摘要卡片 -->
      <div class="row wrap" style="gap:10px;margin-bottom:14px">
        <div class="card summary">
          <div class="sub">请求数</div>
          <div class="num">{{ fmt(data.requests) }}</div>
        </div>
        <div class="card summary">
          <div class="sub" title="不含缓存命中部分（命中的计入「缓存读」）">输入 tokens（未命中缓存）</div>
          <div class="num">{{ fmt(data.input) }}</div>
        </div>
        <div class="card summary">
          <div class="sub" title="含推理 / 思考 token">输出 tokens</div>
          <div class="num">{{ fmt(data.output) }}</div>
        </div>
        <div class="card summary">
          <div class="sub">缓存读 tokens</div>
          <div class="num">{{ fmt(data.cacheRead) }}</div>
        </div>
        <div class="card summary">
          <div class="sub">缓存写 tokens</div>
          <div class="num">{{ fmt(data.cacheWrite) }}</div>
        </div>
        <div class="card summary">
          <div class="sub">估算费用</div>
          <div class="num" style="color:var(--warn)">${{ fmt(data.cost, 2) }}</div>
        </div>
      </div>

      <!-- 日用量图表 -->
      <div class="card">
        <div class="card-title">日用量趋势</div>
        <div class="chart">
          <div class="y-axis">
            <div>{{ fmt(maxTokens) }}</div>
            <div>{{ fmt(maxTokens * 0.75) }}</div>
            <div>{{ fmt(maxTokens * 0.5) }}</div>
            <div>{{ fmt(maxTokens * 0.25) }}</div>
            <div>0</div>
          </div>
          <div class="bars">
            <div v-for="(d, i) in dailyData" :key="d.date" class="bar-wrap" :title="d.date + ': ' + fmt(d.tokens) + ' tokens / $' + d.cost.toFixed(2)">
              <div class="bar-area">
                <div class="bar" :style="{ height: (d.tokens / maxTokens * 100) + '%' }"></div>
              </div>
              <!-- 天数多时隔几天标一次，避免日期挤在一起 -->
              <div class="date">{{ i % labelStep === 0 || i === dailyData.length - 1 ? d.date.slice(5) : '' }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 按模型统计表格 -->
      <div class="card" style="padding:0;overflow:hidden">
        <div style="padding:16px 18px;border-bottom:1px solid var(--border)">
          <div class="card-title" style="margin:0">按模型统计</div>
        </div>
        <table class="table" style="margin:0">
          <thead><tr>
            <th>模型</th><th style="text-align:right">请求</th><th style="text-align:right">输入</th><th style="text-align:right">输出</th><th style="text-align:right">费用</th>
          </tr></thead>
          <tbody>
            <tr v-if="!data.byModel.length"><td colspan="5" class="sub" style="text-align:center;padding:24px">暂无数据</td></tr>
            <tr v-for="m in data.byModel" :key="m.model">
              <td class="mono"><b>{{ m.model }}</b><span v-if="m.unpriced > 0" class="badge warn" style="margin-left:8px">部分无价格</span></td>
              <td style="text-align:right">{{ fmt(m.requests) }}</td>
              <td style="text-align:right">{{ fmt(m.input) }}</td>
              <td style="text-align:right">{{ fmt(m.output) }}</td>
              <td style="text-align:right;color:var(--warn)">
                <template v-if="m.unpriced > 0">${{ fmt(m.cost, 2) }} <router-link :to="{ path: '/rules', query: { focus: 'prices' } }" style="color:inherit">配置价格</router-link></template>
                <template v-else>${{ fmt(m.cost, 2) }}</template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="sub" style="margin-top:12px;text-align:center">按参考价估算，实际以服务商账单为准</div>
    </template>
  </div>
</template>
<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { gw } from '@/utils/gateway';
import { toast } from '@/utils/toast';

const days = ref(7);
const loading = ref(false);
const err = ref('');
const stats = ref(null);

const data = computed(() => {
  if (!stats.value) return null;
  const daily = stats.value.daily || [];
  const byModel = stats.value.byModel || [];

  // 合并统计
  const requests = daily.reduce((s, d) => s + d.requests, 0);
  const input = daily.reduce((s, d) => s + d.input, 0);
  const output = daily.reduce((s, d) => s + d.output, 0);
  const cacheRead = daily.reduce((s, d) => s + d.cacheRead, 0);
  const cacheWrite = daily.reduce((s, d) => s + d.cacheWrite, 0);
  const cost = daily.reduce((s, d) => s + d.cost, 0);

  return { requests, input, output, cacheRead, cacheWrite, cost, daily, byModel };
});

// 按所选天数补齐每一天（没有请求的日子记 0），柱子才能反映真实的时间分布
const pad = (n) => String(n).padStart(2, '0');
const dailyData = computed(() => {
  if (!data.value) return [];
  const byDate = new Map(data.value.daily.map((d) => [d.date, d]));
  const out = [];
  for (let i = days.value - 1; i >= 0; i--) {
    const t = new Date();
    t.setDate(t.getDate() - i);
    const date = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
    const d = byDate.get(date);
    out.push({
      date,
      tokens: d ? d.input + d.output + d.cacheRead + d.cacheWrite : 0,
      cost: d ? d.cost : 0,
    });
  }
  return out;
});

const labelStep = computed(() => Math.max(1, Math.ceil(dailyData.value.length / 10)));

const maxTokens = computed(() => {
  if (!dailyData.value.length) return 1;
  const m = Math.max(...dailyData.value.map(d => d.tokens));
  return m || 1;
});

// 格式化数字：千位分隔或 K/M
function fmt(n, decimals = 0) {
  if (typeof n !== 'number') n = 0;
  if (decimals > 0) return n.toFixed(decimals);

  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

async function load() {
  loading.value = true;
  err.value = '';
  try {
    stats.value = await gw.stats({ days: days.value });
  } catch (e) {
    err.value = e?.message || String(e);
    toast(err.value, false);
  } finally {
    loading.value = false;
  }
}

watch(days, () => load());
onMounted(load);
</script>
<style lang="less" scoped>
.summary {
  flex: 1;
  min-width: 140px;
  padding: 12px !important;
  text-align: center;

  .sub { margin-bottom: 6px; }
  .num {
    font-size: 18px;
    font-weight: 600;
    color: var(--primary);
    font-family: var(--mono);
  }
}

.chart {
  display: flex;
  height: 200px;
  gap: 8px;

  .y-axis {
    width: 50px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    // 底部留出日期标签的高度，让「0」对齐柱子底线
    padding-bottom: 18px;
    text-align: right;
    font-size: 12px;
    color: var(--text-sub);
    font-family: var(--mono);
  }

  .bars {
    flex: 1;
    display: flex;
    align-items: flex-end;
    gap: 4px;
  }

  .bar-wrap {
    flex: 1;
    min-width: 0;
    // 柱高用百分比，父容器必须有确定高度，且柱子贴底
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: center;
    cursor: pointer;

    &:hover .bar { opacity: 0.8; }
  }

  .bar-area {
    flex: 1;
    width: 100%;
    display: flex;
    align-items: flex-end;
  }

  .bar {
    width: 100%;
    background: var(--primary);
    border-radius: 4px 4px 0 0;
    min-height: 2px;
    transition: opacity 0.15s;
  }

  .date {
    height: 18px;
    line-height: 18px;
    font-size: 11px;
    color: var(--text-sub);
    white-space: nowrap;
  }
}

a {
  text-decoration: none;
  &:hover { text-decoration: underline; }
}
</style>
