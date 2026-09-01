# Changelog

独立仓库：DeepSeek Harness cordis 插件（`/desktop` 遥控命令族 + 设置面板）。

## [0.2.0] - 2026-09-01

- **`/desktop notify <文本>`**：请求桌面应用弹一次系统通知——写入共享配置
  `notifyRequest`（唯一 id + 标题 + 正文），Electron 桌面应用轮询到后弹通知并清空
  请求（勿扰时段静默丢弃；重启不补弹启动前的请求）。通知正文上限 500 字符，
  校验失败给出用法提示。至此 `/desktop` 命令族补上「远程提醒」能力——DSH 内
  （插件/命令）无法直接调 Electron API，通知写共享配置由外壳弹，与
  autoLaunch/update/stop 的既有通信模式一致。
- **契约测试**：新增 `test/desktop-control.test.mjs`（node:test，mock ctx +
  `DSH_DESKTOP_CONFIG` 指向临时文件）：notify 写入格式与字段保留、id 唯一、
  空/超长文本拒绝、status 回显、未知子命令；package.json 增加
  `npm test`（此前仓库无测试脚本与依赖，`npm install` 后即可运行）。

## [0.1.0] - 测试中

- `/desktop open | auto <on|off> | update | stop | status` 命令族。
- 设置面板（开机自启、应用路径），与共享配置 `desktop-shell.json` 双向同步。
- 按 DSH 生态惯例命名为 `dsh-plugin-desktop-control`，标记 `"private": true`
  （测试期私密发布，不推公共 npm）。
