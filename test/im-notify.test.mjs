// dsh-plugin-im-notify 契约测试（node:test）。
//
// mock cordis ctx（commands 收集注册、settings 返回 scope 假体、on 收集事件监听），
// 实测：模块导出契约与 /im status；handleSessionEvent 档位（turn 结束 off/
// problems/all、approval 开关、非法事件不炸）；watchForeignNotify 外来通知转发
// （balance-panel 式 spend-alert、src 标记跳过、同 id 去重）。共享配置路径由
// DSH_DESKTOP_CONFIG 指向临时文件，全程无真实网络。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const pluginIndex = pathToFileURL(join(here, '..', 'index.js'));

/** mock cordis ctx：commands.register 收集 + settings.register 返回 scope 假体 + on 收集监听。 */
function makeCtx({ initialSettings = {} } = {}) {
  const commands = [];
  const listeners = new Map();
  const scope = {
    get: () => ({
      notifyTurn: 'problems',
      notifyApproval: true,
      ...initialSettings,
    }),
  };
  const ctx = {
    commands: {
      register(def) {
        commands.push(def);
        return () => {
          const i = commands.indexOf(def);
          if (i >= 0) commands.splice(i, 1);
        };
      },
    },
    settings: {
      register() {
        return scope;
      },
    },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return () => {
        const arr = listeners.get(event) ?? [];
        const i = arr.indexOf(cb);
        if (i >= 0) arr.splice(i, 1);
      };
    },
  };
  const emit = (event, ...args) => (listeners.get(event) ?? []).forEach((cb) => cb(...args));
  const handle = { ctx, commands, scope, emit };
  activeCtxs.push(handle);
  return handle;
}

// 每个 apply 过的 ctx 在 afterEach 里统一 dispose：销毁监听与文件 watch。
const activeCtxs = [];

let mod;
let configFile;
beforeEach(async () => {
  mod ??= await import(pluginIndex);
  configFile = join(tmpdir(), `dsh-im-notify-test-${process.pid}-${Date.now()}.json`);
  process.env.DSH_DESKTOP_CONFIG = configFile;
});
afterEach(() => {
  for (const h of activeCtxs.splice(0)) h.emit('dispose');
  delete process.env.DSH_DESKTOP_CONFIG;
  try {
    rmSync(configFile, { force: true });
  } catch {
    /* ignore */
  }
});

/** 轮询等待条件成立（watcher 50ms 去抖 + fs.watch 事件延迟），超时抛错。 */
async function waitFor(predicate, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(predicate(), 'waitFor 超时');
}

test('模块导出契约：name/inject/apply，注册 /im 命令', async () => {
  mod ??= await import(pluginIndex);
  assert.equal(mod.name, 'im-notify');
  assert.deepEqual([...mod.inject], ['commands', 'settings']);
  assert.equal(typeof mod.apply, 'function');
  const { ctx, commands } = makeCtx();
  mod.apply(ctx);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'im');
  assert.equal(commands[0].input.hint, 'status');
});

test('/im status：回显档位与渠道启用数', async () => {
  const { ctx, commands } = makeCtx({
    initialSettings: {
      notifyTurn: 'all',
      notifyApproval: false,
      imGenericEnabled: true,
      imGenericUrl: 'https://example.com/hook',
      imTelegramEnabled: true,
      imTelegramBotToken: '123:abc',
      imTelegramChatId: '42',
    },
  });
  mod.apply(ctx);
  const cmd = commands.find((c) => c.name === 'im');
  const result = await cmd.handler({ rawInput: 'status', signal: new AbortController().signal });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /turn 通知档位：all/);
  assert.match(result.text, /审批等待通知：关/);
  assert.match(result.text, /IM 扇出：2\/5 渠道启用/);
});

// —— handleSessionEvent 档位（导出的纯逻辑，直接断言 notify 调用） ——

const SESSION = { id: 'sess-abcd1234-5678-90ef' };

// 真实运行时的事件信封：{ type, seq, time, data }，payload 在 data 里
// （dsh-session append() 构造，见 SessionEventMap：turn/end → { turn, reason }）。
function turnEnd(turn, kind, extra = {}) {
  return { type: 'turn/end', seq: 0, time: Date.now(), data: { turn, reason: { kind, ...extra } } };
}

function record() {
  const calls = [];
  return { calls, notify: (n) => calls.push(n) };
}

test('自动通知：默认 problems 档——error/blocked/max-tokens 推送，completed/aborted 不推送', () => {
  const { scope } = makeCtx();
  const r = record();
  mod.handleSessionEvent(scope, r.notify, SESSION, turnEnd(1, 'error', { error: { message: 'rate limited' } }));
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].title, 'DSH 回合出错');
  assert.match(r.calls[0].body, /会话 678-90ef 第 1 轮：rate limited/);
  assert.equal(r.calls[0].silent, false);
  assert.equal(r.calls[0].source, 'turn-end/error');

  mod.handleSessionEvent(scope, r.notify, SESSION, turnEnd(2, 'completed'));
  mod.handleSessionEvent(scope, r.notify, SESSION, turnEnd(3, 'aborted', { reason: { kind: 'hook' } }));
  assert.equal(r.calls.length, 1, 'problems 档 completed/aborted 不通知');
});

test('自动通知：all 档 completed 也推送且静默；off 档全不推送', () => {
  const all = makeCtx({ initialSettings: { notifyTurn: 'all' } });
  const ra = record();
  mod.handleSessionEvent(all.scope, ra.notify, SESSION, turnEnd(1, 'completed'));
  assert.equal(ra.calls.length, 1);
  assert.equal(ra.calls[0].title, 'DSH 回合完成');
  assert.equal(ra.calls[0].silent, true, 'all 档完成通知不响铃');

  const off = makeCtx({ initialSettings: { notifyTurn: 'off' } });
  const ro = record();
  mod.handleSessionEvent(off.scope, ro.notify, SESSION, turnEnd(2, 'error', { error: { message: 'boom' } }));
  mod.handleSessionEvent(off.scope, ro.notify, SESSION, turnEnd(3, 'completed'));
  assert.equal(ro.calls.length, 0);
});

test('自动通知：approval/asked 默认推送、可关；非法/未知事件不炸监听', () => {
  const { scope } = makeCtx();
  const r = record();
  mod.handleSessionEvent(scope, r.notify, SESSION, {
    type: 'approval/asked',
    seq: 1,
    time: Date.now(),
    data: { id: 'apr-1', toolName: 'bash', reason: 'rm -rf 构建' },
  });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].title, 'DSH 等待审批');
  assert.match(r.calls[0].body, /bash 请求审批：rm -rf 构建/);
  assert.equal(r.calls[0].source, 'approval');

  const muted = makeCtx({ initialSettings: { notifyApproval: false } });
  const rm = record();
  mod.handleSessionEvent(muted.scope, rm.notify, SESSION, {
    type: 'approval/asked',
    seq: 2,
    time: Date.now(),
    data: { id: 'apr-2', toolName: 'bash' },
  });
  assert.equal(rm.calls.length, 0);

  // 非法/未知事件形态：静默忽略，不抛出
  const offAll = makeCtx({ initialSettings: { notifyTurn: 'off', notifyApproval: false } });
  const ro = record();
  mod.handleSessionEvent(offAll.scope, ro.notify, SESSION, null);
  mod.handleSessionEvent(offAll.scope, ro.notify, null, { type: 'turn/end', seq: 3, time: Date.now(), data: { turn: 1, reason: { kind: 'error', error: null } } });
  mod.handleSessionEvent(offAll.scope, ro.notify, SESSION, { type: 'assistant/chunk', seq: 4, time: Date.now(), data: {} });
  assert.equal(ro.calls.length, 0);
});

// —— watchForeignNotify 外来通知转发（真实临时文件 + fs.watch） ——

test('外来通知转发：balance-panel 式写入被镜像扇出；src 标记跳过；同 id 去重', async () => {
  const r = record();
  const stop = mod.watchForeignNotify(r.notify);
  try {
    // 外来告警（balance-panel：无 src，带 source 标记）→ 转发并保留 source
    writeFileSync(
      configFile,
      JSON.stringify({ notifyRequest: { id: 'n-1', title: '每日花费告警', body: '今日已花费 ¥12.34', silent: false, source: 'spend-alert' } }),
      'utf8',
    );
    await waitFor(() => r.calls.length === 1);
    assert.equal(r.calls[0].source, 'spend-alert');
    assert.equal(r.calls[0].title, '每日花费告警');
    assert.equal(r.calls[0].body, '今日已花费 ¥12.34');

    // 同 id 再写（其它字段变化）：不重复扇出
    writeFileSync(configFile, JSON.stringify({ notifyRequest: { id: 'n-1', title: '每日花费告警', body: '重复' } }), 'utf8');
    await new Promise((res) => setTimeout(res, 250));
    assert.equal(r.calls.length, 1, '同 id 不重复扇出');

    // 自有/前身插件的历史写入（带 src 标记）：跳过
    writeFileSync(configFile, JSON.stringify({ notifyRequest: { id: 'n-2', title: 't', body: 'b', src: 'desktop-control' } }), 'utf8');
    writeFileSync(configFile, JSON.stringify({ notifyRequest: { id: 'n-3', title: 't', body: 'b', src: 'im-notify' } }), 'utf8');
    await new Promise((res) => setTimeout(res, 250));
    assert.equal(r.calls.length, 1, 'src 标记的写入不扇出');

    // 新的外来 id：正常转发，无 source 时标记 forwarded
    writeFileSync(configFile, JSON.stringify({ notifyRequest: { id: 'n-4', title: '外部通知', body: 'hello' } }), 'utf8');
    await waitFor(() => r.calls.length === 2);
    assert.equal(r.calls[1].source, 'forwarded');
  } finally {
    stop();
  }
});

test('watchForeignNotify：stop 后不再监听（无句柄/定时器泄漏路径）', async () => {
  const r = record();
  const stop = mod.watchForeignNotify(r.notify);
  writeFileSync(configFile, JSON.stringify({ notifyRequest: { id: 's-1', title: 't', body: 'b' } }), 'utf8');
  await waitFor(() => r.calls.length === 1);
  stop();
  writeFileSync(configFile, JSON.stringify({ notifyRequest: { id: 's-2', title: 't', body: 'b' } }), 'utf8');
  await new Promise((res) => setTimeout(res, 250));
  assert.equal(r.calls.length, 1, 'stop 后新通知不再扇出');
});
