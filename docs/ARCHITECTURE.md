# 架构说明

## 一句话

主进程持有全部状态与逻辑，渲染进程只负责画；两者之间只有一层白名单 IPC。

```
┌──────────────────────────────────────────────────────┐
│ 渲染进程 (Chromium)                                   │
│   index.html + styles.css + app.js                    │
│   · 无框架、无构建、无 node 权限                       │
│   · 只做：渲染 state、把用户操作转发成 IPC 调用         │
└───────────────┬──────────────────────────────────────┘
                │ contextBridge 白名单（preload.js）
                │ 单向推送 state:changed / 调用式 invoke
┌───────────────▼──────────────────────────────────────┐
│ 主进程 (Node)                                         │
│   main.js      窗口 / 托盘 / 快捷键 / 通知 / IPC        │
│   store.js     唯一数据源，JSON 持久化                  │
│   planner.js   规则排程 + AI 结果清洗                   │
│   ai.js        OpenAI 兼容 HTTP 客户端                  │
│   secret.js    API Key 加解密                          │
└───────────────┬──────────────────────────────────────┘
                │ 原子写
        %APPDATA%\TodayCard\data.json
```

## 关键取舍

### 为什么不用 React / Vue / 打包器

界面元素不到 20 种、状态只有一份，组件化的收益抵不过启动开销：一个 Vite + React 的最小包也要几百 KB 的运行时和一次水合。现在的做法是首屏直接跑原生 DOM，冷启动到可交互 200ms 左右，改一行样式不用等编译。

代价是列表渲染要手写。缓解办法：任务量本来就是几十条级别，直接整体重绘最简单也不慢；只有在编辑中或拖拽中才跳过重绘（`editingId` / `dragId`）。

### 为什么规则排程和 AI 排程并存

只做 AI，等于把可用性押在别人的接口上：Key 过期、余额不足、模型返回一段散文，用户的计划就没了。只做规则，又少了「按事情性质给建议」的价值。

所以两条路共用同一个产物结构 `{ blocks: [{taskId, start, end, firstStep}], intro, tips }`，渲染层完全无感。AI 失败时不是报错了事，而是**静默回落到规则排程 + 一条说明**。

### 为什么 AI 结果必须清洗

模型的输出不可信。实测会遇到：返回不存在的 taskId、把任务排到凌晨 3 点、两个块时间重叠、只排了一半就结束、用 `9:00` 而不是 `09:00`。

`sanitizePlan()` 做四件事，全部是确定性逻辑：

1. 丢弃不存在 / 重复的 taskId
2. 时间越界夹回 `[dayStart, dayEnd]`
3. 重叠按起始时间排序后依次往后推，保证时间轴单调
4. AI 漏排的任务在末尾补位，实在放不下进 `unscheduled`

清洗后仍然拿不到合法结果，返回 `null`，上层降级。

### 性能预算

| 项 | 目标 | 做法 |
| --- | --- | --- |
| 空闲 CPU | ≈ 0% | 不用 `setInterval`；用 `setTimeout` 对齐到下一个整分钟，只在那时算一次 |
| 空闲内存 | 100MB 量级 | 单窗口、无框架、渲染进程不加载图片资源（图标是矢量绘制） |
| 磁盘写入 | 不抖动 | 所有改动先进内存，300ms 防抖后再落盘 |
| 启动 | < 1s | 无网络请求、无磁盘遍历，只读一个 JSON |

时间对齐的实现：

```js
tickTimer = setTimeout(run, msToNextMinute());  // 60 - 秒 的秒数，加 30ms 容错
```

`msToNextMinute()` 返回的毫秒数保证每次唤醒都踩在整分钟上，不会出现「每分钟醒 2 次」或漂移累积。

### 数据一致性

- 写入：先写 `data.json.tmp`，再 `rename` 覆盖。rename 在同一分区上是原子的，断电不会留下半截 JSON。
- 读取：解析失败先备份成 `data.json.corrupt-<ts>` 再重建空库——用户还有救回来的机会。
- 迁移：`normalizeTask()` / `normalizeSettings()` 逐字段白名单校验，脏字段丢弃而不是让整个文件失效。

### 安全边界

| 面 | 处理 |
| --- | --- |
| 渲染进程权限 | `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true` |
| IPC | preload 只暴露方法，不暴露 `ipcRenderer`；主进程对入参做类型与范围校验 |
| API Key | 只在主进程解密使用；下发给渲染层的 settings 里已经剥掉密文，只留 `hasKey` 布尔值 |
| Key 落盘 | `safeStorage.encryptString`（Windows 上是 DPAPI，绑定当前用户）。加密不可用时退回明文并在设置页明示 |
| 注入 | 所有模型/用户文本一律 `textContent`；页面无 `innerHTML` 拼接；CSP 限制脚本只能来自本地 |
| 网络 | 只有 `ai.js` 发起请求，且只在用户点「排一下」时触发 |

## 数据模型

```jsonc
{
  "version": 1,
  "tasks": [{
    "id": "uuid",
    "title": "备课：Scratch 循环",
    "date": "2026-11-24",       // 归属哪一天
    "done": false,
    "priority": "high",          // high | normal | low
    "estimateMin": 60,
    "startAt": "09:00",          // 由排程写入，手改标题不影响
    "endAt": "10:00",
    "firstStep": "先定三个课堂目标",
    "carriedFrom": "2026-11-23", // 从哪天顺延过来的
    "order": 0
  }],
  "plans": {
    "2026-11-24": { "source": "ai", "intro": "...", "blocks": [], "tips": [], "unscheduled": [] }
  },
  "settings": { "dayStart": "08:30", "...": "...", "ai": { "apiKeyEnc": "..." } },
  "meta": { "lastRollover": "2026-11-24" }
}
```

计划与任务分开存：重排一次只换 `plans[date]`，同时把时间块回写到任务的 `startAt` 上，列表才有时间显示。清空计划时两边一起清，避免残留。

## 跨天怎么处理

没有常驻定时任务。每次 tick 和启动时调用 `store.rollover(today)`，内部先比对 `meta.lastRollover`，只有日期变了才真正执行：

1. 把今天之前、未完成的任务顺延到今天，打上 `carriedFrom` 标记（最多 10 条）
2. 清理 30 天前已完成的任务与计划

这样既不会漏，也不会为了「跨天」专门养一个定时器。

## 目录与职责

| 文件 | 职责 | 不负责 |
| --- | --- | --- |
| `main.js` | 生命周期、窗口、托盘、快捷键、通知、IPC 路由 | 业务规则 |
| `store.js` | 增删改查、持久化、跨天维护 | 排程算法 |
| `planner.js` | 规则排程、AI 结果清洗、首步建议 | 网络 |
| `ai.js` | 提示词组装、HTTP、错误翻译、JSON 提取 | 结果合法性（交给 planner） |
| `secret.js` | Key 的加密存取 | 明文使用 |
| `renderer/app.js` | 渲染与交互 | 任何业务判断 |
