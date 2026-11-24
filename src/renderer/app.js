'use strict';

/**
 * 渲染进程。
 * 原则：
 *  1) 不信任任何外部文本 —— 一律 textContent，杜绝 innerHTML 注入
 *  2) 只有一份状态源在主进程，这里只做展示 + 转发操作
 *  3) 一分钟一次的状态推送只重建差异很小的 DOM，列表项少，直接重绘最省心
 */

const $ = (id) => document.getElementById(id);

const el = {
  card: $('card'),
  dateLine: $('dateLine'),
  progressLine: $('progressLine'),
  progressBar: $('progressBar'),
  btnPlan: $('btnPlan'),
  btnSettings: $('btnSettings'),
  btnHide: $('btnHide'),
  nowCard: $('nowCard'),
  nowLabel: $('nowCard').querySelector('.now-label'),
  nowTitle: $('nowTitle'),
  nowRange: $('nowRange'),
  nowLeft: $('nowLeft'),
  nowStep: $('nowStep'),
  planNote: $('planNote'),
  planNoteText: $('planNoteText'),
  planTips: $('planTips'),
  list: $('list'),
  captureForm: $('captureForm'),
  captureInput: $('captureInput'),
  footHint: $('footHint'),
  settings: $('settings'),
  btnCloseSettings: $('btnCloseSettings'),
  toast: $('toast'),
  verLine: $('verLine'),
};

let state = null;
let editingId = null;
let dragId = null;
let toastTimer = null;
let settingsOpen = false;

// ---------------------------------------------------------------- 启动

async function boot() {
  applyState(await window.api.init());
  bindEvents();

  window.api.onState((next) => {
    applyState(next);
    // 每分钟的推送会把设置面板的输入框重置掉，正在打字时不能刷
    if (settingsOpen && !isEditingSetting()) fillSettings();
  });

  window.api.onFocusCapture(() => {
    el.captureInput.focus();
    el.captureInput.select();
  });

  window.api.onPlanRequest(() => runPlan());
  window.api.onOpenSettings(() => openSettings());
}

// ---------------------------------------------------------------- 状态落地

function applyState(next) {
  state = next;
  document.documentElement.dataset.theme = state.settings.theme;
  document.documentElement.style.setProperty('--card-opacity', String(state.settings.opacity));
  renderHead();
  renderNow();
  renderPlanNote();
  if (!editingId && !dragId) renderList();
  el.verLine.textContent = `v${state.meta.version} · Electron`;
}

function pending() {
  return state.tasks.filter((t) => !t.done);
}

function renderHead() {
  const total = state.tasks.length;
  const done = total - pending().length;
  el.dateLine.textContent = `${state.dateLabel} ${state.weekday}`;

  if (!total) {
    el.progressLine.textContent = '还没排事';
    el.progressBar.style.width = '0%';
    return;
  }

  const left = total - done;
  el.progressLine.textContent = left ? `${done}/${total} 完成 · 还剩 ${left} 件` : `${total} 件全部做完了`;
  el.progressBar.style.width = `${Math.round((done / total) * 100)}%`;
}

function toMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function humanLeft(min) {
  const v = Math.max(0, Math.round(min));
  if (v < 60) return `还剩 ${v} 分钟`;
  const h = Math.floor(v / 60);
  const m = v % 60;
  return m ? `还剩 ${h} 小时 ${m} 分` : `还剩 ${h} 小时`;
}

/** 找出当前正在做的事；没有就找 90 分钟内即将开始的那件 */
function locateFocus() {
  const plan = state.plan;
  if (!plan || !Array.isArray(plan.blocks) || !plan.blocks.length) return null;
  const now = state.nowMinutes;
  const blocks = [...plan.blocks].sort((a, b) => a.start.localeCompare(b.start));

  for (const block of blocks) {
    const start = toMin(block.start);
    const end = toMin(block.end);
    if (now >= start && now < end) {
      const task = state.tasks.find((t) => t.id === block.taskId);
      if (task && !task.done) return { mode: 'now', block, task, minutes: end - now };
    }
  }

  for (const block of blocks) {
    const start = toMin(block.start);
    if (start > now && start - now <= 90) {
      const task = state.tasks.find((t) => t.id === block.taskId);
      if (task && !task.done) return { mode: 'next', block, task, minutes: start - now };
    }
  }
  return null;
}

function renderNow() {
  const focus = locateFocus();
  if (!focus) {
    el.nowCard.classList.add('hidden');
    return;
  }
  el.nowCard.classList.remove('hidden');
  el.nowLabel.textContent = focus.mode === 'now' ? '现在' : '接下来';
  el.nowTitle.textContent = focus.task.title;
  el.nowRange.textContent = `${focus.block.start}–${focus.block.end}`;
  el.nowLeft.textContent =
    focus.mode === 'now' ? humanLeft(focus.minutes) : `${focus.minutes} 分钟后开始`;
  el.nowCard.classList.toggle('done-soon', focus.mode === 'now' && focus.minutes <= 10);

  const step = focus.block.firstStep || focus.task.firstStep;
  if (step) {
    el.nowStep.textContent = step;
    el.nowStep.classList.remove('hidden');
  } else {
    el.nowStep.classList.add('hidden');
  }
}

function renderPlanNote() {
  const plan = state.plan;
  const hasIntro = plan && plan.intro;
  const tips = plan && Array.isArray(plan.tips) ? plan.tips : [];

  if (!hasIntro && !tips.length) {
    el.planNote.classList.add('hidden');
    return;
  }
  el.planNote.classList.remove('hidden');
  el.planNoteText.textContent = hasIntro || '';

  el.planTips.textContent = '';
  if (tips.length) {
    el.planTips.classList.remove('hidden');
    for (const tip of tips) {
      const li = document.createElement('li');
      li.textContent = tip;
      el.planTips.appendChild(li);
    }
  } else {
    el.planTips.classList.add('hidden');
  }
}

function renderList() {
  el.list.textContent = '';

  const showDone = state.settings.showCompleted;
  const tasks = showDone ? state.tasks : pending();

  if (!tasks.length) {
    const box = document.createElement('div');
    box.className = 'empty';
    const t = document.createElement('div');
    t.className = 'empty-title';
    t.textContent = '今天还是空的';
    const s = document.createElement('div');
    s.className = 'empty-sub';
    s.textContent = '先随手写三件要做的事，再点右上角「排一下」，我帮你理顺序和时间。';
    box.append(t, s);
    el.list.appendChild(box);
    return;
  }

  for (const task of tasks) el.list.appendChild(buildRow(task));
}

function buildRow(task) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.id = task.id;
  row.draggable = true;
  if (task.done) row.classList.add('done');
  if (task.priority === 'high') row.classList.add('pri-high');

  const check = document.createElement('button');
  check.className = 'check';
  check.title = task.done ? '标记未完成' : '标记完成';
  check.addEventListener('click', () => {
    window.api.toggleTask(task.id);
  });

  const body = document.createElement('div');
  body.className = 'body';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = task.title;
  title.title = '双击改标题';

  body.appendChild(title);

  const metaBits = [];
  if (task.startAt && task.endAt) metaBits.push(`${task.startAt}–${task.endAt}`);
  metaBits.push(`${task.estimateMin} 分钟`);

  if (metaBits.length) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = metaBits.join(' · ');

    if (task.carriedFrom) {
      const tag = document.createElement('span');
      tag.className = 'tag warn';
      tag.textContent = '顺延';
      tag.title = `原本安排在 ${task.carriedFrom}`;
      meta.appendChild(tag);
    }
    body.appendChild(meta);
  }

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const priBtn = document.createElement('button');
  priBtn.className = 'mini';
  priBtn.textContent = task.priority === 'high' ? '★' : '☆';
  priBtn.title = task.priority === 'high' ? '取消重要' : '标为重要';
  priBtn.addEventListener('click', () => {
    window.api.updateTask(task.id, { priority: task.priority === 'high' ? 'normal' : 'high' });
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'mini del';
  delBtn.textContent = '✕';
  delBtn.title = '删除';
  delBtn.addEventListener('click', () => window.api.removeTask(task.id));

  actions.append(priBtn, delBtn);

  title.addEventListener('dblclick', () => startEdit(task, title));

  row.append(check, body, actions);
  bindDrag(row, task);
  return row;
}

function startEdit(task, titleNode) {
  editingId = task.id;
  const input = document.createElement('input');
  input.className = 'title-input';
  input.value = task.title;
  input.maxLength = 200;

  titleNode.replaceWith(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  const commit = (save) => {
    if (editingId !== task.id) return;
    editingId = null;
    const value = input.value.trim();
    if (save && value && value !== task.title) window.api.updateTask(task.id, { title: value });
    else renderList();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
}

// ---------------------------------------------------------------- 拖拽排序

function bindDrag(row, task) {
  row.addEventListener('dragstart', (e) => {
    dragId = task.id;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // 某些 Electron 版本不设 data 会直接取消拖拽
    e.dataTransfer.setData('text/plain', task.id);
  });

  row.addEventListener('dragend', () => {
    dragId = null;
    row.classList.remove('dragging');
    document.querySelectorAll('.drop-above').forEach((n) => n.classList.remove('drop-above'));
    renderList();
  });

  row.addEventListener('dragover', (e) => {
    if (!dragId || dragId === task.id) return;
    e.preventDefault();
    row.classList.add('drop-above');
  });

  row.addEventListener('dragleave', () => row.classList.remove('drop-above'));

  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drop-above');
    if (!dragId || dragId === task.id) return;

    const ids = state.tasks.map((t) => t.id);
    const from = ids.indexOf(dragId);
    let to = ids.indexOf(task.id);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    to = ids.indexOf(task.id);
    ids.splice(to, 0, dragId);
    window.api.reorder(ids);
  });
}

// ---------------------------------------------------------------- 事件

function bindEvents() {
  el.captureForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = el.captureInput.value.trim();
    if (!title) return;
    el.captureInput.value = '';
    await window.api.addTask({
      title,
      estimateMin: state ? state.settings.focusMin : 30,
      priority: 'normal',
    });
  });

  el.btnPlan.addEventListener('click', () => runPlan());
  el.btnSettings.addEventListener('click', openSettings);
  el.btnCloseSettings.addEventListener('click', closeSettings);
  el.btnHide.addEventListener('click', () => window.api.hide());

  document.addEventListener('keydown', (e) => {
    // 输入框里只拦 Esc，不抢其他键
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.key === 'Escape') {
      if (settingsOpen) return closeSettings();
      if (editingId) return;
      el.captureInput.blur();
      return window.api.hide();
    }
    if (!typing && e.key === '/') {
      e.preventDefault();
      el.captureInput.focus();
    }
  });

  // 右键弹原生菜单（置顶 / 排一下 / 设置 / 退出）
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.api.contextMenu();
  });
}

async function runPlan() {
  if (el.btnPlan.classList.contains('busy')) return;
  el.btnPlan.classList.add('busy');
  el.btnPlan.disabled = true;

  try {
    const res = await window.api.runPlan({});
    if (!res.ok) {
      toast(res.error || '没排成，再试一次。');
    } else if (res.error) {
      toast(res.error);
    } else {
      toast(res.usedAi ? '排好了，按「现在」那块开始就行。' : '按本地规则排好了。');
    }
  } catch (err) {
    toast('出错了：' + (err && err.message ? err.message : String(err)));
  } finally {
    el.btnPlan.classList.remove('busy');
    el.btnPlan.disabled = false;
  }
}

function toast(message, duration = 2600) {
  if (!message) return;
  el.toast.textContent = message;
  el.toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), duration);
}

// ---------------------------------------------------------------- 设置

function openSettings() {
  settingsOpen = true;
  el.settings.classList.remove('hidden');
  fillSettings();
}

/** 光标是否停在设置面板的输入框里（停止打字前不要重置表单） */
function isEditingSetting() {
  const active = document.activeElement;
  if (!active || !el.settings.contains(active)) return false;
  return /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName);
}

function closeSettings() {
  settingsOpen = false;
  el.settings.classList.add('hidden');
}

function fillSettings() {
  const s = state.settings;
  const ai = s.ai;

  $('setDayStart').value = s.dayStart;
  $('setDayEnd').value = s.dayEnd;
  $('setLunchStart').value = s.lunchStart;
  $('setLunchEnd').value = s.lunchEnd;
  $('setFocusMin').value = s.focusMin;
  $('setBufferMin').value = s.bufferMin;

  const provider = $('setProvider');
  if (!provider.options.length) {
    for (const p of state.presets) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      provider.appendChild(opt);
    }
  }
  provider.value = ai.providerId || 'custom';

  $('setBaseUrl').value = ai.baseUrl || '';
  $('setModel').value = ai.model || '';
  $('setApiKey').value = '';
  $('setApiKey').placeholder = ai.hasKey ? '已保存（留空表示不修改）' : '粘贴你的 API Key';

  setSwitch($('setAiEnabled'), ai.enabled);
  $('setTheme').value = s.theme;
  setSwitch($('setAlwaysOnTop'), s.alwaysOnTop);
  setSwitch($('setAutostart'), s.autostart);
  setSwitch($('setNotify'), s.notify);
  setSwitch($('setShowCompleted'), s.showCompleted);
  $('setHotkey').value = s.hotkey || '';
}

function setSwitch(node, on) {
  node.setAttribute('aria-checked', on ? 'true' : 'false');
}

function isOn(node) {
  return node.getAttribute('aria-checked') === 'true';
}

function bindSettings() {
  const autoSave = (node, patchFn, event = 'change') => {
    node.addEventListener(event, async () => {
      await window.api.saveSettings(patchFn(node));
    });
  };

  autoSave($('setDayStart'), (n) => ({ dayStart: n.value }));
  autoSave($('setDayEnd'), (n) => ({ dayEnd: n.value }));
  autoSave($('setLunchStart'), (n) => ({ lunchStart: n.value }));
  autoSave($('setLunchEnd'), (n) => ({ lunchEnd: n.value }));
  autoSave($('setFocusMin'), (n) => ({ focusMin: Number(n.value) || 45 }));
  autoSave($('setBufferMin'), (n) => ({ bufferMin: Number(n.value) || 0 }));
  autoSave($('setTheme'), (n) => ({ theme: n.value }));
  autoSave($('setHotkey'), (n) => ({ hotkey: n.value.trim() }));

  $('setProvider').addEventListener('change', () => {
    const preset = state.presets.find((p) => p.id === $('setProvider').value);
    if (preset && preset.baseUrl) {
      $('setBaseUrl').value = preset.baseUrl;
      $('setModel').value = preset.model;
    }
  });

  for (const [id, key] of [
    ['setAiEnabled', 'enabled'],
    ['setAlwaysOnTop', 'alwaysOnTop'],
    ['setAutostart', 'autostart'],
    ['setNotify', 'notify'],
    ['setShowCompleted', 'showCompleted'],
  ]) {
    const node = $(id);
    node.addEventListener('click', async () => {
      const next = !isOn(node);
      setSwitch(node, next);
      if (id === 'setAiEnabled') await window.api.saveSettings({ ai: { enabled: next } });
      else await window.api.saveSettings({ [key]: next });
    });
  }

  $('btnSaveAi').addEventListener('click', async () => {
    const aiPatch = {
      enabled: isOn($('setAiEnabled')),
      providerId: $('setProvider').value,
      baseUrl: $('setBaseUrl').value.trim(),
      model: $('setModel').value.trim(),
    };
    const key = $('setApiKey').value.trim();
    if (key) aiPatch.apiKey = key;

    const res = await window.api.saveSettings({ ai: aiPatch });
    if (res && res.ok) {
      $('setApiKey').value = '';
      setStatus('aiStatus', '已保存。', 'ok');
    } else {
      setStatus('aiStatus', '保存失败。', 'err');
    }
  });

  $('btnTestAi').addEventListener('click', async () => {
    setStatus('aiStatus', '正在连接…', '');
    const draft = {
      baseUrl: $('setBaseUrl').value.trim(),
      model: $('setModel').value.trim(),
    };
    const key = $('setApiKey').value.trim();
    if (key) draft.apiKey = key;

    const res = await window.api.testAI(draft);
    if (res.ok) setStatus('aiStatus', '连接正常，可以用了。', 'ok');
    else setStatus('aiStatus', res.error || '连接失败。', 'err');
  });

  $('btnOpenData').addEventListener('click', () => window.api.openDataDir());
}

function setStatus(id, text, kind) {
  const node = $(id);
  node.textContent = text;
  node.className = 'status' + (kind ? ' ' + kind : '');
}

// ---------------------------------------------------------------- go

bindSettings();
boot().catch((err) => {
  console.error(err);
  document.body.textContent = '加载失败：' + (err && err.message);
});
