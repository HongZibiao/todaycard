'use strict';

/**
 * 排程核心。
 *
 * 两条路径共用同一套「时间块」结构：
 *   1. planLocally —— 规则排程，不需要任何网络/API Key，永远有兜底
 *   2. sanitizePlan —— 把 AI 返回的 JSON 收敛成合法、无重叠、不越界的时间块
 *
 * 之所以要两者并存：AI 会返回格式不对、时间重叠、把任务排到凌晨的内容，
 * 这类结果不能直接渲染给用户，必须先经过确定性清洗。
 */

const { toMinutes, fromMinutes, nowMinutes } = require('./datetime');
const { PRIORITY_WEIGHT } = require('./defaults');

const MIN_BLOCK = 10; // 一个块少于 10 分钟没有意义
const SNAP = 5; // 时间对齐到 5 分钟

function snapUp(min) {
  return Math.ceil(min / SNAP) * SNAP;
}

/** 把可排期时段拆成窗口列表，自动跳过午休 */
function buildWindows(settings) {
  const dayStart = toMinutes(settings.dayStart) ?? 8 * 60;
  const dayEnd = toMinutes(settings.dayEnd) ?? 23 * 60;
  const lunchStart = toMinutes(settings.lunchStart);
  const lunchEnd = toMinutes(settings.lunchEnd);

  if (dayEnd <= dayStart) return [{ start: dayStart, end: dayStart + 60 }];

  const windows = [];
  const hasLunch = lunchStart != null && lunchEnd != null && lunchEnd > lunchStart && lunchStart > dayStart && lunchStart < dayEnd;
  if (!hasLunch) {
    windows.push({ start: dayStart, end: dayEnd });
  } else {
    windows.push({ start: dayStart, end: Math.min(lunchStart, dayEnd) });
    if (lunchEnd < dayEnd) windows.push({ start: lunchEnd, end: dayEnd });
  }
  return windows.filter((w) => w.end - w.start >= MIN_BLOCK);
}

/** 从 cursor 起找一个能放下 duration 的位置；放不下返回 null */
function locate(windows, cursor, duration) {
  for (let i = 0; i < windows.length; i += 1) {
    const w = windows[i];
    if (cursor >= w.end) continue;
    const start = Math.max(cursor, w.start);
    if (start + duration <= w.end) return { start, end: start + duration, windowIndex: i };
    // 落在窗口尾部且剩余不足：换下一个窗口的开头（前提是那个窗口在 cursor 之后）
    const next = windows[i + 1];
    if (next && next.start >= cursor && next.start + duration <= next.end) {
      return { start: next.start, end: next.start + duration, windowIndex: i + 1 };
    }
  }
  return null;
}

/** 按优先级 + 预计时长排序：重要且耗时的先上，符合「先啃硬骨头」 */
function sortForPlanning(tasks) {
  return [...tasks]
    .filter((t) => !t.done)
    .sort((a, b) => {
      const pa = PRIORITY_WEIGHT[a.priority] ?? 1;
      const pb = PRIORITY_WEIGHT[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      if (b.estimateMin !== a.estimateMin) return b.estimateMin - a.estimateMin;
      return a.order - b.order;
    });
}

/** 给任务生成一句「怎么起手」，规则表，宁缺毋滥 */
function suggestFirstStep(title) {
  const t = String(title || '');
  if (/备课|教案|课件|课程|上课/.test(t)) return '先定三个课堂目标，再补素材';
  if (/开会|会议|教研|例会|复盘会/.test(t)) return '先写下要拍板的三件事';
  if (/批改|点评|反馈|评语/.test(t)) return '先过一遍名单，再逐条写';
  if (/回复|消息|微信|沟通|联系|家长/.test(t)) return '先清未读，只处理今天必须回的';
  if (/写|报告|文档|方案|代码|作业|题/.test(t)) return '先搭最小骨架，别一上来抠细节';
  if (/整理|归档|清理|打扫/.test(t)) return '先划出一小块地方开始';
  if (/买|采购|下单|缴费/.test(t)) return '先列清单，再一次性下完';
  if (/锻炼|跑步|健身|运动/.test(t)) return '先换好衣服出门';
  return '';
}

function emptyPlan(source) {
  return {
    createdAt: new Date().toISOString(),
    source,
    intro: '',
    blocks: [],
    unscheduled: [],
    tips: [],
  };
}

/** 规则排程：纯本地、确定性、毫秒级 */
function planLocally({ tasks, settings, now = new Date() }) {
  const plan = emptyPlan('local');
  const pending = sortForPlanning(tasks);
  if (!pending.length) {
    plan.intro = '今天没有待办，先加两件真正要推进的事。';
    return plan;
  }

  const windows = buildWindows(settings);
  const dayStart = windows.length ? windows[0].start : 8 * 60;
  const dayEnd = windows.length ? windows[windows.length - 1].end : 23 * 60;
  const buffer = Math.max(0, Number(settings.bufferMin) || 5);

  let cursor = snapUp(Math.max(nowMinutes(now), dayStart));
  const totalMin = pending.reduce((sum, t) => sum + t.estimateMin, 0);

  for (const task of pending) {
    const duration = Math.max(MIN_BLOCK, Number(task.estimateMin) || 30);
    const slot = locate(windows, cursor, duration);

    if (!slot) {
      // 放不下：要么剩余时间太碎，要么已经过了收工时间
      const remaining = Math.max(0, dayEnd - Math.max(cursor, dayStart));
      if (remaining >= MIN_BLOCK) {
        const start = snapUp(Math.max(cursor, dayStart));
        plan.blocks.push({
          taskId: task.id,
          start: fromMinutes(start),
          end: fromMinutes(Math.min(dayEnd, start + Math.min(duration, remaining))),
          firstStep: task.firstStep || suggestFirstStep(task.title),
          squeezed: true,
        });
        cursor = Math.min(dayEnd, start + Math.min(duration, remaining)) + buffer;
      } else {
        plan.unscheduled.push(task.id);
      }
      continue;
    }

    plan.blocks.push({
      taskId: task.id,
      start: fromMinutes(slot.start),
      end: fromMinutes(slot.end),
      firstStep: task.firstStep || suggestFirstStep(task.title),
    });
    cursor = slot.end + buffer;
  }

  if (plan.blocks.length) {
    const last = plan.blocks[plan.blocks.length - 1];
    plan.intro = `${pending.length} 件事，大约 ${Math.round(totalMin / 5) * 5} 分钟的活，从 ${plan.blocks[0].start} 排到 ${last.end}。`;
  }

  if (plan.unscheduled.length) {
    plan.tips.push(`${plan.unscheduled.length} 件今天排不下，建议顺延到明天或先砍掉。`);
  }
  if (nowMinutes(now) > dayEnd - 60) {
    plan.tips.push('今天剩下的时间不多了，只保最重要的那一件。');
  }

  return plan;
}

/** 宽松解析 AI 给的时间：'9:00' / '09:00' / '9：00' / '9点半' 都尽量救回来 */
function parseClock(value) {
  if (value == null) return null;
  const s = String(value).trim().replace('：', ':');
  const direct = toMinutes(s);
  if (direct != null) return direct;
  const m = /(\d{1,2})\s*[:点时]\s*(\d{1,2})?/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 清洗 AI 结果：
 *  - 丢掉不存在的 taskId、重复的 taskId
 *  - 时间越界的夹回可排期区间
 *  - 重叠的块按顺序往后推，保证时间轴单调不重叠
 *  - 校验失败返回 null，由调用方回退到本地排程
 */
function sanitizePlan(raw, { tasks, settings, now = new Date() }) {
  if (!raw || typeof raw !== 'object') return null;
  const list = Array.isArray(raw.blocks) ? raw.blocks : Array.isArray(raw.schedule) ? raw.schedule : null;
  if (!list) return null;

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const windows = buildWindows(settings);
  const dayStart = windows.length ? windows[0].start : 8 * 60;
  const dayEnd = windows.length ? windows[windows.length - 1].end : 23 * 60;
  const buffer = Math.max(0, Number(settings.bufferMin) || 5);

  const seen = new Set();
  const parsed = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const taskId = String(item.taskId || item.task_id || item.id || '').trim();
    const task = byId.get(taskId);
    if (!task || seen.has(taskId)) continue;
    seen.add(taskId);

    const start = parseClock(item.start) ?? parseClock(item.startAt);
    if (start == null) continue;
    const fallbackDuration = Math.max(MIN_BLOCK, Number(task.estimateMin) || 30);
    const end = parseClock(item.end) ?? parseClock(item.endAt);

    parsed.push({
      taskId,
      start: Math.max(dayStart, Math.min(dayEnd - MIN_BLOCK, start)),
      end: end != null ? end : null,
      fallbackDuration,
      firstStep: String(item.firstStep || item.first_step || '').trim().slice(0, 60),
    });
  }

  if (!parsed.length) return null;
  parsed.sort((a, b) => a.start - b.start);

  const plan = emptyPlan('ai');
  plan.intro = String(raw.intro || raw.summary || '').trim().slice(0, 200);
  plan.tips = Array.isArray(raw.tips)
    ? raw.tips.map((t) => String(t).trim().slice(0, 80)).filter(Boolean).slice(0, 4)
    : [];

  let cursor = 0;
  for (const item of parsed) {
    const duration = item.end != null ? Math.max(MIN_BLOCK, item.end - item.start) : item.fallbackDuration;
    const start = Math.max(item.start, cursor, dayStart);
    const end = Math.min(dayEnd, start + duration);
    if (end - start < MIN_BLOCK) {
      plan.unscheduled.push(item.taskId);
      continue;
    }
    plan.blocks.push({
      taskId: item.taskId,
      start: fromMinutes(start),
      end: fromMinutes(end),
      firstStep: item.firstStep || suggestFirstStep(byId.get(item.taskId).title),
    });
    cursor = end + buffer;
  }

  // AI 漏排的任务：接在最后一块之后补上，实在放不下就标为未排
  const placed = new Set(plan.blocks.map((b) => b.taskId));
  const leftovers = sortForPlanning(tasks).filter((t) => !placed.has(t.id));
  for (const task of leftovers) {
    const duration = Math.max(MIN_BLOCK, Number(task.estimateMin) || 30);
    const slot = locate(windows, cursor, duration);
    if (!slot) {
      plan.unscheduled.push(task.id);
      continue;
    }
    plan.blocks.push({
      taskId: task.id,
      start: fromMinutes(slot.start),
      end: fromMinutes(slot.end),
      firstStep: suggestFirstStep(task.title),
    });
    cursor = slot.end + buffer;
  }

  if (!plan.blocks.length) return null;
  return plan;
}

module.exports = {
  MIN_BLOCK,
  buildWindows,
  locate,
  sortForPlanning,
  suggestFirstStep,
  planLocally,
  sanitizePlan,
  parseClock,
};
