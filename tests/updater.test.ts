import { describe, expect, it } from 'vitest';
import {
  DEV_NOTE,
  LINUX_DEB_NOTE,
  LINUX_UNSUPPORTED_NOTE,
  MAC_NOTE,
  canDownload,
  decideSupport,
  initialState,
  normalizeReleaseNotes,
  reduceState,
} from '../electron/service/updater-logic';

describe('decideSupport', () => {
  it('开发模式一律不支持', () => {
    expect(decideSupport({ platform: 'win32', packaged: false })).toEqual({ supported: false, platformNote: DEV_NOTE });
  });
  it('Windows 打包版支持', () => {
    expect(decideSupport({ platform: 'win32', packaged: true })).toEqual({ supported: true });
  });
  it('macOS 不支持（未签名）', () => {
    expect(decideSupport({ platform: 'darwin', packaged: true })).toEqual({ supported: false, platformNote: MAC_NOTE });
  });
  it('Linux 仅 deb 包支持并提示管理员密码', () => {
    expect(decideSupport({ platform: 'linux', packaged: true, packageType: 'deb' })).toEqual({ supported: true, platformNote: LINUX_DEB_NOTE });
    expect(decideSupport({ platform: 'linux', packaged: true, packageType: null }).supported).toBe(false);
    expect(decideSupport({ platform: 'linux', packaged: true, packageType: 'rpm' })).toEqual({ supported: false, platformNote: LINUX_UNSUPPORTED_NOTE });
  });
});

describe('decideSupport 与 CPU 架构无关', () => {
  // 判定入参不含架构：Windows x64/arm64、Linux deb x64/arm64 结论必须相同；各架构走各自的通道文件（见 build-channels.test.ts）
  it.each(['x64', 'arm64'])('Windows %s 打包版支持', () => {
    expect(decideSupport({ platform: 'win32', packaged: true })).toEqual({ supported: true });
  });
  it.each(['x64', 'arm64'])('Linux deb %s 支持，非 deb 不支持', () => {
    expect(decideSupport({ platform: 'linux', packaged: true, packageType: 'deb' }).supported).toBe(true);
    expect(decideSupport({ platform: 'linux', packaged: true, packageType: 'AppImage' }).supported).toBe(false);
  });
  it.each(['x64', 'arm64'])('macOS %s 一律不支持', () => {
    expect(decideSupport({ platform: 'darwin', packaged: true })).toEqual({ supported: false, platformNote: MAC_NOTE });
  });
});

describe('reduceState', () => {
  const base = initialState({ supported: true });

  it('完整流程：检查 -> 发现 -> 下载 -> 完成', () => {
    let s = reduceState(base, { type: 'checking' });
    expect(s.status).toBe('checking');
    s = reduceState(s, { type: 'available', version: '1.2.3', releaseNotes: 'notes' });
    expect(s).toMatchObject({ status: 'available', version: '1.2.3', releaseNotes: 'notes' });
    s = reduceState(s, { type: 'progress', progress: { percent: 40, transferred: 4, total: 10, bytesPerSecond: 2 } });
    expect(s.status).toBe('downloading');
    expect(s.version).toBe('1.2.3');
    s = reduceState(s, { type: 'downloaded' });
    expect(s).toMatchObject({ status: 'downloaded', version: '1.2.3' });
    expect(s.progress?.percent).toBe(100);
  });

  it('不修改入参，并保留 supported/platformNote', () => {
    const s0 = initialState({ supported: true, platformNote: 'x' });
    const s1 = reduceState(s0, { type: 'checking' });
    expect(s0.status).toBe('idle');
    expect(s1).toMatchObject({ supported: true, platformNote: 'x' });
  });

  it('错误会清理进度，重新检查会清除错误', () => {
    let s = reduceState(base, { type: 'error', message: 'boom' });
    expect(s).toMatchObject({ status: 'error', error: 'boom' });
    s = reduceState(s, { type: 'checking' });
    expect(s.error).toBeUndefined();
  });

  it('not-available 清除旧的版本说明', () => {
    let s = reduceState(base, { type: 'available', version: '2.0.0', releaseNotes: 'n' });
    s = reduceState(s, { type: 'not-available' });
    expect(s.status).toBe('not-available');
    expect(s.releaseNotes).toBeUndefined();
  });
});

describe('canDownload', () => {
  it('仅 available 或带版本的 error 可下载', () => {
    const s = initialState({ supported: true });
    expect(canDownload(s)).toBe(false);
    expect(canDownload(reduceState(s, { type: 'available', version: '1.0.1' }))).toBe(true);
    const failed = reduceState(reduceState(s, { type: 'available', version: '1.0.1' }), { type: 'error', message: 'x' });
    expect(canDownload(failed)).toBe(true);
    expect(canDownload(reduceState(s, { type: 'error', message: 'x' }))).toBe(false);
  });
  it('不支持的平台永不可下载', () => {
    const s = reduceState(initialState({ supported: false }), { type: 'available', version: '1.0.1' });
    expect(canDownload(s)).toBe(false);
  });
});

describe('normalizeReleaseNotes', () => {
  it('剥离 HTML 标签并还原实体', () => {
    const t = normalizeReleaseNotes('<h2>新增</h2><ul><li>A &amp; B</li><li>C</li></ul><script>alert(1)</script>');
    expect(t).not.toMatch(/<\w/);
    expect(t).toContain('- A & B');
    expect(t).toContain('- C');
  });
  it('支持数组形式与空值', () => {
    expect(normalizeReleaseNotes([{ version: '1.0.0', note: 'hi' }])).toBe('1.0.0\nhi');
    expect(normalizeReleaseNotes(null)).toBeUndefined();
    expect(normalizeReleaseNotes('   ')).toBeUndefined();
  });
  it('超长截断', () => {
    expect(normalizeReleaseNotes('a'.repeat(50), 10)).toBe('a'.repeat(10) + '…');
  });
});
