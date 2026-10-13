<template>
  <div class="shell">
    <aside class="nav">
      <div class="brand">Data Maskit</div>
      <router-link v-for="n in navs" :key="n.to" :to="n.to" class="nav-item">
        <span class="ico">{{ n.ico }}</span>{{ n.text }}
      </router-link>
    </aside>
    <main class="main">
      <div v-if="updateBanner.show" class="update-banner">
        <span>发现新版本 <b class="mono">{{ updateBanner.tag }}</b>，</span>
        <a href="#" class="update-link" @click.prevent="openUpdate">前往下载</a>
        <button class="update-close" title="关闭" @click="dismissUpdate">×</button>
      </div>
      <div v-if="needLogin" class="login">
        <div class="login-card">
          <div class="login-title">访问令牌</div>
          <div class="login-sub">当前为浏览器（Docker / 服务器）模式。请输入启动日志里打印的面板令牌，或部署时设置的 MASKIT_TOKEN。</div>
          <input class="input" type="password" v-model="tokenInput" placeholder="粘贴令牌" autocomplete="off" @keyup.enter="login" />
          <div v-if="loginErr" class="login-err">{{ loginErr }}</div>
          <button class="btn primary" :disabled="logging || !tokenInput.trim()" @click="login">{{ logging ? '验证中…' : '登录' }}</button>
        </div>
      </div>
      <router-view v-else :key="viewKey" />
    </main>
    <div v-if="toastState.show" class="toast" :class="toastState.ok ? 'ok' : 'bad'">{{ toastState.text }}</div>
  </div>
</template>
<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { auth, gw, setToken, onUpdateAvailable } from '@/utils/gateway';
import { toastState } from '@/utils/toast';

const navs = [
  { to: '/dashboard', text: '概览', ico: '◉' },
  { to: '/playground', text: '试验台', ico: '✎' },
  { to: '/events', text: '日志', ico: '≡' },
  { to: '/usage', text: '用量', ico: '📊' },
  { to: '/risk', text: '风险', ico: '⚠' },
  { to: '/rules', text: '规则', ico: '⚙' },
  { to: '/extension', text: '浏览器扩展', ico: '⊕' },
  { to: '/skill', text: '编程助手', ico: '◆' },
  { to: '/system', text: '系统', ico: '⚒' },
];

// ---------- 新版本横幅（maskit/update 推送，payload 为 checkUpdate 结果） ----------
const updateBanner = reactive({ show: false, tag: '', url: '' });
/** 同一版本关闭后本次会话内不再提示 */
let dismissedTag = '';
let offUpdate = () => {};

function onUpdatePush(info) {
  if (!info || !info.hasUpdate || !info.latest) return;
  const tag = `v${String(info.latest).replace(/^v/i, '')}`;
  if (tag === dismissedTag) return;
  updateBanner.tag = tag;
  updateBanner.url = /^https?:\/\//i.test(String(info.url || '')) ? info.url : '';
  updateBanner.show = true;
}

function dismissUpdate() {
  dismissedTag = updateBanner.tag;
  updateBanner.show = false;
}

function openUpdate() {
  if (updateBanner.url) window.open(updateBanner.url, '_blank', 'noopener');
}

const needLogin = computed(() => auth.needLogin);
const tokenInput = ref('');
const loginErr = ref('');
const logging = ref(false);
/** 登录成功后换 key，强制子页面重新挂载并拉取数据 */
const viewKey = ref(0);

async function login() {
  logging.value = true;
  loginErr.value = '';
  setToken(tokenInput.value.trim());
  try {
    await gw.status();
    tokenInput.value = '';
    viewKey.value++;
  } catch (e) {
    setToken('');
    loginErr.value = e?.message || '验证失败';
  } finally {
    logging.value = false;
  }
}

onMounted(() => {
  const loadingElement = document.getElementById('loadingPage');
  if (loadingElement) {
    loadingElement.remove();
  }
  offUpdate = onUpdateAvailable(onUpdatePush);
});

onBeforeUnmount(() => offUpdate());
</script>
<style lang="less">
.shell { display: flex; height: 100%; }
.nav {
  width: 150px; flex: none; background: #fff; border-right: 1px solid var(--border);
  padding: 16px 10px; display: flex; flex-direction: column; gap: 4px;
  .brand { font-weight: 700; font-size: 16px; padding: 4px 10px 16px; color: var(--primary); }
  .nav-item {
    display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 8px;
    color: var(--text); text-decoration: none;
    .ico { width: 16px; text-align: center; color: var(--text-sub); }
    &:hover { background: var(--bg); }
    &.router-link-active { background: var(--primary-soft); color: var(--primary); .ico { color: var(--primary); } }
  }
}
.main { flex: 1; overflow-y: auto; min-width: 0; }
.login {
  height: 100%; display: flex; align-items: center; justify-content: center;
  .login-card {
    width: 360px; background: #fff; border: 1px solid var(--border); border-radius: 12px;
    padding: 28px; display: flex; flex-direction: column; gap: 12px;
  }
  .login-title { font-size: 18px; font-weight: 700; }
  .login-sub { font-size: 13px; color: var(--text-sub); line-height: 1.6; }
  .login-err { font-size: 13px; color: var(--danger); }
}
.update-banner {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 14px; margin: 12px 24px 0; border-radius: 8px;
  background: var(--ok-soft); color: var(--ok); font-size: 13px;
  .update-link { color: var(--primary); font-weight: 600; }
  .update-close {
    margin-left: auto; border: none; background: transparent; color: var(--text-sub);
    font-size: 18px; line-height: 1; cursor: pointer; padding: 0 4px;
    &:hover { color: var(--text); }
  }
}
.toast {
  position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
  padding: 8px 20px; border-radius: 8px; color: #fff; z-index: 99; box-shadow: 0 4px 16px rgba(0,0,0,.15);
  &.ok { background: var(--ok); } &.bad { background: var(--danger); }
}
</style>
