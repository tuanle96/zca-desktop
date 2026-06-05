#!/usr/bin/env node
const baseUrl = process.env.ZCA_CLOUD_BASE_URL || "http://127.0.0.1:37880";
const mailhogApi = process.env.ZCA_CLOUD_MAILHOG_API || "http://127.0.0.1:37885";
const email = process.env.ZCA_CLOUD_TEST_EMAIL || `mailhog-${Date.now()}@example.com`;

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

async function mailhogMessages() {
  const res = await fetch(`${mailhogApi}/api/v2/messages`);
  if (!res.ok) throw new Error(`MailHog messages failed: ${res.status}`);
  return res.json();
}

function bodyText(message) {
  return message?.Content?.Body || message?.MIME?.Parts?.map((part) => part?.Body || "").join("\n") || "";
}

async function waitForMagicToken() {
  for (let idx = 0; idx < 80; idx += 1) {
    const payload = await mailhogMessages();
    const items = payload.items || [];
    for (const message of items) {
      const recipients = message.To || message.Raw?.To || [];
      const matchesRecipient = recipients.some((item) => {
        const mailbox = item.Mailbox && item.Domain ? `${item.Mailbox}@${item.Domain}` : String(item);
        return mailbox.toLowerCase() === email.toLowerCase();
      });
      if (!matchesRecipient) continue;
      const match = bodyText(message).match(/[?&]token=([A-Za-z0-9_-]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("timed out waiting for MailHog magic-link email");
}

async function main() {
  const magic = await request("/api/v1/auth/magic-link/request", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  if (magic.devMagicToken) throw new Error("MailHog smoke must not receive devMagicToken");
  const token = await waitForMagicToken();
  const verified = await request("/api/v1/auth/magic-link/verify", {
    method: "POST",
    body: JSON.stringify({
      email,
      token,
      deviceName: "mailhog-device-a",
    }),
  });
  if (!verified.deviceToken || !verified.recoveryKey) {
    throw new Error("verify response missing device token or recovery key");
  }
  await expectStatus("/api/v1/auth/magic-link/verify", 401, {
    method: "POST",
    body: JSON.stringify({
      email,
      token,
      deviceName: "mailhog-device-reuse",
      recoveryKey: verified.recoveryKey,
    }),
  });
  const devices = await request("/api/v1/devices", {
    headers: { authorization: `Bearer ${verified.deviceToken}` },
  });
  if (!Array.isArray(devices) || devices.length !== 1) throw new Error("device list did not include MailHog device");
  console.log(JSON.stringify({
    ok: true,
    emailDomain: email.split("@")[1] || "unknown",
    sentViaMailHog: true,
    devMagicTokenReturned: false,
    tokenSingleUseRejected: true,
    userId: verified.userId,
    deviceId: verified.deviceId,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
