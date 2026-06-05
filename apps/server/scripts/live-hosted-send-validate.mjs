#!/usr/bin/env node

const baseUrl = process.env.ZCA_CLOUD_BASE_URL || "http://127.0.0.1:37880";
const accountId = process.env.ZCA_CLOUD_ACCOUNT_ID;
const deviceToken = process.env.ZCA_CLOUD_DEVICE_TOKEN;
const livePhone = process.env.ZCA_LIVE_PHONE;
const threadId = process.env.ZCA_LIVE_THREAD_ID;
const threadKind = process.env.ZCA_LIVE_THREAD_KIND || "user";
const text = process.env.ZCA_LIVE_TEXT || `zca hosted smoke ${Date.now()}`;

if (!accountId || !deviceToken || (!livePhone && !threadId)) {
  console.error("Set ZCA_CLOUD_ACCOUNT_ID, ZCA_CLOUD_DEVICE_TOKEN, and either ZCA_LIVE_PHONE or ZCA_LIVE_THREAD_ID.");
  process.exit(2);
}

if (!["user", "group"].includes(threadKind)) {
  console.error("ZCA_LIVE_THREAD_KIND must be user or group.");
  process.exit(2);
}

function auth() {
  return { authorization: `Bearer ${deviceToken}` };
}

async function json(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const bodyText = await res.text();
  let body = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = bodyText;
  }
  if (!res.ok) {
    throw new Error(`${options.method || "GET"} ${path} -> ${res.status} body_len=${bodyText.length}`);
  }
  return body;
}

async function waitForRealtime() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${baseUrl}/api/v1/realtime`, {
      headers: auth(),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`realtime stream failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.type === "message" && event.accountId === accountId) return event;
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return null;
}

async function main() {
  let resolvedThreadId = threadId;
  let resolvedPhone = null;
  if (!resolvedThreadId && livePhone) {
    resolvedPhone = await json(`/api/v1/accounts/${accountId}/resolve/phone`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ phone: livePhone }),
    });
    resolvedThreadId = resolvedPhone.uid;
  }

  const eventPromise = waitForRealtime().catch(() => null);
  const sendResult = await json(`/api/v1/accounts/${accountId}/send/text`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ threadId: resolvedThreadId, text, threadKind }),
  });
  const realtimeEvent = await eventPromise;

  console.log(JSON.stringify({
    ok: true,
    phoneSuffix: livePhone ? livePhone.slice(-4) : null,
    resolvedUidLen: resolvedThreadId.length,
    resolvedHasDisplayName: Boolean(resolvedPhone?.displayName),
    resolvedHasAvatar: Boolean(resolvedPhone?.avatar),
    sentText: Boolean(sendResult?.msgId),
    msgIdLen: sendResult?.msgId?.length || 0,
    realtimeEventSeen: Boolean(realtimeEvent),
    realtimeEvent: realtimeEvent ? {
      threadIdLen: realtimeEvent.threadId?.length || 0,
      msgIdLen: realtimeEvent.msgId?.length || 0,
      outgoing: Boolean(realtimeEvent.outgoing),
    } : null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
