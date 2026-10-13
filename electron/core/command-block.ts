/**
 * 危险命令检测和阻止（LLM 工具调用参数安全防护）
 *
 * 仅用于静态文本分析，无 I/O，无副作用。
 * 移植自 engine/shield_defaults.py 和 engine/transparent.py。
 */

/** 命令拦截模式 */
export type CommandMode = 'observe' | 'rewrite' | 'block';

/** 单条拦截规则 */
export interface CommandPattern {
  id: string;
  label: string;
  regex: string;
  enabled: boolean;
  builtin?: boolean;
}

/** 命令拦截配置 */
export interface CommandBlockConfig {
  mode: CommandMode;
  patterns: CommandPattern[];
  allow: string[];
}

/** 命令检测命中 */
export interface CommandHit {
  id: string;
  label: string;
  snippet: string;
  start: number;
  end: number;
}

// ========== 内置危害命令清单 ==========
// 选条标准：只认「几乎不可能是正常操作」的高置信形态，宁可漏不可扰
export const BUILTIN_COMMAND_PATTERNS: CommandPattern[] = [
  {
    id: 'builtin-rm-root',
    label: '递归删除根目录',
    regex: String.raw`(?i)\brm\s+(?:-[a-z]*[rf][a-z]*\s+)+(?:/|/\*)(?:\s|$|;|&|\|)`,
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-rm-home',
    label: '递归删除家目录',
    // 家目录形态：`~` / `~/` / `~/*`（尾部靠 lookahead 收口，避免把 `~/project` 这类定向删除也算进来）
    regex: String.raw`(?i)\brm\s+(?:-[a-z]*[rf][a-z]*\s+)+~(?:/\*?)?(?=\s|$|;|&|\|)`,
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-del-win',
    label: 'Windows 全盘删除',
    // del/erase 带 /s /q 删到盘符根，以及 PowerShell Remove-Item -Recurse -Force 盘符
    regex: (
      String.raw`(?i)(?:^|[\s;&|])(?:del|erase)\s+/[sq]\b[^\n]{0,40}[A-Za-z]:[\\/]?(?:\s|$)` +
      String.raw`|\bRemove-Item\b[^\n]{0,60}-Recurse\b[^\n]{0,40}-Force\b[^\n]{0,20}[A-Za-z]:\\(?:\s|$|\")`
    ),
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-format',
    label: '格式化磁盘/块设备',
    regex: String.raw`(?i)(?:\bformat\s+[A-Za-z]:|\bmkfs(?:\.\w+)?\s+/dev/)`,
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-drop-db',
    label: '删除数据库/表',
    // ⚠️ DDL 判据在**正文**里会命中「讲解 DROP DATABASE 为什么危险」这类句子。
    // 这正是 channels 默认只含 `tool`、`text` 必须显式 opt-in 的原因。
    regex: (
      String.raw`(?i)(?:\bdrop\s+(?:database|schema)\b|\bdrop\s+table\b` +
      String.raw`|\btruncate\s+table\b)`
    ),
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-dd',
    label: 'dd 直写块设备',
    regex: String.raw`(?i)\bdd\s+[^\n]{0,60}\bof=/dev/(?:sd[a-z]|nvme\d|disk\d)`,
    enabled: true,
    builtin: true,
  },
  {
    id: 'builtin-forkbomb',
    label: 'fork 炸弹',
    regex: String.raw`:\(\)\s*\{\s*:\|\s*:&\s*\}\s*;\s*:`,
    enabled: true,
    builtin: true,
  },
];

// 正则最大长度（防止 ReDoS）
const CMD_REGEX_MAX_LEN = 300;

// 嵌套量词检测（防止灾难性回溯）
// 模式：量化作用在「单原子 + 该原子自带量词」的组上，如 (a+)+ / (\w*)* / (x?)+ / (\w+){2,}
// 注：在 JS 中需要特殊处理 \\ 来匹配源代码中的反斜杠
const CMD_ATOM = String.raw`(?:\\[A-Za-z0-9]|\[[^\]]*\]|\.|\([^()]*\)|[A-Za-z0-9_])`;
const CMD_QUANT = String.raw`(?:[*+?]|\{\d+,?\d*\})`;
const CMD_NESTED_QUANT_RE = new RegExp(
  String.raw`\((?:\?:)?` + CMD_ATOM + CMD_QUANT + String.raw`\)\s*` + CMD_QUANT
);

/** 校验一条命令拦截/白名单正则，返回校验结果和原因 */
export function validateCommandRegex(src: string): { ok: boolean; reason?: string } {
  src = String(src || '');
  if (!src.trim()) {
    return { ok: false, reason: '空正则' };
  }
  if (src.length > CMD_REGEX_MAX_LEN) {
    return { ok: false, reason: `过长（上限 ${CMD_REGEX_MAX_LEN} 字符）` };
  }
  if (CMD_NESTED_QUANT_RE.test(src)) {
    return { ok: false, reason: '含嵌套量词（易触发灾难性回溯）' };
  }
  try {
    // 剥掉 (?i) 内联标志后再编译，因为 JS RegExp 不支持它
    let regex = src;
    if (regex.startsWith('(?i)')) {
      regex = regex.slice(4);
    }
    new RegExp(regex);
  } catch (e) {
    return { ok: false, reason: `正则非法（${String(e).split('\n')[0]})` };
  }
  return { ok: true };
}

/** 默认配置：observe 模式 + 内置规则 + 空白名单 */
export const DEFAULT_COMMAND_BLOCK: CommandBlockConfig = {
  mode: 'observe',
  patterns: BUILTIN_COMMAND_PATTERNS,
  allow: [],
};

/**
 * 标准化命令拦截配置
 *
 * 补充默认值；mode 必须是三种之一（否则默认 'observe'）；
 * 合并用户配置与内置规则：内置条目保留其代码中的 regex，但从配置读取 enabled 状态。
 * 自定义规则只在校验通过时保留；白名单规则也要校验。
 */
export function normalizeCommandBlock(raw: unknown): CommandBlockConfig {
  const out: CommandBlockConfig = {
    mode: 'observe',
    patterns: [],
    allow: [],
  };

  if (typeof raw !== 'object' || raw === null) {
    raw = DEFAULT_COMMAND_BLOCK;
  }

  // 模式：必须是三种之一
  const rawMode = String((raw as any).mode || 'observe').trim().toLowerCase();
  out.mode = (rawMode === 'observe' || rawMode === 'rewrite' || rawMode === 'block')
    ? (rawMode as CommandMode)
    : 'observe';

  // 合并内置规则与用户自定义
  const builtinIds = new Set(BUILTIN_COMMAND_PATTERNS.map((p) => p.id));
  const userPatterns = (raw as any).patterns;
  const userMap = new Map<string, { enabled: boolean }>();

  if (Array.isArray(userPatterns)) {
    for (const item of userPatterns) {
      if (typeof item === 'object' && item !== null && typeof item.id === 'string') {
        userMap.set(item.id, { enabled: item.enabled !== false });
      }
    }
  }

  // 内置规则：保留代码中的 regex，但应用用户配置的 enabled
  for (const builtin of BUILTIN_COMMAND_PATTERNS) {
    const userStatus = userMap.get(builtin.id);
    const enabled = userStatus ? userStatus.enabled : builtin.enabled;
    out.patterns.push({
      id: builtin.id,
      label: builtin.label,
      regex: builtin.regex,
      enabled,
      builtin: true,
    });
  }

  // 自定义规则：必须通过校验
  if (Array.isArray(userPatterns)) {
    for (const item of userPatterns) {
      if (typeof item !== 'object' || item === null) continue;
      const id = String(item.id || '');
      const label = String(item.label || '');
      const regex = String(item.regex || '');
      const enabled = item.enabled !== false;

      // 跳过内置项（它们已处理）
      if (builtinIds.has(id)) continue;
      if (!id.trim() || !regex.trim()) continue;

      const validation = validateCommandRegex(regex);
      if (!validation.ok) continue;

      out.patterns.push({
        id,
        label,
        regex,
        enabled,
        builtin: false,
      });
    }
  }

  // 白名单：必须校验
  const rawAllow = (raw as any).allow;
  if (Array.isArray(rawAllow)) {
    for (const src of rawAllow) {
      const s = String(src || '');
      if (!s.trim()) continue;
      const validation = validateCommandRegex(s);
      if (!validation.ok) continue;
      out.allow.push(s);
    }
  }

  return out;
}

/** 改写后的固定文本（无害 no-op） */
const COMMAND_BLOCK_NOTICE = '[Maskit 已拦截危险命令]';

/**
 * 命令扫描器：编译正则，执行扫描和改写
 */
export class CommandScanner {
  private patterns: Array<{ id: string; label: string; rx: RegExp; enabled: boolean }> = [];
  private allowRxs: RegExp[] = [];
  private scanMode: CommandMode;

  constructor(cfg: CommandBlockConfig) {
    this.scanMode = cfg.mode;

    // 编译启用的模式
    for (const pat of cfg.patterns) {
      if (!pat.enabled) continue;
      try {
        // 剥掉 (?i) 内联标志，改用 RegExp 的 i 标志
        let regex = pat.regex;
        if (regex.startsWith('(?i)')) {
          regex = regex.slice(4);
        }
        // 检查原始字符串中是否已有 (?i)——某些模式用 (?i) 作为大小写标志
        // 如果有，我们需要用 'i' 标志重新编译
        const hasInlineI = /^\(\?i\)/.test(pat.regex);
        const rx = new RegExp(regex, 'g' + (hasInlineI ? 'i' : ''));
        this.patterns.push({
          id: pat.id,
          label: pat.label,
          rx,
          enabled: true,
        });
      } catch {
        // 无效正则在 normalizeCommandBlock 中应已被剔除，这里跳过以防万一
      }
    }

    // 编译白名单
    for (const src of cfg.allow) {
      try {
        let regex = src;
        if (regex.startsWith('(?i)')) {
          regex = regex.slice(4);
        }
        const hasInlineI = /^\(\?i\)/.test(src);
        const rx = new RegExp(regex, hasInlineI ? 'i' : '');
        this.allowRxs.push(rx);
      } catch {
        // 无效白名单在 normalizeCommandBlock 中应已被剔除，这里跳过
      }
    }
  }

  /** 获取当前扫描模式 */
  get mode(): CommandMode {
    return this.scanMode;
  }

  /**
   * 扫描文本中的危险命令
   *
   * 返回启用的模式的命中，跳过被白名单匹配的项。
   * 如果两个模式的匹配范围重叠，保留最早开始的那个（长度相同时保留顺序）。
   */
  scan(text: string): CommandHit[] {
    if (!text || typeof text !== 'string') return [];

    type PatternInfo = { id: string; label: string; rx: RegExp; enabled: boolean };
    const allHits: Array<{ pattern: PatternInfo; start: number; end: number; matched: string }> = [];

    // 收集所有模式的命中
    for (const pattern of this.patterns) {
      pattern.rx.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.rx.exec(text)) !== null) {
        const matched = m[0];
        // 空匹配（用户正则如 `a*`）不推进 lastIndex 会死循环，必须手动前进
        if (!matched) {
          pattern.rx.lastIndex++;
          continue;
        }
        const trimmed = matched.trim();
        if (!trimmed) continue;

        const start = m.index;
        const end = m.index + matched.length;
        allHits.push({ pattern, start, end, matched: trimmed });
      }
    }

    // 过滤掉白名单匹配的
    const filtered = allHits.filter((hit) => {
      const snippet = hit.matched.length <= 120 ? hit.matched : hit.matched.slice(0, 120);
      return !this.allowRxs.some((rx) => {
        rx.lastIndex = 0;
        return rx.test(snippet);
      });
    });

    // 去重重叠：保留最早开始的，tie 时保留顺序
    const sorted = filtered.sort((a, b) => a.start - b.start || a.pattern.rx.source.length - b.pattern.rx.source.length);
    const deduped: typeof sorted = [];
    for (const hit of sorted) {
      // 检查是否与已收入的命中重叠
      let overlaps = false;
      for (const existing of deduped) {
        // 如果新命中的起始位置在已收入命中的范围内，认为重叠
        if (hit.start < existing.end && hit.end > existing.start) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) {
        deduped.push(hit);
      }
    }

    // 转换为 CommandHit 格式
    return deduped.map((hit) => ({
      id: hit.pattern.id,
      label: hit.pattern.label,
      snippet: hit.matched.length <= 120 ? hit.matched : hit.matched.slice(0, 120),
      start: hit.start,
      end: hit.end,
    }));
  }

  /**
   * 改写：把匹配的部分替换成固定无害文本
   *
   * 返回 { text: 改写后的文本, hits: 找到的命中列表 }
   */
  rewrite(text: string): { text: string; hits: CommandHit[] } {
    const hits = this.scan(text);
    if (!hits.length) return { text, hits };

    // 按开始位置降序处理，避免改写时位置变化
    let result = text;
    const sorted = [...hits].sort((a, b) => b.start - a.start);
    for (const hit of sorted) {
      const before = result.slice(0, hit.start);
      const after = result.slice(hit.end);
      result = before + COMMAND_BLOCK_NOTICE + after;
    }

    return { text: result, hits };
  }

  /**
   * 工具调用参数（通常是 JSON 文本）专用：逐个字符串值扫描。
   * 直接扫 JSON 原文会漏检：`{"command":"rm -rf /"}` 里 `/` 后面紧跟的是引号，
   * 不满足规则的命令结尾边界。解析失败（流式残片、非 JSON）时退回扫原文。
   */
  scanToolArgs(argsText: string): CommandHit[] {
    return this.processToolArgs(argsText, false).hits;
  }

  /** 改写工具参数：命中的字符串值内替换为提示文本，再序列化回 JSON（解析失败则改写原文）。 */
  rewriteToolArgs(argsText: string): { text: string; hits: CommandHit[] } {
    return this.processToolArgs(argsText, true);
  }

  private processToolArgs(argsText: string, rewrite: boolean): { text: string; hits: CommandHit[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsText);
    } catch {
      return rewrite ? this.rewrite(argsText) : { text: argsText, hits: this.scan(argsText) };
    }
    const hits: CommandHit[] = [];
    const walk = (v: unknown, depth: number): unknown => {
      if (depth > 32) return v;
      if (typeof v === 'string') {
        if (!rewrite) {
          hits.push(...this.scan(v));
          return v;
        }
        const r = this.rewrite(v);
        hits.push(...r.hits);
        return r.text;
      }
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1);
        return out;
      }
      return v;
    };
    const next = walk(parsed, 0);
    return { text: rewrite && hits.length ? JSON.stringify(next) : argsText, hits };
  }
}
