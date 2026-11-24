# 参与开发

## 环境

- Node.js ≥ 18（开发用的是 22）
- Windows 10/11 用于验证桌面行为；macOS / Linux 也能跑，但托盘、DPI、通知的细节只保证 Windows 上验证过

```bash
npm install
npm run icons   # 图标由脚本生成，仓库不存二进制
npm run dev     # 带 DevTools 启动
npm test        # 单测
```

## 改代码前先看

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 主进程/渲染进程的分工、排程算法、性能与安全上的取舍
- 业务逻辑一律放主进程。渲染进程只做展示和转发，不要在里面判断「今天该做什么」。

## 约定

- 缩进 2 空格，字符串用单引号，语句带分号（跟现有代码保持一致）
- 新增的纯逻辑要能被单测覆盖，放在 `src/main/` 下并保持不 `require('electron')`，这样可以脱离 Electron 直接测
- 需要 electron 能力（safeStorage、Notification 等）的代码单独成模块，例如 `secret.js`
- 任何来自模型或用户的文本进 DOM 一律用 `textContent`
- 提交信息用中文或英文都行，但要说清「改了什么、为什么」

## 提交前自查

- [ ] `npm test` 全绿
- [ ] `npm run lint` 无报错
- [ ] 手动跑一遍：加任务 → 排一下 → 勾选完成 → 关掉重开，数据还在
- [ ] 改动涉及界面时，浅色和深色都看一眼

## 发布

1. 更新 `CHANGELOG.md` 与 `package.json` 的版本号
2. `git tag v1.0.1 && git push origin v1.0.1`
3. Actions 会自动产出三个平台的安装包并挂到 Release
