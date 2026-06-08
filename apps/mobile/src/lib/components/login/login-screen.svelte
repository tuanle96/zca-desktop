<script lang="ts">
  // Device-linking gate (desktop "step 1", ported to a single scrollable mobile
  // screen). OAuth (opens browser) + email magic-link + advanced (server URL,
  // recovery key, OAuth fallback code). After linking with no Zalo account yet,
  // it shows the recovery key + an add-account placeholder (Phase 4 wires QR).
  import { onMount } from "svelte";
  import { Loader2, ChevronDown, Cloud } from "@lucide/svelte";
  import {
    getCloudOAuthProviders,
    requestCloudMagicLink,
    verifyCloudMagicLink,
    verifyCloudOAuthCode,
    type CloudOAuthProviders,
  } from "@zca/core-client";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import BrandMark from "$lib/components/brand-mark.svelte";
  import {
    CLOUD_BASE_URL_STORAGE_KEY,
    DEFAULT_CLOUD_BASE_URL,
    cloudBaseUrlFromStorage,
    normalizeCloudBaseUrl,
  } from "$lib/cloudConfig";
  import { CLOUD_DEVICE_LINKED_STORAGE_KEY, session } from "$lib/session-store.svelte";
  import { defaultDeviceName } from "$lib/session-helpers";
  import { formatCloudVerifyError } from "$lib/cloud-errors";
  import { cn } from "$lib/utils";

  let cloudBaseUrl = $state(DEFAULT_CLOUD_BASE_URL);
  let email = $state("");
  let token = $state("");
  let oauthCode = $state("");
  let deviceName = $state(defaultDeviceName());
  let recoveryKey = $state("");
  let busy = $state(false);
  let oauthBusy = $state<"google" | "github" | "">("");
  let providers = $state<CloudOAuthProviders | null>(null);
  let status = $state("");
  let error = $state("");
  let showAdvanced = $state(false);

  onMount(loadSettings);

  async function loadSettings() {
    if (typeof localStorage !== "undefined") cloudBaseUrl = cloudBaseUrlFromStorage(localStorage);
    try {
      await refreshProviders();
    } catch {
      providers = null;
    }
  }

  async function refreshProviders() {
    cloudBaseUrl = normalizeCloudBaseUrl(cloudBaseUrl);
    providers = await getCloudOAuthProviders(cloudBaseUrl);
    return providers;
  }

  const available = (p: "google" | "github") => providers?.[p]?.configured !== false;

  function persistBaseUrl() {
    if (typeof localStorage !== "undefined") localStorage.setItem(CLOUD_BASE_URL_STORAGE_KEY, cloudBaseUrl);
  }

  function markLinked(recovery: string | null) {
    persistBaseUrl();
    if (typeof localStorage !== "undefined") localStorage.setItem(CLOUD_DEVICE_LINKED_STORAGE_KEY, "1");
    session.cloudIssuedRecoveryKey = recovery ?? "";
    status = recovery ? "Đã liên kết. Hãy lưu recovery key an toàn." : "Đã liên kết thiết bị.";
  }

  async function requestCode() {
    busy = true;
    error = "";
    try {
      cloudBaseUrl = normalizeCloudBaseUrl(cloudBaseUrl);
      const res = await requestCloudMagicLink(cloudBaseUrl, email);
      status = res.devMagicToken ? "Đã nhận mã (chế độ dev)." : "Đã gửi mã đăng nhập qua email.";
      if (res.devMagicToken) token = res.devMagicToken;
      persistBaseUrl();
    } catch (e) {
      error = formatCloudVerifyError(e);
    } finally {
      busy = false;
    }
  }

  async function verifyEmail() {
    busy = true;
    error = "";
    try {
      cloudBaseUrl = normalizeCloudBaseUrl(cloudBaseUrl);
      const res = await verifyCloudMagicLink(cloudBaseUrl, email, token, deviceName, recoveryKey || undefined);
      markLinked(res.recoveryKey);
      token = "";
      await session.connectCloud(cloudBaseUrl, res.deviceToken);
    } catch (e) {
      error = formatCloudVerifyError(e);
    } finally {
      busy = false;
    }
  }

  async function startOAuth(provider: "google" | "github") {
    oauthBusy = provider;
    error = "";
    status = "";
    try {
      cloudBaseUrl = normalizeCloudBaseUrl(cloudBaseUrl);
      const p = await refreshProviders();
      if (!p[provider].configured) {
        error = `${provider === "google" ? "Google" : "GitHub"} OAuth chưa được cấu hình trên máy chủ.`;
        return;
      }
      persistBaseUrl();
      const params = new URLSearchParams({ deviceName: deviceName || defaultDeviceName(), platform: "mobile" });
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(`${cloudBaseUrl}/auth/oauth/${provider}/start?${params.toString()}`);
      // On mobile the browser can't auto-return yet (needs Universal Link + AASA),
      // so reveal the fallback-code field for the manual paste path.
      showAdvanced = true;
      status = "Đã mở trình duyệt. Đăng nhập xong, copy mã rồi quay lại dán vào ô “Mã OAuth dự phòng” bên dưới.";
    } catch (e) {
      error = String(e);
    } finally {
      oauthBusy = "";
    }
  }

  async function verifyOAuth() {
    busy = true;
    error = "";
    try {
      cloudBaseUrl = normalizeCloudBaseUrl(cloudBaseUrl);
      const res = await verifyCloudOAuthCode(cloudBaseUrl, oauthCode);
      markLinked(res.recoveryKey);
      oauthCode = "";
      await session.connectCloud(cloudBaseUrl, res.deviceToken);
    } catch (e) {
      error = formatCloudVerifyError(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="bg-background h-dvh overflow-y-auto pt-safe-top pb-safe-bottom">
  <div class="mx-auto flex w-full max-w-md flex-col gap-5 px-5 py-8">
    <div class="flex flex-col items-center gap-1 pt-4 text-center">
      <div class="bg-brand/10 text-brand mb-1 flex size-14 items-center justify-center rounded-2xl">
        <Cloud class="size-7" />
      </div>
      <h1 class="text-2xl font-bold">Zalo <span class="text-brand">Mobile</span></h1>
      <p class="text-muted-foreground text-sm">Đăng nhập cloud để đồng bộ tin nhắn</p>
    </div>

    <div class="flex flex-col gap-2">
        <Button variant="outline" disabled={!!oauthBusy || !available("google")} onclick={() => startOAuth("google")}>
          {#if oauthBusy === "google"}<Loader2 class="size-4 animate-spin" />{:else}<BrandMark provider="google" class="size-5" />{/if}
          Tiếp tục với Google
        </Button>
        <Button variant="outline" disabled={!!oauthBusy || !available("github")} onclick={() => startOAuth("github")}>
          {#if oauthBusy === "github"}<Loader2 class="size-4 animate-spin" />{:else}<BrandMark provider="github" class="size-5" />{/if}
          Tiếp tục với GitHub
        </Button>
        {#if providers && !providers.google.configured && !providers.github.configured}
          <p class="text-muted-foreground text-center text-xs">OAuth chưa cấu hình trên máy chủ — hãy dùng email.</p>
        {/if}
      </div>

      <div class="text-muted-foreground flex items-center gap-3 text-xs">
        <div class="bg-border h-px flex-1"></div>
        hoặc
        <div class="bg-border h-px flex-1"></div>
      </div>

      <div class="flex flex-col gap-2">
        <label class="text-muted-foreground text-xs font-medium" for="login-email">Email</label>
        <Input id="login-email" type="email" inputmode="email" bind:value={email} placeholder="ban@vidu.com" />
        <div class="flex gap-2">
          <Input bind:value={token} placeholder="Mã từ email" class="flex-1" />
          <Button variant="secondary" disabled={busy || !email} onclick={requestCode}>Gửi mã</Button>
        </div>
        <Button disabled={busy || !token} onclick={verifyEmail}>
          {#if busy}<Loader2 class="size-4 animate-spin" />{/if}
          Kết nối bằng email
        </Button>
      </div>

      <button
        class="text-muted-foreground flex items-center justify-center gap-1 text-xs"
        onclick={() => (showAdvanced = !showAdvanced)}
      >
        <ChevronDown class={cn("size-3.5 transition-transform", showAdvanced && "rotate-180")} />
        Tùy chọn nâng cao
      </button>
      {#if showAdvanced}
        <div class="flex flex-col gap-3 rounded-xl border border-border p-4">
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium" for="login-server">Máy chủ cloud</label>
            <Input id="login-server" type="url" inputmode="url" bind:value={cloudBaseUrl} placeholder={DEFAULT_CLOUD_BASE_URL} />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium" for="login-device">Tên thiết bị</label>
            <Input id="login-device" bind:value={deviceName} placeholder="Điện thoại của tôi" />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium" for="login-recovery">Recovery key (khi chuyển máy)</label>
            <Input id="login-recovery" bind:value={recoveryKey} placeholder="Dán recovery key" />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs font-medium" for="login-oauth-code">Mã OAuth dự phòng</label>
            <div class="flex gap-2">
              <Input id="login-oauth-code" bind:value={oauthCode} placeholder="Dán mã từ trình duyệt" class="flex-1" />
              <Button variant="secondary" disabled={busy || !oauthCode} onclick={verifyOAuth}>Nhận</Button>
            </div>
          </div>
        </div>
      {/if}

    {#if status}<p class="text-muted-foreground text-center text-xs">{status}</p>{/if}
    {#if error}<p class="text-destructive text-center text-xs">{error}</p>{/if}
  </div>
</div>
