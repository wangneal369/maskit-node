/**
 * 凭证类标签：这类映射的原文是密钥/令牌，绝不允许落盘（仅存活于内存）。
 * MappingStore 经 safeLabel() 会剥掉下划线（API_KEY → APIKEY），
 * 所以两种写法都要认。
 */
export const CREDENTIAL_LABELS: ReadonlySet<string> = new Set([
  'API_KEY', 'TOKEN', 'SECRET', 'ACCESS_KEY', 'JWT', 'CONNSTR', 'PRIVATE_KEY',
  'APIKEY', 'ACCESSKEY', 'PRIVATEKEY',
]);

export function isCredentialLabel(label: string): boolean {
  const up = label.toUpperCase();
  return CREDENTIAL_LABELS.has(up) || CREDENTIAL_LABELS.has(up.replace(/[^A-Z0-9]+/g, ''));
}
