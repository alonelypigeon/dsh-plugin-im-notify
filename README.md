# dsh-plugin-desktop-control

DeepSeek Harness 的 cordis 插件：在 DSH 里用 `/desktop` 命令打开并控制独立的 Electron 桌面外壳。

## 命令

| 命令 | 作用 |
|------|------|
| `/desktop open` | 用**当前 DSH web 地址**打开桌面窗口（含自动聚焦已有实例） |
| `/desktop auto on` / `auto off` | 管理桌面应用的开机自启（写共享配置，桌面应用约 5 秒内应用） |
| `/desktop update` | 请求桌面应用检查更新（桌面应用轮询到后触发 electron-updater） |
| `/desktop stop` | 请求桌面应用停止**由它启动的**本地 DSH 服务（没有可停的服务时桌面端会提示） |
| `/desktop notify <文本>` | 请求桌面应用弹一次**系统通知**（如告警/任务完成提醒；桌面应用勿扰时段内静默丢弃） |
| `/desktop status` | 回显桌面应用的地址 / 自启 / 可执行路径 |

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
