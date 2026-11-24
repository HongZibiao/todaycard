import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Store } = require('../src/main/store.js');

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todaycard-test-'));
  file = path.join(dir, 'data.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Store', () => {
  it('新建后能存能读，重启不丢任务', () => {
    const a = new Store(file);
    a.load();
    a.addTask({ title: '备课', estimateMin: 60 }, '2026-11-24');
    a.flush();

    const b = new Store(file);
    b.load();
    const list = b.tasksOf('2026-11-24');
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('备课');
    expect(list[0].estimateMin).toBe(60);
  });

  it('空标题不落库', () => {
    const s = new Store(file);
    s.load();
    expect(s.addTask({ title: '   ' }, '2026-11-24')).toBeNull();
    expect(s.tasksOf('2026-11-24')).toHaveLength(0);
  });

  it('勾选完成会记时间，取消会清空', () => {
    const s = new Store(file);
    s.load();
    const t = s.addTask({ title: '回消息' }, '2026-11-24');
    s.toggleTask(t.id);
    expect(s.findTask(t.id).done).toBe(true);
    expect(s.findTask(t.id).doneAt).toBeTruthy();
    s.toggleTask(t.id);
    expect(s.findTask(t.id).done).toBe(false);
    expect(s.findTask(t.id).doneAt).toBeNull();
  });

  it('已完成排在未完成后面', () => {
    const s = new Store(file);
    s.load();
    const a = s.addTask({ title: 'A' }, '2026-11-24');
    s.addTask({ title: 'B' }, '2026-11-24');
    s.toggleTask(a.id);
    expect(s.tasksOf('2026-11-24').map((t) => t.title)).toEqual(['B', 'A']);
  });

  it('跨天把昨天没做完的顺延过来，做完的不管', () => {
    const s = new Store(file);
    s.load();
    const undone = s.addTask({ title: '没做完的' }, '2026-11-23');
    const done = s.addTask({ title: '做完的' }, '2026-11-23');
    s.toggleTask(done.id);

    const result = s.rollover('2026-11-24');
    expect(result.carried).toBe(1);

    const today = s.tasksOf('2026-11-24');
    expect(today).toHaveLength(1);
    expect(today[0].id).toBe(undone.id);
    expect(today[0].carriedFrom).toBe('2026-11-23');
  });

  it('同一天重复调用 rollover 不会重复顺延', () => {
    const s = new Store(file);
    s.load();
    s.addTask({ title: 'X' }, '2026-11-23');
    expect(s.rollover('2026-11-24').carried).toBe(1);
    expect(s.rollover('2026-11-24').carried).toBe(0);
    expect(s.tasksOf('2026-11-24')).toHaveLength(1);
  });

  it('顺延最多 10 条，防止旧账堆成山', () => {
    const s = new Store(file);
    s.load();
    for (let i = 0; i < 15; i += 1) s.addTask({ title: `旧任务 ${i}` }, '2026-11-20');
    const r = s.rollover('2026-11-24');
    expect(r.carried).toBe(10);
    expect(s.tasksOf('2026-11-24')).toHaveLength(10);
  });

  it('清理 30 天前已完成的任务', () => {
    const s = new Store(file);
    s.load();
    const old = s.addTask({ title: '陈年旧事' }, '2026-01-01');
    s.toggleTask(old.id);
    s.addTask({ title: '最近的事' }, '2026-11-24');
    s.rollover('2026-11-24');
    expect(s.findTask(old.id)).toBeNull();
  });

  it('数据文件损坏时备份原文件而不是直接丢', () => {
    fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
    const s = new Store(file);
    s.load();
    expect(s.tasksOf('2026-11-24')).toEqual([]);
    const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    expect(backups).toHaveLength(1);
  });

  it('设置里的脏字段被挡掉，未知 Key 不会写进去', () => {
    const s = new Store(file);
    s.load();
    s.patchSettings({ opacity: 99, theme: 'rainbow', evil: '<script>' });
    expect(s.getSettings().opacity).toBe(1);
    expect(s.getSettings().theme).toBe('light');
    expect(s.getSettings().evil).toBeUndefined();
  });

  it('改 AI 的某个字段不会冲掉已保存的 Key', () => {
    const s = new Store(file);
    s.load();
    s.patchSettings({ ai: { apiKeyEnc: 'ZW5jcnlwdGVk', model: 'deepseek-chat' } });
    s.patchSettings({ ai: { enabled: true } });
    s.patchSettings({ ai: { model: 'deepseek-reasoner' } });

    const ai = s.getSettings().ai;
    expect(ai.apiKeyEnc).toBe('ZW5jcnlwdGVk');
    expect(ai.enabled).toBe(true);
    expect(ai.model).toBe('deepseek-reasoner');
  });

  it('清空计划时把任务上的时间块一起清掉', () => {
    const s = new Store(file);
    s.load();
    const t = s.addTask({ title: 'A' }, '2026-11-24');
    s.updateTask(t.id, { startAt: '09:00', endAt: '09:45', firstStep: '先打开文件' });
    s.setPlan('2026-11-24', { blocks: [] });
    s.clearPlan('2026-11-24');
    expect(s.findTask(t.id).startAt).toBeNull();
    expect(s.findTask(t.id).firstStep).toBe('');
  });
});
