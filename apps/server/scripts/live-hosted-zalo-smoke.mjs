#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { writeFileSync } from "node:fs";

const baseUrl = process.env.ZCA_CLOUD_BASE_URL || "http://127.0.0.1:37880";
const email = process.env.ZCA_CLOUD_TEST_EMAIL || `live-${Date.now()}@example.com`;
const deviceName = process.env.ZCA_CLOUD_DEVICE_NAME || "live-hosted-smoke";
const threadId = process.env.ZCA_LIVE_THREAD_ID;
const livePhone = process.env.ZCA_LIVE_PHONE;
const threadKind = process.env.ZCA_LIVE_THREAD_KIND || "user";
const text = process.env.ZCA_LIVE_TEXT || `zca hosted smoke ${new Date().toISOString()}`;
const qrOut = process.env.ZCA_QR_OUT || "/tmp/zca-hosted-qr.txt";

if (!["user", "group"].includes(threadKind)) {
  console.error("ZCA_LIVE_THREAD_KIND must be user or group");
  process.exit(2);
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

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

async function verifyDevice() {
  const magic = await json("/api/v1/auth/magic-link/request", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  if (!magic.devMagicToken) {
    throw new Error("live hosted smoke currently expects dev magic token mode for device setup; run provider proof separately");
  }
  return json("/api/v1/auth/magic-link/verify", {
    method: "POST",
    body: JSON.stringify({ email, token: magic.devMagicToken, deviceName }),
  });
}

async function waitForQr(deviceToken, flowId) {
  let wroteQr = false;
  for (let idx = 0; idx < 240; idx += 1) {
    const status = await json(`/api/v1/accounts/qr/${flowId}`, { headers: auth(deviceToken) });
    if (status.qrImage && !wroteQr) {
      writeFileSync(qrOut, status.qrImage);
      console.error(`QR image/data written to ${qrOut}; scan it with Zalo now.`);
      wroteQr = true;
    }
    if (status.state === "success" && status.accountId) return status;
    if (["declined", "expired", "error"].includes(status.state)) {
      throw new Error(`QR flow ended with ${status.state}: ${status.error || ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("QR flow timed out waiting for success");
}

async function waitForRealtime(deviceToken, accountId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${baseUrl}/api/v1/realtime`, {
      headers: auth(deviceToken),
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
  const rl = createInterface({ input, output });
  const verified = await verifyDevice();
  const deviceToken = verified.deviceToken;
  const flow = await json("/api/v1/accounts/qr/start", { method: "POST", headers: auth(deviceToken) });
  const qr = await waitForQr(deviceToken, flow.flowId);
  const accountId = qr.accountId;
  const status = await json(`/api/v1/accounts/${accountId}/status`, { headers: auth(deviceToken) });

  let sendResult = null;
  let realtimeEvent = null;
  let resolvedThreadId = threadId;
  let resolvedPhone = null;
  if (!resolvedThreadId && livePhone) {
    resolvedPhone = await json(`/api/v1/accounts/${accountId}/resolve/phone`, {
      method: "POST",
      headers: auth(deviceToken),
      body: JSON.stringify({ phone: livePhone }),
    });
    resolvedThreadId = resolvedPhone.uid;
  }
  if (resolvedThreadId) {
    const eventPromise = waitForRealtime(deviceToken, accountId).catch(() => null);
    sendResult = await json(`/api/v1/accounts/${accountId}/send/text`, {
      method: "POST",
      headers: auth(deviceToken),
      body: JSON.stringify({ threadId: resolvedThreadId, text, threadKind }),
    });
    realtimeEvent = await eventPromise;
  }

  await rl.question("Restart the backend server now, wait for /health, then press Enter to verify account status still exists...");
  const afterRestart = await json(`/api/v1/accounts/${accountId}/status`, { headers: auth(deviceToken) });
  rl.close();

  console.log(JSON.stringify({
    ok: true,
    emailDomain: email.split("@")[1] || "unknown",
    deviceId: verified.deviceId,
    accountId,
    accountStateBeforeRestart: status.state,
    accountStateAfterRestart: afterRestart.state,
    resolvedThreadId: resolvedThreadId ? `${resolvedThreadId.slice(0, 4)}…${resolvedThreadId.slice(-4)}` : null,
    resolvedPhone: resolvedPhone ? {
      uidLen: resolvedPhone.uid.length,
      hasDisplayName: Boolean(resolvedPhone.displayName),
      hasAvatar: Boolean(resolvedPhone.avatar),
    } : null,
    sentText: Boolean(sendResult?.msgId),
    realtimeEventSeen: Boolean(realtimeEvent),
    qrPath: qrOut,
    note: resolvedThreadId ? "Attach this redacted transcript plus server logs with no message plaintext." : "Set ZCA_LIVE_THREAD_ID or ZCA_LIVE_PHONE to prove hosted send/realtime.",
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
