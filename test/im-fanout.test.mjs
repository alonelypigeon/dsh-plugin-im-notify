// IM/webhook 扇出契约测试：
//   1. payload 构造形状（纯函数）；
//   2. 钉钉加签（向量由 openssl dgst -sha256 -hmac 独立算出，防循环验证）；
//   3. 各渠道真实 HTTP 投递（本地收端，无外网）+ 非 2xx 报错；
//   4. 重试队列语义：即刻首投、2s 重试、60s 过期丢弃、渠道间互不阻塞；
//   5. 经 index.js 的集成：自动/手动通知镜像到 IM，桌面通知不重复；
//   6. Telegram 代理：本地 CONNECT 代理 → 本地 http 收端全链路。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fanoutUrl = pathToFileURL(join(here, '..', 'lib', 'im-fanout.js'));
const pluginIndex = pathToFileURL(join(here, '..', 'index.js'));

let fanout;
let mod;
const applied = [];
beforeEach(async () => {
  fanout ??= await import(fanoutUrl);
  mod ??= await import(pluginIndex);
});
// apply 会启动 fs.watch / 定时器：统一 dispose，防止挂住测试进程
afterEach(() => {
  for (const h of applied.splice(0)) h.emit('dispose');
});

const N = { title: 'DSH 回合出错', body: '会话 abcd1234 第 3 轮：boom', silent: false, source: 'turn-end/error' };

// —— 1. payload 构造 ——

test('payload：五渠道形状', () => {
  assert.deepEqual(fanout.genericPayload(N), {
    source: 'turn-end/error',
    title: 'DSH 回合出错',
    body: '会话 abcd1234 第 3 轮：boom',
    silent: false,
  });
  assert.deepEqual(fanout.feishuPayload(N), {
    msg_type: 'text',
    content: { text: 'DSH 回合出错\n会话 abcd1234 第 3 轮：boom' },
  });
  assert.deepEqual(fanout.wecomPayload(N), {
    msgtype: 'text',
    text: { content: 'DSH 回合出错\n会话 abcd1234 第 3 轮：boom' },
  });
  assert.deepEqual(fanout.dingtalkPayload(N), {
    msgtype: 'text',
    text: { content: 'DSH 回合出错\n会话 abcd1234 第 3 轮：boom' },
  });
  assert.deepEqual(fanout.telegramPayload({ chatId: '42' }, { ...N, silent: true }), {
    chat_id: '42',
    text: 'DSH 回合出错\n会话 abcd1234 第 3 轮：boom',
    disable_notification: true,
  });
});

// —— 2. 钉钉加签 ——

test('钉钉加签：与 openssl 独立向量一致，签名进 URL query', () => {
  // printf '1700000000000\nsecret123' | openssl dgst -sha256 -hmac 'secret123' -binary | base64
  assert.equal(fanout.dingtalkSign('secret123', 1700000000000), 'dmKht5wnRNI8D3ORFxZjr58I3IDg5FOcP5dFPicdUYg%3D');
  const url = fanout.dingtalkSignedUrl('https://oapi.dingtalk.com/robot/send?access_token=abc', 'secret123', 1700000000000);
  const u = new URL(url);
  assert.equal(u.searchParams.get('timestamp'), '1700000000000');
  // URLSearchParams.get 解码一次 → 还原出原始 base64（即最终 URL 只编码一次，符合官方算法）
  assert.equal(u.searchParams.get('sign'), 'dmKht5wnRNI8D3ORFxZjr58I3IDg5FOcP5dFPicdUYg=');
  assert.equal(u.searchParams.get('access_token'), 'abc');
});

// —— 3. 真实 HTTP 投递（本地收端） ——

/** 本地 HTTP 收端：记录每次请求并回 200。 */
function startReceiver() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/webhook`;
      resolve({
        server,
        hits,
        url,
        close: () => new Promise((r) => {
          server.close(r);
          server.closeAllConnections?.(); // keep-alive 连接会挂住 close，直接掐断
        }),
      });
    });
  });
}

test('sendToChannel：五渠道真实投递形状与 URL', async () => {
  const rx = await startReceiver();
  try {
    await fanout.sendToChannel({ key: 'generic', url: rx.url }, N);
    await fanout.sendToChannel({ key: 'feishu', url: rx.url }, N);
    await fanout.sendToChannel({ key: 'wecom', url: rx.url }, N);
    await fanout.sendToChannel({ key: 'dingtalk', url: rx.url, secret: 's3cret' }, N);
    await fanout.sendToChannel({ key: 'telegram', url: rx.url, chatId: '42' }, N);
    assert.equal(rx.hits.length, 5);
    const [generic, feishu, wecom, dingtalk, telegram] = rx.hits;
    assert.deepEqual(JSON.parse(generic.body).source, 'turn-end/error');
    assert.equal(generic.headers['content-type'], 'application/json');
    assert.equal(JSON.parse(feishu.body).msg_type, 'text');
    assert.equal(JSON.parse(wecom.body).msgtype, 'text');
    const dq = new URL(dingtalk.url, 'http://x').searchParams;
    assert.ok(dq.get('timestamp'), '钉钉加签请求带 timestamp');
    assert.ok(dq.get('sign'), '钉钉加签请求带 sign');
    assert.equal(JSON.parse(telegram.body).chat_id, '42');
    // 未知渠道快速失败
    await assert.rejects(() => fanout.sendToChannel({ key: 'nope', url: rx.url }, N), /未知 IM 渠道/);
  } finally {
    await rx.close();
  }
});

test('sendToChannel：非 2xx 抛错', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(400);
    res.end('bad');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/hook`;
    await assert.rejects(() => fanout.sendToChannel({ key: 'feishu', url }, N), /\[feishu\] HTTP 400/);
  } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
  }
});

// —— 4. 重试队列 ——

// mock timers 只推进时钟；send 的失败/成功落在 microtask 里，用 setImmediate 冲刷
const flush = () => new Promise((r) => setImmediate(r));

test('makeImQueue：即刻首投成功即清队；失败 2s 重试成功', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const seen = [];
  const queue = fanout.makeImQueue({
    send: async (e) => {
      calls += 1;
      seen.push(e.notification.body);
      if (calls === 1) throw new Error('first fails');
    },
  });
  queue.push({ key: 'feishu', url: 'https://feishu.example/hook' }, { title: 't', body: 'b' });
  await flush();
  assert.deepEqual(seen, ['b']);
  assert.equal(calls, 1, '首轮失败后等待重试');
  await t.mock.timers.tick(2100);
  await flush();
  assert.equal(calls, 2, '2s 后重试成功');
  await t.mock.timers.tick(10000);
  await flush();
  assert.equal(calls, 2, '成功后不再重试（队列已清空）');
});

test('makeImQueue：60s 未送达丢弃并回调 onDrop', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const dropped = [];
  const queue = fanout.makeImQueue({
    send: async () => {
      throw new Error('always fails');
    },
    onDrop: (e) => dropped.push(e.channel.key),
  });
  queue.push({ key: 'telegram', url: 'https://tg.example/send' }, { title: 't', body: 'b' });
  await flush();
  await t.mock.timers.tick(59_000);
  await flush();
  assert.deepEqual(dropped, [], '60s 内不丢弃');
  await t.mock.timers.tick(2000);
  await flush();
  assert.deepEqual(dropped, ['telegram'], '超龄条目被丢弃');
  queue.dispose();
});

test('makeImQueue：单渠道失败不阻塞其它渠道', async () => {
  const ok = [];
  const queue = fanout.makeImQueue({
    send: async (e) => {
      if (e.channel.key === 'bad') throw new Error('down');
      ok.push(e.channel.key);
    },
  });
  queue.push({ key: 'bad', url: 'https://bad.example' }, { title: 't', body: 'b' });
  queue.push({ key: 'feishu', url: 'https://feishu.example' }, { title: 't', body: 'b' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(ok, ['feishu'], '健康渠道首轮即达');
  queue.dispose();
});

// —— 5. 经 index.js 集成 ——

/** 精简 cordis ctx 桩：与 desktop-control.test.mjs 的 makeCtx 同构（IM 字段进 settings）。 */
function makeCtx(initial = {}) {
  const commands = [];
  const listeners = new Map();
  const settings = {
    autoLaunch: false,
    desktopExe: '',
    notifyTurn: 'problems',
    notifyApproval: true,
    imGenericEnabled: false,
    imGenericUrl: '',
    imFeishuEnabled: false,
    imFeishuUrl: '',
    imWecomEnabled: false,
    imWecomUrl: '',
    imDingtalkEnabled: false,
    imDingtalkUrl: '',
    imDingtalkSecret: '',
    imTelegramEnabled: false,
    imTelegramBotToken: '',
    imTelegramChatId: '',
    ...initial,
  };
  const scope = {
    get: () => settings,
    update: async (patch) => void Object.assign(settings, patch),
    watch: () => () => {},
  };
  const ctx = {
    commands: { register: (def) => commands.push(def) },
    webServer: { host: '127.0.0.1', port: 4000 },
    settings: { register: () => scope },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
  };
  const emit = (event, ...args) => (listeners.get(event) ?? []).forEach((cb) => cb(...args));
  return { ctx, commands, scope, emit };
}

test('集成：自动通知镜像到 IM（source 标记）且桌面照常', async () => {
  const rx = await startReceiver();
  const configFile = join(tmpdir(), `dsh-im-fanout-test-${process.pid}-${Date.now()}.json`);
  process.env.DSH_DESKTOP_CONFIG = configFile;
  try {
    const h = makeCtx({ imGenericEnabled: true, imGenericUrl: rx.url });
    const { ctx, emit } = h;
    applied.push(h);
    mod.apply(ctx);
    emit('session/event', { id: 'sess-abcd1234-5678' }, {
      type: 'turn/end',
      seq: 1,
      time: Date.now(),
      data: { turn: 3, reason: { kind: 'error', error: { message: 'boom' } } },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(rx.hits.length, 1, 'IM 收到一条');
    const payload = JSON.parse(rx.hits[0].body);
    assert.equal(payload.source, 'turn-end/error');
    assert.match(payload.body, /boom/);
    const saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(saved.notifyRequest.title, 'DSH 回合出错', '桌面通道照常工作');
  } finally {
    delete process.env.DSH_DESKTOP_CONFIG;
    rmSync(configFile, { force: true });
    await rx.close();
  }
});

test('集成：手动 /desktop notify 镜像 IM 且桌面不重复', async () => {
  const rx = await startReceiver();
  const configFile = join(tmpdir(), `dsh-im-fanout-test-${process.pid}-${Date.now()}.json`);
  process.env.DSH_DESKTOP_CONFIG = configFile;
  try {
    const h = makeCtx({ imGenericEnabled: true, imGenericUrl: rx.url });
    const { ctx, commands } = h;
    applied.push(h);
    mod.apply(ctx);
    const handler = commands[0].handler;
    const result = handler({ rawInput: 'notify --title 构建完成 --silent 全部通过' });
    assert.match(result.text, /已请求桌面应用通知/);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(rx.hits.length, 1, 'IM 恰好一条');
    assert.equal(JSON.parse(rx.hits[0].body).source, 'manual');
    const saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(saved.notifyRequest.title, '构建完成');
    assert.equal(saved.notifyRequest.silent, true);
    assert.ok(!saved.notifyRequest.source, '桌面 notifyRequest 不携带 IM 扩展字段');
  } finally {
    delete process.env.DSH_DESKTOP_CONFIG;
    rmSync(configFile, { force: true });
    await rx.close();
  }
});

test('集成：无渠道启用时不发 IM，桌面通知不受影响', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    hits += 1;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const configFile = join(tmpdir(), `dsh-im-fanout-test-${process.pid}-${Date.now()}.json`);
  process.env.DSH_DESKTOP_CONFIG = configFile;
  try {
    const h = makeCtx(); // 全部 IM 关
    const { ctx, commands, emit } = h;
    applied.push(h);
    mod.apply(ctx);
    commands[0].handler({ rawInput: 'notify hello' });
    emit('session/event', { id: 'sess-abcd1234-5678' }, {
      type: 'turn/end',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'error', error: { message: 'x' } } },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(hits, 0, 'IM 收端零请求');
    const saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.ok(saved.notifyRequest, '桌面通道照常');
  } finally {
    delete process.env.DSH_DESKTOP_CONFIG;
    rmSync(configFile, { force: true });
    await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
  }
});

test('共享配置监听：外来 notifyRequest（balance-panel 告警）扇出到 IM', async () => {
  const rx = await startReceiver();
  const configFile = join(tmpdir(), `dsh-im-fanout-test-${process.pid}-${Date.now()}.json`);
  process.env.DSH_DESKTOP_CONFIG = configFile;
  try {
    const h = makeCtx({ imGenericEnabled: true, imGenericUrl: rx.url });
    const { ctx } = h;
    applied.push(h);
    mod.apply(ctx);
    // 模拟 balance-panel 的告警写入：直接写共享配置（无 src 标记 = 外来）
    writeFileSync(configFile, JSON.stringify({
      notifyRequest: { id: '123-abc456', title: '每日花费告警', body: 'DeepSeek 今日已花 ¥10（阈值 5）', silent: false, source: 'spend-alert' },
    }), 'utf8');
    await new Promise((r) => setTimeout(r, 200)); // fs.watch + 50ms 去抖
    assert.equal(rx.hits.length, 1, '外来通知被扇出到 IM');
    const payload = JSON.parse(rx.hits[0].body);
    assert.equal(payload.source, 'spend-alert', '透传外来通知的 source 标记');
    assert.match(payload.body, /阈值 5/);

    // 同 id 不重复扇出（如配置其它字段变化再次触发 watch）
    const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
    cfg.desktopExe = 'X:\\shell.exe';
    writeFileSync(configFile, JSON.stringify(cfg), 'utf8');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(rx.hits.length, 1, '同一通知不重复扇出');
  } finally {
    delete process.env.DSH_DESKTOP_CONFIG;
    rmSync(configFile, { force: true });
    await rx.close();
  }
});

test('共享配置监听：自有写入（src 标记）不重复扇出', async () => {
  const rx = await startReceiver();
  const configFile = join(tmpdir(), `dsh-im-fanout-test-${process.pid}-${Date.now()}.json`);
  process.env.DSH_DESKTOP_CONFIG = configFile;
  try {
    const h = makeCtx({ imGenericEnabled: true, imGenericUrl: rx.url });
    const { ctx, commands } = h;
    applied.push(h);
    mod.apply(ctx);
    commands[0].handler({ rawInput: 'notify hello' });
    await new Promise((r) => setTimeout(r, 200)); // 等监听器扫到自己写入的 notifyRequest
    assert.equal(rx.hits.length, 1, '仅内联扇出一次');
    assert.equal(JSON.parse(rx.hits[0].body).source, 'manual', '扇出来源为 manual（监听侧未重复）');
  } finally {
    delete process.env.DSH_DESKTOP_CONFIG;
    rmSync(configFile, { force: true });
    await rx.close();
  }
});

// —— 6. Telegram 代理（CONNECT 隧道 → 本地 http 收端全链路） ——

test('postJson：经 HTTP CONNECT 代理送达', async () => {
  const rx = await startReceiver();
  let tunneled = 0;
  const tunneledSockets = new Set();
  const proxy = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end(); // 普通请求不该进来：只接受 CONNECT
  });
  proxy.on('connect', (req, clientSocket, head) => {
    tunneled += 1;
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port || 80), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    tunneledSockets.add(clientSocket);
    tunneledSockets.add(upstream);
    upstream.on('error', () => clientSocket.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    const res = await fanout.postJson(
      rx.url,
      { chat_id: '42', text: 'via proxy' },
      { proxy: proxyUrl },
    );
    assert.equal(res.ok, true);
    assert.equal(tunneled, 1, '请求确实经过了 CONNECT 隧道');
    assert.equal(rx.hits.length, 1);
    assert.deepEqual(JSON.parse(rx.hits[0].body), { chat_id: '42', text: 'via proxy' });
  } finally {
    await new Promise((r) => {
      proxy.close(r);
      proxy.closeAllConnections?.();
      // 劫持后的 CONNECT socket 不再走 HTTP 解析，close 只能等 60s headers 超时——直接掐断
      for (const s of tunneledSockets) s.destroy();
    });
    await rx.close();
  }
});

test('postJson：代理拒绝 CONNECT 时报错', async () => {
  const proxy = http.createServer((_req, res) => {
    res.writeHead(403);
    res.end();
  });
  proxy.on('connect', (req, clientSocket) => {
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    clientSocket.destroy();
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    await assert.rejects(
      () => fanout.postJson('http://127.0.0.1:9/hook', { a: 1 }, { proxy: proxyUrl, timeoutMs: 2000 }),
      /CONNECT 失败/,
    );
  } finally {
    await new Promise((r) => { proxy.close(r); proxy.closeAllConnections?.(); });
  }
});
