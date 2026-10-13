/**
 * 被动审计模块：扫描 LLM 响应中的安全风险（错误泄漏、响应投毒）。
 *
 * 纯函数硬约束：
 * - 永不修改入参（仅读）
 * - 永不抛异常（检测失败返回空列表）
 * - 永不依赖外部 I/O（仅 stdlib 等效物）
 */

import crypto from 'crypto';

// ========== 严重度 ==========
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface AuditFinding {
  kind: string;
  severity: Severity;
  title: string;
  evidence: string;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

// ========== S1 error_leak：错误响应泄漏 ==========

/**
 * 凭据检测正则表达式列表
 */
const SECRET_REGEX_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{20,}/g, 'sk_prefix_secret'],
  [/Bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/gi, 'bearer_token'],
  [/(?:AKIA|ASIA)[0-9A-Z]{16}/g, 'aws_access_key'],
  [/AIza[0-9A-Za-z_-]{35}/g, 'google_api_key'],
  [/[?&]key=[A-Za-z0-9_\-]{25,}/g, 'google_key_url_param'],
  [/ya29\.[A-Za-z0-9_.~+/\-]{20,}/g, 'gcp_oauth_token'],
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*/g, 'jwt_token'],
  [/-----BEGIN[A-Z \-]{0,40}PRIVATE KEY-----/g, 'pem_private_key'],
  [/(?<=:\/\/)[^\s'"]*:[^\s'"@]+(?=@)/g, 'db_connstring_password'],
];

/**
 * 凭据类环境变量：认形状不认名字。
 */
const ENV_CRED_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS)\b\s*[=:]/g;

/**
 * 任务 #24：形状命中后校验值的熵。
 * 阈值参考 gitleaks/trufflehog 的通行做法。
 */
const ENV_VALUE_MIN_LEN = 20;
const ENV_VALUE_MIN_ENTROPY = 3.0;

/**
 * 连续有序序列（字母表/数字顺逆序）是示例值惯用形态。
 */
const ORDERED_SEQS = [
  'abcdefghijklmnopqrstuvwxyz',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  '0123456789',
];

/**
 * 用户主目录路径：POSIX /home、macOS /Users、Windows %SystemDrive%\Users
 */
const HOME_PATH_RE = /(?:\/home\/|\/Users\/|[A-Za-z]:\\(?:users|Users)\\)[^\s/\\'"]{1,64}/gi;

/**
 * 堆栈帧：认帧格式不认语言。
 */
const STACK_FRAME_RE = /File\s+"[^"\n]+",\s*line\s+\d+|\bat\s+[\w$.<>\/\\-]+\s*\([^)\n]*:\d+(?::\d+)?\)|\bgoroutine\s+\d+\s*\[/g;

/**
 * 自身探针标记（主动探针注入的假 secret）
 */
const SELF_PROBE_MARKERS = ['fake-token', 'xapi-probe', 'nothing-real', 'auth-probe'];

/**
 * Shannon 熵（base 2，bit/char）。空串返回 0。
 */
function valueEntropy(value: string): number {
  if (!value) return 0;
  const n = value.length;
  const freqs = new Map<string, number>();
  for (const ch of value) {
    freqs.set(ch, (freqs.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freqs.values()) {
    const p = count / n;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

/**
 * 检查是否为有序序列
 */
function isOrderedSeq(value: string): boolean {
  const low = value.toLowerCase();
  return ORDERED_SEQS.some((seq) => low.includes(seq) || low.includes(seq.split('').reverse().join('')));
}

/**
 * 检查是否为自身探针标记
 */
function isSelfProbe(textSnippet: string): boolean {
  const low = textSnippet.toLowerCase();
  return SELF_PROBE_MARKERS.some((m) => low.includes(m));
}

/**
 * 凭据证据脱敏：只留类型 + 长度 + 不可逆摘要
 */
function redactEvidence(snippet: string, kind: string): string {
  if (!snippet) return '';
  try {
    const digest = crypto.createHash('sha256').update(snippet, 'utf-8').digest('hex').slice(0, 16);
    return `${kind} len=${snippet.length} sha256=${digest}`;
  } catch {
    return `${kind} len=${snippet.length} sha256=?`;
  }
}

/**
 * 去重：按 (kind, evidence) 去重，重复次数并进 evidence
 */
function dedupeFindings(items: AuditFinding[]): AuditFinding[] {
  const index = new Map<string, AuditFinding & { _n?: number }>();
  const out: AuditFinding[] = [];

  for (const f of items) {
    const key = `${f.kind}|||${f.evidence}`;
    const hit = index.get(key);
    if (hit) {
      hit._n = (hit._n ?? 1) + 1;
    } else {
      index.set(key, f as AuditFinding & { _n?: number });
      out.push(f);
    }
  }

  for (const f of out) {
    const fin = f as AuditFinding & { _n?: number };
    const n = fin._n ?? 1;
    if (n > 1) {
      f.evidence = `${f.evidence} (x${n})`;
    }
    delete fin._n;
  }

  return out;
}

/**
 * S1：错误响应泄漏扫描。
 *
 * 触发条件：statusCode >= 400。
 * 返回 findings 列表，evidence 中的凭据已掩码。
 */
export function scanErrorLeak(statusCode: number, bodyText: string): AuditFinding[] {
  if (statusCode == null) return [];

  let sc: number;
  try {
    sc = Number(statusCode);
  } catch {
    return [];
  }

  if (sc < 400) return [];

  const hay = `${bodyText || ''}\n`;
  if (!hay.trim()) return [];

  const results: AuditFinding[] = [];

  // 凭据正则扫描
  for (const [rxTemplate, kind] of SECRET_REGEX_PATTERNS) {
    // 为了避免全局状态问题，对每个匹配创建新的正则对象
    const rx = new RegExp(rxTemplate.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = rx.exec(hay)) !== null) {
      const snippet = match[0].slice(0, 80);
      if (isSelfProbe(snippet)) continue;

      const severity: Severity =
        ['sk_prefix_secret', 'bearer_token', 'aws_access_key', 'pem_private_key'].includes(kind)
          ? 'CRITICAL'
          : 'HIGH';

      results.push({
        kind,
        severity,
        title: `错误响应泄漏 (${kind})`,
        evidence: `${kind}: ${redactEvidence(snippet, kind)}`,
      });
    }
  }

  // 环境变量（值熵校验）
  ENV_CRED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENV_CRED_RE.exec(hay)) !== null) {
    const val = hay.slice(m.index + m[0].length);
    const vm = /^[^\s'"`,;\]}]+|$/.exec(val);
    const valStr = vm ? vm[0] : '';

    if (
      valStr.length < ENV_VALUE_MIN_LEN ||
      valueEntropy(valStr) < ENV_VALUE_MIN_ENTROPY ||
      isOrderedSeq(valStr)
    ) {
      continue;
    }

    results.push({
      kind: 'env_var',
      severity: 'HIGH',
      title: '错误响应泄漏 (env_var)',
      evidence: `env_var: ${m[0].slice(0, 60)}`,
    });
  }

  // 主目录路径
  HOME_PATH_RE.lastIndex = 0;
  while ((m = HOME_PATH_RE.exec(hay)) !== null) {
    results.push({
      kind: 'fs_path',
      severity: 'LOW',
      title: '错误响应泄漏 (fs_path)',
      evidence: `fs_path: ${m[0].slice(0, 60)}`,
    });
  }

  // 堆栈帧
  STACK_FRAME_RE.lastIndex = 0;
  while ((m = STACK_FRAME_RE.exec(hay)) !== null) {
    results.push({
      kind: 'stack_trace',
      severity: 'LOW',
      title: '错误响应泄漏 (stack_trace)',
      evidence: `stack_trace: ${m[0].slice(0, 60)}`,
    });
  }

  return dedupeFindings(results);
}

// ========== S6 response_poison：响应投毒 ==========

/**
 * 隐藏 Unicode 高危档：双向覆盖/隔离符
 */
const HIDDEN_UNICODE_HIGH = /[‪-‮⁦-⁩]/g;

/**
 * 隐藏 Unicode 低危档：零宽字符与 BOM
 */
const HIDDEN_UNICODE_LOW = /[​-‍﻿]/g;

const HIDDEN_LOW_THRESHOLD = 8;

/**
 * 自动拉取型 URL：Markdown 图片与 HTML img/iframe/script 的 src
 */
const AUTOFETCH_URL_RE =
  /!\[[^\]]{0,200}\]\(\s*(https?:\/\/[^\s)]+)|<(?:img|iframe|script)\b[^>]{0,300}?\bsrc\s*=\s*["']?(https?:\/\/[^\s"'>]+)/gi;

/**
 * query 里挂着长编码串 = 正在往外带数据
 */
const EXFIL_PAYLOAD_RE = /[?&][\w.\-]{1,24}=([A-Za-z0-9+/%_\-]{24,})/g;

/**
 * 凭据检测正则（响应侧）
 */
const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{20,}/g, 'sk_prefix_secret'],
  [/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}/g, 'github_token'],
  [/AIza[0-9A-Za-z_-]{35}/g, 'google_api_key'],
  [/LTAI[A-Za-z0-9]{12,20}/g, 'aliyun_ak'],
  [/AKID[A-Za-z0-9]{13,20}/g, 'tencent_ak'],
  [/xox[baprs]-[0-9A-Za-z-]{10,}/g, 'slack_token'],
  [/[sr]k_(?:live|test)_[0-9A-Za-z]{20,}/g, 'stripe_key'],
  [/AKIA[A-Z0-9]{16}/g, 'aws_ak'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'jwt'],
];

/**
 * 提示词注入 - 指令覆盖：中文与英文
 */
const INSTRUCTION_OVERRIDE_RE =
  /(?:忽略|无视|忘记|忘掉|抛弃|舍弃|覆盖|推翻|绕过|不必理会|不要理会)[^\n。；;]{0,16}(?:之前|先前|以上|上述|前面|所有|全部|原先)[^\n。；;]{0,12}(?:指令|指示|规则|设定|约束|提示词|提示语|系统消息|要求)|(?:ignore|disregard|forget|override|overwrite|bypass|discard)(?:\s+\w+){0,4}\s+(?:previous|prior|above|earlier|preceding|all|any)\s+(?:instructions?|prompts?|rules?|directions?|guidelines?|system message)/gi;

/**
 * 索要系统提示词
 */
const PROMPT_EXTRACT_RE =
  /(?:输出|打印|复述|重复|告诉我|展示|显示|泄露|粘贴|读出|回显)[^\n。；;]{0,16}?(?:系统提示词|系统提示|系统消息|初始指令|初始提示|预设指令)|(?:你的|您的|自己的|内部的)(?:系统|初始|预设|内部|自定义|原始)?(?:提示词|提示|消息|指令|设定)[^\n。；;]{0,10}?(?:复述|重复|打印|泄露|粘贴|读出|回显|原文给出)|(?:原样|完整|逐字|一字不差|全文|毫无保留)[^\n。；;]{0,4}?(?:输出|显示|给出|告诉我)|(?:repeat|print|output|show|reveal|disclose|paste|echo)(?:\s+\w+){0,4}\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions?|initial instructions?|system message)/gi;

/**
 * 凭据外发指令
 */
const CREDENTIAL_EXFIL_RE =
  /(?:api[\s_\-]?key|apikey|access[\s_\-]?key|secret[\s_\-]?key|secret|token|密钥|私钥|密码|口令|凭据|凭证|credential|环境变量|\.env\b)[^\n。；;]{0,24}?(?:发送|发给|上传|提交|粘贴|填入|回传|转发|传给|发往|泄漏给|暴露给)[^\n。；;]{0,16}?(?:https?:\/\/|@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})|(?:api[\s_\-]?key|apikey|access[\s_\-]?key|secret[\s_\-]?key|secret|token|密钥|私钥|密码|口令|凭据|凭证|credential|环境变量|\.env\b)[^\n。；;]{0,24}?(?:send|upload|submit|paste|post|forward|transmit|exfiltrate|share)[^\n。；;]{0,16}?(?:https?:\/\/|@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})|(?:send|upload|submit|paste|post|forward|transmit|exfiltrate|share)(?:\s+\w+){0,3}\s+(?:api[\s_\-]?key|apikey|access[\s_\-]?key|secret[\s_\-]?key|secret|token|密钥|私钥|密码|口令|凭据|凭证|credential|环境变量|\.env\b)[\s\S]{0,24}?(?:https?:\/\/|@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/gi;

/**
 * 伪造协议级系统分隔符
 */
const FAKE_SYSTEM_MARKER_RE =
  /<\|(?:im_start|im_end|start_header_id|end_header_id|system|assistant|user)\|>|\[\/?INST\]|<<\/?SYS>>/gi;

/**
 * Markdown 伪系统标题
 */
const FAKE_SYSTEM_HEADING_RE = /^\s{0,3}#{2,4}\s*(?:system|instruction|系统提示|系统指令)\s*[:：]/gim;

/**
 * Base64 运行
 */
const B64_RUN_RE = /[A-Za-z0-9+/]{24,}={0,2}/g;

/**
 * Unicode 转义运行
 */
const UNICODE_ESC_RUN_RE = /(?:\\u[0-9a-fA-F]{4}){3,}/g;

/**
 * HTML 实体运行
 */
const HTML_ENTITY_RUN_RE = /(?:&#[0-9]{2,7};|&#x[0-9a-fA-F]{2,6};){3,}/g;

const DECODE_MAX_CANDIDATES = 32;
const DECODE_CONTEXT_CHARS = 120;

/**
 * 文本大小限制：只扫描前 512KB
 */
const MAX_TEXT_SIZE = 512 * 1024;

/**
 * 代码块信息：(segment, inCodeBlock)
 */
function splitCodeBlocks(text: string): Array<[string, boolean]> {
  if (!text) return [];
  const parts: Array<[string, boolean]> = [];
  let inCode = false;
  const buf: string[] = [];

  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) {
      if (buf.length) {
        parts.push([buf.join('\n'), inCode]);
        buf.length = 0;
      }
      inCode = !inCode;
      parts.push([line, true]);
    } else {
      buf.push(line);
    }
  }

  if (buf.length) {
    parts.push([buf.join('\n'), inCode]);
  }

  return parts;
}

/**
 * 代码块范围：返回代码块在原文里的字符区间 [(start, end)]
 */
function codeBlockRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let pos = 0;
  let start: number | null = null;

  for (const line of text.split('\n')) {
    const lineStart = pos;
    pos += line.length + 1;

    if (line.trim().startsWith('```')) {
      if (start === null) {
        start = lineStart;
      } else {
        ranges.push([start, lineStart + line.length]);
        start = null;
      }
    }
  }

  if (start !== null) {
    ranges.push([start, pos]);
  }

  return ranges;
}

/**
 * 标记是否落在行首（真实分隔符的形状）
 */
function markerIsTurnAnchored(seg: string, start: number): boolean {
  const lineStart = seg.lastIndexOf('\n', start) + 1;
  return seg.slice(lineStart, start).trim() === '';
}

/**
 * 掩码 evidence 中的凭据
 */
function maskCredsIn(snippet: string): string {
  let out = String(snippet || '');
  for (const [rx, kind] of [...CREDENTIAL_PATTERNS, ...SECRET_REGEX_PATTERNS]) {
    try {
      rx.lastIndex = 0;
      out = out.replace(rx, `<${kind}>`);
    } catch {
      // ignore
    }
  }
  return out;
}

/**
 * 抽出文本里可解码的编码片段并解码（base64 / \uXXXX / HTML实体）
 */
function decodeCandidates(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;

  let count = 0;

  // Base64
  const b64Rx = new RegExp(B64_RUN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = b64Rx.exec(text)) !== null && count < DECODE_MAX_CANDIDATES) {
    count++;
    const chunk = m[0];
    if (chunk.length > 4096) continue;

    try {
      const padded = chunk + '='.repeat((-chunk.length) % 4);
      const raw = Buffer.from(padded, 'base64');
      const decoded = raw.toString('utf-8');

      if (decoded && [...decoded].every((ch) => ch.charCodeAt(0) >= 32 || ['\n', '\r', '\t'].includes(ch))) {
        out.push(decoded);
      }
    } catch {
      // ignore
    }
  }

  // Unicode 转义
  const unicodeRx = new RegExp(UNICODE_ESC_RUN_RE.source, 'g');
  while ((m = unicodeRx.exec(text)) !== null && out.length < DECODE_MAX_CANDIDATES * 2) {
    try {
      const decoded = m[0].replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
      out.push(decoded + text.slice(m.index + m[0].length, m.index + m[0].length + DECODE_CONTEXT_CHARS));
      out.push(text.slice(Math.max(0, m.index - DECODE_CONTEXT_CHARS), m.index) + decoded);
    } catch {
      // ignore
    }
  }

  // HTML 实体
  const entityRx = new RegExp(HTML_ENTITY_RUN_RE.source, 'g');
  while ((m = entityRx.exec(text)) !== null && out.length < DECODE_MAX_CANDIDATES * 2) {
    try {
      let frag = m[0]
        .replace(/&#x([0-9a-fA-F]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/&#([0-9]+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));

      out.push(frag + text.slice(m.index + m[0].length, m.index + m[0].length + DECODE_CONTEXT_CHARS));
      out.push(text.slice(Math.max(0, m.index - DECODE_CONTEXT_CHARS), m.index) + frag);
    } catch {
      // ignore
    }
  }

  return out;
}

/**
 * S6：响应投毒扫描。
 *
 * 检测 LLM 回复（正文 + 工具参数拼接后的文本）里的注入 / 外发 / 隐藏字符等。
 * requestText：用户请求的文本（用于「是用户自己要求的就不报」回声判定）。
 */
export function scanResponsePoison(text: string, requestText?: string): AuditFinding[] {
  if (!text || typeof text !== 'string') return [];

  // 文本大小限制
  let scanText = text;
  if (scanText.length > MAX_TEXT_SIZE) {
    scanText = scanText.slice(0, MAX_TEXT_SIZE);
  }

  const results: AuditFinding[] = [];
  const payloadIndicators: string[] = [];

  // 隐藏 Unicode（高危档）
  const highHits = scanText.match(HIDDEN_UNICODE_HIGH) || [];
  if (highHits.length > 0) {
    const chars = highHits
      .slice(0, 5)
      .map((m) => `U+${m.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
      .join(',');

    results.push({
      kind: 'hidden_unicode',
      severity: 'HIGH',
      title: '隐藏 Unicode 双向覆盖符',
      evidence: `hidden_unicode: ${chars} (count=${highHits.length}) [双向覆盖符]`,
    });
    payloadIndicators.push('bidi_override');
  }

  // 隐藏 Unicode（低危档）
  const lowHits = scanText.match(HIDDEN_UNICODE_LOW) || [];
  if (lowHits.length >= HIDDEN_LOW_THRESHOLD) {
    const chars = lowHits
      .slice(0, 5)
      .map((m) => `U+${m.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
      .join(',');

    results.push({
      kind: 'hidden_unicode',
      severity: 'MEDIUM',
      title: '隐藏 Unicode 零宽字符成规模出现',
      evidence: `hidden_unicode: ${chars} (count=${lowHits.length}) [零宽字符成规模出现]`,
    });
    payloadIndicators.push('hidden_unicode');
  }

  // 自动拉取型外链（非 code block）
  for (const [seg, inCode] of splitCodeBlocks(scanText)) {
    if (inCode) continue;

    // 创建新的正则以避免全局状态问题
    const urlRx = new RegExp(AUTOFETCH_URL_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = urlRx.exec(seg)) !== null) {
      const url = m[1] || m[2] || '';
      if (!url) continue;

      const payloadRx = new RegExp(EXFIL_PAYLOAD_RE.source, 'g');
      const payload = payloadRx.exec(url);
      if (!payload) continue;

      const host = (() => {
        try {
          return new URL(url).hostname || '?';
        } catch {
          return '?';
        }
      })();

      let digest = '?';
      try {
        digest = crypto.createHash('sha256').update(url, 'utf-8').digest('hex').slice(0, 16);
      } catch {
        // ignore
      }

      results.push({
        kind: 'exfil_url',
        severity: 'HIGH',
        title: '自动外发 URL（含数据载荷）',
        evidence: `exfil_url host=${host.slice(0, 120)} len=${url.length} sha256=${digest} [渲染即自动请求，query载荷${payload[1].length}字符]`,
      });
      payloadIndicators.push('exfil_url');
    }
  }

  // 凭据回流扫描
  const codeRanges = codeBlockRanges(scanText);
  for (const [rxTemplate, kind] of CREDENTIAL_PATTERNS) {
    const rx = new RegExp(rxTemplate.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = rx.exec(scanText)) !== null) {
      // 回声抑制：请求里本来就有这串
      if (requestText && requestText.includes(m[0])) {
        continue;
      }

      const value = m[0];
      const inCode = codeRanges.some(([s, e]) => s <= m!.index && m!.index < e);
      const isSample =
        inCode ||
        value.length < ENV_VALUE_MIN_LEN ||
        isOrderedSeq(value) ||
        valueEntropy(value) <= ENV_VALUE_MIN_ENTROPY;

      results.push({
        kind: `credential_echo:${kind}`,
        severity: isSample ? 'LOW' : 'MEDIUM',
        title: isSample ? '凭据示例' : '疑似真实凭据',
        evidence: `${redactEvidence(value, kind)}${isSample ? ' [示例形态]' : ' [疑似真实凭据]'}`,
      });
    }
  }

  // ── S6 扩展：提示词注入 / 系统提示词索要 / 凭据外发指令 ──

  // 伪造协议级系统分隔符
  const markers: string[] = [];
  let anchored = false;
  for (const [seg, inCode] of splitCodeBlocks(scanText)) {
    if (inCode) continue;

    const markerRx = new RegExp(FAKE_SYSTEM_MARKER_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = markerRx.exec(seg)) !== null) {
      markers.push(m[0]);
      if (markerIsTurnAnchored(seg, m.index)) {
        anchored = true;
      }
    }
  }

  if (
    markers.length >= 2 &&
    anchored &&
    !(requestText && [...new Set(markers)].every((mk) => requestText.includes(mk)))
  ) {
    results.push({
      kind: 'fake_system_block',
      severity: 'MEDIUM',
      title: '伪造协议级系统轮次',
      evidence: `fake_system_block: ${[...new Set(markers)].join(',')} (count=${markers.length}) [伪造系统轮次]`,
    });
    payloadIndicators.push('fake_system_block');
  }

  // Markdown 伪系统标题
  for (const [seg, inCode] of splitCodeBlocks(scanText)) {
    if (inCode) continue;

    const headingRx = new RegExp(FAKE_SYSTEM_HEADING_RE.source, 'gim');
    const m = headingRx.exec(seg);
    if (m !== null) {
      const snippet = m[0].trim();
      if (!(requestText && requestText.includes(snippet))) {
        results.push({
          kind: 'fake_system_block',
          severity: 'MEDIUM',
          title: '伪造 Markdown 系统标题',
          evidence: `fake_system_block: ${maskCredsIn(snippet.slice(0, 40))} [正文伪系统标题]`,
        });
        payloadIndicators.push('fake_system_block');
      }
    }
    break; // 只扫第一段非 code block 正文
  }

  // 索要系统提示词
  let m: RegExpExecArray | null;
  const promptRx = new RegExp(PROMPT_EXTRACT_RE.source, 'gi');
  if ((m = promptRx.exec(scanText)) !== null) {
    const snippet = m[0];
    if (!(requestText && requestText.includes(snippet))) {
      results.push({
        kind: 'prompt_extraction',
        severity: 'MEDIUM',
        title: '索要系统提示词',
        evidence: `prompt_extraction: ${maskCredsIn(snippet.slice(0, 80))}`,
      });
      payloadIndicators.push('prompt_extraction');
    }
  }

  // 凭据外发指令
  const exfilRx = new RegExp(CREDENTIAL_EXFIL_RE.source, 'gi');
  if ((m = exfilRx.exec(scanText)) !== null) {
    const snippet = m[0];
    if (!(requestText && requestText.includes(snippet))) {
      results.push({
        kind: 'credential_exfil_instruction',
        severity: 'MEDIUM',
        title: '凭据外发指令',
        evidence: `credential_exfil_instruction: ${maskCredsIn(snippet.slice(0, 80))}`,
      });
      payloadIndicators.push('credential_exfil_instruction');
    }
  }

  // 泛化指令覆盖：只有同一段回复里另有客观载荷时才定罪
  if (payloadIndicators.length > 0) {
    const overrideRx = new RegExp(INSTRUCTION_OVERRIDE_RE.source, 'gi');
    if ((m = overrideRx.exec(scanText)) !== null) {
      const snippet = m[0];
      if (!(requestText && requestText.includes(snippet))) {
        results.push({
          kind: 'instruction_override',
          severity: 'MEDIUM',
          title: '指令覆盖（同现载荷）',
          evidence: `instruction_override: ${maskCredsIn(snippet.slice(0, 80))} [同现载荷:${[...new Set(payloadIndicators)].join(',')}]`,
        });
      }
    }
  }

  // 编码绕过：直接扫描零命中时，解码后再扫
  if (results.length === 0) {
    const prose = splitCodeBlocks(scanText)
      .filter(([, inCode]) => !inCode)
      .map(([seg]) => seg)
      .join('\n');

    for (const decoded of decodeCandidates(prose).slice(0, DECODE_MAX_CANDIDATES)) {
      const overrideTest = new RegExp(INSTRUCTION_OVERRIDE_RE.source, 'i');
      const promptTest = new RegExp(PROMPT_EXTRACT_RE.source, 'i');
      const exfilTest = new RegExp(CREDENTIAL_EXFIL_RE.source, 'i');
      const markerTest = new RegExp(FAKE_SYSTEM_MARKER_RE.source, 'i');

      if (
        !overrideTest.test(decoded) &&
        !promptTest.test(decoded) &&
        !exfilTest.test(decoded) &&
        !markerTest.test(decoded)
      ) {
        continue;
      }

      let digest = '?';
      try {
        digest = crypto.createHash('sha256').update(decoded, 'utf-8').digest('hex').slice(0, 16);
      } catch {
        // ignore
      }

      results.push({
        kind: 'encoded_instruction',
        severity: 'MEDIUM',
        title: '编码指令（base64/转义）',
        evidence: `encoded_instruction: ${maskCredsIn(decoded.slice(0, 80))} [base64/转义解码len=${decoded.length}sha256=${digest}]`,
      });
      break;
    }
  }

  return dedupeFindings(results);
}
