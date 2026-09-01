// @dsh-plugin-desktop-control  —— DeepSeek Harness 的 cordis 插件。
// 注册 /desktop 命令族 + settings namespace（出现在 DSH「设置 → 插件 → 插件配置」里）：
//   /desktop open           用当前 DSH web 地址打开桌面窗口
//   /desktop auto on|off    管理桌面应用的开机自启（与 settings 面板同一来源）
//   /desktop update         请求桌面应用检查更新（写共享配置，Electron 监听后触发）
//   /desktop stop           请求桌面应用停止本地 DSH 服务（写共享配置，Electron 监听后停止）
//   /desktop notify <文本>  请求桌面应用弹一次系统通知（写共享配置 notifyRequest，
//                           Electron 监听后弹并清空；勿扰时段内静默丢弃）
//   /desktop status         回显桌面应用状态
//
// settings 是真相来源：设置面板与 /desktop 命令都通过它；变化由 watch 镜像到
// 共享配置文件（$DSH_HOME/desktop-shell.json，或 DSH_DESKTOP_CONFIG 指定），
// Electron 桌面应用监听该文件后应用。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import z from '@deepseek-ai/schemastery';

const name = 'desktop-control';
const inject = ['commands', 'webServer', 'settings'];

const SETTINGS_NS = 'desktop-control';

// —— 共享配置（与 Electron 侧 shared-config.ts 保持一致） ——

function dshHome() {
  const explicit = process.env.DSH_HOME;
  if (explicit && isAbsolute(explicit)) return explicit;
  const p = join(homedir(), '.dsh');
  return existsSync(p) ? p : null;
}

function configPath() {
  // 显式覆盖仅接受绝对路径（与外壳 shared-config.ts 一致）：相对路径会随 cwd 漂移。
  const explicit = process.env.DSH_DESKTOP_CONFIG;
  if (explicit && isAbsolute(explicit)) return explicit;
  const home = dshHome();
  if (home) return join(home, 'desktop-shell.json');
  return null;
}

function load() {
  const p = configPath();
  if (!p) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function save(patch) {
  const p = configPath();
  if (!p) throw new Error('无法定位共享配置文件（缺少 DSH_HOME）');
  const next = { ...load(), ...patch };
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, p);
  return next;
}

// 当前 DSH web 服务的回环地址（由 webServer 服务监听端口拼出）。
function currentWebUrl(ctx) {
  const host = ctx.webServer.host === '0.0.0.0' ? '127.0.0.1' : ctx.webServer.host;
  return `http://${host}:${ctx.webServer.port}`;
}

function ok(text) {
  return { kind: 'success', text };
}
function err(text) {
  return { kind: 'error', text };
}

// —— settings namespace：出现在 DSH 设置 → 插件 → 插件配置 ——

const DesktopSettingsSchema = z.object({
  autoLaunch: z.boolean().default(false),
  desktopExe: z.string().default(''),
});

// 桌面应用 exe 的解析顺序：共享配置（桌面应用自动注册）> settings 手填 > 环境变量。
function resolveExe(scope) {
  const cfg = load();
  return (
    (typeof cfg.desktopExe === 'string' && cfg.desktopExe) ||
    (scope.get().desktopExe || '') ||
    process.env.DSH_DESKTOP_EXE ||
    null
  );
}

// —— 子命令 ——

function open(ctx, scope) {
  const exe = resolveExe(scope);
  if (!exe || !existsSync(exe)) {
    return err('未找到桌面应用。请在「设置 → 插件 → 插件配置 → desktop-control」里填写应用路径（desktopExe），或先运行一次桌面应用让它自动注册。');
  }
  const url = currentWebUrl(ctx);
  save({ url }); // 让桌面应用下次启动直接复用当前 DSH 地址
  const child = spawn(exe, ['--url', url], { detached: true, stdio: 'ignore' });
  child.unref();
  return ok(`已在桌面窗口打开 ${url}`);
}

function setAuto(scope, value) {
  if (value !== 'on' && value !== 'off') {
    return err('用法：/desktop auto on|off');
  }
  // 通过 settings scope 写入：设置面板会同步显示，watch 会镜像到共享配置。
  const next = value === 'on';
  void scope.update({ autoLaunch: next }).catch((e) => {
    console.warn('[desktop-control] settings update failed:', e?.message ?? e);
  });
  return ok(`开机自启已${next ? '开启' : '关闭'}`);
}

function requestUpdate() {
  save({ updateRequest: Date.now() });
  return ok('已请求桌面应用检查更新。');
}

function requestStop() {
  save({ serviceStopRequest: Date.now() });
  return ok('已请求桌面应用停止本地 DSH 服务。');
}

/** 通知请求 id：时间戳 + 随机段（与外壳 notify-queue.ts 的 makeNotifyId 同构，保持唯一）。 */
function makeNotifyId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function requestNotify(text) {
  const body = (text || '').trim();
  if (!body) return err('用法：/desktop notify <通知文本>');
  if (body.length > 500) return err('通知文本过长（上限 500 字符）。');
  save({
    notifyRequest: {
      id: makeNotifyId(),
      title: 'DSH 通知',
      body,
      silent: false,
    },
  });
  return ok(`已请求桌面应用通知：${body.slice(0, 40)}${body.length > 40 ? '…' : ''}`);
}

function status(scope) {
  const cfg = load();
  const lines = [
    `桌面地址：${cfg.url ?? '（未设置）'}`,
    `开机自启：${scope.get().autoLaunch ? '开' : '关'}`,
    `应用路径：${resolveExe(scope) ?? '（未注册）'}`,
  ];
  return ok(lines.join('\n'));
}

// —— 插件入口 ——

function apply(ctx) {
  // 1) 注册 settings namespace（设置 → 插件 → 插件配置）
  const scope = ctx.settings.register(SETTINGS_NS, DesktopSettingsSchema);

  // 启动同步：以共享配置（桌面应用注册的）为准，把缺的字段填进 settings，
  // 让设置面板显示与桌面应用实际状态一致。
  const existing = load();
  const syncPatch = {};
  if (typeof existing.autoLaunch === 'boolean' && scope.get().autoLaunch !== existing.autoLaunch) {
    syncPatch.autoLaunch = existing.autoLaunch;
  }
  if (typeof existing.desktopExe === 'string' && existing.desktopExe && !scope.get().desktopExe) {
    syncPatch.desktopExe = existing.desktopExe;
  }
  if (Object.keys(syncPatch).length > 0) {
    void scope.update(syncPatch).catch(() => {});
  }

  // 2) settings 变化 → 镜像到共享配置（Electron 桌面应用监听并应用）
  scope.watch((next) => {
    try {
      const patch = { autoLaunch: next.autoLaunch };
      if (typeof next.desktopExe === 'string' && next.desktopExe) patch.desktopExe = next.desktopExe;
      save(patch);
    } catch (e) {
      console.warn('[desktop-control] mirror to shared config failed:', e?.message ?? e);
    }
  });

  // 3) /desktop 命令族
  ctx.commands.register({
    name: 'desktop',
    description: 'open or control the DeepSeek Harness desktop shell',
    input: { hint: 'open | auto <on|off> | update | stop | notify <text> | status' },
    handler: (invocation) => {
      const [sub, ...rest] = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
      const cmd = (sub || 'open').toLowerCase();
      try {
        switch (cmd) {
          case 'open':
            return open(ctx, scope);
          case 'auto':
            return setAuto(scope, rest[0]);
          case 'update':
            return requestUpdate();
          case 'stop':
            return requestStop();
          case 'notify':
            return requestNotify(rest.join(' '));
          case 'status':
            return status(scope);
          default:
            return err('用法：/desktop open | auto <on|off> | update | stop | notify <text> | status');
        }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
}

export { apply, inject, name };
