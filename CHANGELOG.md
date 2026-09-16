# Changelog

独立仓库：DeepSeek Harness cordis 插件（IM/webhook 通知扇出；v1.0.0 前身为 desktop-control——`/desktop` 遥控命令族 + 桌面通知 + IM 扇出）。

## [1.0.0] - 2026-09-16

- **更名 `desktop-control` → `im-notify`，收敛为纯 IM/webhook 通知扇出**：DeepSeek
  官方桌面客户端发布、外壳 dsh-desktop-shell 归档，移除全部外壳耦合面——
  `/desktop` 命令族（open/auto/update/stop/status）、手动 `notify` 命令、桌面
  系统通知与单槽队列、开机自启/应用路径设置与共享配置镜像写入。
- 保留：四渠道 + 通用 webhook 扇出（2s 重试、60s 丢弃、渠道间互不阻塞）、
  turn 结束 / 审批等待自动通知档位（off/problems/all）、外来通知转发
  （共享配置 `notifyRequest`，balance-panel 告警联动）。
- 插件 id / settings namespace / 包名统一更名为 `im-notify`；新增 `/im status`
  命令回显档位与渠道启用数。`inject` 不再需要 `webServer`。
- **升级**：profile `cordis.patch.yml` 的 insert id 需改为 `im-notify`；IM 渠道
  配置因 namespace 更名需在设置面板重填一次。

## [0.5.0] - 2026-09-12

- **IM/webhook 通知扇出**：桌面通知（手动 notify + 自动通知）镜像推送到 IM 渠道——
  通用自定义 webhook（基座，POST 通知 JSON）+ 飞书 / 企业微信 / 钉钉（可选加签）/
  Telegram（botToken+chatId）适配器，各渠道独立开关；失败与桌面队列同语义
  （2s 重试、60s 丢弃），渠道间互不阻塞。Telegram 走标准 `HTTPS_PROXY`
  （内置零依赖 CONNECT 隧道）；webhook 地址 / botToken / 加签密钥按
  `role('secret')` 脱敏。
- **跨插件转发**：监听共享配置目录，其它插件（balance-panel 花费告警）直接写入
  的外来 `notifyRequest`（带 `source`、无 `src` 标记）自动扇出到 IM，同 id 去重；
  自有写入带 `src: 'desktop-control'` 不重复扇出。零代码耦合、加载顺序无关。
- **SDK 0.1.5-rc.2 适配 + 修复自动通知既有 bug**：核对 `session/event` 信封
  （payload 在 `event.data`）——0.3.0 按平铺形状读 `event.reason`/`event.turn`/
  `event.toolName`，在真实宿主下自动通知从不触发（旧测试夹具同错互证）；现已
  改为从 `event.data` 读取，夹具同步纠正。peerDependencies 提升至
  `^0.1.5-rc.1`（cordis `^4.0.2`）。

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
