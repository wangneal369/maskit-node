/**
 * 规则命中后的语义校验（移植自 engine/transparent.py 的 _xxx_ok 系列）。
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
