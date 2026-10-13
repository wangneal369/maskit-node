import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NerEngine } from '../electron/ner/engine';

const MODEL_DIR = 'E:/projects/aiProject/ner-model-check/ner';
const HAS_MODEL = fs.existsSync(path.join(MODEL_DIR, 'model_quantized.onnx'));
const far = () => Date.now() + 60_000;

describe('NerEngine.load 错误信息', () => {
  it('目录不存在 → 中文提示缺失文件', async () => {
    await expect(NerEngine.load(path.join(os.tmpdir(), 'maskit-no-such-model'))).rejects.toThrow('NER 模型文件缺失');
  });

  it('文件齐全但损坏 → 中文提示，而不是原生层崩溃', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maskit-ner-bad-'));
    try {
      fs.writeFileSync(path.join(dir, 'model_quantized.onnx'), 'not an onnx');
      fs.writeFileSync(path.join(dir, 'tokenizer.json'), '{ broken');
      fs.writeFileSync(path.join(dir, 'config.json'), '{}');
      await expect(NerEngine.load(dir)).rejects.toThrow('分词器文件损坏');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!HAS_MODEL)('NerEngine（真实模型）', () => {
  let eng: NerEngine;
  beforeAll(async () => {
    eng = await NerEngine.load(MODEL_DIR);
  }, 120_000);
  afterAll(async () => {
    await eng?.dispose();
  });

  it('识别人名 / 机构 / 地址，start/end 对得上原文', async () => {
    const text = '请联系张伟，他在腾讯公司上班，住在上海市浦东新区世纪大道100号';
    const r = await eng.extract(text, far());
    expect(r.truncated).toBe(false);
    expect(r.error).toBeUndefined();
    for (const e of r.entities) expect(text.slice(e.start, e.end)).toBe(e.text);
    const by = (t: string) => r.entities.filter((e) => e.type === t).map((e) => e.text);
    expect(by('NAME')).toContain('张伟');
    expect(by('ORG')).toContain('腾讯公司');
    expect(by('ADDR').some((a) => a.includes('世纪大道100号'))).toBe(true);
  });

  it('地址后缀吸附 + 裸行政区被过滤（北京市海淀区不单独成实体）', async () => {
    const text = '请联系张伟，他在北京市海淀区中关村大街1号的公司上班';
    const r = await eng.extract(text, far());
    const addr = r.entities.filter((e) => e.type === 'ADDR').map((e) => e.text);
    expect(addr.some((a) => a.includes('1号'))).toBe(true);
    expect(addr).not.toContain('北京市海淀区');
    expect(addr).not.toContain('北京');
  });

  it('纯英文 / 代码 / 过短文本直接返回空，不起推理', async () => {
    const before = eng.stats.windows;
    for (const t of ['Please contact John Smith at Google, 1600 Amphitheatre Pkwy.', 'const a = 1;', '好', '  ', '']) {
      const r = await eng.extract(t, far());
      expect(r).toEqual({ entities: [], truncated: false });
    }
    expect(eng.stats.windows).toBe(before);
  });

  it('同一文本第二次命中缓存（不再起推理），结果逐字节一致', async () => {
    const text = '我是李明华，在华为技术有限公司工作，办公室在深圳市龙岗区坂田华为基地';
    const w0 = eng.stats.windows;
    const a = await eng.extract(text, far());
    const w1 = eng.stats.windows;
    const b = await eng.extract(text, far());
    expect(w1).toBeGreaterThan(w0);
    expect(eng.stats.windows).toBe(w1);
    expect(b).toEqual(a);
  });

  it('deadline 已过：不推理，truncated=true，且残缺结果不入缓存', async () => {
    const text = '联系人王建国，来自中国工商银行北京分行，地址是朝阳区建国路88号';
    const w0 = eng.stats.windows;
    const r = await eng.extract(text, Date.now() - 1);
    expect(r.truncated).toBe(true);
    expect(r.entities).toEqual([]);
    expect(eng.stats.windows).toBe(w0);
    // 之后正常预算下仍能识别（没有把“空结果”当负缓存固化）
    const ok = await eng.extract(text, far());
    expect(ok.truncated).toBe(false);
    expect(ok.entities.some((e) => e.text.includes('王建国'))).toBe(true);
  });

  it('extractMany 最新优先，且预算耗尽后未缓存文本被标记 truncated', async () => {
    const older = '老消息里的陈思远在阿里巴巴集团工作';
    const newer = '新消息里的赵雅琪在百度公司工作';
    const r = await eng.extractMany([older, newer], 60_000);
    expect(r.truncated).toBe(false);
    const names = r.entities.filter((e) => e.type === 'NAME').map((e) => e.text);
    expect(names).toEqual(expect.arrayContaining(['陈思远', '赵雅琪']));
    // 最新消息的实体排在前面
    expect(names.indexOf('赵雅琪')).toBeLessThan(names.indexOf('陈思远'));

    const fresh = await eng.extractMany(['预算为零时刘德胜在新浪公司上班'], 0);
    expect(fresh.truncated).toBe(true);
    // 已缓存的文本在零预算下仍可返回
    const cached = await eng.extractMany([older, newer], 0);
    expect(cached.truncated).toBe(false);
    expect(cached.entities.length).toBe(r.entities.length);
  });

  it('同一实体在多条消息里只出现一次', async () => {
    const r = await eng.extractMany(['我叫周海涛，在中国移动工作', '周海涛说他在中国移动工作'], 60_000);
    expect(r.entities.filter((e) => e.text === '周海涛')).toHaveLength(1);
  });

  it('超长文本分段识别：偏移是全文坐标，段首 / 段中 / 段尾都能识别', async () => {
    const filler = '这是一段用于填充的普通说明文字，不包含任何需要识别的内容。\n';
    const head = '开头的负责人是张伟。\n';
    const mid = '中间的联系人是李娜，她在腾讯公司工作。\n';
    const tail = '结尾的联系人是王芳。';
    const text = head + filler.repeat(120) + mid + filler.repeat(120) + tail;
    expect(text.length).toBeGreaterThan(6000);
    const r = await eng.extract(text, far());
    expect(r.truncated).toBe(false);
    for (const e of r.entities) expect(text.slice(e.start, e.end)).toBe(e.text);
    const names = r.entities.filter((e) => e.type === 'NAME').map((e) => e.text);
    expect(names).toEqual(expect.arrayContaining(['张伟', '李娜', '王芳']));
    // 区间两两不交
    for (let i = 1; i < r.entities.length; i++) expect(r.entities[i].start).toBeGreaterThanOrEqual(r.entities[i - 1].end);
  });

  it('实体正好被段切点劈开（无换行/句末可吸附）：靠回看重叠仍能完整识别', async () => {
    // 填充要有变化：整段重复文字会让模型失去上下文判断力（模型自身特性，与分段无关）
    let pad = '';
    for (let i = 0; pad.length < 3900; i++) pad += `第${i}条说明文字，`;
    pad = pad.slice(0, 3866);
    const text = pad + '我的同事叫张伟，' + '这是普通的说明文字，'.repeat(30);
    expect(text.indexOf('张伟')).toBe(3871); // 切点网格在 3872，正好落在“张”“伟”之间
    const r = await eng.extract(text, far());
    expect(r.entities.some((e) => e.type === 'NAME' && e.text === '张伟' && e.start === 3871)).toBe(true);
  });

  it('延迟（仅打印）', async () => {
    const seed = '请联系张伟，他在北京市海淀区中关村大街1号的腾讯公司上班，电话见附件。';
    const lines: string[] = [];
    for (const n of [100, 500, 2000]) {
      let text = '';
      let i = 0;
      // 每份文本都带唯一编号，避开缓存
      while (text.length < n) text += `${seed}第${n}-${i++}号。`;
      text = text.slice(0, n);
      const t0 = performance.now();
      const r = await eng.extract(text, far());
      const cold = performance.now() - t0;
      const t1 = performance.now();
      await eng.extract(text, far());
      const warm = performance.now() - t1;
      lines.push(`${n} 字：冷 ${cold.toFixed(0)}ms / 缓存命中 ${warm.toFixed(2)}ms / 实体 ${r.entities.length}`);
    }
    console.log(`[NER 延迟 threads=${eng.threads}] ${lines.join(' | ')}`);
  });

  it('dispose 之后再调用不抛异常，返回可见的错误', async () => {
    const e2 = await NerEngine.load(MODEL_DIR);
    await e2.dispose();
    const r = await e2.extract('张伟在北京工作', far());
    expect(r.error).toContain('已释放');
  });
});
