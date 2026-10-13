import { SUFFIX_PAT } from './store';

/** 严格形态：脱敏时用它跳过已有占位符，防止多轮历史里的旧占位符被二次包裹。 */
export const PLACEHOLDER_RX = new RegExp(`\\{\\{[A-Z0-9]{1,12}_${SUFFIX_PAT}\\}\\}`, 'g');

/** 容错形态：允许内部空白与标签大小写改写（模型常写成 `{{ EMAIL_xxx }}`）。 */
export const BRACED_PLACEHOLDER_RX = new RegExp(`\\{\\{\\s*([A-Za-z0-9_]{1,12})_(${SUFFIX_PAT})\\s*\\}\\}`, 'g');

/** 裸形态：模型把花括号剥掉（写命令时常把 {{}} 当模板语法整理掉）。只还原本表签发过的。 */
export const BARE_PLACEHOLDER_RX = /(?<![A-Za-z0-9_{])([A-Z][A-Z0-9]{0,11})_([bcdfghjkmnpqrstvwxz]{6})(?![A-Za-z0-9_}])/g;

/** 流式：行尾半截占位符（可能被切在两个 chunk 之间），需扣留到下个 chunk。 */
export const PARTIAL_RX = /(?:\\{0,3}\{){1,3}\s{0,4}[A-Za-z0-9_]{0,20}\s{0,4}\\{0,3}\}?\\{0,3}$|\\{1,3}$/;
export const PARTIAL_MAX = 48;

/**
 * 对 text 中「非占位符」的片段逐段调用 fn，占位符原样保留。
 * fn 接收片段文本，返回替换后的文本。
 */
export function mapOutsidePlaceholders(text: string, fn: (chunk: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER_RX)) {
    if (m.index > last) out += fn(text.slice(last, m.index));
    out += m[0];
    last = m.index + m[0].length;
  }
  if (last < text.length) out += fn(text.slice(last));
  return out;
}
