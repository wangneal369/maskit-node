/**
 * 请求体文本脱敏：JSON 体走协议感知的 maskJson，其余整段扫描。
 * 零命中时逐字节原样返回，保住上游前缀缓存。
 */
import type { Masker, MaskHit } from './masker';
import { maskJson } from './tree';

export interface BodyMaskResult {
  text: string;
  hits: MaskHit[];
  signedBlocksSkipped: number;
}

export function maskBody(masker: Masker, text: string): BodyMaskResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed !== null && typeof parsed === 'object') {
    // 深度超限等异常向上抛，由调用方阻断，绝不静默放行明文
    const r = maskJson(masker, parsed);
    return { text: r.changed ? JSON.stringify(r.body) : text, hits: r.hits, signedBlocksSkipped: r.signedBlocksSkipped };
  }
  const hits = new Map<string, MaskHit>();
  return { text: masker.mask(text, hits), hits: [...hits.values()], signedBlocksSkipped: 0 };
}
