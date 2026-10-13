/**
 * 请求体脱敏 + 回写。
 *
 * 目标：别把客户端 body 的前缀整体挪位。上游按前缀做 Prompt Cache，整棵 JSON.stringify
 * 会改掉客户端排版（冒号后空格、\u 转义风格、1e-05 这类数字写法），首个差异位前移到 body 开头附近，
 * 整段 prompt 缓存 miss。所以命中后优先在原文上就地替换，只改敏感值本身。
 *
 * 三级：
 *   1. 无命中且无重复键 → 原文逐字节返回（unchanged）
 *   2. 就地替换（splice）+ 等价校验 JSON.parse(结果) 深等于已脱敏的树
 *   3. 重复键 / 超限 / 校验不过 → 整棵重序列化（reserialize）
 *
 * 正确性不依赖 splice：校验不过退回的是同一棵已脱敏的树，最差只是回到旧行为。
 * 重复键的体绝不 splice：被覆盖的值不在树里也不在替换表里，而 splice 结果解析回来仍等于脱敏树，
 * 校验会误判通过，明文照样出网。
 */
import type { Masker, MaskHit } from './masker';
import { maskJson, type MaskJsonOptions } from './tree';
import { hasDuplicateKeys } from './json-dupes';

export interface RewriteResult {
  text: string;
  changed: boolean;
  method: 'unchanged' | 'splice' | 'reserialize';
  hits: MaskHit[];
  signedBlocksSkipped: number;
}

/** 就地替换的体积上限（字符数）：大 body 实测 splice 与整棵序列化同价，不必更早退回 */
export const SPLICE_MAX = 8 << 20;
/** 替换形式（原文 × 转义风格）上限，另一条独立的退回线 */
export const SPLICE_MAX_FORMS = 128;

/** 同 Python ensure_ascii=True：非 ASCII 一律 \uXXXX（UTF-16 码元，astral 自然成代理对） */
function escapeNonAscii(s: string): string {
  return s.replace(/[^\x00-\x7f]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

const RX_ESC = /[.*+?^${}()|[\]\\]/g;

/** 在 raw 上把 pairs 的原文就地换成占位符；无可替换 / 超限返回 null。结果是否正确由调用方校验。 */
function spliceMask(raw: string, pairs: MaskHit[]): string | null {
  if (!pairs.length || !raw || raw.length > SPLICE_MAX) return null;
  const table = new Map<string, string>();
  for (const { orig, token } of pairs) {
    if (!orig || !token || orig === token) continue;
    const lit = JSON.stringify(orig).slice(1, -1);
    const rep = JSON.stringify(token).slice(1, -1);
    const litA = escapeNonAscii(lit);
    const repA = escapeNonAscii(rep);
    if (lit !== rep) table.set(lit, rep);
    if (litA !== repA) {
      table.set(litA, repA);
      // 部分序列化器输出大写十六进制
      const litU = litA.replace(/\\u[0-9a-f]{4}/g, (m) => '\\u' + m.slice(2).toUpperCase());
      if (litU !== litA) table.set(litU, repA);
    }
    if (table.size > SPLICE_MAX_FORMS) return null;
  }
  if (!table.size) return null;
  // 长 form 优先：交替是「首个匹配胜出」，短原文若是长原文的子串，排前面会把长原文切碎
  const forms = [...table.keys()].sort((a, b) => b.length - a.length);
  const rx = new RegExp(forms.map((f) => f.replace(RX_ESC, '\\$&')).join('|'), 'g');
  let n = 0;
  const out = raw.replace(rx, (m) => {
    n++;
    return table.get(m) as string;
  });
  return n ? out : null;
}

/** 严格深等：对象键集合相等（不论顺序，只认自有键）、数组有序、原始值按 === */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!deepEqual(x[i], y[i])) return false;
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const ka = Object.keys(x);
  if (ka.length !== Object.keys(y).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(y, k)) return false;
    if (!deepEqual(x[k], y[k])) return false;
  }
  return true;
}

/** 请求体脱敏 + 回写：无命中且无重复键 → 原文；否则优先就地替换，校验不过退回整棵序列化 */
export function maskRequestText(masker: Masker, raw: string, opts?: MaskJsonOptions): RewriteResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed === null || typeof parsed !== 'object') {
    // 非 JSON 体（含合法 JSON 标量）：整段当纯文本扫描
    const hits = new Map<string, MaskHit>();
    const text = masker.mask(raw, hits, opts?.entities);
    const changed = text !== raw;
    return { text, changed, method: changed ? 'reserialize' : 'unchanged', hits: [...hits.values()], signedBlocksSkipped: 0 };
  }
  const dupes = hasDuplicateKeys(raw);
  // 深度超限等异常向上抛，由调用方阻断，绝不静默放行明文
  const r = maskJson(masker, parsed, opts);
  if (!r.changed && !dupes) {
    return { text: raw, changed: false, method: 'unchanged', hits: r.hits, signedBlocksSkipped: r.signedBlocksSkipped };
  }
  if (!dupes) {
    try {
      const spliced = spliceMask(raw, r.hits);
      if (spliced !== null && deepEqual(JSON.parse(spliced), r.body)) {
        return { text: spliced, changed: true, method: 'splice', hits: r.hits, signedBlocksSkipped: r.signedBlocksSkipped };
      }
    } catch {
      // 退回整棵序列化
    }
  }
  let text = JSON.stringify(r.body);
  // 客户端用了 \u 转义风格就沿用，尽量贴近原文字节
  if (raw.includes('\\u')) text = escapeNonAscii(text);
  return { text, changed: true, method: 'reserialize', hits: r.hits, signedBlocksSkipped: r.signedBlocksSkipped };
}
