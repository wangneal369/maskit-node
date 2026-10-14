// 生成 Release 说明：更新内容（上一个 tag 到本 tag 的提交，按类型分组）+ 各平台下载直链。
// 用法：node scripts/release-notes.mjs <tag> [repo] [--check <dir>]，输出 Markdown 到 stdout。
// --check：下载表里的每个文件都必须存在于 <dir>，否则失败（防止改了产物命名后说明里出现死链）。
// CI 需 checkout fetch-depth: 0，否则拿不到上一个 tag。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const ci = argv.indexOf('--check');
const checkDir = ci >= 0 ? argv.splice(ci, 2)[1] : null;
const [tag, repo = 'wangneal369/maskit-node'] = argv;
if (!/^v\d+\.\d+\.\d+/.test(tag || '')) {
  console.error('用法：node scripts/release-notes.mjs v1.2.3 [owner/repo]');
  process.exit(1);
}
const version = tag.slice(1);

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function previousTag() {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v*', `${tag}^`);
  } catch {
    return null; // 第一个版本
  }
}

const GROUPS = [
  { title: '新功能', types: ['feat'] },
  { title: '问题修复', types: ['fix'] },
  { title: '性能与体验', types: ['perf', 'refactor', 'style'] },
  { title: '构建与发布', types: ['build', 'ci'] },
  { title: '其他', types: [] },
];

function changes(prev) {
  const range = prev ? `${prev}..${tag}` : tag;
  const subjects = git('log', '--no-merges', '--format=%s', range).split('\n').filter(Boolean);
  const buckets = new Map(GROUPS.map((g) => [g.title, []]));
  for (const s of subjects) {
    const m = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(s);
    const type = m?.[1] ?? '';
    // 版本号提交与纯测试/文档不进更新说明
    if (/^chore\(release\)/.test(s) || ['test', 'docs'].includes(type)) continue;
    const text = m ? m[3] : s;
    const group = GROUPS.find((g) => g.types.includes(type)) ?? GROUPS[GROUPS.length - 1];
    buckets.get(group.title).push(text);
  }
  return buckets;
}

const linked = [];
const url = (file) => `https://github.com/${repo}/releases/download/${tag}/${file}`;
const link = (label, file) => {
  linked.push(file);
  return `[${label}](${url(file)})`;
};

const DOWNLOADS = [
  ['Windows', 'x64（绝大多数电脑）', link('安装包 .exe', `DataMaskit-win-${version}-x64.exe`)],
  ['Windows', 'ARM64（骁龙等 ARM 笔记本）', link('安装包 .exe', `DataMaskit-win-${version}-arm64.exe`)],
  ['macOS', 'Apple 芯片（M 系列）', `${link('.dmg', `DataMaskit-mac-${version}-arm64.dmg`)} / ${link('.zip', `DataMaskit-mac-${version}-arm64.zip`)}`],
  ['Linux', 'x64', link('.deb', `DataMaskit-linux-${version}-amd64.deb`)],
  ['Linux', 'ARM64', link('.deb', `DataMaskit-linux-${version}-arm64.deb`)],
  ['浏览器扩展', 'Chrome / Edge', link('.zip', `DataMaskit-extension-${tag}.zip`)],
  ['编程助手 Skill', 'Claude Code 等', link('.zip', `maskit-placeholders-${tag}.zip`)],
];

if (checkDir) {
  const missing = linked.filter((f) => !fs.existsSync(path.join(checkDir, f)));
  if (missing.length) {
    console.error(`下载表链接的文件在 ${checkDir} 中不存在：\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
}

const prev = previousTag();
const out = [];
out.push('## 更新内容', '');
let any = false;
for (const [title, items] of changes(prev)) {
  if (!items.length) continue;
  any = true;
  out.push(`### ${title}`, '', ...items.map((t) => `- ${t}`), '');
}
if (!any) out.push('- 维护性更新', '');

out.push('## 下载', '', '| 平台 | 架构 | 下载 |', '|---|---|---|');
for (const [p, a, d] of DOWNLOADS) out.push(`| ${p} | ${a} | ${d} |`);
out.push(
  '',
  `Docker（amd64 / arm64）：\`docker pull ghcr.io/${repo}:${version}\``,
  '',
  '> 安装包未做代码签名：Windows 若出现 SmartScreen 提示，点「更多信息 → 仍要运行」；macOS 首次打开请右键「打开」。',
  '> 列表中的 `.yml` / `.blockmap` 文件供应用内自动更新使用，无需手动下载。',
  '',
);
if (prev) out.push(`**完整变更**：https://github.com/${repo}/compare/${prev}...${tag}`, '');

process.stdout.write(out.join('\n'));
