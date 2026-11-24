'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SCHEMA_VERSION, normalizeSettings, normalizeTask, createTask } = require('./defaults');
const { addDays } = require('./datetime');

const MAX_HISTORY_DAYS = 30; // 完成超过 30 天的任务自动清理
const MAX_CARRYOVER = 10; // 单次最多顺延 10 条，避免旧账堆积成山

/**
 * 单文件 JSON 存储。
 * 写入策略：内存改 → 300ms 防抖落盘（先写 .tmp 再 rename，避免断电/崩溃写出半截文件）。
 * 这样任务勾选等高频操作不会频繁碰磁盘，也不会有丢数据的风险窗口。
 */
class Store {
  constructor(filePath) {
    this.file = filePath;
    this.data = this.emptyState();
    this._timer = null;
    this._dirty = false;
  }

  emptyState() {
    return {
      version: SCHEMA_VERSION,
      tasks: [],
      plans: {},
      settings: normalizeSettings({}),
      meta: { lastRollover: null, createdAt: new Date().toISOString() },
    };
  }

  load() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (!fs.existsSync(this.file)) {
        this.data = this.emptyState();
        this.save(true);
        return this.data;
      }
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = this.migrate(raw);
    } catch (err) {
      // 数据坏了不能直接清空：备份一份再重建，用户还有救回来的机会
      this.backupCorrupt(err);
      this.data = this.emptyState();
      this.save(true);
    }
    return this.data;
  }

  backupCorrupt(err) {
    try {
      if (fs.existsSync(this.file)) {
        const dest = `${this.file}.corrupt-${Date.now()}`;
        fs.copyFileSync(this.file, dest);
        console.error('[store] 数据文件解析失败，已备份到', dest, err && err.message);
      }
    } catch (_) {
      /* 备份失败也不能阻塞启动 */
    }
  }

  migrate(raw) {
    const base = this.emptyState();
    if (!raw || typeof raw !== 'object') return base;

    const tasks = Array.isArray(raw.tasks) ? raw.tasks.map(normalizeTask).filter(Boolean) : [];
    const plans = raw.plans && typeof raw.plans === 'object' ? raw.plans : {};
    const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : base.meta;

    return {
      version: SCHEMA_VERSION,
      tasks,
      plans,
      settings: normalizeSettings(raw.settings),
      meta: { ...base.meta, ...meta },
    };
  }

  /** 防抖保存；immediate=true 时立即落盘 */
  save(immediate = false) {
    this._dirty = true;
    if (this._timer) clearTimeout(this._timer);
    if (immediate) return this.flush();
    this._timer = setTimeout(() => this.flush(), 300);
    if (this._timer.unref) this._timer.unref();
  }

  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this._dirty = true;
      console.error('[store] 写入失败', err && err.message);
    }
  }

  // ---------- 设置 ----------

  getSettings() {
    return this.data.settings;
  }

  patchSettings(patch) {
    const merged = { ...this.data.settings, ...patch };
    // ai 是嵌套对象，必须深合并：渲染进程只会传来改动的几个字段，
    // 直接整体替换会把 apiKeyEnc（加密后的 Key）冲掉。
    if (patch && patch.ai && typeof patch.ai === 'object') {
      merged.ai = { ...this.data.settings.ai, ...patch.ai };
    }
    this.data.settings = normalizeSettings(merged);
    this.save();
    return this.data.settings;
  }

  // ---------- 任务 ----------

  tasksOf(dateKey) {
    return this.data.tasks
      .filter((t) => t.date === dateKey)
      .sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        if (a.order !== b.order) return a.order - b.order;
        return a.createdAt.localeCompare(b.createdAt);
      });
  }

  findTask(id) {
    return this.data.tasks.find((t) => t.id === id) || null;
  }

  addTask(input, dateKey) {
    const list = this.tasksOf(dateKey);
    const task = createTask({ ...input, order: list.length }, dateKey);
    if (!task.title) return null;
    this.data.tasks.push(task);
    this.save();
    return task;
  }

  /** 批量添加（AI 拆解或粘贴多行时用），跳过空标题 */
  addTasks(items, dateKey) {
    const out = [];
    for (const item of items) {
      const task = this.addTask(item, dateKey);
      if (task) out.push(task);
    }
    return out;
  }

  updateTask(id, patch) {
    const task = this.findTask(id);
    if (!task) return null;
    const allowed = ['title', 'note', 'priority', 'estimateMin', 'done', 'startAt', 'endAt', 'firstStep', 'order', 'date'];
    for (const key of allowed) {
      if (patch[key] === undefined) continue;
      if (key === 'estimateMin') task.estimateMin = Math.min(480, Math.max(5, Number(patch[key]) || 30));
      else if (key === 'priority') task.priority = ['high', 'normal', 'low'].includes(patch[key]) ? patch[key] : 'normal';
      else if (key === 'done') task.done = Boolean(patch[key]);
      else if (key === 'order') task.order = Number(patch[key]) || 0;
      else if (key === 'title') task.title = String(patch[key]).trim().slice(0, 200) || task.title;
      else task[key] = patch[key];
    }
    if (patch.done === true && !task.doneAt) task.doneAt = new Date().toISOString();
    if (patch.done === false) task.doneAt = null;
    task.updatedAt = new Date().toISOString();
    this.save();
    return task;
  }

  toggleTask(id) {
    const task = this.findTask(id);
    if (!task) return null;
    return this.updateTask(id, { done: !task.done });
  }

  removeTask(id) {
    const idx = this.data.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    this.data.tasks.splice(idx, 1);
    this.save();
    return true;
  }

  /** 按给定 id 顺序重排当天任务 */
  reorder(dateKey, ids) {
    const index = new Map(ids.map((id, i) => [id, i]));
    for (const task of this.data.tasks) {
      if (task.date !== dateKey) continue;
      if (index.has(task.id)) task.order = index.get(task.id);
    }
    this.save();
  }

  // ---------- 计划 ----------

  getPlan(dateKey) {
    return this.data.plans[dateKey] || null;
  }

  setPlan(dateKey, plan) {
    this.data.plans[dateKey] = plan;
    this.save();
    return plan;
  }

  clearPlan(dateKey) {
    delete this.data.plans[dateKey];
    // 计划清掉后，任务上挂的时间块也要一起清，避免显示残留
    for (const task of this.data.tasks) {
      if (task.date === dateKey) {
        task.startAt = null;
        task.endAt = null;
        task.firstStep = '';
      }
    }
    this.save();
  }

  // ---------- 每日维护 ----------

  /**
   * 跨天维护：把没做完的任务顺延到今天；清理太老的已完成记录。
   * 采用「惰性执行」——启动时和每分钟 tick 时判断日期是否变了，
   * 只在那一天执行一次，不常驻定时器。
   */
  rollover(todayKey) {
    const last = this.data.meta.lastRollover;
    if (last === todayKey) return { carried: 0, cleaned: 0 };

    const cutoff = addDays(todayKey, -MAX_HISTORY_DAYS);
    let carried = 0;

    // 昨天及更早、仍未完成的任务 → 顺延到今天（最多 10 条，先带最近的）
    const pending = this.data.tasks
      .filter((t) => !t.done && t.date < todayKey)
      .sort((a, b) => b.date.localeCompare(a.date) || a.order - b.order);

    let order = this.tasksOf(todayKey).length;
    for (const task of pending) {
      if (carried >= MAX_CARRYOVER) break;
      const origin = task.date;
      task.date = todayKey;
      task.carriedFrom = origin;
      task.startAt = null;
      task.endAt = null;
      task.firstStep = '';
      task.order = order++;
      carried += 1;
    }

    const before = this.data.tasks.length;
    this.data.tasks = this.data.tasks.filter((t) => !(t.done && t.date < cutoff));
    const cleaned = before - this.data.tasks.length;

    for (const key of Object.keys(this.data.plans)) {
      if (key < cutoff) delete this.data.plans[key];
    }

    this.data.meta.lastRollover = todayKey;
    this.save();
    return { carried, cleaned };
  }
}

module.exports = { Store, MAX_HISTORY_DAYS, MAX_CARRYOVER };
