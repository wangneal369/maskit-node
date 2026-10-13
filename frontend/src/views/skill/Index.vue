<template>
  <div class="page">
    <h1 class="page-title">编程助手 Skill</h1>

    <div class="card">
      <div class="card-title">什么是编程助手 Skill</div>
      <p class="desc">
        让 Claude Code / Cursor / Codex 等编程助手看到占位符时原样使用：不编造、不拆分、不替换成示例数据、不无谓拒绝。
      </p>
      <p class="desc">
        Maskit 本地网关会把敏感原文替换成 <span class="mono">{{标签_后缀}}</span> 形态的占位符，这份契约告诉编程助手该怎么处理它们。
      </p>
    </div>

    <div class="card">
      <div class="card-title">操作</div>
      <div class="btn-group">
        <button class="btn primary" :disabled="exporting" @click="exportSkill">
          {{ exporting ? '导出中...' : '导出 Skill 包' }}
        </button>
        <button class="btn" :disabled="copying" @click="copyInstallCmd">
          {{ copying ? '复制中...' : '复制安装命令' }}
        </button>
        <button class="btn" :disabled="copying" @click="copyAgentsSnippet">
          {{ copying ? '复制中...' : '复制 AGENTS.md 片段' }}
        </button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">安装位置参考</div>
      <table class="install-table">
        <thead>
          <tr>
            <th>编程助手</th>
            <th>机制</th>
            <th>放哪里</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Claude Code</td>
            <td>Agent Skills</td>
            <td><span class="mono">~/.claude/skills/maskit-placeholders/</span><br>或项目 <span class="mono">.claude/skills/maskit-placeholders/</span></td>
          </tr>
          <tr>
            <td>Qoder</td>
            <td>Skill 目录</td>
            <td>用户资源目录 / 项目目录</td>
          </tr>
          <tr>
            <td>Cursor</td>
            <td>rules（.mdc）</td>
            <td>项目 <span class="mono">.cursor/rules/</span></td>
          </tr>
          <tr>
            <td>Codex CLI</td>
            <td>AGENTS.md</td>
            <td>项目根 <span class="mono">AGENTS.md</span><br>或用户级 <span class="mono">~/.codex/AGENTS.md</span></td>
          </tr>
          <tr>
            <td>Gemini CLI</td>
            <td>GEMINI.md</td>
            <td>项目根 <span class="mono">GEMINI.md</span></td>
          </tr>
        </tbody>
      </table>
      <div class="note">未逐个宿主实测，以各工具官方文档为准。</div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { gw } from '@/utils/gateway';
import { toast } from '@/utils/toast';

const exporting = ref(false);
const copying = ref(false);

async function exportSkill() {
  exporting.value = true;
  try {
    const result = await gw.exportSkillBundle();
    if (result.canceled) {
      // 用户取消，不显示 toast
      return;
    }
    if (result.ok) {
      toast(`已保存到：${result.path}`);
    } else {
      toast(`导出失败：${result.error || '未知错误'}`, false);
    }
  } catch (e) {
    toast(`导出失败：${e?.message || String(e)}`, false);
  } finally {
    exporting.value = false;
  }
}

function copyInstallCmd() {
  const isWindows = navigator.userAgent.includes('Windows');
  const cmd = isWindows
    ? 'Expand-Archive .\\maskit-placeholders.zip -DestinationPath "$env:USERPROFILE\\.claude\\skills\\" -Force'
    : 'unzip -o maskit-placeholders.zip -d ~/.claude/skills/';

  copying.value = true;
  navigator.clipboard.writeText(cmd)
    .then(() => {
      toast('已复制安装命令到剪贴板');
    })
    .catch(() => {
      toast('复制失败，请手动复制', false);
    })
    .finally(() => {
      copying.value = false;
    });
}

async function copyAgentsSnippet() {
  copying.value = true;
  try {
    const snippet = await gw.skillAgentsSnippet();
    await navigator.clipboard.writeText(snippet);
    toast('已复制 AGENTS.md 片段到剪贴板');
  } catch (e) {
    toast(`获取失败：${e?.message || String(e)}`, false);
  } finally {
    copying.value = false;
  }
}
</script>

<style lang="less" scoped>
.desc {
  margin: 0 0 12px;
  line-height: 1.6;
  font-size: 14px;
  color: var(--text);

  .mono {
    font-family: 'Courier New', monospace;
    background: var(--bg);
    padding: 2px 6px;
    border-radius: 4px;
  }
}

.btn-group {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;

  button {
    flex: 0 0 auto;
  }
}

.install-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin-bottom: 12px;

  th, td {
    padding: 10px 12px;
    text-align: left;
    border: 1px solid var(--border);
  }

  th {
    background: var(--bg);
    font-weight: 600;
    color: var(--text);
  }

  td {
    color: var(--text);
    line-height: 1.5;
  }

  .mono {
    font-family: 'Courier New', monospace;
    background: var(--bg);
    padding: 2px 6px;
    border-radius: 4px;
    display: inline-block;
  }
}

.note {
  padding: 8px 12px;
  background: var(--warn-soft);
  color: var(--warn);
  border-radius: 8px;
  font-size: 13px;
}
</style>
