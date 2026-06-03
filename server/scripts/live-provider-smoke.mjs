#!/usr/bin/env node
const baseUrl = process.env.ZCA_CLOUD_BASE_URL || "http://127.0.0.1:37880";
const email = process.env.ZCA_CLOUD_TEST_EMAIL;

if (!email) {
  console.error("ZCA_CLOUD_TEST_EMAIL is required");
  process.exit(2);
}

async function main() {
  const res = await fetch(`${baseUrl}/api/v1/auth/magic-link/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { rawBodyLen: text.length };
  }
  if (!res.ok) {
    throw new Error(`magic-link provider request failed: ${res.status} body_len=${text.length}`);
  }
  if (body.devMagicToken) {
    throw new Error("provider smoke must run with ZCA_CLOUD_DEV_RETURN_MAGIC_TOKENS disabled");
  }

  const domain = email.split("@")[1] || "unknown";
  console.log(JSON.stringify({
    ok: true,
    emailDomain: domain,
    sent: body.sent === true,
    devMagicTokenReturned: false,
    expiresInSecs: body.expiresInSecs ?? null,
    note: "Confirm delivery in provider dashboard or mailbox and attach non-secret transcript.",
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
