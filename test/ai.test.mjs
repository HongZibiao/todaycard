import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractJson, buildMessages } = require('../src/main/ai.js');

const tasks = [
  {
    id: 'abc-1',
    title: '备课：Scratch 循环',
    estimateMin: 60,
    priority: 'high',
    note: '要准备三个例子',
    carriedFrom: '2026-11-23',
    done: false,
  },
];

const settings = {
  dayStart: '09:00',
  dayEnd: '18:00',
  lunchStart: '12:00',
  lunchEnd: '13:30',
  focusMin: 45,
  bufferMin: 5,
};

describe('extractJson', () => {
  it('解析裸 JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('剥掉 markdown 围栏', () => {
    const text = '```json\n{"blocks":[]}\n```';
    expect(extractJson(text)).toEqual({ blocks: [] });
  });

  it('模型在 JSON 前后加了解释也能救回来', () => {
    const text = '好的，这是今天的安排：\n{"intro":"先难后易"}\n希望有帮助。';
    expect(extractJson(text)).toEqual({ intro: '先难后易' });
  });

  it('容忍尾随逗号', () => {
    expect(extractJson('{"blocks":[{"taskId":"1"},],}')).toEqual({ blocks: [{ taskId: '1' }] });
  });

  it('完全不是 JSON 就返回 null', () => {
    expect(extractJson('抱歉，我无法完成')).toBeNull();
    expect(extractJson('')).toBeNull();
    expect(extractJson(null)).toBeNull();
  });
});

describe('buildMessages', () => {
  const messages = buildMessages({ tasks, settings, now: new Date(2026, 10, 24, 9, 5), dateKey: '2026-11-24' });

  it('带上任务 id，否则清洗阶段对不上', () => {
    expect(messages[1].content).toContain('abc-1');
    expect(messages[1].content).toContain('Scratch 循环');
  });

  it('把当前时间、可排期区间、午休都交代清楚', () => {
    const user = messages[1].content;
    expect(user).toContain('09:05');
    expect(user).toContain('09:00–18:00');
    expect(user).toContain('12:00–13:30');
  });

  it('顺延过的任务会被特别标注，让模型知道它一直没做完', () => {
    expect(messages[1].content).toContain('2026-11-23');
  });

  it('已完成的任务不进提示词', () => {
    const msgs = buildMessages({
      tasks: [...tasks, { ...tasks[0], id: 'done-1', title: '已经做完的事', done: true }],
      settings,
      now: new Date(),
      dateKey: '2026-11-24',
    });
    expect(msgs[1].content).not.toContain('已经做完的事');
  });

  it('系统提示要求只输出 JSON', () => {
    expect(messages[0].content).toContain('只输出 JSON');
  });
});
