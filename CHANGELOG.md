# Changelog

独立仓库：DeepSeek Harness cordis 插件（`/desktop` 遥控命令族 + 设置面板 + 自动通知）。

## [0.3.0] - 2026-09-01

- **turn 结束 / 审批等待自动通知**：监听 `session/event` 事件流，`turn/end`
  （error / blocked / max-tokens，`all` 档再含 completed）与 `approval/asked`
  自动写 `notifyRequest` 由桌面外壳弹系统通知——对齐社区 dsh-notify /
  dsh-notification 验证过的「turn 完成/审批提醒」需求，但通知走独立 Electron
  外壳（纯插件受浏览器通知 API 限制）。档位进设置面板：
  `notifyTurn`（off/problems/all，默认 problems——异常才弹，正常完成不打扰）、
  `notifyApproval`（默认开）。aborted/interrupted 不通知。
- **单槽发送队列**：`notifyRequest` 一次只承载一条，自动通知在插件内排队
  （槽空立即写、占用每 2s 重试、积压 60s 丢弃），避免密集事件互相覆盖；
  插件卸载（dispose）时销毁队列，不向共享配置泄漏写入。
- **`/desktop notify` 旗标**：`--silent`（外壳侧静默能力此前是死字段）与
  `--title <标题>`（默认「DSH 通知」，上限 100 字符），用法回显同步更新。
- **契约测试**：新增 session/event 自动通知（problems/all/off 档、approval
  开关、异常事件形态）、旗标解析、队列补发（node:test mock timers）共 4 组用例。

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
