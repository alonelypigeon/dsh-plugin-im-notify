# dsh-plugin-im-notify

DeepSeek Harness 的 cordis 插件：把 DSH 通知**扇出到 IM/webhook 渠道**——turn 结束 /
审批等待自动通知，以及其它插件（如 balance-panel 的每日花费告警）经共享配置转发的
外来通知。

> **v1.0.0 起由 `dsh-plugin-desktop-control` 更名而来。** DeepSeek 官方桌面客户端发布、
> [dsh-desktop-shell](https://github.com/alonelypigeon/dsh-desktop-shell)（已归档）完成使命后，
> 插件收敛为纯通知扇出：`/desktop` 命令族、手动 notify、桌面系统通知通道均已移除，
> IM 扇出能力原样保留。升级见下方「从 desktop-control 升级」。

## 通知来源

| 来源 | 行为 | 默认 |
|------|------|------|
| `turn/end`（reason=error / blocked / max-tokens） | 「DSH 回合出错/受阻/输出截断」，带会话短 id、轮次与错误摘要 | 开（problems 档） |
| `turn/end`（reason=completed） | 「DSH 回合完成」，静默无声 | 关（`all` 档才开） |
| `approval/asked` | 「DSH 等待审批」，带工具名与原因 | 开 |
| 外来 `notifyRequest`（共享配置） | 其它插件写入的通知（如 balance-panel 每日花费告警，`source: 'spend-alert'`）原样转发 | 开（随渠道） |

档位在 DSH「设置 → 插件 → 插件配置 → im-notify」里调整：

- `notifyTurn`：`off` / `problems`（默认，仅异常）/ `all`（完成也通知，静默不响铃）
- `notifyApproval`：审批等待通知开关（默认开）

`aborted`（用户主动取消）与 `interrupted`（崩溃恢复合成）不通知。

## IM/webhook 渠道

| 渠道 | 配置 | 说明 |
|------|------|------|
| `imGeneric*` | 开关 + webhook 地址 | **通用基座**：POST 通知 JSON（`{source,title,body,silent}`），可接企业自动化/自建网关 |
| `imFeishu*` | 开关 + 群机器人 webhook | 自定义机器人「安全设置」选任意项均可（默认文本消息） |
| `imWecom*` | 开关 + 群机器人 webhook | 企业微信群机器人 |
| `imDingtalk*` | 开关 + webhook（+ 加签密钥） | 钉钉群机器人；安全设置选「加签」时填 `imDingtalkSecret` |
| `imTelegram*` | 开关 + botToken + chatId | 走 bot API `sendMessage`；自动使用标准 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量代理（国内渠道直连不受影响） |

- 每渠道独立开关 + 地址，互不阻塞；成功判定 = HTTP 2xx。
- 发送失败每 2s 重试，超过 60s 丢弃（console 告警一次）。
- webhook 地址 / botToken / 加签密钥在设置面板按敏感项脱敏展示。

## 命令

| 命令 | 作用 |
|------|------|
| `/im status` | 回显通知档位与渠道启用数 |

## 运行机制

插件运行在 DSH 进程内，不依赖任何桌面应用：

- **自动通知**：监听 DSH 的 `session/event` 事件流（`turn/end` / `approval/asked`），
  按档位构造通知后推入 IM 队列。
- **外来通知转发**：监听共享配置文件（`$DSH_HOME/desktop-shell.json`，或
  `DSH_DESKTOP_CONFIG` 显式指定）的 `notifyRequest` 字段——其它插件写入新通知
  （唯一 id + 标题 + 正文，可选 `source` 标记）即镜像扇出到 IM；带 `src` 标记的
  自有/历史写入（`desktop-control` / `im-notify`）不重复扇出。启动时已存在的
  通知不补发。

## 安装（写进 DSH profile）

```sh
# 1. 把本目录作为本地依赖装进目标 profile
dsh plugin --profile web add file:/path/to/dsh-plugin-im-notify

# 2. profile 的 cordis.patch.yml 追加：
```

```yaml
- id: im-notify
  name: dsh-plugin-im-notify
```

重启 DSH 后，在 Web UI 输入框里输 `/im status` 验证加载成功。

## 从 desktop-control 升级（0.5.x → 1.0.0）

1. `cordis.patch.yml` 里的插件条目改为上例的 `id: im-notify`（插件 id 已更名）。
2. settings namespace 同步更名：IM 渠道配置（webhook 地址、botToken 等）需要在
   「设置 → 插件 → 插件配置 → im-notify」重填一次。
3. 被移除的能力：`/desktop` 命令族（open/auto/update/stop/status）、手动
   `notify`、桌面系统通知与单槽队列——官方桌面客户端发布后该外壳已归档。

## 发布状态

> **当前状态：测试期私密发布。** `package.json` 标记了 `"private": true`，
> 不会（也不应）发布到公共 npm；`dsh plugin add` 用本地路径即可。
> 转入稳定后再移除 `private` 并 `npm publish`。

## 测试

```sh
npm test   # node:test 契约测试（im-notify + im-fanout），无真实网络
```
