'use strict';

const crypto = require('node:crypto');

/** 数据文件结构版本，用于后续迁移 */
const SCHEMA_VERSION = 1;

/** 优先级权重：数字越小越先做 */
const PRIORITY_WEIGHT = { high: 0, normal: 1, low: 2 };

const PRIORITY_LABEL = { high: '重要', normal: '普通', low: '顺带' };

/** 常见 AI 服务商预设（都是 OpenAI 兼容接口，换 baseUrl 即可） */
const AI_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'dashscope', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'moonshot', name: '月之暗面', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  { id: 'custom', name: '自定义', baseUrl: '', model: '' },
];

const DEFAULT_SETTINGS = {
  /** 开机自启 */
  autostart: true,
  /** 窗口始终置顶 */
  alwaysOnTop: true,
  /** 自启动时不抢占焦点 */
  startUnfocused: true,
  theme: 'light', // light | dark
  opacity: 0.96,
  /** 记住的窗口位置与尺寸，null 表示用默认角落 */
  bounds: null,
  /** 全局唤起快捷键（录不到时自动降级为不注册） */
  hotkey: 'Control+Alt+T',
  /** 一天的可排期区间 */
  dayStart: '08:30',
  dayEnd: '23:00',
  /** 午休，排期时跳过 */
  lunchStart: '12:00',
  lunchEnd: '13:30',
  /** 单个专注块的默认时长 / 块与块之间的缓冲 */
  focusMin: 45,
  bufferMin: 5,
  /** 完成的任务是否仍然显示 */
  showCompleted: true,
  /** 每个计划块开始前弹出系统通知 */
  notify: true,
  ai: {
    enabled: false,
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    /** 由 safeStorage 加密后的 base64；未加密时为 null */
    apiKeyEnc: null,
    /** 加密不可用时退回明文（会在设置页明确提示） */
    apiKeyPlain: null,
    temperature: 0.3,
    timeoutMs: 30000,
  },
};

/** 白名单式合并，避免脏数据/原型污染写进设置 */
function normalizeSettings(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...DEFAULT_SETTINGS };

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key === 'ai') continue;
    if (src[key] === undefined) continue;
    const def = DEFAULT_SETTINGS[key];
    if (typeof def === 'number') {
      const n = Number(src[key]);
      if (Number.isFinite(n)) out[key] = n;
    } else if (typeof def === 'boolean') {
      out[key] = Boolean(src[key]);
    } else if (def === null) {
      out[key] = src[key] === null ? null : src[key];
    } else {
      out[key] = String(src[key]);
    }
  }

  out.opacity = Math.min(1, Math.max(0.5, Number(out.opacity) || 0.96));
  out.focusMin = Math.min(180, Math.max(10, Number(out.focusMin) || 45));
  out.bufferMin = Math.min(60, Math.max(0, Number(out.bufferMin) || 0));
  out.theme = out.theme === 'dark' ? 'dark' : 'light';

  for (const k of ['dayStart', 'dayEnd', 'lunchStart', 'lunchEnd']) {
    if (!/^\d{1,2}:\d{2}$/.test(out[k])) out[k] = DEFAULT_SETTINGS[k];
  }

  if (out.bounds && typeof out.bounds === 'object') {
    const b = out.bounds;
    out.bounds = {
      x: Number(b.x) || 0,
      y: Number(b.y) || 0,
      width: Math.min(720, Math.max(300, Number(b.width) || 344)),
      height: Math.min(900, Math.max(300, Number(b.height) || 520)),
    };
  } else {
    out.bounds = null;
  }

  const ai = src.ai && typeof src.ai === 'object' ? src.ai : {};
  out.ai = {
    ...DEFAULT_SETTINGS.ai,
    ...ai,
    enabled: Boolean(ai.enabled),
    temperature: Math.min(1, Math.max(0, Number(ai.temperature) || 0.3)),
    timeoutMs: Math.min(120000, Math.max(5000, Number(ai.timeoutMs) || 30000)),
  };
  out.ai.baseUrl = String(out.ai.baseUrl || '').trim().replace(/\/+$/, '');
  out.ai.model = String(out.ai.model || '').trim();

  return out;
}

/** 新建一个任务对象 */
function createTask(input, date) {
  const now = new Date().toISOString();
  const title = String(input.title || '').trim().slice(0, 200);
  return {
    id: crypto.randomUUID(),
    title,
    note: String(input.note || '').slice(0, 500),
    date,
    done: false,
    doneAt: null,
    priority: PRIORITY_WEIGHT[input.priority] !== undefined ? input.priority : 'normal',
    estimateMin: Math.min(480, Math.max(5, Number(input.estimateMin) || 30)),
    startAt: null,
    endAt: null,
    firstStep: '',
    source: input.source === 'ai' ? 'ai' : 'manual',
    carriedFrom: input.carriedFrom || null,
    createdAt: now,
    updatedAt: now,
    order: Number(input.order) || 0,
  };
}

/** 读盘时对任务做一次宽松校验，坏数据直接丢弃而不是让整个文件失效 */
function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  const title = String(raw.title || '').trim();
  if (!id || !title) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || ''))) return null;

  return {
    id,
    title: title.slice(0, 200),
    note: String(raw.note || '').slice(0, 500),
    date: raw.date,
    done: Boolean(raw.done),
    doneAt: raw.doneAt || null,
    priority: PRIORITY_WEIGHT[raw.priority] !== undefined ? raw.priority : 'normal',
    estimateMin: Math.min(480, Math.max(5, Number(raw.estimateMin) || 30)),
    startAt: /^\d{1,2}:\d{2}$/.test(String(raw.startAt || '')) ? raw.startAt : null,
    endAt: /^\d{1,2}:\d{2}$/.test(String(raw.endAt || '')) ? raw.endAt : null,
    firstStep: String(raw.firstStep || '').slice(0, 120),
    source: raw.source === 'ai' ? 'ai' : 'manual',
    carriedFrom: raw.carriedFrom || null,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
    order: Number(raw.order) || 0,
  };
}

module.exports = {
  SCHEMA_VERSION,
  PRIORITY_WEIGHT,
  PRIORITY_LABEL,
  AI_PRESETS,
  DEFAULT_SETTINGS,
  normalizeSettings,
  createTask,
  normalizeTask,
};
