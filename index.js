// @dsh-plugin-im-notify —— DeepSeek Harness 的 cordis 插件：IM/webhook 通知扇出。
// 前身 desktop-control（/desktop 外壳遥控命令族 + 桌面通知）；官方桌面客户端
// 发布、dsh-desktop-shell 归档后，v1.0.0 起更名并收敛为纯通知扇出：
//   1. 自动通知：监听 session/event —— turn/end（reason=error/blocked/max-tokens，
//      all 档再含 completed）与 approval/asked（审批等待），按 settings 档位推送；
//   2. 外来通知转发：监听共享配置（$DSH_HOME/desktop-shell.json，或
//      DSH_DESKTOP_CONFIG 指定）里的 notifyRequest——其它插件（如 balance-panel
//      的每日花费告警，带 source 标记）写入即镜像扇出到 IM。
//
// 渠道：通用自定义 webhook（基座，POST 通知 JSON）、飞书、企业微信、钉钉
// （可选加签）、Telegram（botToken+chatId，走 HTTPS_PROXY 代理）。每渠道独立
// 开关 + 地址，配置在 settings 面板；失败 2s 重试、60s 丢弃（单渠道故障互不
// 阻塞），详见 lib/im-fanout.js。
import { existsSync, readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { IM_CHANNELS, makeImQueue, proxyFromEnv, sendToChannel } from './lib/im-fanout.js';

const name = 'im-notify';
const inject = ['commands', 'settings'];

const SETTINGS_NS = 'im-notify';

// —— 共享配置（只读）：外来通知经此文件流转，格式与原外壳 shared-config.ts 一致 ——

function dshHome() {
  const explicit = process.env.DSH_HOME;
  if (explicit && isAbsolute(explicit)) return explicit;
  const p = join(homedir(), '.dsh');
  return existsSync(p) ? p : null;
}

function configPath() {
  // 显式覆盖仅接受绝对路径（与原外壳 shared-config.ts 一致）：相对路径会随 cwd 漂移。
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

function ok(text) {
  return { kind: 'success', text };
}

// —— settings namespace：出现在 DSH 设置 → 插件 → 插件配置 ——

const NotifySettingsSchema = z.object({
  // turn 结束自动通知档位：off 关 / problems 仅 error·blocked·max-tokens / all 再含 completed
  notifyTurn: z.union(['off', 'problems', 'all']).default('problems'),
  // 审批等待（approval/asked）自动通知
  notifyApproval: z.boolean().default(true),
  // —— IM/webhook 扇出：各渠道独立开关 ——
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

// —— 自动通知：turn 结束 / 审批等待 ——

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
 * 前身插件/本插件自己的历史写入带 src 标记（'desktop-control' / 'im-notify'），
 * 监听侧跳过防重复。fs.watch 监听配置所在目录（写入方走 tmp+rename 原子替换，
 * Windows 上文件级 watch 不可靠），50ms 去抖合并连续事件；监视失败仅告警，
 * 不影响其余功能。启动时已存在的通知不补发（可能是无人消费的残留，避免重复打扰）。
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
      if (n.src === 'desktop-control' || n.src === 'im-notify' || n.id === lastId) return;
      lastId = n.id;
      fanoutIm({ title: n.title ?? '', body: n.body ?? '', silent: !!n.silent, source: n.source ?? 'forwarded' });
    } catch (e) {
      console.warn('[im-notify] foreign notify scan failed:', e?.message ?? e);
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
    watcher.on('error', (e) => console.warn('[im-notify] config watch failed:', e?.message ?? e));
  } catch (e) {
    console.warn('[im-notify] config watch unavailable:', e?.message ?? e);
    return () => {};
  }
  return () => {
    clearTimeout(timer);
    watcher?.close();
  };
}

/** session/event 监听：按 settings 档位把 turn 结束 / 审批等待转成 IM 通知。
 *  事件信封为 { type, seq, time, data }，payload 字段一律从 event.data 读。
 *  notify(notification) 驱动 IM 扇出。 */
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
  const s = scope.get();
  const lines = [
    `turn 通知档位：${s.notifyTurn}（problems=仅出错受阻 / all=含完成 / off=关）`,
    `审批等待通知：${s.notifyApproval ? '开' : '关'}`,
    `IM 扇出：${collectChannels(s).length}/${IM_CHANNELS.length} 渠道启用`,
  ];
  return ok(lines.join('\n'));
}

// —— 插件入口 ——

function apply(ctx) {
  // 1) 注册 settings namespace（设置 → 插件 → 插件配置）
  const scope = ctx.settings.register(SETTINGS_NS, NotifySettingsSchema);

  // 2) IM/webhook 扇出：通知推送到已启用的 IM 渠道。队列语义：2s 重试、60s
  //    丢弃，单渠道故障互不阻塞；Telegram 走 HTTPS_PROXY 代理。
  const imQueue = makeImQueue({
    send: (entry) => sendToChannel(entry.channel, entry.notification, { proxy: proxyFromEnv() }),
    onDrop: (e) => console.warn(`[im-notify] IM 扇出放弃（${e.channel.key}，60s 未送达）`),
  });
  const fanoutIm = (n) => {
    for (const channel of collectChannels(scope.get())) imQueue.push(channel, n);
  };

  // 3) 外来通知转发：其它插件（如 balance-panel 的每日花费告警）会直接往
  //    notifyRequest 写外来通知——发现新 id 就镜像扇出到 IM。
  const stopWatch = watchForeignNotify(fanoutIm);
  ctx.on('session/event', (session, event) => {
    try {
      handleSessionEvent(scope, fanoutIm, session, event);
    } catch (e) {
      console.warn('[im-notify] auto notify failed:', e?.message ?? e);
    }
  });
  ctx.on('dispose', () => {
    imQueue.dispose();
    stopWatch();
  });

  // 4) /im 命令
  ctx.commands.register({
    name: 'im',
    description: 'show IM/webhook notification fanout status',
    input: { hint: 'status' },
    handler: () => status(scope),
  });
}

export { apply, inject, name, handleSessionEvent, watchForeignNotify };
