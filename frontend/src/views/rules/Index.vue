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
      <div class="card-title">语义识别（NER）</div>
      <div class="row" style="margin-bottom:12px;align-items:flex-start">
        <div class="switch" :class="{ on: cfg.ner.enabled }" @click="toggleNer"></div>
        <div class="grow">
          <b>启用语义识别</b>
          <div class="sub" style="margin-top:4px;line-height:1.7">本地识别人名、机构、地址，正则规则覆盖不到的部分由它补充。模型约 100MB，首次使用需下载；全部在本机推理，不上传任何内容。</div>
          <div class="sub" style="margin-top:4px">模型来源：ckiplab/bert-base-chinese-ner（GPL-3.0）</div>
        </div>
      </div>
      <div class="row" style="margin-bottom:12px">
        <span>单次识别预算</span>
        <input class="input mono" style="width:120px" type="number" min="100" max="10000" step="100" v-model.number="cfg.ner.budgetMs" />
        <span class="sub">毫秒，范围 100–10000</span>
      </div>
      <div class="row wrap" style="margin-bottom:10px">
        <span>模型状态</span>
        <span v-for="(b, i) in nerBadges" :key="i" class="badge" :class="b.cls">{{ b.text }}</span>
      </div>
      <div v-if="nerErrorText" class="err-line" style="margin-bottom:10px">{{ nerErrorText }}</div>
      <div class="row" style="margin-bottom:6px">
        <button class="btn" :disabled="downloading || nerInstalled" @click="doDownloadNer">{{ downloading ? '下载中…' : '下载模型（约 78MB）' }}</button>
        <span v-if="nerInstalled" class="sub">模型已安装，无需重复下载</span>
      </div>
      <div v-if="downloading" class="progress">
        <div class="progress-bar" :style="{ width: dlPercent + '%' }"></div>
      </div>
      <div v-if="downloading" class="sub mono" style="margin-top:4px">{{ dlText }}</div>
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
      <div class="card-title">数据存储</div>
      <div class="row" style="margin-bottom:6px">
        <div class="switch" :class="{ on: cfg.storage.persistMappings }" @click="cfg.storage.persistMappings = !cfg.storage.persistMappings"></div>
        <b>持久化占位符映射</b>
      </div>
      <div class="sub" style="margin-bottom:12px">开启后，非凭据类映射（手机号、邮箱、自定义词等）保存到本地，重启后仍可还原历史对话中的占位符；API Key、密码、私钥等凭据永不写入磁盘。</div>
      <div class="row">
        <span>日志保留条数</span>
        <input class="input" style="width:120px" type="number" min="100" max="100000" v-model.number="cfg.storage.maxEvents" />
        <span class="sub">范围 100–100000</span>
      </div>
    </div>

    <div class="card">
      <div class="card-title">出网代理</div>
      <div class="sub" style="margin-bottom:8px">留空 = 自动（环境变量 → 系统代理）；填 direct = 强制直连；或填写 http://127.0.0.1:7890 这类 HTTP 代理地址。本机上游始终直连。</div>
      <input class="input mono" style="width:100%" v-model="cfg.egressProxy" placeholder="自动" />
    </div>

    <div class="card">
      <div class="card-title">危险命令拦截</div>
      <div class="sub" style="margin-bottom:12px">只检查模型下发的工具调用参数；改写/阻断时，流式工具参数会先缓冲到该参数结束再检查</div>

      <div style="margin-bottom:14px">
        <div class="sub" style="margin-bottom:6px">处理模式</div>
        <div class="row" style="gap:16px;flex-wrap:wrap">
          <label class="row" style="gap:6px">
            <input type="radio" v-model="cfg.commandBlock.mode" value="observe" />
            <span>仅记录</span>
          </label>
          <label class="row" style="gap:6px">
            <input type="radio" v-model="cfg.commandBlock.mode" value="rewrite" />
            <span>改写为提示</span>
          </label>
          <label class="row" style="gap:6px">
            <input type="radio" v-model="cfg.commandBlock.mode" value="block" />
            <span>阻断</span>
          </label>
        </div>
      </div>

      <div style="margin-bottom:14px">
        <div class="sub" style="margin-bottom:6px">检查规则</div>
        <div v-for="(p, i) in cfg.commandBlock.patterns" :key="i" class="pattern-row">
          <div class="switch" :class="{ on: p.enabled !== false }" @click="p.enabled = p.enabled === false ? true : false"></div>
          <div class="grow">
            <input v-if="!p.builtin" class="input grow mono" style="margin-bottom:4px" v-model="p.label" placeholder="规则标签" />
            <div v-else class="mono sub" style="margin-bottom:4px"><b>{{ p.label }}</b></div>
            <input v-if="!p.builtin" class="input grow mono" style="font-size:12px" v-model="p.regex" placeholder="/^re:.*pattern$/i" @change="validateRegex(i)" />
            <div v-else class="mono sub" style="font-size:12px">{{ p.regex }}</div>
          </div>
          <button v-if="!p.builtin" class="btn sm danger" @click="cfg.commandBlock.patterns.splice(i, 1)">删除</button>
        </div>
        <button class="btn sm" @click="cfg.commandBlock.patterns.push({ id: 'custom_' + Date.now(), label: '', regex: '', enabled: true })">+ 添加规则</button>
      </div>

      <div>
        <div class="sub" style="margin-bottom:6px">白名单：每行一条正则，命中的命令片段不再记录或拦截（例如测试环境里允许的 <span class="mono">DROP TABLE tmp_\w+</span>）</div>
        <textarea class="input mono" style="min-height:80px;font-size:12px;line-height:1.5" v-model="allowListText" placeholder="(?i)drop table tmp_\w+&#10;rm -rf /tmp/build"></textarea>
      </div>
    </div>

    <div class="card">
      <div class="card-title">安全审计</div>
      <div class="row">
        <div class="switch" :class="{ on: cfg.audit.enabled }" @click="cfg.audit.enabled = !cfg.audit.enabled"></div>
        <div class="grow">
          <b>启用被动检测</b>
          <div class="sub" style="margin-top:4px">被动检测模型回复中的提示词注入、索要系统提示词、凭据外发指令、隐藏字符，以及上游错误响应中泄露的密钥/路径/堆栈。只标记，不拦截。</div>
        </div>
      </div>
    </div>

    <div class="card" id="prices">
      <div class="card-title">模型价格</div>
      <div class="sub" style="margin-bottom:12px">内置参考价已覆盖常见模型，这里只需填写需要覆盖或缺失的模型</div>
      <div class="prices-table">
        <div class="prices-header">
          <div class="col-model">模型</div>
          <div class="col-price">输入 (/$1M)</div>
          <div class="col-price">输出 (/$1M)</div>
          <div class="col-price">缓存读 (/$1M)</div>
          <div class="col-price">缓存写 (/$1M)</div>
          <div class="col-action"></div>
        </div>
        <div v-for="(p, i) in cfg.prices.list" :key="i" class="prices-row">
          <input class="input mono" style="flex:0 0 auto;width:180px" v-model="p.model" placeholder="gpt-4o" />
          <input type="number" class="input mono" style="flex:0 0 auto;width:100px" v-model.number="p.input" min="0" step="0.01" placeholder="0.00" />
          <input type="number" class="input mono" style="flex:0 0 auto;width:100px" v-model.number="p.output" min="0" step="0.01" placeholder="0.00" />
          <input type="number" class="input mono" style="flex:0 0 auto;width:100px" v-model.number="p.cacheRead" min="0" step="0.01" placeholder="0.00" />
          <input type="number" class="input mono" style="flex:0 0 auto;width:100px" v-model.number="p.cacheWrite" min="0" step="0.01" placeholder="0.00" />
          <button class="btn sm danger" style="flex:none" @click="cfg.prices.list.splice(i, 1)">删除</button>
        </div>
      </div>
      <button class="btn sm" @click="cfg.prices.list.push({ model: '', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })">+ 添加模型</button>
    </div>
  </div>
  <div class="page" v-else><div class="sub">{{ err || '加载中...' }}</div></div>
</template>
<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { gw, RULE_META } from '@/utils/gateway';
import { toast } from '@/utils/toast';

const cfg = ref(null);
const err = ref('');
const saving = ref(false);
const allowListText = ref('');

// ---------- 语义识别（NER） ----------
const nerStatus = ref(null);
const downloading = ref(false);
let nerPoll = null;

const nerInstalled = computed(() => !!nerStatus.value?.model?.installed);

const mb = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? `${(v / 1024 / 1024).toFixed(1)} MB` : '—';
};

const nerBadges = computed(() => {
  const n = nerStatus.value;
  if (!n) return [{ text: '状态未知', cls: '' }];
  const m = n.model || {};
  const out = [];
  if (n.error || m.error) out.push({ text: '错误', cls: 'bad' });
  if (n.loading) out.push({ text: '加载中', cls: 'warn' });
  if (n.ready) out.push({ text: '已就绪', cls: 'ok' });
  if (m.installed) out.push({ text: m.sizeBytes != null ? `已安装 · ${mb(m.sizeBytes)}` : '已安装', cls: 'ok' });
  else out.push({ text: '未安装', cls: 'warn' });
  return out;
});

const nerErrorText = computed(() => nerStatus.value?.error || nerStatus.value?.model?.error || '');

const dlProgress = computed(() => nerStatus.value?.model?.downloading || null);
const dlPercent = computed(() => {
  const p = dlProgress.value;
  if (!p || !(p.total > 0)) return 0;
  return Math.min(100, Math.round((p.received / p.total) * 100));
});
const dlText = computed(() => {
  const p = dlProgress.value;
  if (!p) return '准备下载…';
  return p.total > 0 ? `${mb(p.received)} / ${mb(p.total)}（${dlPercent.value}%）` : `已接收 ${mb(p.received)}`;
});

async function refreshNer() {
  try {
    const s = await gw.status();
    nerStatus.value = s?.ner || null;
  } catch { /* 忽略：下次轮询或保存时重试 */ }
}

/** 未安装模型时不允许开启 */
function toggleNer() {
  if (!cfg.value.ner.enabled && !nerInstalled.value) return toast('请先下载模型', false);
  cfg.value.ner.enabled = !cfg.value.ner.enabled;
}

async function doDownloadNer() {
  if (downloading.value) return;
  downloading.value = true;
  // 下载期间每秒轮询 status() 刷新进度
  nerPoll = setInterval(refreshNer, 1000);
  try {
    const s = await gw.downloadNerModel();
    if (s?.ner) nerStatus.value = s.ner;
    toast(nerInstalled.value ? '模型下载完成' : '模型下载结束，但未检测到安装', nerInstalled.value);
  } catch (e) {
    toast('模型下载失败：' + (e?.message || e), false);
    await refreshNer();
  } finally {
    clearInterval(nerPoll);
    nerPoll = null;
    downloading.value = false;
  }
}

onBeforeUnmount(() => { if (nerPoll) clearInterval(nerPoll); });

const ruleLabels = computed(() => {
  const keys = Object.keys(cfg.value?.mask.builtinRules || {});
  const known = Object.keys(RULE_META).filter((k) => keys.includes(k));
  return [...known, ...keys.filter((k) => !known.includes(k))];
});

const parsePaths = (s) => s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
const nextPort = () => Math.max(18700, ...cfg.value.upstreams.map((u) => Number(u.port) || 0)) + 1;

function validateRegex(i) {
  const p = cfg.value.commandBlock.patterns[i];
  if (!p.regex) return;
  try {
    // Remove (?i) case-insensitive flag
    new RegExp(p.regex.replace(/^\(\?i\)/, ''));
  } catch (e) {
    toast('正则表达式无效：' + e.message, false);
  }
}

async function load() {
  try {
    const c = await gw.getConfig();
    // 兼容旧配置：补默认值
    c.storage = { persistMappings: true, maxEvents: 5000, ...(c.storage || {}) };
    c.commandBlock = { mode: 'observe', patterns: [], allow: [], ...(c.commandBlock || {}) };
    c.audit = { enabled: true, ...(c.audit || {}) };
    c.ner = { enabled: false, budgetMs: 800, ...(c.ner || {}) };
    c.prices = c.prices || {};
    // Convert prices Record to list format for editing
    if (!c.prices.list) {
      c.prices.list = Object.entries(c.prices).filter(([k]) => k !== 'list').map(([model, v]) => ({ model, ...v }));
    }
    cfg.value = c;
    err.value = '';
    refreshNer();
    // Update allowListText from allow array
    allowListText.value = (c.commandBlock.allow || []).join('\n');
  }
  catch (e) { err.value = e?.message || String(e); }
}

async function save() {
  const c = cfg.value;

  // Validate upstreams
  for (const u of c.upstreams) {
    if (!u.name.trim() || !u.target.trim() || !(u.port > 0 && u.port < 65536)) {
      return toast('上游的名称、目标地址和端口(1-65535)不能为空', false);
    }
  }

  const bm = Number(c.ner.budgetMs);
  if (!Number.isInteger(bm) || bm < 100 || bm > 10000) return toast('NER 预算需为 100–10000 的整数（毫秒）', false);
  c.ner.budgetMs = bm;
  // 保存前重新确认模型状态，未安装时不允许保存为启用
  if (c.ner.enabled) {
    await refreshNer();
    if (!nerInstalled.value) return toast('请先下载模型（或先关闭语义识别再保存）', false);
  }

  const me = Number(c.storage.maxEvents);
  if (!Number.isInteger(me) || me < 100 || me > 100000) return toast('日志保留条数需为 100–100000 的整数', false);
  c.storage.maxEvents = me;

  const ports = c.upstreams.map((u) => u.port);
  if (new Set(ports).size !== ports.length) return toast('上游端口不能重复', false);

  // Clean up
  c.mask.secretPrefixes = c.mask.secretPrefixes.map((s) => s.trim()).filter(Boolean);
  c.mask.customWords = c.mask.customWords.filter((w) => w.word.trim()).map((w) => ({ ...w, label: w.label?.trim() || undefined }));

  // Validate command patterns
  for (const p of c.commandBlock.patterns) {
    if (!p.builtin && p.regex) {
      if (p.regex.length > 300) {
        return toast('规则的正则表达式不能超过 300 字符', false);
      }
      try {
        new RegExp(p.regex.replace(/^\(\?i\)/, ''));
      } catch (e) {
        return toast('规则的正则表达式无效：' + e.message, false);
      }
    }
  }

  // Convert allowListText back to array
  c.commandBlock.allow = allowListText.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  // 无效正则会被主进程丢弃，必须在这里提示，避免用户以为白名单已生效
  for (const src of c.commandBlock.allow) {
    try {
      if (src.length > 300) throw new Error('超过 300 字符');
      new RegExp(src.replace(/^\(\?i\)/, ''));
    } catch (e) {
      return toast(`白名单正则无效「${src}」：${e.message}`, false);
    }
  }

  // Clean custom patterns (remove empty ones)
  c.commandBlock.patterns = c.commandBlock.patterns.filter(p => !p.builtin || p.enabled !== undefined);

  // Convert prices list back to Record
  const pricesRecord = {};
  for (const p of (c.prices.list || [])) {
    if (p.model.trim()) {
      pricesRecord[p.model.trim()] = {
        input: Math.max(0, Number(p.input) || 0),
        output: Math.max(0, Number(p.output) || 0),
        ...(Number(p.cacheRead) > 0 && { cacheRead: Number(p.cacheRead) }),
        ...(Number(p.cacheWrite) > 0 && { cacheWrite: Number(p.cacheWrite) }),
      };
    }
  }
  c.prices = pricesRecord;

  saving.value = true;
  try { await gw.setConfig(c); toast('保存成功'); }
  catch (e) { toast('保存失败：' + (e?.message || e), false); }
  finally { saving.value = false; }
}

onMounted(load);
</script>
<style lang="less" scoped>
.rules {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 20px;
}
.rule { align-items: flex-start; }
.up {
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 8px;
  background: #fafbfd;
}

.pattern-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin-bottom: 8px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #fafbfd;

  .switch { margin-top: 6px; }
  .grow {
    flex: 1;
    min-width: 0;
  }
}

.prices-table {
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 10px;

  .prices-header,
  .prices-row {
    display: flex;
    gap: 8px;
    padding: 8px;
    align-items: center;

    .col-model { flex: 0 0 180px; }
    .col-price { flex: 0 0 100px; }
    .col-action { flex: none; }
  }

  .prices-header {
    background: #fafbfd;
    border-bottom: 1px solid var(--border);
    font-weight: 500;
    font-size: 12px;
    color: var(--text-sub);
  }

  .prices-row {
    border-bottom: 1px solid var(--border);
    &:last-child { border-bottom: none; }
  }
}

input[type="radio"] {
  cursor: pointer;
}

.err-line { color: var(--danger); font-size: 13px; }

.progress {
  height: 8px;
  border-radius: 4px;
  background: var(--bg);
  overflow: hidden;
  .progress-bar {
    height: 100%;
    background: var(--primary);
    transition: width .3s;
  }
}
</style>
