/**
 * 内置扫描规则。
 * 顺序有语义：CONNSTR 必须排在 EMAIL 之前（EMAIL 要避让被豁免的连接串区间）。
 */
import {
  cardOk, connstrOk, emailOk, ibanOk, idcardOk, jwtOk, landlineOk, phoneOk,
  ipPublicOk, ipv6PrivateOk, usccOk,
} from './validators';

export type RuleLabel =
  | 'PRIVATE_KEY' | 'API_KEY' | 'ACCESS_KEY' | 'JWT' | 'TOKEN' | 'SECRET' | 'CONNSTR'
  | 'PHONE' | 'EMAIL' | 'LANDLINE' | 'PLATE' | 'HKID' | 'IDCARD'
  | 'IP_PRIVATE' | 'IP_INTERNAL' | 'IPV6_PRIVATE' | 'IP_PUBLIC' | 'CARD' | 'IBAN' | 'USCC' | 'MAC';

export interface Rule {
  rx: RegExp;
  label: RuleLabel;
  /** 只替换该捕获组（0 = 整个匹配） */
  group: number;
  validate?: (orig: string, m: RegExpExecArray, text: string) => boolean;
}

const ID_BOUND_L = '(?<![A-Za-z0-9])';
const ID_BOUND_R = '(?![A-Za-z0-9])';
const IP_BOUND_R = '(?![A-Za-z0-9]|\\.\\d)';
// 公网 IPv4 专用边界：强防误伤定宽断言
// 左边界：挡住字母数字、字母数字连字符/下划线、包名域名点号前缀与多段版本截断
const IP_PUBLIC_BOUND_L = '(?<![A-Za-z0-9][-_])(?<![A-Za-z0-9]\\.)(?<![A-Za-z0-9])';
// 右边界：挡住字母数字、点号文件后缀（.jar/.tar.gz/.js）与连字符标签/构建号后缀（-beta/-SNAPSHOT/-5）
const IP_PUBLIC_BOUND_R = '(?![A-Za-z0-9]|\\.[A-Za-z0-9]|[-_][A-Za-z0-9])';
const MOBILE_CC = '(?:(?:\\+?86|0086|[\\(（]\\+?86[\\)）])[\\s-]?)?';

/** 全局 + 捕获组下标（d）是必须的：分组替换要拿到组的精确区间。 */
const rx = (src: string, flags = '') => new RegExp(src, `gd${flags}`);

export const RULES: Rule[] = [
  { label: 'PRIVATE_KEY', group: 0, rx: rx('-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----(?:[^-]|-(?!-)){20,}?-----END[^-]*PRIVATE KEY-----') },
  { label: 'API_KEY', group: 0, rx: rx('(?<![A-Za-z0-9_-])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}(?![A-Za-z0-9_-])') },
  { label: 'API_KEY', group: 0, rx: rx('(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{50,}(?![A-Za-z0-9_-])') },
  { label: 'API_KEY', group: 0, rx: rx('(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35,38}(?![A-Za-z0-9_-])') },
  { label: 'ACCESS_KEY', group: 0, rx: rx('(?<![A-Za-z0-9_-])LTAI[A-Za-z0-9]{12,20}(?![A-Za-z0-9_-])') },
  { label: 'ACCESS_KEY', group: 0, rx: rx('(?<![A-Za-z0-9_-])AKID[A-Za-z0-9]{13,32}(?![A-Za-z0-9_-])') },
  { label: 'API_KEY', group: 0, rx: rx('(?<![A-Za-z0-9_-])xox[baprs]-[0-9A-Za-z-]{10,}(?![A-Za-z0-9-])') },
  { label: 'API_KEY', group: 0, rx: rx('(?<![A-Za-z0-9_-])[sr]k_(?:live|test)_[0-9A-Za-z]{20,}(?![A-Za-z0-9])') },
  { label: 'API_KEY', group: 0, rx: rx('(?<![A-Za-z0-9_-])cli_[a-z0-9]{16,}(?![a-z0-9])') },
  { label: 'API_KEY', group: 0, rx: rx('(?<![A-Za-z0-9_-])ding[a-z0-9]{6,}(?![a-z0-9])') },
  { label: 'ACCESS_KEY', group: 0, rx: rx('(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])') },
  { label: 'ACCESS_KEY', group: 1, rx: rx('aws[_-]?secret[_-]?access[_-]?key["\']?\\s*[:=]\\s*["\']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])', 'i') },
  { label: 'JWT', group: 0, validate: jwtOk, rx: rx('(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])') },
  { label: 'TOKEN', group: 1, rx: rx('\\bBearer\\s+([A-Za-z0-9._~+/=-]{20,})', 'i') },
  {
    label: 'SECRET', group: 1,
    rx: rx(
      '(?:(?<![A-Za-z0-9_.])(?:password|passwd|pwd|secret|token|api[_-]?key'
      + '|access[_-]?key|private[_-]?key)(?![A-Za-z0-9_.])'
      + '|(?:密码|口令|令牌|密钥|秘钥|密匙|凭据|凭证|私钥|授权码|访问密钥|接口密钥))'
      + '["\'“”「」]?\\s*[:=：＝]\\s*["\'“”「」]?(?!/)'
      + '(?=[A-Za-z0-9!@#$%^&*_~+=-]*[0-9!@#$%^&*])'
      + '([A-Za-z0-9!@#$%^&*_~+=-]{6,64})(?![A-Za-z0-9!@#$%^&*_~+=-])',
      'i',
    ),
  },
  {
    label: 'CONNSTR', group: 1,
    rx: rx('\\b[a-z][a-z0-9+.-]{0,63}://[^\\s:@/]+:([^\\s@/]{4,})@', 'i'),
    validate: (orig, m, text) => connstrOk(orig, m[0], text, m.index + m[0].length),
  },
  { label: 'PHONE', group: 0, validate: phoneOk, rx: rx(`${ID_BOUND_L}${MOBILE_CC}1[3-9]\\d(?:([-\\s])\\d{4}\\1\\d{4}|\\d{8})${ID_BOUND_R}`) },
  {
    label: 'EMAIL', group: 0, validate: emailOk,
    rx: rx('(?<!:)(?<![A-Za-z0-9._\\u4e00-\\u9fff])[a-zA-Z0-9_\\u4e00-\\u9fff][\\u4e00-\\u9fffA-Za-z0-9._%+-]{0,63}@[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*\\.[a-zA-Z\\u4e00-\\u9fff]{2,}(?![A-Za-z0-9._%+-])'),
  },
  {
    label: 'LANDLINE', group: 0, validate: landlineOk,
    rx: rx(
      `${ID_BOUND_L}${MOBILE_CC}(?:[\\(（]0(?:10|2\\d|[3-9]\\d{2})[\\)）][\\s-]?[2-9]\\d{6,7}`
      + '|0(?:10|2\\d|[3-9]\\d{2})[-\\s][2-9]\\d{6,7})'
      + `(?:[-\\s]?(?:转|分机|ext|x|#)[-\\s]?\\d{1,5})?${ID_BOUND_R}`,
      'i',
    ),
  },
  { label: 'PLATE', group: 0, rx: rx('(?<![A-Za-z0-9])[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-Z](?=[A-Z0-9]{0,5}\\d)[A-Z0-9]{5,6}(?![A-Z0-9])') },
  { label: 'HKID', group: 0, rx: rx(`${ID_BOUND_L}H\\d{8}${ID_BOUND_R}`) },
  { label: 'IDCARD', group: 0, validate: idcardOk, rx: rx(`${ID_BOUND_L}(?:1[1-5]|2[1-3]|3[1-7]|4[1-6]|5[0-4]|6[1-5]|71|8[12])\\d{13}${ID_BOUND_R}`) },
  { label: 'IDCARD', group: 0, validate: idcardOk, rx: rx(`${ID_BOUND_L}(?:1[1-5]|2[1-3]|3[1-7]|4[1-6]|5[0-4]|6[1-5]|71|8[12])\\d{15}[\\dXx]${ID_BOUND_R}`) },
  { label: 'IP_PRIVATE', group: 0, rx: rx(`${ID_BOUND_L}(?:192\\.168\\.\\d{1,3}\\.\\d{1,3}|169\\.254\\.\\d{1,3}\\.\\d{1,3})${IP_BOUND_R}`) },
  { label: 'IP_PRIVATE', group: 0, rx: rx(`${ID_BOUND_L}100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3}${IP_BOUND_R}`) },
  { label: 'IP_INTERNAL', group: 0, rx: rx(`${ID_BOUND_L}(?:10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})${IP_BOUND_R}`) },
  // IPv6 私网地址（fe80:: 链路本地 / fc00::/7 ULA）：宽正则抓候选，_ipv6_private_ok 保证只脱私网段
  { label: 'IPV6_PRIVATE', group: 0, validate: ipv6PrivateOk, rx: rx('(?<![0-9A-Fa-f.])[0-9A-Fa-f:]{2,45}(?![0-9A-Fa-f:])') },
  // 公网 IPv4：严格限定各段 0-255，_ip_public_ok 剔除私网保留段、组播与知名公共 DNS
  {
    label: 'IP_PUBLIC', group: 0, validate: ipPublicOk,
    rx: rx(`${IP_PUBLIC_BOUND_L}(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d?|[1-9])(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3})${IP_PUBLIC_BOUND_R}`),
  },
  { label: 'CARD', group: 0, validate: cardOk, rx: rx(`${ID_BOUND_L}(?:[3-6]\\d{12,18}|[3-6]\\d{2,5}(?:([ -])\\d{1,6}){1,4})${ID_BOUND_R}`) },
  { label: 'IBAN', group: 0, validate: ibanOk, rx: rx(`${ID_BOUND_L}[A-Z]{2}\\d{2}[A-Z0-9]{11,30}${ID_BOUND_R}`) },
  // 统一社会信用代码：18 位，需过 GB 32100-2015 校验
  { label: 'USCC', group: 0, validate: usccOk, rx: rx(`${ID_BOUND_L}[0-9A-HJ-NPQRTUWXY]{2}\\d{6}[0-9A-HJ-NPQRTUWXY]{10}${ID_BOUND_R}`) },
  { label: 'MAC', group: 0, rx: rx('(?<![0-9A-Fa-f:-])[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\\1){4}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:-])') },
];

/** 特征预检：文本不含任一特征子串则整条规则跳过（只放保守、必含的片段）。 */
export const RULE_MARKERS: Partial<Record<RuleLabel, string[]>> = {
  PRIVATE_KEY: ['PRIVATE KEY'],
  CONNSTR: ['://'],
  API_KEY: ['gh', 'AIza', 'xox', 'sk_', 'rk_', 'cli_', 'ding'],
  ACCESS_KEY: ['AK', 'LTAI', 'AKID', 'aws', 'AWS'],
  JWT: ['eyJ'],
  TOKEN: ['Bearer', 'bearer', 'BEARER'],
  SECRET: ['=', ':', '：', '＝'],
  PHONE: ['1'],
  EMAIL: ['@'],
  LANDLINE: ['0'],
  IP_PRIVATE: ['192.', '169.', '100.'],
  IP_INTERNAL: ['10.', '172.'],
  // IPv6 私网首组必是 fe80-febf（fe8/fe9/fea/feb）或 fc00-fdff（fc/fd）
  // 只列小写：该规则按大小写不敏感比对（见 RULE_MARKERS_CI）
  IPV6_PRIVATE: ['fe8', 'fe9', 'fea', 'feb', 'fc', 'fd'],
  IP_PUBLIC: ['.'],  // 公网 IP 最保险特征就是含小数点（避免与版本号混淆）
  USCC: ['A', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R', 'T', 'U', 'W', 'X', 'Y'],  // 排除 I/O/S/V/Z 的字母标记
};

/** 预检需要大小写不敏感的规则标签 */
export const RULE_MARKERS_CI = new Set<RuleLabel>(['IPV6_PRIVATE']);

/** 默认开启 7 类核心规则，其余按需开启。 */
export const DEFAULT_BUILTIN_RULES: Record<RuleLabel, boolean> = {
  API_KEY: true, CARD: true, CONNSTR: true, EMAIL: true, IDCARD: true, LANDLINE: true, PHONE: true,
  ACCESS_KEY: false, HKID: false, IBAN: false, IP_INTERNAL: false, IP_PRIVATE: false,
  IPV6_PRIVATE: false, IP_PUBLIC: false, JWT: false, MAC: false, PLATE: false, PRIVATE_KEY: false, SECRET: false, TOKEN: false, USCC: false,
};

export const DEFAULT_SECRET_PREFIXES = ['sk-', 'ah-', 'ghp_', 'glpat-', 'xoxb-', 'xoxp-', 'pypi-', 'npm_', 'dify-'];

/** 前缀凭据正则：- 与 _ 视为等价，前缀后至少 8 位密文字符。 */
export function buildPrefixRegex(prefixes: string[]): RegExp | null {
  const parts = prefixes.filter(Boolean).map((p) =>
    [...p].map((ch) => (ch === '-' || ch === '_' ? '[-_]' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join(''));
  if (!parts.length) return null;
  return new RegExp(`(?<![A-Za-z0-9_-])(?:${parts.join('|')})[A-Za-z0-9][A-Za-z0-9_-]{7,}(?![A-Za-z0-9_-])`, 'g');
}
