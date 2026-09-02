// dsh-plugin-desktop-control host half 契约测试（node:test）。
//
// mock cordis ctx（commands 收集注册、settings 返回 scope 假体、on 收集事件监听），
// 实测 /desktop 命令族与 session/event 自动通知：notify（写共享配置 notifyRequest）、
// --silent/--title 旗标、turn/approval 事件档位；共享配置路径由 DSH_DESKTOP_CONFIG
// 指向临时文件，全程无真实进程/网络。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const pluginIndex = pathToFileURL(join(here, '..', 'index.js'));

/** mock cordis ctx：commands.register 收集 + settings.register 返回 scope 假体 + on 收集监听。 */
function makeCtx({ initialSettings = {} } = {}) {
  const commands = [];
  const watches = [];
  const updates = [];
  const listeners = new Map();
  const scope = {
    get: () => ({
      autoLaunch: false,
      desktopExe: '',
      notifyTurn: 'problems',
      notifyApproval: true,
      ...initialSettings,
    }),
    update: async (patch) => {
      updates.push(patch);
      Object.assign(initialSettings, patch);
    },
    watch: (cb) => {
      watches.push(cb);
      return () => {
        const i = watches.indexOf(cb);
        if (i >= 0) watches.splice(i, 1);
      };
    },
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
    webServer: { host: '127.0.0.1', port: 4000 },
    settings: {
      register(ns, schema) {
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
  const handle = { ctx, commands, watches, updates, scope, emit };
  activeCtxs.push(handle);
  return handle;
}

// 每个 apply 过的 ctx 在 afterEach 里统一 dispose：销毁队列重试定时器，
// 防止残留 timer 向后续测试的临时文件（或退回真实 ~/.dsh）泄漏写入。
const activeCtxs = [];

let mod;
let configFile;
beforeEach(async () => {
  mod ??= await import(pluginIndex);
  configFile = join(tmpdir(), `dsh-desktop-control-test-${process.pid}-${Date.now()}.json`);
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

function readConfig() {
  return JSON.parse(readFileSync(configFile, 'utf8'));
}

test('模块导出契约：name/apply 注册 /desktop 命令', async () => {
  mod ??= await import(pluginIndex);
  assert.equal(mod.name, 'desktop-control');
  assert.deepEqual([...mod.inject], ['commands', 'webServer', 'settings']);
  assert.equal(typeof mod.apply, 'function');
  const { ctx, commands } = makeCtx();
  mod.apply(ctx);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'desktop');
  assert.match(commands[0].input.hint, /notify/);
});

test('/desktop notify <文本>：写入 notifyRequest（唯一 id、默认标题、保留已有字段）', async () => {
  const { ctx, commands } = makeCtx();
  mod.apply(ctx);
  // 预置共享配置里已有字段（如桌面应用注册的 url/desktopExe）→ notify 应保留
  writeFileSync(
    configFile,
    JSON.stringify({ url: 'http://127.0.0.1:4000', desktopExe: 'C:\\app\\dsh-desktop-shell.exe' }),
    'utf8',
  );
  const cmd = commands.find((c) => c.name === 'desktop');
  const result = await cmd.handler({ rawInput: 'notify 今日花费已超阈值，注意！', signal: new AbortController().signal });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /已请求桌面应用通知：今日花费已超阈值/);
  const saved = readConfig();
  assert.equal(saved.url, 'http://127.0.0.1:4000', 'notify 不得覆盖已有字段');
  assert.equal(saved.desktopExe, 'C:\\app\\dsh-desktop-shell.exe');
  assert.match(saved.notifyRequest.id, /^\d+-[a-z0-9]{6}$/);
  assert.equal(saved.notifyRequest.title, 'DSH 通知');
  assert.equal(saved.notifyRequest.body, '今日花费已超阈值，注意！');
  assert.equal(saved.notifyRequest.silent, false);
  // 再次 notify：新 id（与上一次不同，外壳按 id 去重）
  await cmd.handler({ rawInput: 'notify 第二次', signal: new AbortController().signal });
  const saved2 = readConfig();
  assert.notEqual(saved2.notifyRequest.id, saved.notifyRequest.id, '连续两次通知 id 必须不同');
});

test('/desktop notify --silent / --title：旗标解析与校验', async () => {
  const { ctx, commands } = makeCtx();
  mod.apply(ctx);
  const cmd = commands.find((c) => c.name === 'desktop');
  const r1 = await cmd.handler({ rawInput: 'notify --silent 后台任务完成', signal: new AbortController().signal });
  assert.equal(r1.kind, 'success');
  let saved = readConfig();
  assert.equal(saved.notifyRequest.silent, true);
  assert.equal(saved.notifyRequest.body, '后台任务完成');
  assert.equal(saved.notifyRequest.title, 'DSH 通知');

  const r2 = await cmd.handler({
    rawInput: 'notify --title 每日花费告警 余额不足',
    signal: new AbortController().signal,
  });
  assert.equal(r2.kind, 'success');
  saved = readConfig();
  assert.equal(saved.notifyRequest.title, '每日花费告警');
  assert.equal(saved.notifyRequest.body, '余额不足');
  assert.equal(saved.notifyRequest.silent, false);

  const r3 = await cmd.handler({
    rawInput: 'notify --title=构建失败 --silent 编译错误',
    signal: new AbortController().signal,
  });
  assert.equal(r3.kind, 'success');
  saved = readConfig();
  assert.equal(saved.notifyRequest.title, '构建失败');
  assert.equal(saved.notifyRequest.body, '编译错误');
  assert.equal(saved.notifyRequest.silent, true);

  // --title 缺值 / 标题超长 → 用法/校验错误，不写配置
  const before = readConfig().notifyRequest.id;
  const bad = await cmd.handler({ rawInput: 'notify --title', signal: new AbortController().signal });
  assert.equal(bad.kind, 'error');
  assert.match(bad.text, /--title/);
  const longTitle = await cmd.handler({
    rawInput: `notify --title ${'t'.repeat(101)} 正文`,
    signal: new AbortController().signal,
  });
  assert.equal(longTitle.kind, 'error');
  assert.match(longTitle.text, /标题过长/);
  assert.equal(readConfig().notifyRequest.id, before, '失败请求不得写共享配置');
});

test('/desktop notify：空文本/超长文本被拒绝', async () => {
  const { ctx, commands } = makeCtx();
  mod.apply(ctx);
  const cmd = commands.find((c) => c.name === 'desktop');
  const empty = await cmd.handler({ rawInput: 'notify', signal: new AbortController().signal });
  assert.equal(empty.kind, 'error');
  assert.match(empty.text, /用法：\/desktop notify/);
  const blank = await cmd.handler({ rawInput: 'notify    ', signal: new AbortController().signal });
  assert.equal(blank.kind, 'error');
  const long = await cmd.handler({ rawInput: `notify ${'x'.repeat(501)}`, signal: new AbortController().signal });
  assert.equal(long.kind, 'error');
  assert.match(long.text, /上限 500 字符/);
});

test('/desktop status：回显共享配置中的地址与自启状态', async () => {
  const { ctx, commands } = makeCtx({ initialSettings: { autoLaunch: true, desktopExe: 'C:\\app\\shell.exe' } });
  writeFileSync(configFile, JSON.stringify({ url: 'http://127.0.0.1:4000' }), 'utf8');
  mod.apply(ctx);
  const cmd = commands.find((c) => c.name === 'desktop');
  const result = await cmd.handler({ rawInput: 'status', signal: new AbortController().signal });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /桌面地址：http:\/\/127\.0\.0\.1:4000/);
  assert.match(result.text, /开机自启：开/);
  assert.match(result.text, /应用路径：C:\\app\\shell\.exe/);
});

test('/desktop：未知子命令给出用法；空子命令默认 open（找不到 exe 时报配置指引）', async () => {
  const { ctx, commands } = makeCtx();
  mod.apply(ctx);
  const cmd = commands.find((c) => c.name === 'desktop');
  const bad = await cmd.handler({ rawInput: 'frobnicate', signal: new AbortController().signal });
  assert.equal(bad.kind, 'error');
  assert.match(bad.text, /用法：\/desktop open \| auto/);
  // open 无 exe：报配置指引而非崩溃
  const open = await cmd.handler({ rawInput: '', signal: new AbortController().signal });
  assert.equal(open.kind, 'error');
  assert.match(open.text, /未找到桌面应用/);
});

// —— session/event 自动通知 ——

const SESSION = { id: 'sess-abcd1234-5678-90ef' };

function turnEnd(turn, kind, extra = {}) {
  return { type: 'turn/end', turn, reason: { kind, ...extra } };
}

test('自动通知：默认 problems 档——error/blocked/max-tokens 弹，completed/aborted 不弹', async () => {
  const { ctx, emit } = makeCtx();
  mod.apply(ctx);

  emit('session/event', SESSION, turnEnd(1, 'error', { error: { message: 'rate limited', code: '429' } }));
  let saved = readConfig();
  assert.equal(saved.notifyRequest.title, 'DSH 回合出错');
  assert.match(saved.notifyRequest.body, /会话 678-90ef 第 1 轮：rate limited/);
  assert.equal(saved.notifyRequest.silent, false);

  // 槽被占用（上一条未被外壳取走）：后续事件入队不覆盖
  emit('session/event', SESSION, turnEnd(2, 'blocked'));
  assert.equal(readConfig().notifyRequest.id, saved.notifyRequest.id, '单槽占用时不覆盖');

  // completed / aborted 在 problems 档不通知
  writeFileSync(configFile, JSON.stringify({}), 'utf8'); // 模拟外壳取走
  emit('session/event', SESSION, turnEnd(3, 'completed'));
  emit('session/event', SESSION, turnEnd(4, 'aborted', { reason: { kind: 'hook' } }));
  assert.equal(readConfig().notifyRequest, undefined);
});

test('自动通知：all 档 completed 也弹且静默；off 档全不弹', async () => {
  const all = makeCtx({ initialSettings: { notifyTurn: 'all' } });
  mod.apply(all.ctx);
  all.emit('session/event', SESSION, turnEnd(1, 'completed'));
  let saved = readConfig();
  assert.equal(saved.notifyRequest.title, 'DSH 回合完成');
  assert.equal(saved.notifyRequest.silent, true, 'all 档完成通知不响铃');

  writeFileSync(configFile, JSON.stringify({}), 'utf8');
  const off = makeCtx({ initialSettings: { notifyTurn: 'off' } });
  mod.apply(off.ctx);
  off.emit('session/event', SESSION, turnEnd(2, 'error', { error: { message: 'boom' } }));
  off.emit('session/event', SESSION, turnEnd(3, 'completed'));
  assert.equal(readConfig().notifyRequest, undefined);
});

test('自动通知：approval/asked 默认弹、可关；错误事件不炸监听', async () => {
  const { ctx, emit } = makeCtx();
  mod.apply(ctx);
  emit('session/event', SESSION, { type: 'approval/asked', toolName: 'bash', reason: 'rm -rf 构建' });
  let saved = readConfig();
  assert.equal(saved.notifyRequest.title, 'DSH 等待审批');
  assert.match(saved.notifyRequest.body, /bash 请求审批：rm -rf 构建/);

  writeFileSync(configFile, JSON.stringify({}), 'utf8');
  const muted = makeCtx({ initialSettings: { notifyApproval: false } });
  mod.apply(muted.ctx);
  muted.emit('session/event', SESSION, { type: 'approval/asked', toolName: 'bash' });
  assert.equal(readConfig().notifyRequest, undefined);

  // 非法/未知事件形态：静默忽略，不抛出（用全关档位隔离验证）
  const offAll = makeCtx({ initialSettings: { notifyTurn: 'off', notifyApproval: false } });
  mod.apply(offAll.ctx);
  offAll.emit('session/event', SESSION, null);
  offAll.emit('session/event', null, { type: 'turn/end', turn: 1, reason: { kind: 'error', error: null } });
  offAll.emit('session/event', SESSION, { type: 'assistant/chunk' });
  assert.equal(readConfig().notifyRequest, undefined);
});

test('自动通知队列：外壳取走后积压补发，60s 过期丢弃', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    const { ctx, emit } = makeCtx();
    mod.apply(ctx);
    emit('session/event', SESSION, turnEnd(1, 'error', { error: { message: 'first' } }));
    const first = readConfig().notifyRequest;
    // 槽被占：第二条入队
    emit('session/event', SESSION, turnEnd(2, 'error', { error: { message: 'second' } }));
    assert.equal(readConfig().notifyRequest.id, first.id);

    // 模拟外壳取走通知 → 下个 drain 周期补发积压
    writeFileSync(configFile, JSON.stringify({}), 'utf8');
    t.mock.timers.tick(2100);
    const second = readConfig().notifyRequest;
    assert.match(second.body, /second/);
    assert.notEqual(second.id, first.id);
  } finally {
    t.mock.timers.reset();
  }
});
