/**
 * 命令拦截模块测试
 *
 * 覆盖：每个内置规则至少一个真实危害形态 + 良性命令 + 白名单 + 禁用规则 + 改写 + 校验 + 标准化 + 重叠去重
 */
import { describe, it, expect } from 'vitest';
import {
  BUILTIN_COMMAND_PATTERNS,
  CommandBlockConfig,
  CommandScanner,
  DEFAULT_COMMAND_BLOCK,
  validateCommandRegex,
  normalizeCommandBlock,
} from '../electron/core/command-block';

describe('validateCommandRegex', () => {
  it('accepts valid regex', () => {
    const result = validateCommandRegex(String.raw`\brm\s+/`);
    expect(result.ok).toBe(true);
  });

  it('rejects empty regex', () => {
    const result = validateCommandRegex('');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('空');
  });

  it('rejects regex longer than 300 chars', () => {
    const long = 'a'.repeat(301);
    const result = validateCommandRegex(long);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('过长');
  });

  it('rejects nested quantifiers (a+)+', () => {
    const result = validateCommandRegex('(a+)+');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('嵌套量词');
  });

  it('rejects nested quantifiers (a*)*', () => {
    // Using simple 'a' instead of '\w' for clearer matching
    const result = validateCommandRegex('(a*)*');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('嵌套量词');
  });

  it('rejects invalid regex syntax', () => {
    const result = validateCommandRegex('[');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('正则非法');
  });

  it('allows non-nested complex quantifiers', () => {
    // 这个是合法的：(?:-[a-z]*[rf][a-z]*\s+)+ 不是嵌套量词
    // 量词只作用在组，组内的 * 是内容的一部分，组本身没被量化后再量化
    const result = validateCommandRegex(String.raw`(?:-[a-z]*[rf][a-z]*\s+)+`);
    expect(result.ok).toBe(true);
  });
});

describe('BUILTIN_COMMAND_PATTERNS - rm root', () => {
  const pattern = BUILTIN_COMMAND_PATTERNS.find((p) => p.id === 'builtin-rm-root')!;
  const scanner = new CommandScanner({
    mode: 'observe',
    patterns: [{ ...pattern, enabled: true }],
    allow: [],
  });

  it('matches rm -rf /', () => {
    const hits = scanner.scan('rm -rf /');
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe('builtin-rm-root');
  });

  it('matches rm -rf / with trailing semicolon', () => {
    const hits = scanner.scan('rm -rf /; echo done');
    expect(hits.length).toBe(1);
  });

  it('matches rm -rf //* (glob)', () => {
    const hits = scanner.scan('rm -rf /*');
    expect(hits.length).toBe(1);
  });

  it('does not match rm -rf ./build (safe local delete)', () => {
    const hits = scanner.scan('rm -rf ./build');
    expect(hits.length).toBe(0);
  });

  it('does not match rm file.txt (non-recursive single file)', () => {
    const hits = scanner.scan('rm file.txt');
    expect(hits.length).toBe(0);
  });
});

describe('BUILTIN_COMMAND_PATTERNS - rm home', () => {
  const pattern = BUILTIN_COMMAND_PATTERNS.find((p) => p.id === 'builtin-rm-home')!;
  const scanner = new CommandScanner({
    mode: 'observe',
    patterns: [{ ...pattern, enabled: true }],
    allow: [],
  });

  it('matches rm -rf ~/', () => {
    const hits = scanner.scan('rm -rf ~/');
    expect(hits.length).toBe(1);
  });

  it('matches rm -rf ~', () => {
    const hits = scanner.scan('rm -rf ~');
    expect(hits.length).toBe(1);
  });

  it('matches rm -rf ~/*', () => {
    const hits = scanner.scan('rm -rf ~/*');
    expect(hits.length).toBe(1);
  });

  it('does not match rm -rf ~/project (targeted directory delete)', () => {
    const hits = scanner.scan('rm -rf ~/project');
    expect(hits.length).toBe(0);
  });
});

describe('BUILTIN_COMMAND_PATTERNS - Windows delete', () => {
  const pattern = BUILTIN_COMMAND_PATTERNS.find((p) => p.id === 'builtin-del-win')!;
  const scanner = new CommandScanner({
    mode: 'observe',
    patterns: [{ ...pattern, enabled: true }],
    allow: [],
  });

  it('matches del /s /q C:\\', () => {
    const hits = scanner.scan('del /s /q C:\\');
    expect(hits.length).toBe(1);
  });

  it('matches del /q /s D:', () => {
    const hits = scanner.scan('del /q /s D:');
    expect(hits.length).toBe(1);
  });

  it('matches PowerShell Remove-Item -Recurse -Force C:\\', () => {
    const hits = scanner.scan('Remove-Item -Recurse -Force C:\\');
    expect(hits.length).toBe(1);
  });

  it('does not match rm -rf (Unix rm, not del)', () => {
    const hits = scanner.scan('rm -rf /some/path');
    expect(hits.length).toBe(0);
  });
});

describe('BUILTIN_COMMAND_PATTERNS - format disk', () => {
  const pattern = BUILTIN_COMMAND_PATTERNS.find((p) => p.id === 'builtin-format')!;
  const scanner = new CommandScanner({
    mode: 'observe',
    patterns: [{ ...pattern, enabled: true }],
    allow: [],
  });

  it('matches format C:', () => {
    const hits = scanner.scan('format C:');
    expect(hits.length).toBe(1);
  });

  it('matches mkfs.ext4 /dev/sda1', () => {
    const hits = scanner.scan('mkfs.ext4 /dev/sda1');
    expect(hits.length).toBe(1);
  });

  it('matches mkfs /dev/nvme0', () => {
    const hits = scanner.scan('mkfs /dev/nvme0');
    expect(hits.length).toBe(1);
  });

  it('does not match formatDate(x) (function call, not disk format)', () => {
    const hits = scanner.scan('formatDate(x)');
    expect(hits.length).toBe(0);
  });
});

describe('BUILTIN_COMMAND_PATTERNS - drop database', () => {
  const pattern = BUILTIN_COMMAND_PATTERNS.find((p) => p.id === 'builtin-drop-db')!;
  const scanner = new CommandScanner({
    mode: 'observe',
    patterns: [{ ...pattern, enabled: true }],
    allow: [],
  });

  it('matches DROP DATABASE prod', () => {
    const hits = scanner.scan('DROP DATABASE prod;');
    expect(hits.length).toBe(1);
  });

  it('matches drop table users (case insensitive)', () => {
    const hits = scanner.scan('drop table users;');
    expect(hits.length).toBe(1);
  });

  it('matches TRUNCATE TABLE logs', () => {
    const hits = scanner.scan('TRUNCATE TABLE logs');
    expect(hits.length).toBe(1);
  });

  it('does not match select * from droptable_x (table name containing drop)', () => {
    const hits = scanner.scan('select * from droptable_x');
    expect(hits.length).toBe(0);
  });

  it('does not match update 改为显式 set (Chinese text discussion)', () => {
    const hits = scanner.scan('update 改为显式 set');
    expect(hits.length).toBe(0);
  });
});

describe('BUILTIN_COMMAND_PATTERNS - dd direct write', () => {
  const pattern = BUILTIN_COMMAND_PATTERNS.find((p) => p.id === 'builtin-dd')!;
  const scanner = new CommandScanner({
    mode: 'observe',
    patterns: [{ ...pattern, enabled: true }],
    allow: [],
  });

  it('matches dd if=/dev/zero of=/dev/sda', () => {
    const hits = scanner.scan('dd if=/dev/zero of=/dev/sda');
    expect(hits.length).toBe(1);
  });

  it('matches dd if=/dev/zero of=/dev/nvme0', () => {
    const hits = scanner.scan('dd if=/dev/zero of=/dev/nvme0');
    expect(hits.length).toBe(1);
  });

  it('matches dd if=a of=/dev/disk0', () => {
    const hits = scanner.scan('dd if=a of=/dev/disk0');
    expect(hits.length).toBe(1);
  });

  it('does not match dd if=a of=b.img (safe file-to-file copy)', () => {
    const hits = scanner.scan('dd if=a of=b.img');
    expect(hits.length).toBe(0);
  });
});

describe('BUILTIN_COMMAND_PATTERNS - fork bomb', () => {
  const pattern = BUILTIN_COMMAND_PATTERNS.find((p) => p.id === 'builtin-forkbomb')!;
  const scanner = new CommandScanner({
    mode: 'observe',
    patterns: [{ ...pattern, enabled: true }],
    allow: [],
  });

  it('matches fork bomb :(){ :|:& };:', () => {
    const hits = scanner.scan(':() { :| :& }; :');
    expect(hits.length).toBe(1);
  });
});

describe('normalizeCommandBlock', () => {
  it('fills in defaults for empty config', () => {
    const result = normalizeCommandBlock({});
    expect(result.mode).toBe('observe');
    expect(result.patterns.length).toBe(7);
    expect(result.allow).toEqual([]);
  });

  it('preserves builtin regex even if user tries to change it', () => {
    const config = normalizeCommandBlock({
      mode: 'observe',
      patterns: [
        {
          id: 'builtin-rm-root',
          label: 'custom label',
          regex: 'custom regex that will be ignored',
          enabled: true,
        },
      ],
    });
    const builtin = config.patterns.find((p) => p.id === 'builtin-rm-root');
    expect(builtin).toBeDefined();
    expect(builtin!.regex).toBe(BUILTIN_COMMAND_PATTERNS[0].regex);
    expect(builtin!.label).toBe(BUILTIN_COMMAND_PATTERNS[0].label); // label 也不改
  });

  it('applies user-provided enabled state to builtins', () => {
    const config = normalizeCommandBlock({
      patterns: [
        { id: 'builtin-rm-root', enabled: false },
      ],
    });
    const builtin = config.patterns.find((p) => p.id === 'builtin-rm-root');
    expect(builtin!.enabled).toBe(false);
  });

  it('rejects custom pattern with invalid regex', () => {
    const config = normalizeCommandBlock({
      patterns: [
        { id: 'custom-bad', label: 'bad', regex: '[', enabled: true },
      ],
    });
    const custom = config.patterns.find((p) => p.id === 'custom-bad');
    expect(custom).toBeUndefined();
  });

  it('rejects custom pattern with nested quantifiers', () => {
    const config = normalizeCommandBlock({
      patterns: [
        { id: 'custom-nested', label: 'nested', regex: '(a+)+', enabled: true },
      ],
    });
    const custom = config.patterns.find((p) => p.id === 'custom-nested');
    expect(custom).toBeUndefined();
  });

  it('keeps custom valid pattern', () => {
    const config = normalizeCommandBlock({
      patterns: [
        { id: 'custom-good', label: 'good', regex: String.raw`\bwipe\b`, enabled: true },
      ],
    });
    const custom = config.patterns.find((p) => p.id === 'custom-good');
    expect(custom).toBeDefined();
    expect(custom!.builtin).toBe(false);
  });

  it('validates allow-list patterns', () => {
    const config = normalizeCommandBlock({
      allow: [
        String.raw`\bsafe.*\b`,
        '[', // rejected: invalid
      ],
    });
    expect(config.allow).toHaveLength(1);
    expect(config.allow[0]).toBe(String.raw`\bsafe.*\b`);
  });

  it('converts non-object config to defaults', () => {
    const result = normalizeCommandBlock(null);
    expect(result.mode).toBe('observe');
    expect(result.patterns.length).toBe(7);
  });
});

describe('CommandScanner - scan with allow-list', () => {
  it('suppresses hit matching allow-list regex', () => {
    const config = normalizeCommandBlock({
      mode: 'observe',
      patterns: [{ id: 'builtin-rm-root', enabled: true }],
      allow: [String.raw`\brm\s+-rf\s+/tmp/`],
    });
    const scanner = new CommandScanner(config);
    const hits = scanner.scan('rm -rf /tmp/safe');
    expect(hits.length).toBe(0); // suppressed by allow-list
  });

  it('still reports if allow-list does not match', () => {
    const config = normalizeCommandBlock({
      mode: 'observe',
      patterns: [{ id: 'builtin-rm-root', enabled: true }],
      allow: [String.raw`\brm\s+-rf\s+/tmp/`],
    });
    const scanner = new CommandScanner(config);
    const hits = scanner.scan('rm -rf /');
    expect(hits.length).toBe(1); // not suppressed
  });
});

describe('CommandScanner - disabled patterns not reported', () => {
  it('does not report disabled builtin', () => {
    const config = normalizeCommandBlock({
      patterns: [{ id: 'builtin-rm-root', enabled: false }],
    });
    const scanner = new CommandScanner(config);
    const hits = scanner.scan('rm -rf /');
    expect(hits.length).toBe(0);
  });
});

describe('CommandScanner - overlapping hits', () => {
  it('deduplicates overlapping matches (keeps earliest start)', () => {
    // Create a scenario where two patterns match overlapping ranges
    const config: CommandBlockConfig = {
      mode: 'observe',
      patterns: [
        { id: 'p1', label: 'rm', regex: String.raw`\brm\s+\-rf\s+/`, enabled: true },
        { id: 'p2', label: 'rf', regex: String.raw`\-rf\s+/`, enabled: true },
      ],
      allow: [],
    };
    const scanner = new CommandScanner(config);
    const hits = scanner.scan('rm -rf /');
    // Only the earliest (p1 matching 'rm -rf /') should be reported
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe('p1');
  });
});

describe('CommandScanner - rewrite mode', () => {
  it('replaces matched text with notice', () => {
    const config = normalizeCommandBlock({
      mode: 'rewrite',
      patterns: [{ id: 'builtin-rm-root', enabled: true }],
    });
    const scanner = new CommandScanner(config);
    const result = scanner.rewrite('dangerous: rm -rf / done');
    expect(result.text).toContain('[Maskit 已拦截危险命令]');
    expect(result.text).not.toContain('rm -rf /');
    expect(result.hits.length).toBe(1);
  });

  it('does not modify text with no matches', () => {
    const config = normalizeCommandBlock({
      mode: 'rewrite',
      patterns: [{ id: 'builtin-rm-root', enabled: true }],
    });
    const scanner = new CommandScanner(config);
    const result = scanner.rewrite('safe: rm file.txt');
    expect(result.text).toBe('safe: rm file.txt');
    expect(result.hits.length).toBe(0);
  });
});

describe('CommandScanner - mode property', () => {
  it('returns configured mode', () => {
    const config = normalizeCommandBlock({ mode: 'block' });
    const scanner = new CommandScanner(config);
    expect(scanner.mode).toBe('block');
  });
});

describe('CommandScanner - JSON-escaped arguments', () => {
  it('matches command inside JSON tool arguments', () => {
    const json = '{"command":"drop table users;","args":[]}';
    const config = normalizeCommandBlock({
      patterns: [{ id: 'builtin-drop-db', enabled: true }],
    });
    const scanner = new CommandScanner(config);
    const hits = scanner.scan(json);
    expect(hits.length).toBe(1);
  });
});

describe('CommandScanner - snippet truncation', () => {
  it('truncates long matches to 120 chars', () => {
    const longCmd = 'drop table ' + 'x'.repeat(200);
    const config = normalizeCommandBlock({
      patterns: [{ id: 'builtin-drop-db', enabled: true }],
    });
    const scanner = new CommandScanner(config);
    const hits = scanner.scan(longCmd);
    expect(hits.length).toBe(1);
    expect(hits[0].snippet.length).toBeLessThanOrEqual(120);
  });
});

describe('CommandScanner - performance (1MB text)', () => {
  it('scans 1MB text with builtins in under 200ms', () => {
    // Generate 1MB of text with occasional dangerous patterns mixed in
    const dangerous = 'rm -rf / and dd if=/dev/zero of=/dev/sda ';
    const filler = 'normal command output line\n';
    const lines = Math.floor(1024 * 1024 / (filler.length + dangerous.length));
    let text = '';
    for (let i = 0; i < lines; i++) {
      if (i % 100 === 0) {
        text += dangerous;
      } else {
        text += filler;
      }
    }
    text = text.slice(0, 1024 * 1024); // Trim to exactly 1MB

    const config = DEFAULT_COMMAND_BLOCK;
    const scanner = new CommandScanner(config);

    const start = performance.now();
    const hits = scanner.scan(text);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(200);
    expect(hits.length).toBeGreaterThan(0); // Should find matches
  });
});

describe('CommandScanner - edge cases', () => {
  it('handles empty text', () => {
    const config = DEFAULT_COMMAND_BLOCK;
    const scanner = new CommandScanner(config);
    const hits = scanner.scan('');
    expect(hits.length).toBe(0);
  });

  it('handles null text gracefully', () => {
    const config = DEFAULT_COMMAND_BLOCK;
    const scanner = new CommandScanner(config);
    const hits = scanner.scan(null as unknown as string);
    expect(hits.length).toBe(0);
  });

  it('handles multiple patterns with mixed enabled/disabled', () => {
    const config = normalizeCommandBlock({
      patterns: [
        { id: 'builtin-rm-root', enabled: true },
        { id: 'builtin-rm-home', enabled: false },
        { id: 'builtin-del-win', enabled: true },
      ],
    });
    const scanner = new CommandScanner(config);
    const hits = scanner.scan('rm -rf / and rm -rf ~ and del /s /q C:\\');
    // Only builtin-rm-root and builtin-del-win should match
    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.id).sort()).toEqual(['builtin-del-win', 'builtin-rm-root']);
  });
});

describe('CommandScanner - 工具参数（JSON）', () => {
  const s = new CommandScanner(DEFAULT_COMMAND_BLOCK);
  it('JSON 字符串值里的命令能被识别（原文扫描会因引号边界漏检）', () => {
    expect(s.scanToolArgs('{"command":"rm -rf /"}').map((h) => h.id)).toEqual(['builtin-rm-root']);
    expect(s.scanToolArgs('{"command":"sudo rm -rf ~"}').map((h) => h.id)).toEqual(['builtin-rm-home']);
    expect(s.scanToolArgs('{"cmd":["bash","-c","rm -rf /"]}').length).toBe(1);
    expect(s.scanToolArgs('{"command":"rm -rf ./build"}')).toEqual([]);
  });
  it('rewriteToolArgs 改写后仍是合法 JSON', () => {
    const r = s.rewriteToolArgs('{"command":"rm -rf /","cwd":"/tmp"}');
    expect(r.hits.length).toBe(1);
    const j = JSON.parse(r.text);
    expect(j.cwd).toBe('/tmp');
    expect(j.command).not.toContain('rm -rf');
  });
  it('非 JSON 退回原文扫描', () => {
    expect(s.scanToolArgs('rm -rf / && echo').length).toBe(1);
  });
});

describe('CommandScanner - 空匹配不死循环', () => {
  it('能匹配空串的自定义正则不会卡死', () => {
    const cfg = normalizeCommandBlock({ patterns: [{ id: 'c1', label: 'x', regex: 'z*', enabled: true }] });
    const s = new CommandScanner(cfg);
    expect(() => s.scan('abc zz def')).not.toThrow();
    expect(s.scan('abc zz def').map((h) => h.snippet)).toEqual(['zz']);
  });
});
