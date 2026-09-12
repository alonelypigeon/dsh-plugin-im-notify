# dsh-plugin-desktop-control

DeepSeek Harness 的 cordis 插件：在 DSH 里用 `/desktop` 命令打开并控制独立的 Electron 桌面外壳。

## 命令

| 命令 | 作用 |
|------|------|
| `/desktop open` | 用**当前 DSH web 地址**打开桌面窗口（含自动聚焦已有实例） |
| `/desktop auto on` / `auto off` | 管理桌面应用的开机自启（写共享配置，桌面应用约 5 秒内应用） |
| `/desktop update` | 请求桌面应用检查更新（桌面应用轮询到后触发 electron-updater） |
| `/desktop stop` | 请求桌面应用停止**由它启动的**本地 DSH 服务（没有可停的服务时桌面端会提示） |
| `/desktop notify <文本>` | 请求桌面应用弹一次**系统通知**；支持 `--silent`（无声）与 `--title <标题>`（自定义标题，默认「DSH 通知」） |
| `/desktop status` | 回显桌面应用的地址 / 自启 / 可执行路径 |

## 自动通知（turn 结束 / 审批等待）

0.3.0 起插件监听 DSH 的 `session/event` 事件流，把两类高价值时机自动转成系统通知
（走与 `/desktop notify` 相同的共享配置通道，无需手动敲命令）：

| 事件 | 通知 | 默认 |
|------|------|------|
| `turn/end`（reason=error / blocked / max-tokens） | 「DSH 回合出错/受阻/输出截断」，带会话短 id、轮次与错误摘要 | 开（problems 档） |
| `turn/end`（reason=completed） | 「DSH 回合完成」，静默无声 | 关（`all` 档才开） |
| `approval/asked` | 「DSH 等待审批」，带工具名与原因 | 开 |

档位在 DSH「设置 → 插件 → 插件配置 → desktop-control」里调整：

- `notifyTurn`：`off` / `problems`（默认，仅异常）/ `all`（完成也通知，静默不响铃）
- `notifyApproval`：审批等待通知开关（默认开）

`aborted`（用户主动取消）与 `interrupted`（崩溃恢复合成）不通知。
通知通道为**单槽**：一条通知被桌面应用取走前，后续自动通知会在插件内排队
（每 2s 重试，积压超过 60s 丢弃）；手动 `/desktop notify` 直接占用槽位。
桌面应用勿扰时段内的通知会被外壳静默丢弃（按既有勿扰设计）。

## IM/webhook 通知扇出（0.5.0+）

桌面通知（手动 notify + 自动通知 + balance-panel 花费告警的转发）可镜像推送到
IM 渠道，在 DSH「设置 → 插件 → 插件配置 → desktop-control」里按渠道开启：

| 渠道 | 配置 | 说明 |
|------|------|------|
| `imGeneric*` | 开关 + webhook 地址 | **通用基座**：POST 通知 JSON（`{source,title,body,silent}`），可接企业自动化/自建网关 |
| `imFeishu*` | 开关 + 群机器人 webhook | 自定义机器人「安全设置」选任意项均可（默认文本消息） |
| `imWecom*` | 开关 + 群机器人 webhook | 企业微信群机器人 |
| `imDingtalk*` | 开关 + webhook（+ 加签密钥） | 钉钉群机器人；安全设置选「加签」时填 `imDingtalkSecret` |
| `imTelegram*` | 开关 + botToken + chatId | 走 bot API `sendMessage`；自动使用标准 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量代理（国内渠道直连不受影响） |

- 每渠道独立开关 + 地址，互不阻塞；成功判定 = HTTP 2xx。
- 发送失败与桌面队列同语义：每 2s 重试，超过 60s 丢弃（console 告警一次）。
- **跨插件转发**：其它插件（如 balance-panel 的每日花费告警）直接写共享配置的
  `notifyRequest`（带 `source` 标记、无 `src` 字段），本插件监听共享配置变化
  自动扇出到 IM；自己的写入带 `src: 'desktop-control'` 标记不会重复扇出。
- webhook 地址 / botToken / 加签密钥在设置面板按敏感项脱敏展示。

## 运行机制

插件运行在 DSH 进程内，与独立 Electron 桌面应用通过**共享配置文件**通信：

- 路径：`$DSH_HOME/desktop-shell.json`（或 `DSH_DESKTOP_CONFIG` 环境变量显式指定）
- 字段：`url` / `autoLaunch` / `updateRequest` / `serviceStopRequest` / `notifyRequest` / `desktopExe`

`/desktop notify` 写入 `notifyRequest`（唯一 id + 标题 + 正文），桌面应用轮询到后弹一次
系统通知并清空该字段（应用重启不补弹启动前的请求）；应用处于勿扰时段时静默丢弃。

`/desktop open` 通过 `ctx.webServer.port` 拿到当前 DSH web 的监听端口，把它作为 `--url` 传给桌面应用（同时写进共享配置），桌面应用据此直接连到当前实例，不重复启动后端。

## 安装（写进 DSH profile）

插件是纯 JS 单文件，可通过 `dsh plugin` 装进某个 profile 的 `node_modules`，再在 `cordis.patch.yml` 里 include：

```sh
# 1. 把本目录作为本地依赖装进当前 profile
dsh plugin --profile web add file:/path/to/dsh-plugin-desktop-control

# 2. 在 profile 的 cordis.patch.yml 里加入该插件条目
#    （或用 dsh 提供的 include 语法把包名列入插件树）
```

`cordis.patch.yml` 追加一条：

```yaml
- id: desktop-control
  name: dsh-plugin-desktop-control
```

重启 DSH 后，在 Web UI 输入框里输 `/desktop status` 验证加载成功。

## 前置条件

- `/desktop open` 依赖桌面应用已运行过一次（打包版），把自身可执行路径写进共享配置的 `desktopExe`。开发模式（desktopExe 指向 electron.exe）不支持 `open`。
- 桌面应用与 DSH 需共享 `DSH_HOME`（从 DSH 里被 spawn 时会继承）。

## 发布状态

> **当前状态：测试期私密发布。** `package.json` 标记了 `"private": true`，
> 不会（也不应）发布到公共 npm；`dsh plugin add` 用本地路径即可。
> 转入稳定后再移除 `private` 并 `npm publish`。
