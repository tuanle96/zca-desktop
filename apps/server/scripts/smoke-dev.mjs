#!/usr/bin/env node
const baseUrl = process.env.ZCA_CLOUD_BASE_URL || "http://127.0.0.1:37880";

async function request(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${options.method || "GET"} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  return body;
}

async function expectStatus(path, expectedStatus, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (res.status !== expectedStatus) {
    const text = await res.text();
    throw new Error(`${options.method || "GET"} ${path} expected ${expectedStatus}, got ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function main() {
  const health = await request("/health");
  if (!health.ok) throw new Error("health check did not return ok");

  const rateEmail = `rate-${Date.now()}@example.com`;
  for (let idx = 0; idx < 5; idx += 1) {
    await request("/api/v1/auth/magic-link/request", {
      method: "POST",
      body: JSON.stringify({ email: rateEmail }),
    });
  }
  await expectStatus("/api/v1/auth/magic-link/request", 429, {
    method: "POST",
    body: JSON.stringify({ email: rateEmail }),
  });

  const email = `smoke-${Date.now()}@example.com`;
  const magic = await request("/api/v1/auth/magic-link/request", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  if (!magic.devMagicToken) throw new Error("dev magic token missing; set ZCA_CLOUD_DEV_RETURN_MAGIC_TOKENS=1");

  const verified = await request("/api/v1/auth/magic-link/verify", {
    method: "POST",
    body: JSON.stringify({
      email,
      token: magic.devMagicToken,
      deviceName: "smoke-device-a",
    }),
  });
  if (!verified.deviceToken || !verified.recoveryKey) {
    throw new Error("verify response missing device token or first-user recovery key");
  }
  const auth = { authorization: `Bearer ${verified.deviceToken}` };

  const devices = await request("/api/v1/devices", { headers: auth });
  if (!Array.isArray(devices) || devices.length !== 1) throw new Error("device list did not include device A");

  const fakeAccountId = "00000000-0000-0000-0000-000000000001";
  await expectStatus(`/api/v1/accounts/${fakeAccountId}/send/text`, 404, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ threadId: "fake-thread", text: "blocked" }),
  });
  await expectStatus(`/api/v1/accounts/${fakeAccountId}/send/sticker`, 404, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ threadId: "fake-thread", stickerId: 1, catId: 1, stickerType: 1 }),
  });
  await expectStatus(`/api/v1/accounts/${fakeAccountId}/send/reaction`, 404, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      threadId: "fake-thread",
      msgId: "fake-msg",
      cliMsgId: "fake-cli-msg",
      icon: "heart",
    }),
  });

  const magicB = await request("/api/v1/auth/magic-link/request", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  await expectStatus("/api/v1/auth/magic-link/verify", 403, {
    method: "POST",
    body: JSON.stringify({
      email,
      token: magicB.devMagicToken,
      deviceName: "smoke-device-b",
    }),
  });
  const registered = await request("/api/v1/auth/magic-link/verify", {
    method: "POST",
    body: JSON.stringify({
      email,
      token: magicB.devMagicToken,
      deviceName: "smoke-device-b",
      recoveryKey: verified.recoveryKey,
    }),
  });
  if (!registered.deviceToken || registered.recoveryKey) {
    throw new Error("existing-user verify should return device B token and no new recovery key");
  }

  const content = Buffer.from("known plaintext file payload for zca cloud smoke", "utf8");
  const digest = await crypto.subtle.digest("SHA-256", content);
  const sha256 = Buffer.from(digest).toString("hex");
  const file = await request("/api/v1/files/init", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      filename: "smoke.txt",
      mime: "text/plain",
      sizeBytes: content.length,
      contentSha256: sha256,
    }),
  });
  await expectStatus(`/api/v1/files/${file.id}/blob`, 400, {
    method: "POST",
    headers: { authorization: auth.authorization },
    body: Buffer.from("tampered payload", "utf8"),
  });
  const uploadRes = await fetch(`${baseUrl}/api/v1/files/${file.id}/blob`, {
    method: "POST",
    headers: { authorization: auth.authorization },
    body: content,
  });
  if (!uploadRes.ok) throw new Error(`file upload failed: ${uploadRes.status}`);

  const downloadRes = await fetch(`${baseUrl}/api/v1/files/${file.id}/blob`, {
    headers: { authorization: `Bearer ${registered.deviceToken}` },
  });
  if (!downloadRes.ok) throw new Error(`device B file download failed: ${downloadRes.status}`);
  const downloaded = Buffer.from(await downloadRes.arrayBuffer());
  if (!downloaded.equals(content)) throw new Error("downloaded file did not match uploaded content");

  await request(`/api/v1/devices/${registered.deviceId}`, { method: "DELETE", headers: auth });
  const revokedRes = await fetch(`${baseUrl}/api/v1/devices`, {
    headers: { authorization: `Bearer ${registered.deviceToken}` },
  });
  if (revokedRes.status !== 401) throw new Error(`revoked device token was not rejected: ${revokedRes.status}`);

  console.log(JSON.stringify({
    ok: true,
    emailDomain: "example.com",
    userId: verified.userId,
    deviceA: verified.deviceId,
    deviceB: registered.deviceId,
    fileId: file.id,
    fileBytes: content.length,
    sha256,
    fileIntegrityRejected: true,
    revokedRejected: true,
    fakeAccountSendRejected: true,
    reauthRestoreMarked: process.env.ZCA_CLOUD_REAUTH_RESTORE_PROVED === "1",
    magicLinkRateLimited: true,
    auditEventsProved: process.env.ZCA_CLOUD_AUDIT_EVENTS_PROVED === "1",
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
