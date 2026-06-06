<script lang="ts">
  // Mobile thin client (scaffold). Reuses the SHARED cloud client
  // (@zca/core-client) and SHARED types (@zca/types) — the exact same code the
  // desktop uses. invoke() targets the mobile Rust core's cloud_* commands,
  // which keep the device token in the OS keychain (referenced by the
  // __keychain__ sentinel) and proxy HTTP to the cloud server.
  import {
    requestCloudMagicLink,
    verifyCloudMagicLink,
    loadCloudDeviceSession,
    clearCloudDeviceSession,
    listCloudAccounts,
    CLOUD_DEVICE_TOKEN_KEYCHAIN,
  } from "@zca/core-client";
  import type { CloudAccount } from "@zca/core-client";
  import { DEFAULT_CLOUD_BASE_URL } from "$lib/cloudConfig";

  let baseUrl = $state(DEFAULT_CLOUD_BASE_URL);
  let email = $state("");
  let code = $state("");
  let status = $state("");
  let busy = $state(false);
  let linked = $state(false);
  let accounts = $state<CloudAccount[]>([]);

  async function run(label: string, fn: () => Promise<void>) {
    busy = true;
    status = label;
    try {
      await fn();
    } catch (e) {
      status = `Lỗi: ${e}`;
    } finally {
      busy = false;
    }
  }

  function checkSession() {
    return run("Đang kiểm tra...", async () => {
      const session = await loadCloudDeviceSession(baseUrl);
      linked = !!session?.hasDeviceToken;
      status = linked ? "Thiết bị đã liên kết." : "Chưa liên kết.";
      if (linked) await refreshAccounts();
    });
  }

  function sendCode() {
    return run("Đang gửi mã...", async () => {
      const res = await requestCloudMagicLink(baseUrl, email);
      status = res.devMagicToken
        ? `Mã đăng nhập (dev): ${res.devMagicToken}`
        : "Đã gửi mã đăng nhập tới email của bạn.";
    });
  }

  function verify() {
    return run("Đang xác thực...", async () => {
      await verifyCloudMagicLink(baseUrl, email, code, "Điện thoại");
      linked = true;
      status = "Liên kết thành công.";
      await refreshAccounts();
    });
  }

  function unlink() {
    return run("Đang hủy liên kết...", async () => {
      await clearCloudDeviceSession(baseUrl);
      linked = false;
      accounts = [];
      status = "Đã hủy liên kết thiết bị.";
    });
  }

  async function refreshAccounts() {
    // The token never leaves the Rust core — pass the keychain sentinel.
    accounts = await listCloudAccounts(baseUrl, CLOUD_DEVICE_TOKEN_KEYCHAIN);
  }
</script>

<main>
  <h1>Zalo <span>Mobile</span></h1>

  {#if !linked}
    <section>
      <label>
        Máy chủ
        <input bind:value={baseUrl} placeholder={DEFAULT_CLOUD_BASE_URL} />
      </label>
      <label>
        Email
        <input bind:value={email} type="email" placeholder="ban@vidu.com" />
      </label>
      <div class="row">
        <button onclick={sendCode} disabled={busy || !email}>Gửi mã</button>
      </div>
      <label>
        Mã đăng nhập
        <input bind:value={code} placeholder="Nhập mã từ email" />
      </label>
      <div class="row">
        <button class="primary" onclick={verify} disabled={busy || !code}>Liên kết thiết bị</button>
        <button onclick={checkSession} disabled={busy}>Kiểm tra</button>
      </div>
    </section>
  {:else}
    <section>
      <p class="ok">Đã liên kết với {baseUrl}</p>
      <div class="row">
        <button onclick={refreshAccounts} disabled={busy}>Tải tài khoản</button>
        <button onclick={unlink} disabled={busy}>Hủy liên kết</button>
      </div>
      <ul>
        {#each accounts as acc (acc.id)}
          <li>{acc.displayName ?? acc.zaloAccountId} · {acc.state}</li>
        {:else}
          <li class="muted">Chưa có tài khoản Zalo nào.</li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if status}
    <p class="status">{status}</p>
  {/if}
</main>

<style>
  main {
    max-width: 28rem;
    margin: 0 auto;
    padding: 1.5rem 1.25rem 3rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  h1 {
    font-size: 1.6rem;
    font-weight: 700;
    margin: 0.5rem 0 0.25rem;
  }
  h1 span {
    color: var(--accent);
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.85rem;
    color: var(--muted);
  }
  input {
    padding: 0.7rem 0.8rem;
    font-size: 1rem;
    border: 1px solid var(--border);
    border-radius: 0.6rem;
    background: transparent;
    color: var(--fg);
  }
  .row {
    display: flex;
    gap: 0.5rem;
  }
  button {
    flex: 1;
    padding: 0.7rem 0.9rem;
    font-size: 0.95rem;
    border: 1px solid var(--border);
    border-radius: 0.6rem;
    background: transparent;
    color: var(--fg);
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  button:disabled {
    opacity: 0.5;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  li {
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: 0.6rem;
    font-size: 0.95rem;
  }
  .muted {
    color: var(--muted);
  }
  .ok {
    color: var(--accent);
    font-weight: 600;
  }
  .status {
    font-size: 0.85rem;
    color: var(--muted);
    word-break: break-word;
  }
</style>
