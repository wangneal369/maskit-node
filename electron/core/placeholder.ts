import { SUFFIX_PAT } from './store';

/** 严格形态：脱敏时用它跳过已有占位符，防止多轮历史里的旧占位符被二次包裹。 */
export const PLACEHOLDER_RX = new RegExp(`\\{\\{[A-Z0-9]{1,12}_${SUFFIX_PAT}\\}\\}`, 'g');

/**
 * 还原用的合并正则：一次扫描识别全部形态，按分支先后决定优先级。
 * 必须单遍替换——分多遍时，前一遍换回的原文若恰好长得像占位符，会被后一遍再替换一次。
 * 分组：1/2 转义形态（`\{\{X\}\}`，1–3 个反斜杠）；3/4 标准双花括号（容内部空白与大小写）；
 *       5/6 单/半花括号（`{X}`、`{{X}`、`{X}}`）；7/8 裸形态（模型剥掉了花括号）。
 */
export const RESTORE_RX = new RegExp(
  [
    String.raw`(?:\\{1,3}\{){2}\s*([A-Za-z0-9_]{1,12})_(${SUFFIX_PAT})\s*(?:\\{1,3}\}){2}`,
    String.raw`\{\{\s*([A-Za-z0-9_]{1,12})_(${SUFFIX_PAT})\s*\}\}`,
    String.raw`\{{1,2}\s*([A-Za-z0-9_]{1,12})_(${SUFFIX_PAT})\s*\}{1,2}`,
    String.raw`(?<![A-Za-z0-9_{\\])([A-Z][A-Z0-9_]{0,11})_([bcdfghjkmnpqrstvwxz]{6})(?![A-Za-z0-9_}])`,
  ].join('|'),
  'g',
);

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
