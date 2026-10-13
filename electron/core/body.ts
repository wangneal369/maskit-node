/**
 * 请求体文本脱敏：JSON 体走协议感知的 maskJson，其余整段扫描。
 * 零命中时逐字节原样返回，命中时优先就地替换（见 rewrite.ts），保住上游前缀缓存。
 */
import type { Masker, MaskHit } from './masker';
import type { MaskJsonOptions } from './tree';
import { maskRequestText } from './rewrite';

export interface BodyMaskResult {
  text: string;
  hits: MaskHit[];
  signedBlocksSkipped: number;
}

export function maskBody(masker: Masker, text: string, opts?: MaskJsonOptions): BodyMaskResult {
  const r = maskRequestText(masker, text, opts);
  return { text: r.text, hits: r.hits, signedBlocksSkipped: r.signedBlocksSkipped };
}
