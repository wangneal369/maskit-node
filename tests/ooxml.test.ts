import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { DEFAULT_MASK_CONFIG, Masker } from '../electron/core';
import { maskOoxml } from '../electron/gateway/ooxml';

const PHONE = '13800138000';
const EMAIL = 'alice@corp-x.com';

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const coreXml = (creator: string) =>
  `<?xml version="1.0"?><cp:coreProperties xmlns:cp="c" xmlns:dc="d"><dc:title>T &amp; Co</dc:title><dc:creator>${creator}</dc:creator></cp:coreProperties>`;

const DOC_XML =
  `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body>` +
  // 手机号被切成两个 run，且段首有 &amp;
  `<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:t>R&amp;D </w:t></w:r><w:r><w:t>1380013</w:t></w:r><w:r><w:t>8000</w:t></w:r></w:p>` +
  `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">mail ${EMAIL} &lt;ok&gt;</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t>nothing here &amp; there</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t/></w:r></w:p>` +
  `</w:body></w:document>`;

const BIN = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253]);

function zip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const o: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) o[k] = typeof v === 'string' ? strToU8(v) : v;
  return zipSync(o);
}

const docx = () => zip({
  '[Content_Types].xml': CONTENT_TYPES,
  'word/document.xml': DOC_XML,
  'word/media/image1.png': BIN,
  'docProps/core.xml': coreXml(EMAIL),
});

function read(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(unzipSync(bytes))) out[k] = strFromU8(v);
  return out;
}

describe('maskOoxml docx', () => {
  const masker = new Masker();
  const input = docx();
  const r = maskOoxml(input, 'a.docx', masker);
  const files = unzipSync(r.bytes);
  const doc = strFromU8(files['word/document.xml']);

  it('命中计数 > 0 且输出可解压、保持条目顺序', () => {
    expect(r.hits).toBeGreaterThan(0);
    expect(Object.keys(files)).toEqual(Object.keys(unzipSync(input)));
  });

  it('跨 run 的手机号被脱敏，占位符进入首 run，其余 run 清空', () => {
    expect(doc).not.toContain(PHONE);
    expect(doc).not.toContain('1380013');
    expect(doc).toMatch(/\{\{PHONE_[a-z]{6}\}\}/);
    // 首 run 带上 xml:space="preserve"，后面两个 run 被清空
    expect(doc).toMatch(/<w:t xml:space="preserve">R&amp;D \{\{PHONE_[a-z]{6}\}\}<\/w:t>/);
    expect(doc).toMatch(/<w:t><\/w:t><\/w:r><w:r><w:t><\/w:t>/);
  });

  it('单 run 的邮箱被脱敏，实体与属性保持', () => {
    expect(doc).not.toContain(EMAIL);
    expect(doc).toMatch(/<w:t xml:space="preserve">mail \{\{EMAIL_[a-z]{6}\}\} &lt;ok&gt;<\/w:t>/);
  });

  it('未命中段落字节不变，XML 仍然合法转义', () => {
    expect(doc).toContain('<w:t>nothing here &amp; there</w:t>');
    expect(doc).toContain('<w:t/>');
    expect(doc.replace(/&(amp|lt|gt|quot|apos);/g, '')).not.toMatch(/&/);
    expect(doc.startsWith('<?xml version="1.0" encoding="UTF-8"?><w:document')).toBe(true);
  });

  it('docProps/core.xml 的 creator 被脱敏，其余文本保留', () => {
    const core = strFromU8(files['docProps/core.xml']);
    expect(core).not.toContain(EMAIL);
    expect(core).toMatch(/<dc:creator>\{\{EMAIL_[a-z]{6}\}\}<\/dc:creator>/);
    expect(core).toContain('<dc:title>T &amp; Co</dc:title>');
  });

  it('未触碰条目字节一致', () => {
    const orig = unzipSync(input);
    expect(files['[Content_Types].xml']).toEqual(orig['[Content_Types].xml']);
    expect(files['word/media/image1.png']).toEqual(BIN);
  });

  it('输出不大于原文件时补白对齐到原体积', () => {
    if (r.bytes.length <= input.length) expect(r.bytes.length).toBe(input.length);
  });

  it('同一明文在不同文件里复用同一占位符（共享映射表）', () => {
    const doc2 = zip({ 'word/document.xml': `<w:document ${W_NS}><w:p><w:r><w:t>${PHONE}</w:t></w:r></w:p></w:document>` });
    const r2 = maskOoxml(doc2, 'b.docx', masker);
    const tok1 = /\{\{PHONE_[a-z]{6}\}\}/.exec(doc)![0];
    expect(read(r2.bytes)['word/document.xml']).toContain(tok1);
  });
});

describe('maskOoxml 其它格式与分支', () => {
  it('xlsx：sharedStrings 的 <t> 与 core.xml', () => {
    const input = zip({
      '[Content_Types].xml': CONTENT_TYPES,
      'xl/sharedStrings.xml': `<sst xmlns="x"><si><t>${EMAIL}</t></si><si><t>a &amp; b</t></si></sst>`,
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>',
      'docProps/core.xml': coreXml('bob'),
    });
    const r = maskOoxml(input, 'x.xlsx', new Masker());
    expect(r.hits).toBe(1);
    const f = read(r.bytes);
    expect(f['xl/sharedStrings.xml']).not.toContain(EMAIL);
    expect(f['xl/sharedStrings.xml']).toMatch(/<si><t>\{\{EMAIL_[a-z]{6}\}\}<\/t><\/si><si><t>a &amp; b<\/t><\/si>/);
    expect(f['xl/worksheets/sheet1.xml']).toBe('<worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>');
  });

  it('pptx：a:t 带命名空间前缀', () => {
    const input = zip({
      '[Content_Types].xml': CONTENT_TYPES,
      'ppt/slides/slide1.xml': `<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>call ${PHONE}</a:t></a:r></a:p></p:sld>`,
    });
    const r = maskOoxml(input, 'deck.pptx', new Masker());
    expect(r.hits).toBe(1);
    const s = read(r.bytes)['ppt/slides/slide1.xml'];
    expect(s).not.toContain(PHONE);
    expect(s).toMatch(/<a:t>call \{\{PHONE_[a-z]{6}\}\}<\/a:t>/);
  });

  it('wps/et/dps 按 docx/xlsx/pptx 处理', () => {
    const mk = (path: string, body: string) => zip({ [path]: body });
    const w = maskOoxml(mk('word/document.xml', `<w:document ${W_NS}><w:p><w:r><w:t>${EMAIL}</w:t></w:r></w:p></w:document>`), 'a.wps', new Masker());
    const e = maskOoxml(mk('xl/sharedStrings.xml', `<sst><si><t>${EMAIL}</t></si></sst>`), 'a.et', new Masker());
    const d = maskOoxml(mk('ppt/slides/s.xml', `<s><a:t>${EMAIL}</a:t></s>`), 'a.dps', new Masker());
    expect([w.hits, e.hits, d.hits]).toEqual([1, 1, 1]);
  });

  it('文件名无扩展名或扩展名未知时按条目名探测格式', () => {
    const input = zip({ 'xl/sharedStrings.xml': `<sst><si><t>${EMAIL}</t></si></sst>` });
    expect(maskOoxml(input, 'noext', new Masker()).hits).toBe(1);
    expect(maskOoxml(input, 'weird.bin', new Masker()).hits).toBe(1);
  });

  it('既无 xl/word/ppt 目录又无可识别扩展名 → 原样返回', () => {
    const input = zip({ 'other/a.xml': `<t>${EMAIL}</t>` });
    const r = maskOoxml(input, 'a.zip', new Masker());
    expect(r.hits).toBe(0);
    expect(r.bytes).toBe(input);
  });

  it('零命中返回原始字节（同一引用，不重压缩）', () => {
    const input = zip({ 'word/document.xml': `<w:document ${W_NS}><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:document>` });
    const r = maskOoxml(input, 'a.docx', new Masker());
    expect(r.hits).toBe(0);
    expect(r.bytes).toBe(input);
  });

  it('非 zip 输入原样返回', () => {
    for (const name of ['a.docx', 'a.doc', 'a.xls']) {
      const raw = strToU8(`plain text ${PHONE}`);
      const r = maskOoxml(raw, name, new Masker());
      expect(r.hits).toBe(0);
      expect(r.bytes).toBe(raw);
    }
    const bad = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(40).fill(7)]);
    expect(maskOoxml(bad, 'a.docx', new Masker())).toEqual({ bytes: bad, hits: 0 });
  });

  it('Zip Bomb：声明解压总量超 64MB 时不解压，原样返回', () => {
    const big = new Uint8Array(65 * 1024 * 1024); // 全零，压缩后很小
    const input = zipSync({
      'word/document.xml': [strToU8(`<w:document ${W_NS}><w:p><w:r><w:t>${EMAIL}</w:t></w:r></w:p></w:document>`), { level: 6 }],
      'word/media/bomb.bin': [big, { level: 1 }],
    });
    expect(input.length).toBeLessThan(1024 * 1024);
    const r = maskOoxml(input, 'bomb.docx', new Masker());
    expect(r.hits).toBe(0);
    expect(r.bytes).toBe(input);
  });

  it('命中后体积对不齐仍返回脱敏字节（不回退明文）', () => {
    // 邮箱很短、占位符更长 → 输出必然比输入大，无法补白
    const input = zip({ 'xl/sharedStrings.xml': '<sst><si><t>a@b.cc</t></si></sst>' });
    const r = maskOoxml(input, 'a.xlsx', new Masker());
    expect(r.hits).toBe(1);
    expect(read(r.bytes)['xl/sharedStrings.xml']).not.toContain('a@b.cc');
  });

  it('XML 数字字符引用先解码再脱敏', () => {
    const input = zip({ 'xl/sharedStrings.xml': '<sst><si><t>1380013&#56;00&#x30;</t></si></sst>' });
    const r = maskOoxml(input, 'a.xlsx', new Masker());
    expect(r.hits).toBe(1);
    expect(read(r.bytes)['xl/sharedStrings.xml']).not.toMatch(/13800138000|&#/);
  });

  it('脱敏结果含特殊字符时重新转义（自定义词含 &）', () => {
    const m = new Masker();
    m.configure({ ...DEFAULT_MASK_CONFIG, secretPrefixes: [], customWords: [{ word: 'AT&T', label: 'TERM' }] });
    const input = zip({ 'xl/sharedStrings.xml': '<sst><si><t>AT&amp;T corp</t></si></sst>' });
    const r = maskOoxml(input, 'a.xlsx', m);
    expect(r.hits).toBe(1);
    const s = read(r.bytes)['xl/sharedStrings.xml'];
    expect(s).not.toContain('AT&amp;T');
    expect(s).toMatch(/<t>\{\{TERM_[a-z]{6}\}\} corp<\/t>/);
  });
});
