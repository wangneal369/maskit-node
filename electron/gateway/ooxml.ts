/**
 * Office 文档（docx / xlsx / pptx，兼容 wps / et / dps）内部文本脱敏。
 *
 * 解 zip → 对 XML 文本节点逐个脱敏 → 重新封包。
 * 不引入 XML DOM 库，文本节点用正则定位，只改动命中的节点，其余字节原样保留。
 *
 * 不变量：
 * - 零命中 → 返回原始字节（不重压缩，上传方按声明大小校验，体积漂移会被拒收）；
 * - 命中过 → 返回的一定是打过码的字节，体积对不齐也不回退明文（回退会让 hits 归零，扩展侧误判成「无敏感信息」）；
 * - 不是 zip / 不是 Office 包 / 解压体积超限 → 原样返回且 hits=0。
 * - 遗留 Office (.doc / .xls) 转码只在 convertLegacyOffice 启用时执行，有损重建，默认关闭。
 */
import { unzipSync, zipSync, type ZipOptions } from 'fflate';
import type { Masker } from '../core';

export interface OoxmlMaskResult {
  bytes: Uint8Array;
  hits: number;
  /** 当遗留 Office 被转换时，记录原扩展名 */
  convertedFrom?: 'doc' | 'xls';
  /** 当遗留 Office 被转换时，记录新文件名 */
  newFilename?: string;
}

/** 解压体积上限：防 Zip Bomb 撑爆内存 */
export const MAX_TOTAL_UNCOMPRESSED = 64 * 1024 * 1024;

type Kind = 'docx' | 'xlsx' | 'pptx';

const EXT_KIND: Record<string, Kind> = {
  docx: 'docx', wps: 'docx', xlsx: 'xlsx', et: 'xlsx', pptx: 'pptx', dps: 'pptx',
};

const NAME = '(?:[A-Za-z_][\\w.-]*:)?';

/** 无 ZIP 本地文件头魔数时一定不是 zip（空 zip 以 EOCD 开头也算） */
function looksLikeZip(b: Uint8Array): boolean {
  if (b.length < 22) return false;
  return b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06);
}

function decodeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (m, e: string) => {
    switch (e) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'quot': return '"';
      case 'apos': return "'";
    }
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(cp);
    } catch {
      return m;
    }
  });
}

function encodeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(xml: string, edits: Edit[]): string {
  if (!edits.length) return xml;
  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const e of edits) {
    out += xml.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + xml.slice(pos);
}

/** 确保开标签带 xml:space="preserve"（首 run 吸收整段文本后，首尾空白不能被吞） */
function withPreserve(openTag: string): string {
  const rx = /xml:space\s*=\s*("[^"]*"|'[^']*')/;
  if (rx.test(openTag)) return openTag.replace(rx, 'xml:space="preserve"');
  return openTag.replace(new RegExp(`^<(${NAME}[\\w.-]+)`), '<$1 xml:space="preserve"');
}

interface Run {
  /** 开标签起点 */
  start: number;
  openTag: string;
  /** 文本内容区间 */
  textStart: number;
  textEnd: number;
  text: string;
}

/**
 * Word：按段落处理 run。
 * 1) 每个 run 独立脱敏（保全格式独立性）；
 * 2) 段内没有任何 run 命中、但 run 数 > 1 时，拼接整段再脱敏——敏感值可能被 run 切分，
 *    命中则整段写入首 run、其余清空。
 * 段落按栈配对（文本框里可能嵌套段落），run 归属最内层段落。
 */
function maskWordXml(xml: string, masker: Masker): { xml: string; hits: number } {
  const edits: Edit[] = [];
  let hits = 0;

  const tokenRx = new RegExp(`<(\\/?)${NAME}(p|t)(?=[\\s>\\/])([^>]*)>`, 'g');
  const stack: Run[][] = [];

  const maskRun = (r: Run): boolean => {
    const plain = decodeXml(r.text);
    if (!plain) return false;
    const m = masker.mask(plain);
    if (m === plain) return false;
    edits.push({ start: r.start, end: r.textEnd, text: r.openTag + encodeXml(m) });
    hits++;
    return true;
  };

  const finishParagraph = (runs: Run[]): void => {
    if (!runs.length) return;
    let touched = false;
    for (const r of runs) if (maskRun(r)) touched = true;
    if (touched || runs.length < 2) return;
    const full = runs.map((r) => decodeXml(r.text)).join('');
    const m = masker.mask(full);
    if (m === full) return;
    edits.push({ start: runs[0].start, end: runs[0].textEnd, text: withPreserve(runs[0].openTag) + encodeXml(m) });
    for (const r of runs.slice(1)) edits.push({ start: r.start, end: r.textEnd, text: r.openTag });
    hits++;
  };

  let mt: RegExpExecArray | null;
  while ((mt = tokenRx.exec(xml))) {
    const [whole, closing, local, attrs] = mt;
    if (closing) {
      if (local === 'p' && stack.length) finishParagraph(stack.pop()!);
      continue;
    }
    if (attrs.endsWith('/')) continue; // 自闭合
    if (local === 'p') {
      stack.push([]);
      continue;
    }
    // <w:t ...>text</w:t>
    const textStart = mt.index + whole.length;
    const closeRx = new RegExp(`<\\/${NAME}t\\s*>`, 'g');
    closeRx.lastIndex = textStart;
    const cm = closeRx.exec(xml);
    if (!cm) continue;
    const text = xml.slice(textStart, cm.index);
    if (text.includes('<')) continue; // 夹带子标记（非常规），不处理
    const run: Run = { start: mt.index, openTag: whole, textStart, textEnd: cm.index, text };
    tokenRx.lastIndex = cm.index; // 跳到 </t>，由下一轮当作普通闭标签忽略
    if (stack.length) stack[stack.length - 1].push(run);
    else finishParagraph([run]);
  }
  // 残缺文档：栈里剩余段落也要处理，不能漏
  while (stack.length) finishParagraph(stack.pop()!);

  return { xml: applyEdits(xml, edits), hits };
}

/** xlsx / pptx / core.xml：局部名为 t、v、creator、lastModifiedBy 或以 Text 结尾的元素 */
function maskGenericXml(xml: string, masker: Masker): { xml: string; hits: number } {
  let hits = 0;
  const rx = new RegExp(
    `<(${NAME}(?:t|v|creator|lastModifiedBy|[A-Za-z0-9_.-]*Text))((?:\\s[^>]*?)?)(?<!\\/)>([^<]+)<\\/\\1\\s*>`,
    'g',
  );
  const out = xml.replace(rx, (whole, tag: string, attrs: string, text: string) => {
    const plain = decodeXml(text);
    if (!plain) return whole;
    const m = masker.mask(plain);
    if (m === plain) return whole;
    hits++;
    return `<${tag}${attrs}>${encodeXml(m)}</${tag}>`;
  });
  return { xml: out, hits };
}

/** 借 EOCD 注释字段把 zip 无损补到目标体积（只能补大） */
export function padZipToSize(zip: Uint8Array, target: number): Uint8Array {
  if (zip.length >= target) return zip;
  const diff = target - zip.length;
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.length);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1 || zip.length - eocd < 22) return zip;
  const oldLen = buf.readUInt16LE(eocd + 20);
  const newLen = oldLen + diff;
  if (newLen > 65535) return zip;
  const out = new Uint8Array(target);
  out.set(zip.subarray(0, eocd + 20), 0);
  new DataView(out.buffer).setUint16(eocd + 20, newLen, true);
  out.set(zip.subarray(eocd + 22, eocd + 22 + oldLen), eocd + 22);
  out.fill(0x20, eocd + 22 + oldLen);
  return out;
}

function shouldMask(kind: Kind, lowerName: string): boolean {
  if (lowerName === 'docprops/core.xml') return true;
  const dir = kind === 'docx' ? 'word/' : kind === 'xlsx' ? 'xl/' : 'ppt/';
  return lowerName.startsWith(dir) && lowerName.endsWith('.xml');
}

export function maskOoxml(
  bytes: Uint8Array,
  filename: string,
  masker: Masker,
  opts?: { convertLegacyOffice?: boolean },
): OoxmlMaskResult {
  const orig: OoxmlMaskResult = { bytes, hits: 0 };

  // 遗留 Office 转码路径：.doc 或 .xls（仅在启用时）
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot + 1).trim().toLowerCase() : '';
  if (opts?.convertLegacyOffice && (ext === 'doc' || ext === 'xls')) {
    // 注意：即使 hits === 0，也返回重建的字节，这是有意的行为（见 Python 实现注释）
    const result = _convertAndMaskLegacyOffice(bytes, ext as 'doc' | 'xls', masker);
    const newExt = ext === 'xls' ? 'xlsx' : 'docx';
    const newFilename = filename.slice(0, filename.length - ext.length) + newExt;
    return {
      bytes: result.bytes,
      hits: result.hits,
      convertedFrom: ext as 'doc' | 'xls',
      newFilename,
    };
  }

  // 标准 OOXML 路径：docx / xlsx / pptx（以及 wps / et / dps）
  if (!looksLikeZip(bytes)) return orig;

  // 只读中央目录：先看总体积与条目名，再决定要不要解压
  const names: string[] = [];
  let total = 0;
  try {
    unzipSync(bytes, {
      filter: (f) => {
        names.push(f.name);
        total += f.originalSize;
        return false;
      },
    });
  } catch {
    return orig;
  }
  if (total > MAX_TOTAL_UNCOMPRESSED) return orig;

  let kind: Kind | undefined = EXT_KIND[ext];
  if (!kind) {
    if (names.some((n) => n.startsWith('xl/'))) kind = 'xlsx';
    else if (names.some((n) => n.startsWith('word/'))) kind = 'docx';
    else if (names.some((n) => n.startsWith('ppt/'))) kind = 'pptx';
    else return orig;
  }

  const methods = new Map<string, number>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        methods.set(f.name, f.compression);
        return true;
      },
    });
  } catch {
    return orig;
  }

  let hits = 0;
  const td = new TextDecoder('utf-8');
  const te = new TextEncoder();
  const entries: Record<string, [Uint8Array, ZipOptions]> = {};
  for (const [name, content] of Object.entries(files)) {
    let data: Uint8Array = content;
    if (shouldMask(kind, name.toLowerCase())) {
      const lower = name.toLowerCase();
      const xml = td.decode(content);
      const r = kind === 'docx' && lower.startsWith('word/') ? maskWordXml(xml, masker) : maskGenericXml(xml, masker);
      if (r.hits) {
        hits += r.hits;
        data = te.encode(r.xml);
      }
    }
    entries[name] = [data, { level: methods.get(name) === 0 ? 0 : 9 }];
  }

  // 零命中：原样返回原始字节，绝不重压缩
  if (hits === 0) return orig;

  let out: Uint8Array = zipSync(entries);
  if (out.length < bytes.length) out = padZipToSize(out, bytes.length);
  // 体积对不齐也返回脱敏结果，不回退明文（见文件头不变量）
  return { bytes: out, hits };
}

/**
 * 从二进制字节中提取可读文本行。
 * 尝试 UTF-16LE（Word/Excel 经典编码）和 UTF-8 解码，按控制字符分割，
 * 保留包含 CJK 或字母数字的部分，长度 >= 2，去重。
 */
function extractTextLines(rawBytes: Uint8Array): string[] {
  const textLines: string[] = [];
  const td = new TextDecoder();

  // 1. 优先提取 UTF-16LE 文本段落
  try {
    const u16 = new TextDecoder('utf-16le').decode(rawBytes);
    // 按控制字符分割：\r \n \x00-\x08 \x0b \x0c \x0e-\x1f
    const parts = u16.split(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]+/);
    for (const part of parts) {
      const trimmed = part.trim();
      // 长度 >= 2 且包含 CJK 或字母数字
      if (trimmed.length >= 2 && /[一-鿿\w]/.test(trimmed)) {
        textLines.push(trimmed);
      }
    }
  } catch {
    // UTF-16LE 解码失败，继续尝试 UTF-8
  }

  // 2. 补充提取 UTF-8 / ASCII（避免重复）
  try {
    const u8 = td.decode(rawBytes);
    const parts = u8.split(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]+/);
    const seen = new Set(textLines);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length >= 2 && /[一-鿿\w]/.test(trimmed) && !seen.has(trimmed)) {
        textLines.push(trimmed);
        seen.add(trimmed);
      }
    }
  } catch {
    // UTF-8 解码失败，保留之前提取的结果
  }

  return textLines;
}

/**
 * 生成极简合规 .docx（WordprocessingML）字节流，包含给定的行。
 */
function _makeMinimalDocx(lines: string[]): Uint8Array {
  const te = new TextEncoder();
  const entries: Record<string, [Uint8Array, ZipOptions]> = {};

  // [Content_Types].xml
  entries['[Content_Types].xml'] = [
    te.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
        '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
        '  <Default Extension="xml" ContentType="application/xml"/>\n' +
        '  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\n' +
        '</Types>',
    ),
    { level: 9 },
  ];

  // _rels/.rels
  entries['_rels/.rels'] = [
    te.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>\n' +
        '</Relationships>',
    ),
    { level: 9 },
  ];

  // word/document.xml
  const bodyXml: string[] = [];
  for (const p of lines) {
    const escaped = p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    bodyXml.push(`<w:p><w:r><w:t>${escaped}</w:t></w:r></w:p>`);
  }
  entries['word/document.xml'] = [
    te.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n' +
        `  <w:body>${bodyXml.join('')}</w:body>\n` +
        '</w:document>',
    ),
    { level: 9 },
  ];

  return zipSync(entries);
}

/**
 * 生成极简合规 .xlsx（SpreadsheetML）字节流，包含给定的行。
 * 每行可能包含制表符，将被分割为单元格。
 */
function _makeMinimalXlsx(lines: string[]): Uint8Array {
  const te = new TextEncoder();
  const entries: Record<string, [Uint8Array, ZipOptions]> = {};

  // [Content_Types].xml
  entries['[Content_Types].xml'] = [
    te.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
        '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
        '  <Default Extension="xml" ContentType="application/xml"/>\n' +
        '  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>\n' +
        '  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>\n' +
        '</Types>',
    ),
    { level: 9 },
  ];

  // _rels/.rels
  entries['_rels/.rels'] = [
    te.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>\n' +
        '</Relationships>',
    ),
    { level: 9 },
  ];

  // xl/_rels/workbook.xml.rels
  entries['xl/_rels/workbook.xml.rels'] = [
    te.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>\n' +
        '</Relationships>',
    ),
    { level: 9 },
  ];

  // xl/workbook.xml
  entries['xl/workbook.xml'] = [
    te.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n' +
        '  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>\n' +
        '</workbook>',
    ),
    { level: 9 },
  ];

  // xl/worksheets/sheet1.xml
  const sheetRows: string[] = [];
  for (let rIdx = 0; rIdx < lines.length; rIdx++) {
    const rowNum = rIdx + 1;
    const cells = lines[rIdx].includes('\t') ? lines[rIdx].split('\t') : [lines[rIdx]];
    const cellXml: string[] = [];
    for (let cIdx = 0; cIdx < cells.length; cIdx++) {
      const colNum = cIdx + 1;
      // 列字母：A, B, C, ..., Z, AA, AB, ...
      const colLetter = colNum <= 26 ? String.fromCharCode(64 + colNum) : 'A';
      const cellVal = cells[cIdx];
      const escaped = cellVal.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      cellXml.push(`<c r="${colLetter}${rowNum}" t="inlineStr"><is><t>${escaped}</t></is></c>`);
    }
    sheetRows.push(`<row r="${rowNum}">${cellXml.join('')}</row>`);
  }
  entries['xl/worksheets/sheet1.xml'] = [
    te.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n' +
        `  <sheetData>${sheetRows.join('')}</sheetData>\n` +
        '</worksheet>',
    ),
    { level: 9 },
  ];

  return zipSync(entries);
}

/**
 * 处理遗留 Office 文件（.doc / .xls）：有损重建。
 * 从二进制中提取可读文本 → 逐行脱敏 → 构造最小化的 OOXML 文档。
 *
 * 注意：即使 hits === 0（无任何敏感信息），也返回重建的字节，
 * 这与 OOXML 路径的「无命中绝不动文件」原则相反。
 */
function _convertAndMaskLegacyOffice(
  rawBytes: Uint8Array,
  ext: 'doc' | 'xls',
  masker: Masker,
): { bytes: Uint8Array; hits: number } {
  const textLines = extractTextLines(rawBytes);

  if (textLines.length === 0) {
    return { bytes: rawBytes, hits: 0 };
  }

  let hits = 0;
  const maskedLines: string[] = [];
  for (const line of textLines) {
    const masked = masker.mask(line);
    if (masked !== line) {
      hits++;
    }
    maskedLines.push(masked);
  }

  // 根据扩展名选择对应的 OOXML 格式
  const bytes = ext === 'xls' ? _makeMinimalXlsx(maskedLines) : _makeMinimalDocx(maskedLines);

  return { bytes, hits };
}
