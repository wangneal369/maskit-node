<template>
  <div class="page" v-if="cfg">
    <div class="row" style="margin-bottom:16px">
      <h1 class="page-title grow" style="margin:0">规则</h1>
      <button class="btn" :disabled="saving" @click="load">重置</button>
      <button class="btn primary" :disabled="saving" @click="save">保存</button>
    </div>

    <div class="card">
      <div class="card-title">内置规则</div>
      <div class="rules">
        <div v-for="label in ruleLabels" :key="label" class="rule row">
          <div class="switch" :class="{ on: cfg.mask.builtinRules[label] }" @click="cfg.mask.builtinRules[label] = !cfg.mask.builtinRules[label]"></div>
          <div class="grow">
            <b class="mono">{{ label }}</b>
            <div class="sub">{{ RULE_META[label] || '' }}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">密钥前缀</div>
      <div class="sub" style="margin-bottom:8px">命中这些前缀的字符串会被视为密钥脱敏。</div>
      <div v-for="(p, i) in cfg.mask.secretPrefixes" :key="i" class="row" style="margin-bottom:6px">
        <input class="input grow mono" v-model="cfg.mask.secretPrefixes[i]" />
        <button class="btn sm danger" @click="cfg.mask.secretPrefixes.splice(i, 1)">删除</button>
      </div>
      <button class="btn sm" @click="cfg.mask.secretPrefixes.push('')">+ 添加前缀</button>
    </div>

    <div class="card">
      <div class="card-title">自定义词</div>
      <div class="sub" style="margin-bottom:8px">普通词按字面量匹配（忽略大小写）；以 <span class="mono">re:</span> 开头表示正则表达式。标签留空默认为 TERM。</div>
      <div v-for="(w, i) in cfg.mask.customWords" :key="i" class="row" style="margin-bottom:6px">
        <div class="switch" :class="{ on: w.enabled !== false }" title="启用" @click="w.enabled = w.enabled === false"></div>
        <input class="input grow mono" v-model="w.word" placeholder="词 或 re:正则" />
        <input class="input mono" style="width:110px" v-model="w.label" placeholder="标签(TERM)" />
        <label class="row sub" style="gap:4px"><input type="checkbox" v-model="w.wholeWord" />整词</label>
        <button class="btn sm danger" @click="cfg.mask.customWords.splice(i, 1)">删除</button>
      </div>
      <button class="btn sm" @click="cfg.mask.customWords.push({ word: '', label: '', enabled: true, wholeWord: false })">+ 添加自定义词</button>
    </div>

    <div class="card">
      <div class="card-title">上游</div>
      <div class="sub" style="margin-bottom:8px">每个上游监听一个本地端口；路径列表用逗号分隔，仅匹配的路径会被脱敏，其余透传。</div>
      <div v-for="(u, i) in cfg.upstreams" :key="i" class="up">
        <div class="row" style="margin-bottom:6px">
          <input class="input" style="width:120px" v-model="u.name" placeholder="名称" />
          <input class="input" style="width:90px" type="number" v-model.number="u.port" placeholder="端口" />
          <input class="input grow mono" v-model="u.target" placeholder="https://api.example.com" />
          <button class="btn sm danger" @click="cfg.upstreams.splice(i, 1)">删除</button>
        </div>
        <input class="input mono" style="width:100%" :value="(u.paths || []).join(', ')" @input="u.paths = parsePaths($event.target.value)" placeholder="/v1/chat/completions, /v1/messages" />
      </div>
      <button class="btn sm" @click="cfg.upstreams.push({ name: '', port: nextPort(), target: '', paths: [] })">+ 添加上游</button>
    </div>

    <div class="card">
      <div class="card-title">出网代理</div>
      <div class="sub" style="margin-bottom:8px">留空 = 自动（环境变量 → 系统代理）；填 direct = 强制直连；或填写 http://127.0.0.1:7890 这类 HTTP 代理地址。本机上游始终直连。</div>
      <input class="input mono" style="width:100%" v-model="cfg.egressProxy" placeholder="自动" />
    </div>
  </div>
  <div class="page" v-else><div class="sub">{{ err || '加载中...' }}</div></div>
</template>
<script setup>
import { ref, computed, onMounted } from 'vue';
import { gw, RULE_META } from '@/utils/gateway';
import { toast } from '@/utils/toast';

const cfg = ref(null);
const err = ref('');
const saving = ref(false);

const ruleLabels = computed(() => {
  const keys = Object.keys(cfg.value?.mask.builtinRules || {});
  const known = Object.keys(RULE_META).filter((k) => keys.includes(k));
  return [...known, ...keys.filter((k) => !known.includes(k))];
});

const parsePaths = (s) => s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
const nextPort = () => Math.max(18700, ...cfg.value.upstreams.map((u) => Number(u.port) || 0)) + 1;

async function load() {
  try { cfg.value = await gw.getConfig(); err.value = ''; }
  catch (e) { err.value = e?.message || String(e); }
}

async function save() {
  const c = cfg.value;
  for (const u of c.upstreams) {
    if (!u.name.trim() || !u.target.trim() || !(u.port > 0 && u.port < 65536)) {
      return toast('上游的名称、目标地址和端口(1-65535)不能为空', false);
    }
  }
  const ports = c.upstreams.map((u) => u.port);
  if (new Set(ports).size !== ports.length) return toast('上游端口不能重复', false);
  // 清理空项
  c.mask.secretPrefixes = c.mask.secretPrefixes.map((s) => s.trim()).filter(Boolean);
  c.mask.customWords = c.mask.customWords.filter((w) => w.word.trim()).map((w) => ({ ...w, label: w.label?.trim() || undefined }));
  saving.value = true;
  try { await gw.setConfig(c); toast('保存成功'); }
  catch (e) { toast('保存失败：' + (e?.message || e), false); }
  finally { saving.value = false; }
}

onMounted(load);
</script>
<style lang="less" scoped>
.rules { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 20px; }
.rule { align-items: flex-start; }
.up { padding: 10px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; background: #fafbfd; }
</style>
