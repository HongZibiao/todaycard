import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildWindows, planLocally, sanitizePlan, suggestFirstStep, sortForPlanning } =
  require('../src/main/planner.js');
const { toMinutes } = require('../src/main/datetime.js');

const settings = {
  dayStart: '09:00',
  dayEnd: '18:00',
  lunchStart: '12:00',
  lunchEnd: '13:30',
  focusMin: 45,
  bufferMin: 5,
};

function task(id, title, estimateMin = 45, priority = 'normal', order = 0) {
  return {
    id,
    title,
    estimateMin,
    priority,
    order,
    done: false,
    firstStep: '',
    note: '',
    date: '2026-11-24',
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
  };
}

const at = (h, m = 0) => new Date(2026, 10, 24, h, m, 0);

describe('buildWindows', () => {
  it('把一天切成上午和下午，跳过午休', () => {
    const w = buildWindows(settings);
    expect(w).toEqual([
      { start: 540, end: 720 },
      { start: 810, end: 1080 },
    ]);
  });

  it('午休配置无效时退回整段', () => {
    const w = buildWindows({ ...settings, lunchStart: '13:00', lunchEnd: '12:00' });
    expect(w).toEqual([{ start: 540, end: 1080 }]);
  });
});

describe('sortForPlanning', () => {
  it('重要的先排，同优先级里耗时的先排，已完成的排除', () => {
    const list = [
      task('a', '普通短事', 15, 'normal', 0),
      task('b', '重要的事', 30, 'high', 1),
      { ...task('c', '已做完', 60, 'high', 2), done: true },
      task('d', '普通长事', 90, 'normal', 3),
    ];
    const sorted = sortForPlanning(list).map((t) => t.id);
    expect(sorted).toEqual(['b', 'd', 'a']);
  });
});

describe('planLocally', () => {
  it('时间块不重叠、按顺序推进、都落在可排期区间内', () => {
    const tasks = [task('1', '备课', 60), task('2', '改作业', 45), task('3', '回消息', 20)];
    const plan = planLocally({ tasks, settings, now: at(9, 0) });

    expect(plan.blocks).toHaveLength(3);
    for (let i = 1; i < plan.blocks.length; i += 1) {
      expect(toMinutes(plan.blocks[i].start)).toBeGreaterThan(toMinutes(plan.blocks[i - 1].end));
    }
    for (const block of plan.blocks) {
      const s = toMinutes(block.start);
      const e = toMinutes(block.end);
      expect(s).toBeGreaterThanOrEqual(540);
      expect(e).toBeLessThanOrEqual(1080);
      // 不能横跨午休
      expect(s >= 810 || e <= 720).toBe(true);
    }
  });

  it('从当前时间开始排，不会把事排到过去', () => {
    const plan = planLocally({ tasks: [task('1', '写方案', 30)], settings, now: at(15, 20) });
    expect(toMinutes(plan.blocks[0].start)).toBeGreaterThanOrEqual(15 * 60 + 20);
  });

  it('每块之间留出 buffer', () => {
    const tasks = [task('1', 'A', 30), task('2', 'B', 30)];
    const plan = planLocally({ tasks, settings: { ...settings, bufferMin: 15 }, now: at(9, 0) });
    expect(toMinutes(plan.blocks[1].start) - toMinutes(plan.blocks[0].end)).toBe(15);
  });

  it('排在午休前放不下时顺延到下午，而不是压进午休', () => {
    // 11:30 起，60 分钟的活放不进 12:00 前
    const plan = planLocally({ tasks: [task('1', '长活', 60)], settings, now: at(11, 30) });
    expect(toMinutes(plan.blocks[0].start)).toBeGreaterThanOrEqual(810);
  });

  it('收工时间之后不再排，标为未排', () => {
    const plan = planLocally({ tasks: [task('1', '来不及', 60)], settings, now: at(17, 55) });
    expect(plan.blocks).toHaveLength(0);
    expect(plan.unscheduled).toEqual(['1']);
    expect(plan.tips.join()).toContain('排不下');
  });

  it('没有待办时给一句提示，不崩', () => {
    const plan = planLocally({ tasks: [], settings, now: at(9, 0) });
    expect(plan.blocks).toEqual([]);
    expect(plan.intro).toContain('没有待办');
  });
});

describe('sanitizePlan', () => {
  const tasks = [task('1', '备课', 45), task('2', '开会', 30)];

  it('丢掉不存在的 taskId 和重复项', () => {
    const plan = sanitizePlan(
      {
        blocks: [
          { taskId: '1', start: '09:00', end: '09:45' },
          { taskId: '1', start: '10:00', end: '10:30' },
          { taskId: 'ghost', start: '11:00', end: '11:30' },
        ],
      },
      { tasks, settings, now: at(8, 0) }
    );
    // 重复的 '1' 只保留第一条，'ghost' 被丢掉，漏排的 '2' 自动补在末尾
    expect(plan.blocks.map((b) => b.taskId)).toEqual(['1', '2']);
    expect(plan.blocks[0].start).toBe('09:00');
    expect(plan.blocks[0].end).toBe('09:45');
  });

  it('重叠的块被推开，时间轴保持单调', () => {
    const plan = sanitizePlan(
      {
        blocks: [
          { taskId: '1', start: '09:00', end: '10:00' },
          { taskId: '2', start: '09:30', end: '10:00' },
        ],
      },
      { tasks, settings, now: at(8, 0) }
    );
    expect(toMinutes(plan.blocks[1].start)).toBeGreaterThanOrEqual(toMinutes(plan.blocks[0].end));
  });

  it('把越界时间夹回可排期区间', () => {
    const plan = sanitizePlan(
      { blocks: [{ taskId: '1', start: '03:00', end: '04:00' }] },
      { tasks, settings, now: at(8, 0) }
    );
    expect(toMinutes(plan.blocks[0].start)).toBe(540);
  });

  it('AI 漏排的任务被补在末尾', () => {
    const plan = sanitizePlan(
      { blocks: [{ taskId: '1', start: '09:00', end: '09:45' }] },
      { tasks, settings, now: at(8, 0) }
    );
    expect(plan.blocks.map((b) => b.taskId)).toEqual(['1', '2']);
  });

  it('完全无效的返回 null，交给上层降级', () => {
    expect(sanitizePlan({ blocks: [] }, { tasks, settings, now: at(8, 0) })).toBeNull();
    expect(sanitizePlan(null, { tasks, settings, now: at(8, 0) })).toBeNull();
    expect(sanitizePlan({ blocks: [{ taskId: 'ghost', start: '09:00' }] }, { tasks, settings, now: at(8, 0) })).toBeNull();
  });

  it('容忍 9:00 这种不补零的写法', () => {
    const plan = sanitizePlan(
      { blocks: [{ taskId: '1', start: '9:05', end: '9:50' }] },
      { tasks, settings, now: at(8, 0) }
    );
    expect(plan.blocks[0].start).toBe('09:05');
  });
});

describe('suggestFirstStep', () => {
  it('按关键词给出具体动作', () => {
    expect(suggestFirstStep('明天上课的备课')).toContain('课堂目标');
    expect(suggestFirstStep('批改周作业')).toContain('名单');
  });

  it('没匹配上就不硬编，返回空串', () => {
    expect(suggestFirstStep('随便一件事')).toBe('');
  });
});
