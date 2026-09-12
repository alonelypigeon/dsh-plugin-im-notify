// @dsh-plugin-desktop-control  —— DeepSeek Harness 的 cordis 插件。
// 注册 /desktop 命令族 + settings namespace（出现在 DSH「设置 → 插件 → 插件配置」里）：
//   /desktop open           用当前 DSH web 地址打开桌面窗口
//   /desktop auto on|off    管理桌面应用的开机自启（与 settings 面板同一来源）
//   /desktop update         请求桌面应用检查更新（写共享配置，Electron 监听后触发）
//   /desktop stop           请求桌面应用停止本地 DSH 服务（写共享配置，Electron 监听后停止）
//   /desktop notify <文本>  请求桌面应用弹一次系统通知（写共享配置 notifyRequest，
//                           Electron 监听后弹并清空；勿扰时段内静默丢弃）。
//                           支持 --silent（无声）与 --title <标题> 自定义标题。
//   /desktop status         回显桌面应用状态
//
// 自动通知（0.3.0+）：监听 session/event ——
//   turn/end（reason=error/blocked/max-tokens，或 all 档再含 completed）与
//   approval/asked（审批等待）也走同一 notifyRequest 通道；
//   档位由 settings 的 notifyTurn（off/problems/all）/ notifyApproval 控制。
//
// IM/webhook 扇出（0.5.0+）：桌面通知（手动 notify + 自动通知）镜像推送到
// 已启用的 IM 渠道——通用自定义 webhook（基座，POST 通知 JSON）、飞书、
// 企业微信、钉钉（可选加签）、Telegram（botToken+chatId，走 HTTPS_PROXY）。
// 每渠道独立开关 + 地址，配置在 settings 面板；失败 2s 重试、60s 丢弃
// （与桌面单槽队列同语义），详见 lib/im-fanout.js。
//
// settings 是真相来源：设置面板与 /desktop 命令都通过它；变化由 watch 镜像到
// 共享配置文件（$DSH_HOME/desktop-shell.json，或 DSH_DESKTOP_CONFIG 指定），
// Electron 桌面应用监听该文件后应用。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { IM_CHANNELS, makeImQueue, proxyFromEnv, sendToChannel } from './lib/im-fanout.js';

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
  // turn 结束自动通知档位：off 关 / problems 仅 error·blocked·max-tokens / all 再含 completed
  notifyTurn: z.union(['off', 'problems', 'all']).default('problems'),
  // 审批等待（approval/asked）自动通知
  notifyApproval: z.boolean().default(true),
  // —— IM/webhook 扇出（0.5.0+）：桌面通知镜像推送到 IM 渠道，各渠道独立开关 ——
  // generic=通用自定义 webhook（POST 通知 JSON）；feishu/wecom/dingtalk=群机器人
  // webhook；telegram=bot API（botToken+chatId，走 HTTPS_PROXY 代理）。
  imGenericEnabled: z.boolean().default(false),
  imGenericUrl: z.string().default(''),
  imFeishuEnabled: z.boolean().default(false),
  imFeishuUrl: z.string().default(''),
  imWecomEnabled: z.boolean().default(false),
  imWecomUrl: z.string().default(''),
  imDingtalkEnabled: z.boolean().default(false),
  imDingtalkUrl: z.string().default(''),
  // 钉钉「加签」安全设置的密钥（可选）
  imDingtalkSecret: z.string().default('').role('secret'),
  imTelegramEnabled: z.boolean().default(false),
  imTelegramBotToken: z.string().default('').role('secret'),
  imTelegramChatId: z.string().default(''),
});

/** 从 settings 读出已启用的 IM 渠道（开关开且地址齐备才算启用）。 */
function collectChannels(s) {
  const channels = [];
  if (s.imGenericEnabled && s.imGenericUrl) channels.push({ key: 'generic', url: s.imGenericUrl });
  if (s.imFeishuEnabled && s.imFeishuUrl) channels.push({ key: 'feishu', url: s.imFeishuUrl });
  if (s.imWecomEnabled && s.imWecomUrl) channels.push({ key: 'wecom', url: s.imWecomUrl });
  if (s.imDingtalkEnabled && s.imDingtalkUrl) {
    channels.push({ key: 'dingtalk', url: s.imDingtalkUrl, secret: s.imDingtalkSecret || undefined });
  }
  if (s.imTelegramEnabled && s.imTelegramBotToken && s.imTelegramChatId) {
    channels.push({
      key: 'telegram',
      url: `https://api.telegram.org/bot${s.imTelegramBotToken}/sendMessage`,
      chatId: s.imTelegramChatId,
    });
  }
  return channels;
}

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

const NOTIFY_USAGE = '用法：/desktop notify [--silent] [--title <标题>] <通知文本>';

/** 解析 notify 参数里的旗标（--silent、--title <t> / --title=<t>），返回 {title, silent, body} 或用法错误。 */
function parseNotifyArgs(args) {
  let silent = false;
  let title = 'DSH 通知';
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--silent') {
      silent = true;
    } else if (a === '--title') {
      const t = args[i + 1];
      if (!t || t.startsWith('--')) return { error: NOTIFY_USAGE };
      title = t;
      i += 1;
    } else if (a.startsWith('--title=')) {
      title = a.slice('--title='.length);
      if (!title) return { error: NOTIFY_USAGE };
    } else {
      rest.push(a);
    }
  }
  return { title, silent, body: rest.join(' ').trim() };
}

function requestNotify(args, afterSave) {
  const parsed = parseNotifyArgs(args);
  if (parsed.error) return err(parsed.error);
  const { title, silent, body } = parsed;
  if (!body) return err(NOTIFY_USAGE);
  if (body.length > 500) return err('通知文本过长（上限 500 字符）。');
  if (title.length > 100) return err('通知标题过长（上限 100 字符）。');
  save({
    notifyRequest: {
      id: makeNotifyId(),
      title,
      body,
      silent,
      src: 'desktop-control', // 标记自有写入：共享配置监听不重复扇出
    },
  });
  // 手动通知也镜像到 IM 渠道（桌面写入成功后触发，失败不影响命令结果）
  if (afterSave) afterSave({ title, body, silent, source: 'manual' });
  return ok(`已请求桌面应用通知：${body.slice(0, 40)}${body.length > 40 ? '…' : ''}`);
}

// —— 自动通知：turn 结束 / 审批等待 → 同一 notifyRequest 通道 ——

const TURN_TITLES = {
  completed: '回合完成',
  error: '回合出错',
  blocked: '回合受阻',
  'max-tokens': '输出截断',
};

function shortId(id) {
  return String(id ?? '').slice(-8) || '未知';
}

/**
 * 监听共享配置：外来 notifyRequest（其它插件直接写入、无 src 标记，如
 * balance-panel 的每日花费告警带 source 标记）出现新 id 时，镜像扇出到 IM。
 * 自己的写入带 src='desktop-control'，监听侧跳过防重复。fs.watch 监听配置
 * 所在目录（写入走 tmp+rename 原子替换，Windows 上文件级 watch 不可靠），
 * 50ms 去抖合并连续事件；监视失败仅告警，不影响其余功能。启动时已存在的
 * 通知不补发（可能是外壳未消费的残留，避免重复打扰）。
 */
function watchForeignNotify(fanoutIm) {
  const p = configPath();
  if (!p) return () => {};
  let lastId = null;
  let timer = null;
  let watcher = null;
  const scan = () => {
    try {
      const n = load().notifyRequest;
      if (!n || typeof n.id !== 'string') return;
      if (n.src === 'desktop-control' || n.id === lastId) return;
      lastId = n.id;
      fanoutIm({ title: n.title ?? '', body: n.body ?? '', silent: !!n.silent, source: n.source ?? 'forwarded' });
    } catch (e) {
      console.warn('[desktop-control] foreign notify scan failed:', e?.message ?? e);
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(scan, 50);
    timer.unref?.();
  };
  try {
    watcher = watch(dirname(p), (_event, filename) => {
      if (!filename || filename === basename(p)) schedule();
    });
    watcher.on('error', (e) => console.warn('[desktop-control] config watch failed:', e?.message ?? e));
  } catch (e) {
    console.warn('[desktop-control] config watch unavailable:', e?.message ?? e);
    return () => {};
  }
  return () => {
    clearTimeout(timer);
    watcher?.close();
  };
}

/**
 * 单槽发送队列：notifyRequest 一次只承载一条，外壳取走（清空字段）后才能放下一条。
 * 自动通知先入队，槽空则立即写；被占时每 2s 重试，超过 60s 的积压丢弃
 * （无人消费说明桌面外壳没在运行，不值得无限排队）。
 */
function makeNotifyQueue(loadFn, saveFn) {
  const pending = [];
  let timer = null;
  function tryDrain() {
    while (pending.length > 0) {
      if (loadFn().notifyRequest) return; // 槽被占用：等外壳取走
      saveFn({ notifyRequest: { id: makeNotifyId(), ...pending.shift(), src: 'desktop-control' } });
    }
  }
  function arm() {
    if (timer) return;
    timer = setInterval(() => {
      pending.splice(0, pending.length, ...pending.filter((n) => Date.now() - n.queuedAt < 60_000));
      tryDrain();
      if (pending.length === 0) {
        clearInterval(timer);
        timer = null;
      }
    }, 2000);
    timer.unref?.();
  }
  return {
    push(notification) {
      pending.push({ silent: false, ...notification, queuedAt: Date.now() });
      tryDrain();
      if (pending.length > 0) arm();
    },
    dispose() {
      pending.length = 0;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/** session/event 监听：按 settings 档位把 turn 结束 / 审批等待转成桌面通知。
 *  事件信封为 { type, seq, time, data }，payload 字段一律从 event.data 读。
 *  notify(notification) 同时驱动桌面队列与 IM 扇出。 */
function handleSessionEvent(scope, notify, session, event) {
  const settings = scope.get();
  const data = event?.data ?? {};
  if (event?.type === 'turn/end') {
    const kind = data.reason?.kind;
    const isProblem = kind === 'error' || kind === 'blocked' || kind === 'max-tokens';
    // aborted（用户自己取消）/ interrupted（崩溃恢复合成）不打扰
    const wanted =
      settings.notifyTurn === 'all'
        ? kind === 'completed' || isProblem
        : settings.notifyTurn === 'problems' && isProblem;
    if (!wanted) return;
    const detail = kind === 'error' && data.reason?.error?.message
      ? `：${String(data.reason.error.message).slice(0, 120)}`
      : '';
    notify({
      title: `DSH ${TURN_TITLES[kind] ?? '回合结束'}`,
      body: `会话 ${shortId(session?.id)} 第 ${data.turn} 轮${detail}`,
      silent: kind === 'completed', // all 档的完成通知不响铃
      source: `turn-end/${kind}`,
    });
  } else if (event?.type === 'approval/asked' && settings.notifyApproval) {
    const tool = data.toolName || '工具';
    const reason = data.reason ? `：${String(data.reason).slice(0, 120)}` : '';
    notify({
      title: 'DSH 等待审批',
      body: `${tool} 请求审批${reason}（会话 ${shortId(session?.id)}）`,
      source: 'approval',
    });
  }
}

function status(scope) {
  const cfg = load();
  const lines = [
    `桌面地址：${cfg.url ?? '（未设置）'}`,
    `开机自启：${scope.get().autoLaunch ? '开' : '关'}`,
    `应用路径：${resolveExe(scope) ?? '（未注册）'}`,
    `IM 扇出：${collectChannels(scope.get()).length}/${IM_CHANNELS.length} 渠道启用`,
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

  // 3) 自动通知：turn 结束 / 审批等待 → notifyRequest（观察者不得抛出，save 失败仅告警）
  const queue = makeNotifyQueue(load, (patch) => save(patch));

  // 4) IM/webhook 扇出：同一通知镜像推送到已启用的 IM 渠道。队列同桌面语义
  //    （2s 重试、60s 丢弃），单渠道故障互不阻塞；Telegram 走 HTTPS_PROXY 代理。
  const imQueue = makeImQueue({
    send: (entry) => sendToChannel(entry.channel, entry.notification, { proxy: proxyFromEnv() }),
    onDrop: (e) => console.warn(`[desktop-control] IM 扇出放弃（${e.channel.key}，60s 未送达）`),
  });
  // 统一通知发出点：桌面队列 push + IM 扇出（source 等扩展字段只进 IM，不改外壳契约）。
  // fanoutIm 另供共享配置监听转发外来通知用；手动通知的桌面槽位由 requestNotify
  // 直接写，不走队列防重复。
  const fanoutIm = (n) => {
    for (const channel of collectChannels(scope.get())) imQueue.push(channel, n);
  };
  const notify = (n) => {
    queue.push({ title: n.title, body: n.body, silent: n.silent });
    fanoutIm(n);
  };

  // 3.5) 共享配置监听：其它插件（如 balance-panel 的每日花费告警）会直接往
  //      notifyRequest 写外来通知——发现新 id 就镜像扇出到 IM。自己的写入带
  //      src 标记（见 saveNotify），监听侧据此跳过，不重复扇出。
  const stopWatch = watchForeignNotify(fanoutIm);
  ctx.on('session/event', (session, event) => {
    try {
      handleSessionEvent(scope, notify, session, event);
    } catch (e) {
      console.warn('[desktop-control] auto notify failed:', e?.message ?? e);
    }
  });
  // 插件卸载时停掉重试定时器与配置监听，避免向共享配置泄漏写入
  ctx.on('dispose', () => {
    queue.dispose();
    imQueue.dispose();
    stopWatch();
  });

  // 5) /desktop 命令族
  ctx.commands.register({
    name: 'desktop',
    description: 'open or control the DeepSeek Harness desktop shell',
    input: { hint: 'open | auto <on|off> | update | stop | notify [--silent] [--title <标题>] <文本> | status' },
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
            return requestNotify(rest, fanoutIm);
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
