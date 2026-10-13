/**
 * 规则命中后的语义校验。
 * 原则：正则只抓候选，误报由这里挡；拿不准时偏向脱敏（fail-closed）。
 */

const PROVINCES = new Set([
  '11', '12', '13', '14', '15', '21', '22', '23',
  '31', '32', '33', '34', '35', '36', '37',
  '41', '42', '43', '44', '45', '46', '50', '51', '52', '53', '54',
  '61', '62', '63', '64', '65', '71', '81', '82',
]);
const IDCARD_W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const IDCARD_CODE = '10X98765432';

function isRealDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function luhnOk(num: string): boolean {
  const digits = [...num].filter((c) => c >= '0' && c <= '9').map(Number);
  if (digits.length < 12) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits[i];
    if (dbl) d = d > 4 ? d * 2 - 9 : d * 2;
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** 银行卡：去分隔符后 13-19 位纯数字且过 Luhn（分组那支正则不锁位数，必须显式验）。 */
export function cardOk(orig: string): boolean {
  const digits = orig.replace(/[ -]/g, '');
  return /^\d{13,19}$/.test(digits) && luhnOk(digits);
}

function idcard18Ok(num: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(num) || !PROVINCES.has(num.slice(0, 2))) return false;
  const y = +num.slice(6, 10);
  const m = +num.slice(10, 12);
  const d = +num.slice(12, 14);
  if (!isRealDate(y, m, d) || y < 1880 || y > new Date().getFullYear()) return false;
  let total = 0;
  for (let i = 0; i < 17; i++) total += +num[i] * IDCARD_W[i];
  return num[17].toUpperCase() === IDCARD_CODE[total % 11];
}

function idcard15Ok(num: string): boolean {
  if (!/^\d{15}$/.test(num) || !PROVINCES.has(num.slice(0, 2))) return false;
  return isRealDate(1900 + +num.slice(6, 8), +num.slice(8, 10), +num.slice(10, 12));
}

export function idcardOk(num: string): boolean {
  if (num.length === 18) return idcard18Ok(num);
  if (num.length === 15) return idcard15Ok(num);
  return false;
}

export function phoneOk(numStr: string): boolean {
  let digits = numStr.replace(/\D/g, '');
  if (digits.startsWith('86') && digits.length === 13) digits = digits.slice(2);
  else if (digits.startsWith('0086') && digits.length === 15) digits = digits.slice(4);
  if (!/^1[3-9]\d{9}$/.test(digits)) return false;
  return new Set(digits).size > 1;
}

export function landlineOk(numStr: string): boolean {
  let digits = numStr.replace(/\D/g, '');
  if (digits.startsWith('86')) digits = digits.slice(2);
  else if (digits.startsWith('0086')) digits = digits.slice(4);
  if (digits.length < 10 || digits.length > 17 || !digits.startsWith('0')) return false;
  let localFirst: string;
  if ('12'.includes(digits[1])) localFirst = digits[3];
  else if ('3456789'.includes(digits[1]) && digits.length >= 5) localFirst = digits[4];
  else return false;
  return '23456789'.includes(localFirst);
}

export function emailOk(email: string): boolean {
  const s = email.trim();
  const parts = s.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || domain.length < 3 || !domain.includes('.')) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..') || domain.includes('..')) return false;
  return (domain.split('.').pop() ?? '').length >= 2;
}

export function ibanOk(iban: string): boolean {
  const s = iban.trim();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const reordered = s.slice(4) + s.slice(0, 4);
  // 逐位取模，避免大整数
  let rem = 0;
  for (const c of reordered) {
    const chunk = /[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c;
    for (const d of chunk) rem = (rem * 10 + +d) % 97;
  }
  return rem === 1;
}

/** JWT：首段 base64url 解码后必须是含 alg 的 header，挡掉普通长 base64 串。 */
export function jwtOk(token: string): boolean {
  try {
    return Buffer.from(token.split('.')[0], 'base64url').toString('utf8').includes('"alg"');
  } catch {
    return false;
  }
}

// ---- CONNSTR 模板豁免 ----
const CONNSTR_TPL_RXS = [
  /^\$?\{[A-Za-z_][A-Za-z0-9_]*\}$/,
  /^<[A-Za-z_][A-Za-z0-9_]*>$/,
  /^\[[A-Za-z_][A-Za-z0-9_]*\]$/,
  /^\$[A-Za-z_][A-Za-z0-9_]*$/,
  /^%[A-Za-z_][A-Za-z0-9_]*%$/,
];
const CONNSTR_WILDCARD_RX = /^[xX*.]+$/;
const CONNSTR_DUMMY_HOSTS = new Set([
  'host', 'hostname', 'myhost', 'server', 'myserver',
  'example.com', 'example.org', 'example.net',
  'test.com', 'sample.com', 'your-host', 'yourhost', 'yourdomain.com',
]);
const CONNSTR_DUMMY_HOST_SUFFIXES = ['.example', '.invalid'];
const CONNSTR_PLACEHOLDER_USERS = new Set(['user', 'username', 'your_username', 'yourusername', 'usr', 'guest']);
const CONNSTR_PLACEHOLDER_PASSWORDS = new Set([
  'pass', 'password', 'passwd', 'your_password', 'yourpassword', 'changeme', 'change_me', 'guest',
]);
const CONNSTR_AUTH_RX = /^(?:\[[^\]\s]*\](?::[^\s/?#"'`)>},;]*)?|[^\s/?#"'`)>\]},;]*)/;

function connstrAuthority(text: string, pos: number): [string, string] {
  const auth = CONNSTR_AUTH_RX.exec(text.slice(pos, pos + 256))?.[0] ?? '';
  if (auth.startsWith('[')) {
    const close = auth.indexOf(']');
    const rest = auth.slice(close + 1);
    return [auth.slice(0, close), rest.startsWith(':') ? rest.slice(1) : ''];
  }
  const idx = auth.indexOf(':');
  return idx === -1 ? [auth, ''] : [auth.slice(0, idx), auth.slice(idx + 1)];
}

/**
 * 连接串密码真伪：只豁免「一眼是文档/代码模板」的形态，其余照常脱敏。
 * @param whole 整个匹配（scheme://user:pass@）
 * @param end   匹配在 text 中的结束位置（authority 从这里开始）
 */
export function connstrOk(orig: string, whole: string, text: string, end: number): boolean {
  if (CONNSTR_WILDCARD_RX.test(orig) || CONNSTR_TPL_RXS.some((rx) => rx.test(orig))) return false;
  try {
    const rest = whole.split('://', 2)[1] ?? '';
    const idx = rest.lastIndexOf(`:${orig}@`);
    const user = (idx !== -1 ? rest.slice(0, idx) : rest.split(':')[0]).toLowerCase();
    const [host, port] = connstrAuthority(text, end);
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    const hostDummy = CONNSTR_DUMMY_HOSTS.has(h) || CONNSTR_DUMMY_HOST_SUFFIXES.some((s) => h.endsWith(s));
    const userDummy = CONNSTR_PLACEHOLDER_USERS.has(user);
    const passDummy = CONNSTR_PLACEHOLDER_PASSWORDS.has(orig.toLowerCase());
    if (port && !/\d/.test(port) && (userDummy || passDummy)) return false;
    if (hostDummy && passDummy) return false;
    if (userDummy && passDummy) return false;
  } catch {
    return true;
  }
  return true;
}

// ---- IP_PUBLIC 验证 ----
const KNOWN_PUBLIC_DNS = new Set([
  '8.8.8.8', '8.8.4.4',           // Google DNS
  '1.1.1.1', '1.0.0.1',           // Cloudflare DNS
  '4.2.2.1', '4.2.2.2', '4.2.2.3',  // Level3 DNS
  '114.114.114.114', '114.114.115.115',  // 114 DNS
  '223.5.5.5', '223.6.6.6',       // 阿里 DNS
  '119.29.29.29',                 // 腾讯 DNSPod
  '180.76.76.76',                 // 百度 DNS
  '9.9.9.9',                      // Quad9
  '208.67.222.222', '208.67.220.220',  // OpenDNS
]);

/**
 * 公网 IPv4 校验：排除已知公共 DNS、版本号形态、私网、环回、组播及保留段。
 * 两层版本号启发式（规则默认关，宁漏勿误伤）：
 * 1. 四段全个位数（1.2.3.4 / 2.0.1.0）：开发文本压倒性偏向版本号与教学示例；
 *    真实公网主机的全个位数地址只有知名 anycast DNS，已全部枚举。
 * 2. 构建号形态（首段个位 + 第三段为 0 + 末段三位数）：Java/构建号版本标准形状。
 */
export function ipPublicOk(orig: string): boolean {
  if (!orig || KNOWN_PUBLIC_DNS.has(orig)) return false;
  try {
    const parts = orig.split('.');
    if (parts.length !== 4) return false;
    // 四段全个位数：视为版本号/教学示例放行
    if (all(parts, (p) => p.length === 1)) return false;
    // 构建号形态：首段个位 + 第三段为 0 + 末段三位数（100-255）
    if (parts[0].length === 1 && parts[2] === '0' && parts[3].length === 3) return false;

    // 校验各段 0-255
    const nums = parts.map((p) => {
      const n = +p;
      if (isNaN(n) || n < 0 || n > 255) throw new Error('invalid octet');
      return n;
    });

    // 排除私网段：10.x / 172.16-31.x / 192.168.x
    if (nums[0] === 10) return false;
    if (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) return false;
    if (nums[0] === 192 && nums[1] === 168) return false;

    // 排除环回段 127.x
    if (nums[0] === 127) return false;

    // 排除链路本地 169.254.x
    if (nums[0] === 169 && nums[1] === 254) return false;

    // 排除组播段 224-239.x
    if (nums[0] >= 224 && nums[0] <= 239) return false;

    // 排除保留段 240-255.x
    if (nums[0] >= 240) return false;

    // 排除 CGNAT 段 100.64-127.x
    if (nums[0] === 100 && nums[1] >= 64 && nums[1] <= 127) return false;

    // 其余非全局段（与 Python ipaddress.is_global 对齐）：
    // 0.0.0.0/8 本网、192.0.0.0/24 协议分配、192.0.2.0/24 / 198.51.100.0/24 / 203.0.113.0/24 文档示例、
    // 198.18.0.0/15 基准测试——文档示例段在教程与代码注释里极常见，脱敏它们只会干扰模型理解
    if (nums[0] === 0) return false;
    if (nums[0] === 192 && nums[1] === 0 && (nums[2] === 0 || nums[2] === 2)) return false;
    if (nums[0] === 198 && (nums[1] === 18 || nums[1] === 19)) return false;
    if (nums[0] === 198 && nums[1] === 51 && nums[2] === 100) return false;
    if (nums[0] === 203 && nums[1] === 0 && nums[2] === 113) return false;

    return true;
  } catch {
    return false;
  }
}

function all<T>(arr: T[], predicate: (v: T) => boolean): boolean {
  return arr.every(predicate);
}

// ---- IPV6_PRIVATE 验证 ----
/**
 * IPv6 私网校验：仅 fe80::/10（链路本地）与 fc00::/7（ULA）算命中。
 * 宽正则抓来的候选绝大多数不是 IPv6（MAC、时间、端口号串），先靠
 * 解析剔除；解析成功的再看是否私网段。
 * 带 zone id（fe80::1%eth0）的解析会失败——剥掉 % 后缀再试一次。
 */
export function ipv6PrivateOk(orig: string): boolean {
  if (!orig || orig.split(':').length < 2) return false;

  let candidate = orig.split('%')[0];  // 去掉 zone id

  try {
    // 解析 IPv6 地址
    const addr = parseIPv6(candidate);
    if (!addr) return false;

    // 检查是否为 fe80::/10（链路本地）
    if (addr[0] === 0xfe && (addr[1] & 0xc0) === 0x80) return true;

    // 检查是否为 fc00::/7（ULA）
    if ((addr[0] & 0xfe) === 0xfc) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * 最小化的 IPv6 解析：返回 16 字节的地址，或 null
 */
function parseIPv6(str: string): number[] | null {
  // 处理 :: 压缩
  const parts = str.split('::');
  if (parts.length > 2) return null;  // 多于一个 ::

  let fullParts: string[];
  if (parts.length === 2) {
    const [left, right] = parts;
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const totalSpecified = leftParts.length + rightParts.length;
    if (totalSpecified > 7) return null;  // 超过 8 段

    // 填充压缩段
    const numZeros = 8 - totalSpecified;
    fullParts = [...leftParts, ...Array(numZeros).fill('0'), ...rightParts];
  } else {
    fullParts = parts[0].split(':');
    if (fullParts.length !== 8) return null;
  }

  const bytes: number[] = [];
  for (const part of fullParts) {
    if (!part && fullParts.length !== 1) return null;
    const val = parseInt(part || '0', 16);
    if (isNaN(val) || val < 0 || val > 0xffff) return null;
    bytes.push((val >> 8) & 0xff, val & 0xff);
  }

  return bytes.length === 16 ? bytes : null;
}

// ---- USCC 验证 ----
const USCC_CHARS = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

/**
 * USCC（统一社会信用代码）校验位验证（GB 32100-2015 MOD31）。
 * 18 位 = 登记管理部门(1) + 机构类别(1) + 登记管理机关(6) + 主体标识(9) + 校验位(1)。
 * 前 17 位加权求和 mod 31，映射到字符集取校验位比对。
 */
export function usccOk(orig: string): boolean {
  if (!orig || orig.length !== 18) return false;

  try {
    let total = 0;
    for (let i = 0; i < 17; i++) {
      const idx = USCC_CHARS.indexOf(orig[i]);
      if (idx === -1) return false;
      total += USCC_WEIGHTS[i] * idx;
    }
    const check = (31 - (total % 31)) % 31;
    return USCC_CHARS[check] === orig[17];
  } catch {
    return false;
  }
}
