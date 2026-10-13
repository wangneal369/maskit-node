import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { Masker } from '../electron/core';
import { maskOoxml } from '../electron/gateway/ooxml';

const PHONE = '13800138000';
const EMAIL = 'alice@corp-x.com';

/**
 * 构造一个假的遗留二进制文件，包含：
 * - 随机控制字节
 * - UTF-16LE 编码的电话号码
 * - UTF-8 编码的中文文本和邮箱
 */
function buildFakeLegacyBinary(): Uint8Array {
  const te = new TextEncoder();

  // 构造 UTF-16LE 部分（Word/Excel 经典编码）
  const u16Text = `Contact: ${PHONE}`;
  const u16Bytes = new TextEncoder().encode(u16Text);
  const u16LE = new Uint8Array(u16Text.length * 2);
  for (let i = 0; i < u16Text.length; i++) {
    const code = u16Text.charCodeAt(i);
    u16LE[i * 2] = code & 0xff;
    u16LE[i * 2 + 1] = (code >> 8) & 0xff;
  }

  // 构造 UTF-8 部分
  const u8Text = `公司信息：${EMAIL}\n测试用户邮箱地址`;
  const u8Bytes = te.encode(u8Text);

  // 混合：随机控制字节 + UTF-16LE + 控制字节 + UTF-8
  const parts: Uint8Array[] = [];

  // 添加随机控制字节（模拟二进制头）
  const header = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    header[i] = Math.random() * 256;
  }
  parts.push(header);

  // 添加 UTF-16LE 文本
  parts.push(u16LE);

  // 添加分隔符（控制字符）
  parts.push(new Uint8Array([0x00, 0x0d, 0x0a, 0x00, 0x0c]));

  // 添加 UTF-8 文本
  parts.push(u8Bytes);

  // 添加尾部填充
  parts.push(new Uint8Array(15).fill(0xff));

  // 合并所有部分
  let totalLen = 0;
  for (const part of parts) totalLen += part.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

describe('maskOoxml 遗留 Office 转码', () => {
  it('选项关闭时，.doc 文件原样返回，hits=0', () => {
    const binary = buildFakeLegacyBinary();
    const r = maskOoxml(binary, 'document.doc', new Masker(), { convertLegacyOffice: false });
    expect(r.hits).toBe(0);
    expect(r.bytes).toBe(binary);
    expect(r.convertedFrom).toBeUndefined();
    expect(r.newFilename).toBeUndefined();
  });

  it('选项关闭时，.xls 文件原样返回，hits=0', () => {
    const binary = buildFakeLegacyBinary();
    const r = maskOoxml(binary, 'data.xls', new Masker(), { convertLegacyOffice: false });
    expect(r.hits).toBe(0);
    expect(r.bytes).toBe(binary);
    expect(r.convertedFrom).toBeUndefined();
    expect(r.newFilename).toBeUndefined();
  });

  it('选项启用时，.doc 转换为 .docx，提取文本并脱敏', () => {
    const binary = buildFakeLegacyBinary();
    const masker = new Masker();
    const r = maskOoxml(binary, 'report.doc', masker, { convertLegacyOffice: true });

    // 验证转换元数据
    expect(r.convertedFrom).toBe('doc');
    expect(r.newFilename).toBe('report.docx');

    // 验证输出是有效的 zip（OOXML）
    const files = unzipSync(r.bytes);
    expect(files).toHaveProperty('word/document.xml');
    expect(files).toHaveProperty('[Content_Types].xml');
    expect(files).toHaveProperty('_rels/.rels');

    // 验证原始敏感信息被移除
    const docXml = strFromU8(files['word/document.xml']);
    expect(docXml).not.toContain(PHONE);
    expect(docXml).not.toContain(EMAIL);

    // 验证脱敏占位符存在
    expect(docXml).toMatch(/\{\{PHONE_[a-z]{6}\}\}/);
    expect(docXml).toMatch(/\{\{EMAIL_[a-z]{6}\}\}/);

    // 验证有命中
    expect(r.hits).toBeGreaterThan(0);
  });

  it('选项启用时，.xls 转换为 .xlsx，生成合规的 sheet 结构', () => {
    const binary = buildFakeLegacyBinary();
    const masker = new Masker();
    const r = maskOoxml(binary, 'sheet.xls', masker, { convertLegacyOffice: true });

    // 验证转换元数据
    expect(r.convertedFrom).toBe('xls');
    expect(r.newFilename).toBe('sheet.xlsx');

    // 验证输出是有效的 zip（OOXML）
    const files = unzipSync(r.bytes);
    expect(files).toHaveProperty('xl/worksheets/sheet1.xml');
    expect(files).toHaveProperty('xl/workbook.xml');
    expect(files).toHaveProperty('[Content_Types].xml');
    expect(files).toHaveProperty('_rels/.rels');
    expect(files).toHaveProperty('xl/_rels/workbook.xml.rels');

    // 验证原始敏感信息被移除
    const sheetXml = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(sheetXml).not.toContain(PHONE);
    expect(sheetXml).not.toContain(EMAIL);

    // 验证脱敏占位符存在
    expect(sheetXml).toMatch(/\{\{PHONE_[a-z]{6}\}\}/);
    expect(sheetXml).toMatch(/\{\{EMAIL_[a-z]{6}\}\}/);

    // 验证有命中
    expect(r.hits).toBeGreaterThan(0);
  });

  it('空二进制或无可读文本时，原样返回原始字节但 hits=0', () => {
    const empty = new Uint8Array(0);
    const r = maskOoxml(empty, 'empty.doc', new Masker(), { convertLegacyOffice: true });
    expect(r.hits).toBe(0);
    expect(r.bytes).toBe(empty);
  });

  it('DOCX 文件不受转码影响（应走标准 OOXML 路径）', () => {
    const te = new TextEncoder();
    // 创建一个最小化的 DOCX
    const docxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // ZIP header
    const r = maskOoxml(docxBytes, 'document.docx', new Masker(), { convertLegacyOffice: true });
    // DOCX 不满足 ZIP 条件时返回原始
    expect(r.convertedFrom).toBeUndefined();
    expect(r.newFilename).toBeUndefined();
  });

  it('文件名大小写不敏感：.DOC/.XLS 也被转码', () => {
    const binary = buildFakeLegacyBinary();
    const masker = new Masker();

    const r1 = maskOoxml(binary, 'file.DOC', masker, { convertLegacyOffice: true });
    expect(r1.convertedFrom).toBe('doc');
    expect(r1.newFilename).toMatch(/\.docx$/i);

    const r2 = maskOoxml(binary, 'file.XLS', masker, { convertLegacyOffice: true });
    expect(r2.convertedFrom).toBe('xls');
    expect(r2.newFilename).toMatch(/\.xlsx$/i);
  });

  it('即使无敏感信息，转码仍返回重建文件（不同于 OOXML 路径）', () => {
    // 构造仅含普通文本的二进制
    const te = new TextEncoder();
    const u16LE = new Uint8Array('hello'.length * 2);
    for (let i = 0; i < 'hello'.length; i++) {
      const code = 'hello'.charCodeAt(i);
      u16LE[i * 2] = code & 0xff;
      u16LE[i * 2 + 1] = (code >> 8) & 0xff;
    }

    const r = maskOoxml(u16LE, 'test.doc', new Masker(), { convertLegacyOffice: true });
    // 即使 hits=0，也返回重建的文件（不是原始 u16LE）
    expect(r.hits).toBe(0);
    expect(r.bytes).not.toBe(u16LE);
    expect(r.convertedFrom).toBe('doc');

    // 验证可解压
    const files = unzipSync(r.bytes);
    expect(files).toHaveProperty('word/document.xml');
  });

  it('文件名转换：路径和扩展名正确处理', () => {
    const binary = buildFakeLegacyBinary();
    const masker = new Masker();

    // 带路径前缀
    const r1 = maskOoxml(binary, '/path/to/file.doc', masker, { convertLegacyOffice: true });
    expect(r1.newFilename).toBe('/path/to/file.docx');

    // 多个点
    const r2 = maskOoxml(binary, 'archive.2024.xls', masker, { convertLegacyOffice: true });
    expect(r2.newFilename).toBe('archive.2024.xlsx');

    // 无扩展名（不应触发转码）
    const r3 = maskOoxml(binary, 'noext', masker, { convertLegacyOffice: true });
    expect(r3.convertedFrom).toBeUndefined();
    expect(r3.newFilename).toBeUndefined();
  });

  it('生成的 DOCX 包含有效的 XML 转义', () => {
    const te = new TextEncoder();
    // 构造包含 XML 特殊字符的文本
    const text = 'a&b<c>d"e\'f';
    const u16LE = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      u16LE[i * 2] = code & 0xff;
      u16LE[i * 2 + 1] = (code >> 8) & 0xff;
    }

    const r = maskOoxml(u16LE, 'test.doc', new Masker(), { convertLegacyOffice: true });
    const files = unzipSync(r.bytes);
    const docXml = strFromU8(files['word/document.xml']);

    // 验证特殊字符被正确转义
    expect(docXml).toContain('&amp;');
    expect(docXml).toContain('&lt;');
    expect(docXml).toContain('&gt;');
    // 验证 XML 仍然合法
    expect(docXml.match(/&[^;]*;/g)?.every((e) => ['&amp;', '&lt;', '&gt;', '&quot;', '&apos;'].some((ref) => e.includes(ref.slice(1, -1))))).not.toBe(false);
  });

  it('生成的 XLSX 单元格引用正确（列字母 A-Z）', () => {
    const te = new TextEncoder();
    // 构造包含制表符的文本（模拟多列）
    const text = 'A\tB\tC';
    const u16LE = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      u16LE[i * 2] = code & 0xff;
      u16LE[i * 2 + 1] = (code >> 8) & 0xff;
    }

    const r = maskOoxml(u16LE, 'test.xls', new Masker(), { convertLegacyOffice: true });
    const files = unzipSync(r.bytes);
    const sheetXml = strFromU8(files['xl/worksheets/sheet1.xml']);

    // 验证单元格引用：A1, B1, C1
    expect(sheetXml).toContain('r="A1"');
    expect(sheetXml).toContain('r="B1"');
    expect(sheetXml).toContain('r="C1"');
  });

  it('同一原文在转码中复用相同占位符（共享映射表）', () => {
    const te = new TextEncoder();
    // 构造两次相同的敏感词
    const text = PHONE;
    const u16LE = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      u16LE[i * 2] = code & 0xff;
      u16LE[i * 2 + 1] = (code >> 8) & 0xff;
    }

    const masker = new Masker();
    const r1 = maskOoxml(u16LE, 'file1.doc', masker, { convertLegacyOffice: true });
    const files1 = unzipSync(r1.bytes);
    const docXml1 = strFromU8(files1['word/document.xml']);
    const token1 = /\{\{PHONE_[a-z]{6}\}\}/.exec(docXml1)?.[0];

    // 使用同一个 masker 实例再处理一个文件
    const r2 = maskOoxml(u16LE, 'file2.doc', masker, { convertLegacyOffice: true });
    const files2 = unzipSync(r2.bytes);
    const docXml2 = strFromU8(files2['word/document.xml']);
    const token2 = /\{\{PHONE_[a-z]{6}\}\}/.exec(docXml2)?.[0];

    // 同一原文应使用相同占位符
    expect(token1).toBe(token2);
  });
});
