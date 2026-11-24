import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dateKey, addDays, toMinutes, fromMinutes, weekdayCN, monthDayCN, humanDuration } =
  require('../src/main/datetime.js');

describe('datetime', () => {
  it('dateKey 用本地时区，不会因为 UTC 偏移串到前一天', () => {
    const d = new Date(2026, 10, 24, 0, 30, 0); // 本地 11-24 00:30
    expect(dateKey(d)).toBe('2026-11-24');
  });

  it('addDays 能跨月、跨年', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('toMinutes / fromMinutes 互逆', () => {
    expect(toMinutes('09:05')).toBe(545);
    expect(fromMinutes(545)).toBe('09:05');
    expect(toMinutes('24:00')).toBeNull();
    expect(toMinutes('9:5')).toBeNull();
    expect(toMinutes('abc')).toBeNull();
    expect(fromMinutes(-30)).toBe('00:00');
    expect(fromMinutes(24 * 60 + 10)).toBe('23:59');
  });

  it('中文日期格式', () => {
    expect(weekdayCN('2026-11-24')).toBe('周二');
    expect(monthDayCN('2026-11-24')).toBe('11月24日');
  });

  it('humanDuration 输出人话', () => {
    expect(humanDuration(25)).toBe('25 分钟');
    expect(humanDuration(60)).toBe('1 小时');
    expect(humanDuration(80)).toBe('1 小时 20 分');
  });
});
