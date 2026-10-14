import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_BEHAVIOR, normalizeAppBehavior } from '../electron/gateway/config';

describe('应用行为配置', () => {
  it('缩到托盘默认开启，自启与检查更新默认关闭', () => {
    expect(DEFAULT_APP_BEHAVIOR).toEqual({ autostart: false, checkUpdates: false, closeToTray: true });
    expect(normalizeAppBehavior(undefined)).toEqual(DEFAULT_APP_BEHAVIOR);
  });

  it('旧配置没有 closeToTray 字段时按开启处理，只有显式 false 才关闭', () => {
    expect(normalizeAppBehavior({ autostart: true, checkUpdates: true }).closeToTray).toBe(true);
    expect(normalizeAppBehavior({ closeToTray: false }).closeToTray).toBe(false);
    expect(normalizeAppBehavior({ closeToTray: 'no' as unknown as boolean }).closeToTray).toBe(true);
  });
});
