import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Skill 包结构：Claude Code 从 ~/.claude/skills/<name>/SKILL.md 加载，
 * 安装命令把 zip 解到 ~/.claude/skills/，所以 zip 顶层必须是 maskit-placeholders/，
 * 且 SKILL.md 的 frontmatter name 必须与目录名一致。
 */
describe('编程助手 Skill 包', () => {
  const dir = path.join(__dirname, '..', 'agent-bundle', 'maskit-placeholders');

  it('分发文件齐全', () => {
    for (const f of ['SKILL.md', 'README.md', 'README_EN.md', 'templates/AGENTS.snippet.md']) {
      expect(fs.existsSync(path.join(dir, f))).toBe(true);
    }
  });

  it('SKILL.md frontmatter 的 name 与目录名一致，且有 description', () => {
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    expect(/^name:\s*maskit-placeholders\s*$/m.test(fm)).toBe(true);
    expect(/^description:\s*\S+/m.test(fm)).toBe(true);
  });

  it('分发文件里不出现严格形态的占位符（会被网关当成真 token 还原）', () => {
    for (const f of ['SKILL.md', 'README.md', 'README_EN.md', 'templates/AGENTS.snippet.md']) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(text).not.toMatch(/\{\{[A-Z0-9]{1,12}_(?:[0-9a-f]{6}|[bcdfghjkmnpqrstvwxz]{6})\}\}/);
    }
  });
});
