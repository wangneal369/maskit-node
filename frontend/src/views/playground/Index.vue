<template>
  <div class="page">
    <h1 class="page-title">试验台</h1>
    <div class="card">
      <textarea v-model="input" class="input" rows="6" placeholder="输入包含敏感信息的文本..."></textarea>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" :disabled="loading || !input.trim()" @click="run">脱敏</button>
        <button class="btn" @click="fill">填充示例</button>
      </div>
    </div>

    <template v-if="result">
      <div class="card">
        <div class="row">
          <div class="card-title grow" style="margin:0">脱敏结果</div>
          <span class="badge" :class="result.roundTripOk ? 'ok' : 'bad'">往返一致 {{ result.roundTripOk ? '✓' : '✗' }}</span>
        </div>
        <div class="out" style="margin-top:10px"><template v-for="(p, i) in maskedParts" :key="i"><span v-if="p.ph" class="ph">{{ p.t }}</span><template v-else>{{ p.t }}</template></template></div>
      </div>
      <div class="card">
        <div class="card-title">还原结果</div>
        <div class="out">{{ result.restored }}</div>
      </div>
      <div class="card">
        <div class="card-title">命中明细（{{ result.hits.length }}）</div>
        <div v-if="!result.hits.length" class="sub">未命中任何规则</div>
        <table v-else class="table">
          <thead><tr><th>标签</th><th>占位符</th><th>原文</th></tr></thead>
          <tbody>
            <tr v-for="(h, i) in result.hits" :key="i">
              <td><span class="badge">{{ h.label }}</span></td>
              <td class="mono">{{ h.token }}</td>
              <td class="mono">{{ h.orig }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
<script setup>
import { ref, computed } from 'vue';
import { gw } from '@/utils/gateway';
import { toast } from '@/utils/toast';

const SAMPLE = '排查数据库：mysql://root:Pass123@192.168.1.50:3306/db，联系人 13800138000，邮箱 zhangsan@example.com，key sk-proj-abcdefgh12345678';
const input = ref('');
const result = ref(null);
const loading = ref(false);

const fill = () => { input.value = SAMPLE; };

// 按 {{...}} 切片，文本以插值渲染（Vue 自动转义），不使用 v-html
const maskedParts = computed(() => {
  const s = result.value?.masked ?? '';
  const parts = [];
  const rx = /\{\{[^{}]*\}\}/g;
  let last = 0, m;
  while ((m = rx.exec(s))) {
    if (m.index > last) parts.push({ t: s.slice(last, m.index), ph: false });
    parts.push({ t: m[0], ph: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ t: s.slice(last), ph: false });
  return parts;
});

async function run() {
  loading.value = true;
  try { result.value = await gw.playground(input.value); }
  catch (e) { toast(e?.message || String(e), false); }
  finally { loading.value = false; }
}
</script>
<style lang="less" scoped>
.out { white-space: pre-wrap; word-break: break-all; font-family: var(--mono); line-height: 1.7; background: #fafbfd; border: 1px solid var(--border); border-radius: 7px; padding: 10px 12px; }
</style>
