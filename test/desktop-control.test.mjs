// dsh-plugin-desktop-control host half 契约测试（node:test）。
//
// mock cordis ctx（commands 收集注册、settings 返回 scope 假体），实测
// /desktop 命令族：notify（写共享配置 notifyRequest）、status、非法输入；
// 共享配置路径由 DSH_DESKTOP_CONFIG 指向临时文件，全程无真实进程/网络。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const pluginIndex = pathToFileURL(join(here, '..', 'index.js'));

/** mock cordis ctx：commands.register 收集 + settings.register 返回 scope 假体。 */
function makeCtx({ initialSettings = {} } = {}) {
  const commands = [];
  const watches = [];
  const updates = [];
  const scope = {
    get: () => ({ autoLaunch: false, desktopExe: '', ...initialSettings }),
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
  };
  return { ctx, commands, watches, updates, scope };
}

let mod;
let configFile;
beforeEach(async () => {
  mod ??= await import(pluginIndex);
  configFile = join(tmpdir(), `dsh-desktop-control-test-${process.pid}-${Date.now()}.json`);
  process.env.DSH_DESKTOP_CONFIG = configFile;
});
afterEach(() => {
  delete process.env.DSH_DESKTOP_CONFIG;
  try {
    rmSync(configFile, { force: true });
  } catch {
    /* ignore */
  }
});

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
  const saved = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(saved.url, 'http://127.0.0.1:4000', 'notify 不得覆盖已有字段');
  assert.equal(saved.desktopExe, 'C:\\app\\dsh-desktop-shell.exe');
  assert.match(saved.notifyRequest.id, /^\d+-[a-z0-9]{6}$/);
  assert.equal(saved.notifyRequest.title, 'DSH 通知');
  assert.equal(saved.notifyRequest.body, '今日花费已超阈值，注意！');
  assert.equal(saved.notifyRequest.silent, false);
  // 再次 notify：新 id（与上一次不同，外壳按 id 去重）
  await cmd.handler({ rawInput: 'notify 第二次', signal: new AbortController().signal });
  const saved2 = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.notEqual(saved2.notifyRequest.id, saved.notifyRequest.id, '连续两次通知 id 必须不同');
});

test('/desktop notify：空文本/超长文本被拒绝', async () => {
  const { ctx, commands } = makeCtx();
  mod.apply(ctx);
  const cmd = commands.find((c) => c.name === 'desktop');
  const empty = await cmd.handler({ rawInput: 'notify', signal: new AbortController().signal });
  assert.equal(empty.kind, 'error');
  assert.match(empty.text, /用法：\/desktop notify <通知文本>/);
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
