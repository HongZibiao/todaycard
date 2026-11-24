'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  globalShortcut,
  shell,
  screen,
  nativeImage,
  Notification,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { Store } = require('./store');
const { dateKey, monthDayCN, weekdayCN, pad2, msToNextMinute, nowMinutes } = require('./datetime');
const { planLocally, sanitizePlan } = require('./planner');
const { requestPlan, testConnection } = require('./ai');
const { AI_PRESETS } = require('./defaults');
const { packKey, readKey, hasKey, canEncrypt } = require('./secret');

const isDev = process.argv.includes('--dev');
/** 开机自启时带上这个参数：窗口照样显示，但不抢焦点、不闪任务栏 */
const startQuiet = process.argv.includes('--autostart-quiet');

const ROOT = path.join(__dirname, '..', '..');
const START_SIZE = { width: 344, height: 546 };

let win = null;
let tray = null;
let store = null;
let tickTimer = null;
let isQuitting = false;
let planning = false;
const notified = new Set();

// ---------------------------------------------------------------- 基础设施

app.setName('TodayCard');
app.setPath('userData', path.join(app.getPath('appData'), 'TodayCard'));
app.setAppUserModelId('com.todaycard.app');

// 只允许一个实例：重复启动时把已有窗口唤到前面
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow(true));
  app.whenReady().then(bootstrap);
}

function dataFile() {
  return path.join(app.getPath('userData'), 'data.json');
}

// ---------------------------------------------------------------- 启动

async function bootstrap() {
  store = new Store(dataFile());
  store.load();
  store.rollover(dateKey());

  registerIpc();
  createWindow();
  createTray();
  registerShortcut();
  applyAutostart(store.getSettings().autostart);
  startTicker();
}

// ---------------------------------------------------------------- 窗口

/** 计算窗口位置：优先用记住的位置，超出手够得着的屏幕范围就回落到右下角 */
function resolveBounds(settings) {
  const area = screen.getPrimaryDisplay().workArea;
  const saved = settings.bounds;
  const width = START_SIZE.width;
  const height = START_SIZE.height;

  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const reachable = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return (
        saved.x < a.x + a.width - 100 &&
        saved.x + width > a.x + 100 &&
        saved.y < a.y + a.height - 80 &&
        saved.y + 60 > a.y
      );
    });
    if (reachable) {
      return { x: Math.round(saved.x), y: Math.round(saved.y), width, height };
    }
  }

  return {
    x: area.x + area.width - width - 24,
    y: area.y + area.height - height - 24,
    width,
    height,
  };
}

function createWindow() {
  const settings = store.getSettings();
  const bounds = resolveBounds(settings);

  win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    // 固定尺寸：桌面挂件不该被误拖动改大小，内容超长时列表内部滚动
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false, // 阴影交给 CSS 画，系统阴影在透明窗口上会发灰
    backgroundColor: '#00000000',
    alwaysOnTop: settings.alwaysOnTop,
    title: '今日卡',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: isDev,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    if (startQuiet) win.showInactive();
    else showWindow(true);

    // 开发用：--capture=<png 路径>，渲染完自动截图退出。
    // README 与文档截图靠它生成，也方便改样式时快速比对。
    const captureArg = process.argv.find((a) => a.startsWith('--capture='));
    if (captureArg && !app.isPackaged) {
      const target = captureArg.slice('--capture='.length);
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage();
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, image.toPNG());
          console.log('[capture] 已保存', target);
        } catch (err) {
          console.error('[capture] 失败', err && err.message);
        }
        quitApp();
      }, 900);
    }
  });

  // 关闭 = 收进托盘，不做成「一不小心点掉就没了」
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  const persistBounds = debounce(() => {
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    const [width, height] = win.getSize();
    store.patchSettings({ bounds: { x, y, width, height } });
  }, 500);

  win.on('moved', persistBounds);
  win.on('resized', persistBounds);

  // 渲染进程崩了自动重载，别让用户面对一个空白卡片
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) win.reload();
  });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

function showWindow(focus = false) {
  if (!win || win.isDestroyed()) return;
  if (focus) {
    win.show();
    win.focus();
  } else {
    win.showInactive();
  }
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow(true);
}

// ---------------------------------------------------------------- 托盘

function trayImage() {
  // 用 readFileSync 而不是 createFromPath：打包后资源在 asar 里，
  // 走 Buffer 这条路在开发态和打包态行为一致，不会出现托盘图标空白。
  const file = path.join(ROOT, 'assets', 'tray.png');
  try {
    const img = nativeImage.createFromBuffer(fs.readFileSync(file));
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  } catch (err) {
    console.error('[tray] 图标读取失败', err && err.message);
  }
  return nativeImage.createEmpty();
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('今日卡');
  tray.on('click', toggleWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const settings = store.getSettings();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 / 收起', click: toggleWindow },
      { type: 'separator' },
      { label: '添加任务', click: () => { showWindow(true); send('focus:capture'); } },
      { label: '重新排今天的计划', click: () => { showWindow(true); send('plan:request'); } },
      { type: 'separator' },
      {
        label: '窗口置顶',
        type: 'checkbox',
        checked: settings.alwaysOnTop,
        click: (item) => {
          store.patchSettings({ alwaysOnTop: item.checked });
          if (win && !win.isDestroyed()) win.setAlwaysOnTop(item.checked, 'floating');
          broadcast();
        },
      },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: settings.autostart,
        click: (item) => {
          store.patchSettings({ autostart: item.checked });
          applyAutostart(item.checked);
          broadcast();
        },
      },
      { type: 'separator' },
      { label: '打开数据文件夹', click: () => shell.openPath(app.getPath('userData')) },
      { label: '退出', click: quitApp },
    ])
  );
}

/**
 * 开机自启。
 *
 * 用启动文件夹里的快捷方式，而不是 app.setLoginItemSettings：
 * 后者的写入位置和命名由 Electron 内部决定，实测在打包后会出现
 * 「回读说成功了，注册表里却没有」的情况，用户完全看不出来。
 * 快捷方式这条路目标、参数、图标全在自己手里，还能被用户直接删掉。
 */
function applyAutostart(enabled) {
  // 开发态注册指向 electron.exe，没有意义，只处理打包后的正式版本
  if (!app.isPackaged) return { applied: false, reason: 'dev' };

  const shortcutPath = startupShortcutPath();

  try {
    // 清掉早期版本可能写过的注册表项，避免两种机制同时生效、开机起两份
    try {
      app.setLoginItemSettings({ openAtLogin: false, path: process.execPath, args: ['--autostart-quiet'] });
    } catch (_) {
      /* 清不掉也不影响下面的判断 */
    }

    if (!enabled) {
      removeStartupShortcut(shortcutPath);
      return { applied: true, via: 'none' };
    }

    fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
    const ok = shell.writeShortcutLink(shortcutPath, 'create', {
      target: process.execPath,
      args: '--autostart-quiet',
      cwd: path.dirname(process.execPath),
      description: '今日卡 · 开机自动出现在桌面角落',
      icon: process.execPath,
      iconIndex: 0,
    });
    return { applied: Boolean(ok), via: 'shortcut' };
  } catch (err) {
    console.error('[autostart] 设置失败', err && err.message);
    return { applied: false, error: err && err.message };
  }
}

function startupShortcutPath() {
  return path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    '今日卡.lnk'
  );
}

function removeStartupShortcut(file) {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (err) {
    console.error('[autostart] 清理快捷方式失败', err && err.message);
  }
}

// ---------------------------------------------------------------- 快捷键

function registerShortcut() {
  const accel = store.getSettings().hotkey;
  globalShortcut.unregisterAll();
  if (!accel) return;
  try {
    globalShortcut.register(accel, () => {
      showWindow(true);
      send('focus:capture');
    });
  } catch (err) {
    console.error('[hotkey] 注册失败', accel, err && err.message);
  }
}

// ---------------------------------------------------------------- 状态

function buildState() {
  const today = dateKey();
  const settings = store.getSettings();
  const { apiKeyEnc, apiKeyPlain, ...aiSafe } = settings.ai;
  const now = new Date();

  return {
    today,
    weekday: weekdayCN(today),
    dateLabel: monthDayCN(today),
    nowLabel: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    nowMinutes: nowMinutes(now),
    tasks: store.tasksOf(today),
    plan: store.getPlan(today),
    settings: { ...settings, ai: { ...aiSafe, hasKey: hasKey(settings) } },
    presets: AI_PRESETS,
    meta: {
      version: app.getVersion(),
      isDev,
      canEncrypt: canEncrypt(),
      hotkeyActive: Boolean(accelRegistered(settings.hotkey)),
      notifications: Notification.isSupported(),
    },
  };
}

function accelRegistered(accel) {
  if (!accel) return false;
  try {
    return globalShortcut.isRegistered(accel);
  } catch (_) {
    return false;
  }
}

function broadcast() {
  send('state:changed', buildState());
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- 每分钟 tick

function startTicker() {
  const run = () => {
    tickTimer = null;
    try {
      store.rollover(dateKey());
      const state = buildState();
      send('state:changed', state);
      maybeNotify(state);
    } catch (err) {
      console.error('[tick] 出错', err && err.message);
    }
    tickTimer = setTimeout(run, msToNextMinute());
    if (tickTimer.unref) tickTimer.unref();
  };
  tickTimer = setTimeout(run, msToNextMinute());
  if (tickTimer.unref) tickTimer.unref();
}

/** 到点提醒：只对计划块生效，且同一天同一块只提醒一次 */
function maybeNotify(state) {
  if (!state.settings.notify || !Notification.isSupported()) return;
  const plan = state.plan;
  if (!plan || !Array.isArray(plan.blocks)) return;

  const now = state.nowMinutes;
  const today = state.today;

  for (const block of plan.blocks) {
    const [h, m] = block.start.split(':').map(Number);
    const start = h * 60 + m;
    if (now !== start) continue;
    const key = `${today}:${block.taskId}:${block.start}`;
    if (notified.has(key)) continue;
    notified.add(key);

    const task = state.tasks.find((t) => t.id === block.taskId);
    if (!task || task.done) continue;

    const body = block.firstStep ? `先做这一步：${block.firstStep}` : `预计 ${block.start}–${block.end}`;
    const n = new Notification({ title: `该做：${task.title}`, body, silent: false });
    n.on('click', () => showWindow(true));
    n.show();
  }

  // 只保留当天的提醒记录，避免 Set 无限增长
  if (notified.size > 200) {
    for (const key of notified) {
      if (!key.startsWith(`${today}:`)) notified.delete(key);
    }
  }
}

// ---------------------------------------------------------------- 排程

async function runPlan({ forceLocal = false } = {}) {
  if (planning) return { ok: false, error: '正在排，稍等一下。' };
  planning = true;
  try {
    const today = dateKey();
    const settings = store.getSettings();
    const tasks = store.tasksOf(today);
    const pending = tasks.filter((t) => !t.done);

    if (!pending.length) {
      return { ok: false, error: '今天还没有待办，先在下面加两件。' };
    }

    let plan = null;
    let error = '';
    let attemptedAi = false;

    if (settings.ai.enabled && !forceLocal) {
      const apiKey = readKey(settings);
      if (!apiKey) {
        error = '没填 API Key，先用本地规则排了。';
      } else {
        attemptedAi = true;
        const res = await requestPlan({ settings, apiKey, tasks: pending, now: new Date(), dateKey: today });
        if (res.ok) {
          plan = sanitizePlan(res.raw, { tasks: pending, settings, now: new Date() });
          if (!plan) error = 'AI 返回的格式不对，已按本地规则重排。';
        } else {
          error = res.error;
        }
      }
    }

    if (!plan) {
      plan = planLocally({ tasks: pending, settings, now: new Date() });
    }

    // 把时间块写回任务，列表里才有时间显示
    const blockMap = new Map(plan.blocks.map((b) => [b.taskId, b]));
    for (const task of pending) {
      const block = blockMap.get(task.id);
      store.updateTask(task.id, {
        startAt: block ? block.start : null,
        endAt: block ? block.end : null,
        firstStep: block ? block.firstStep : '',
      });
    }

    // 列表按时间顺序重排：有块的按开始时间排，排不下的沉到最后。
    // 否则「第 3 行是 18:50、第 4 行是 18:00」这种读起来是错的。
    const timed = [...plan.blocks].sort((a, b) => a.start.localeCompare(b.start)).map((b) => b.taskId);
    const untimed = pending.filter((t) => !blockMap.has(t.id)).map((t) => t.id);
    store.reorder(today, [...timed, ...untimed]);

    store.setPlan(today, plan);
    return { ok: true, plan, usedAi: attemptedAi && plan.source === 'ai', error };
  } catch (err) {
    return { ok: false, error: `排程失败：${err && err.message}` };
  } finally {
    planning = false;
    broadcast();
  }
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('app:init', () => buildState());

  ipcMain.handle('tasks:add', (_e, { title, estimateMin, priority }) => {
    const task = store.addTask({ title, estimateMin, priority }, dateKey());
    broadcast();
    return { ok: Boolean(task), task };
  });

  ipcMain.handle('tasks:toggle', (_e, id) => {
    store.toggleTask(id);
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('tasks:update', (_e, { id, patch }) => {
    store.updateTask(id, patch || {});
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('tasks:remove', (_e, id) => {
    store.removeTask(id);
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('tasks:reorder', (_e, ids) => {
    store.reorder(dateKey(), ids);
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('plan:run', async (_e, options) => {
    const result = await runPlan(options || {});
    if (!result.ok) broadcast();
    return result;
  });

  ipcMain.handle('plan:clear', () => {
    store.clearPlan(dateKey());
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    const clean = { ...(patch || {}) };

    // Key 单独走加密通道，不接受渲染进程直接写 apiKeyEnc
    if (clean.ai && typeof clean.ai.apiKey === 'string') {
      const packed = packKey(clean.ai.apiKey);
      clean.ai = { ...clean.ai, ...packed };
      delete clean.ai.apiKey;
    }
    const settings = store.patchSettings(clean);

    if (patch && patch.alwaysOnTop !== undefined && win && !win.isDestroyed()) {
      win.setAlwaysOnTop(Boolean(patch.alwaysOnTop), 'floating');
    }
    if (patch && patch.hotkey !== undefined) registerShortcut();
    if (patch && patch.autostart !== undefined) applyAutostart(Boolean(patch.autostart));

    refreshTrayMenu();
    broadcast();
    return { ok: true, settings: buildState().settings };
  });

  ipcMain.handle('ai:test', async (_e, draft) => {
    const settings = store.getSettings();
    const merged = {
      ...settings,
      ai: { ...settings.ai, ...(draft || {}) },
    };
    const apiKey = draft && draft.apiKey ? draft.apiKey : readKey(settings);
    return testConnection({ settings: merged, apiKey });
  });

  ipcMain.handle('app:hide', () => {
    if (win && !win.isDestroyed()) win.hide();
    return { ok: true };
  });

  ipcMain.handle('app:quit', () => {
    quitApp();
    return { ok: true };
  });

  ipcMain.handle('app:openDataDir', () => shell.openPath(app.getPath('userData')));

  ipcMain.handle('app:contextMenu', () => {
    const settings = store.getSettings();
    Menu.buildFromTemplate([
      { label: '添加任务', click: () => { showWindow(true); send('focus:capture'); } },
      { label: '重新排一下', click: () => { showWindow(true); send('plan:request'); } },
      { type: 'separator' },
      { label: '设置…', click: () => { showWindow(true); send('open:settings'); } },
      {
        label: '窗口置顶',
        type: 'checkbox',
        checked: settings.alwaysOnTop,
        click: (item) => {
          store.patchSettings({ alwaysOnTop: item.checked });
          if (win && !win.isDestroyed()) win.setAlwaysOnTop(item.checked, 'floating');
          refreshTrayMenu();
          broadcast();
        },
      },
      { type: 'separator' },
      { label: '收进托盘', click: () => win && win.hide() },
      { label: '退出', click: quitApp },
    ]).popup({ window: win });
    return { ok: true };
  });

  ipcMain.handle('window:setIgnoreMouse', (_e, ignore) => {
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
    return { ok: true };
  });
}

// ---------------------------------------------------------------- 收尾

function quitApp() {
  isQuitting = true;
  if (store) store.flush();
  app.quit();
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
    if (timer.unref) timer.unref();
  };
}

app.on('window-all-closed', () => {
  // 托盘常驻，窗口全关也不退出
});

app.on('before-quit', () => {
  isQuitting = true;
  if (store) store.flush();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (tickTimer) clearTimeout(tickTimer);
});

app.on('activate', () => showWindow(true));
