<template>
  <div class="shell">
    <aside class="nav">
      <div class="brand">Data Maskit</div>
      <router-link v-for="n in navs" :key="n.to" :to="n.to" class="nav-item">
        <span class="ico">{{ n.ico }}</span>{{ n.text }}
      </router-link>
    </aside>
    <main class="main">
      <div v-if="!isEE" class="banner">未在 Electron 环境中运行：当前为浏览器预览，网关功能不可用。</div>
      <router-view />
    </main>
    <div v-if="toastState.show" class="toast" :class="toastState.ok ? 'ok' : 'bad'">{{ toastState.text }}</div>
  </div>
</template>
<script setup>
import { onMounted } from 'vue';
import { isEE } from '@/utils/ipcRenderer';
import { toastState } from '@/utils/toast';

const navs = [
  { to: '/dashboard', text: '概览', ico: '◉' },
  { to: '/playground', text: '试验台', ico: '✎' },
  { to: '/events', text: '日志', ico: '≡' },
  { to: '/rules', text: '规则', ico: '⚙' },
  { to: '/extension', text: '浏览器扩展', ico: '⊕' },
];

onMounted(() => {
  const loadingElement = document.getElementById('loadingPage');
  if (loadingElement) {
    loadingElement.remove();
  }
});
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
.banner { background: var(--warn-soft); color: var(--warn); padding: 8px 24px; font-size: 13px; }
.toast {
  position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
  padding: 8px 20px; border-radius: 8px; color: #fff; z-index: 99; box-shadow: 0 4px 16px rgba(0,0,0,.15);
  &.ok { background: var(--ok); } &.bad { background: var(--danger); }
}
</style>
