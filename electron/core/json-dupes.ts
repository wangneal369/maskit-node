/**
 * JSON 重复键检测：O(n) 单遍扫描，不构建对象。
 *
 * 为什么需要：JSON.parse 对重复键取「后者覆盖前者」，解析树无法代表原文。
 * `{"a":"13800138000","a":"safe"}` 解析后只剩 "safe"，脱敏扫不到手机号 → 判定零命中 → 网关原样转发
 * 原始字节；而上游解析器可能取第一个值，明文就出网了。有重复键的体必须从已脱敏的树重序列化。
 *
 * 键按**解码后的值**比较（"a" 与 u0061 转义写法是同一个键）。非法 JSON 不抛错、返回 false：
 * 解析失败由调用方各自的「非 JSON 体」分支处理。
 */

interface Frame {
  isObj: boolean;
  /** 仅对象使用：下一个字符串是否处于键位置 */
  expectKey: boolean;
  keys: Set<string> | null;
}

export function hasDuplicateKeys(text: string): boolean {
  const n = text.length;
  const stack: Frame[] = [];
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      // 字符串：扫到未转义的结束引号
      let j = i + 1;
      let escaped = false;
      for (;;) {
        if (j >= n) return false; // 未闭合：非法 JSON
        const d = text.charCodeAt(j);
        if (d === 0x5c) {
          escaped = true;
          j += 2;
          continue;
        }
        if (d === 0x22) break;
        j++;
      }
      const top = stack.length ? stack[stack.length - 1] : undefined;
      if (top && top.isObj && top.expectKey) {
        top.expectKey = false;
        let key: string;
        if (escaped) {
          try {
            key = JSON.parse(text.slice(i, j + 1)) as string;
          } catch {
            return false;
          }
        } else {
          key = text.slice(i + 1, j);
        }
        const keys = (top.keys ??= new Set<string>());
        if (keys.has(key)) return true;
        keys.add(key);
      }
      i = j + 1;
      continue;
    }
    if (c === 0x7b) stack.push({ isObj: true, expectKey: true, keys: null });
    else if (c === 0x5b) stack.push({ isObj: false, expectKey: false, keys: null });
    else if (c === 0x7d || c === 0x5d) stack.pop();
    else if (c === 0x2c) {
      const top = stack.length ? stack[stack.length - 1] : undefined;
      if (top && top.isObj) top.expectKey = true;
    }
    i++;
  }
  return false;
}
