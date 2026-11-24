'use strict';

/**
 * 时间与日期工具（主进程侧，纯函数，便于单测）
 * 约定：
 *  - 日期键统一为本地时区的 'YYYY-MM-DD'
 *  - 一天内的时刻统一为 'HH:mm'，内部再换算成「距 00:00 的分钟数」参与计算
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** Date -> 'YYYY-MM-DD'（本地时区，不走 toISOString，避免 UTC 偏移串日期） */
function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 'YYYY-MM-DD' -> Date（当天 00:00 本地） */
function parseDateKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** 日期键加减天数，返回新键 */
function addDays(key, n) {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

/** 'HH:mm' -> 分钟数；非法返回 null */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 分钟数 -> 'HH:mm'，会夹到 00:00–23:59 */
function fromMinutes(min) {
  const v = Math.max(0, Math.min(23 * 60 + 59, Math.round(Number(min) || 0)));
  return `${pad2(Math.floor(v / 60))}:${pad2(v % 60)}`;
}

/** 当前时刻的分钟数 */
function nowMinutes(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}

/** 'YYYY-MM-DD' -> '周一' */
function weekdayCN(key) {
  return WEEKDAYS[parseDateKey(key).getDay()];
}

/** 'YYYY-MM-DD' -> '11月24日' */
function monthDayCN(key) {
  const d = parseDateKey(key);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 距离下一个整分钟的毫秒数（用于省电的对齐定时器） */
function msToNextMinute(d = new Date()) {
  return (60 - d.getSeconds()) * 1000 - d.getMilliseconds() + 30;
}

/** 两个分钟数之差，格式化成人话：'1 小时 20 分' / '25 分钟' */
function humanDuration(min) {
  const v = Math.max(0, Math.round(min));
  if (v < 60) return `${v} 分钟`;
  const h = Math.floor(v / 60);
  const m = v % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

module.exports = {
  WEEKDAYS,
  pad2,
  dateKey,
  parseDateKey,
  addDays,
  toMinutes,
  fromMinutes,
  nowMinutes,
  weekdayCN,
  monthDayCN,
  msToNextMinute,
  humanDuration,
};
