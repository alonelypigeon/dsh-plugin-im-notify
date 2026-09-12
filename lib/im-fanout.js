// IM/Webhook 扇出（0.5.0+）：把桌面通知镜像推送到 IM 渠道。
//
// 通用自定义 webhook 是基座（POST 通知 JSON），飞书 / 企业微信 / 钉钉 / Telegram
// 是其上的格式适配器（群机器人 webhook / bot API，均为一次 POST）。
// 成功判定 = HTTP 2xx：不做渠道业务码解析（各家机器人 webhook 的业务码互不
// 相同，配置错误看非 2xx / console 告警即可定位）。
// 失败语义与桌面单槽队列一致：每 2s 重试一轮，积压超过 60s 丢弃（onDrop 告警）。
// 代理：仅 Telegram 走标准 HTTPS(S)_PROXY 环境变量（api.telegram.org 国内不可
// 直连；飞书/企微/钉钉为国内服务，直连不受代理波动影响）。
import { createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export const IM_CHANNELS = ['generic', 'feishu', 'wecom', 'dingtalk', 'telegram'];

export function imText(title, body) {
  return `${title}\n${body}`;
}

// —— payload 构造（纯函数，契约测试直接断言形状）——

/** 通用 webhook：POST 通知本体，消费方自行解析。 */
export function genericPayload(n) {
  return { source: n.source, title: n.title, body: n.body, silent: !!n.silent };
}

export function feishuPayload(n) {
  return { msg_type: 'text', content: { text: imText(n.title, n.body) } };
}

export function wecomPayload(n) {
  return { msgtype: 'text', text: { content: imText(n.title, n.body) } };
}

export function dingtalkPayload(n) {
  return { msgtype: 'text', text: { content: imText(n.title, n.body) } };
}

export function telegramPayload(cfg, n) {
  return { chat_id: cfg.chatId, text: imText(n.title, n.body), disable_notification: !!n.silent };
}

/** 钉钉加签（安全设置选「加签」时）：sign = urlencode(base64(hmacSha256(secret, `${ts}\n${secret}`)))。 */
export function dingtalkSign(secret, timestamp) {
  return encodeURIComponent(
    createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64'),
  );
}

/** 钉钉加签 URL：sign 已按官方算法 encodeURIComponent，这里必须字符串拼接——
 *  走 URLSearchParams.set 会被二次编码（%3D → %253D）导致服务端验签失败。 */
export function dingtalkSignedUrl(url, secret, timestamp = Date.now()) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}timestamp=${timestamp}&sign=${dingtalkSign(secret, timestamp)}`;
}

// —— 发送 ——

export function proxyFromEnv(env = process.env) {
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || null;
}

/** 经 HTTP 代理建 CONNECT 隧道；https 目标在隧道上再包一层 TLS。返回净 socket。 */
function establishTunnel(target, proxyUrl, timeoutMs) {
  const proxy = new URL(proxyUrl);
  const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
  const authority = `${target.hostname}:${targetPort}`;
  return new Promise((resolve, reject) => {
    const socket = netConnect(proxyPort, proxy.hostname);
    socket.setTimeout(timeoutMs);
    const onTimeout = () => fail(new Error('IM 代理连接超时'));
    const fail = (e) => {
      socket.destroy();
      reject(e);
    };
    socket.once('timeout', onTimeout);
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let head = '';
    const onData = (chunk) => {
      head += chunk.toString('latin1');
      const sep = head.indexOf('\r\n\r\n');
      if (sep < 0) return;
      cleanup();
      socket.setTimeout(0);
      const statusLine = head.slice(0, head.indexOf('\r\n'));
      if (!/^HTTP\/1\.[01] 200\b/.test(statusLine)) {
        socket.destroy();
        reject(new Error(`IM 代理 CONNECT 失败：${statusLine}`));
        return;
      }
      // 正经代理对 CONNECT 2xx 不带报文体；带了说明代理行为异常，快速失败
      if (head.length > sep + 4) {
        socket.destroy();
        reject(new Error('IM 代理 CONNECT 响应携带异常数据'));
        return;
      }
      if (target.protocol === 'https:') {
        resolve(tlsConnect(socket, { servername: target.hostname }));
      } else {
        resolve(socket);
      }
    };
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('timeout', onTimeout);
      socket.removeListener('error', fail);
    };
    socket.on('data', onData);
  });
}

/** POST JSON：直连走 fetch；给了 proxy 走 CONNECT 隧道（node:https/http）。
 *  统一返回 { ok, status, body }；网络层失败抛出。 */
export async function postJson(url, payloadObj, { fetchImpl = fetch, proxy, timeoutMs = 10_000 } = {}) {
  const payload = JSON.stringify(payloadObj);
  if (!proxy) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status, body: await res.text().catch(() => '') };
  }
  const target = new URL(url);
  const socket = await establishTunnel(target, proxy, timeoutMs);
  const lib = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      target,
      {
        method: 'POST',
        agent: false,
        createConnection: () => socket,
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('IM 代理请求超时')));
    req.on('error', reject);
    req.end(payload);
  });
}

/** 单渠道单次投递：构造 payload（钉钉按需加签）并发送；非 2xx 抛错。 */
export async function sendToChannel(channel, n, deps = {}) {
  let url = channel.url;
  let payload;
  switch (channel.key) {
    case 'generic':
      payload = genericPayload(n);
      break;
    case 'feishu':
      payload = feishuPayload(n);
      break;
    case 'wecom':
      payload = wecomPayload(n);
      break;
    case 'dingtalk':
      payload = dingtalkPayload(n);
      if (channel.secret) url = dingtalkSignedUrl(url, channel.secret);
      break;
    case 'telegram':
      payload = telegramPayload(channel, n);
      break;
    default:
      throw new Error(`未知 IM 渠道：${channel.key}`);
  }
  const res = await postJson(url, payload, {
    fetchImpl: deps.fetchImpl,
    proxy: channel.key === 'telegram' ? deps.proxy : undefined,
    timeoutMs: deps.timeoutMs,
  });
  if (!res.ok) throw new Error(`[${channel.key}] HTTP ${res.status}`);
}

/**
 * IM 重试队列：与桌面单槽队列同语义（2s 一轮、60s 过期丢弃），但按
 * 「渠道 × 通知」逐条独立投递——单渠道故障不阻塞其它渠道，也无关桌面槽位。
 * push 即刻尝试首轮，失败的条目留在队列里等下一轮。
 */
export function makeImQueue({ send, retryMs = 2000, ttlMs = 60000, onDrop } = {}) {
  const pending = [];
  let timer = null;
  function remove(entry) {
    const i = pending.indexOf(entry);
    if (i >= 0) pending.splice(i, 1);
  }
  function sweep() {
    const now = Date.now();
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const e = pending[i];
      if (!e.inFlight && now - e.queuedAt > ttlMs) {
        pending.splice(i, 1);
        if (onDrop) onDrop(e);
      }
    }
    for (const e of [...pending]) {
      if (e.inFlight) continue;
      e.inFlight = true;
      Promise.resolve()
        .then(() => send(e))
        .then(
          () => remove(e),
          () => {
            e.inFlight = false;
          },
        );
    }
    if (pending.length === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  function arm() {
    if (timer) return;
    timer = setInterval(sweep, retryMs);
    timer.unref?.();
  }
  return {
    push(channel, notification) {
      pending.push({ channel, notification, queuedAt: Date.now(), inFlight: false });
      arm();
      sweep();
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
