<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    Loader2,
    RotateCw,
    CircleCheck,
    X,
    Cloud,
    Copy,
    KeyRound,
    ShieldCheck,
    Server,
    Wifi,
  } from "@lucide/svelte";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import {
    CLOUD_DEVICE_TOKEN_KEYCHAIN,
    listCloudAccounts,
    loadCloudDeviceSession,
    requestCloudMagicLink,
    startCloudAccountQr,
    getCloudQrStatus,
    verifyCloudMagicLink,
    type CloudAccount,
  } from "$lib/cloud";
  import { session } from "$lib/session.svelte";

  // `adding` = shown as an overlay to add another account (cancellable);
  // otherwise this is the full-screen login gate (auto-starts the flow).
  let { adding = false }: { adding?: boolean } = $props();

  onMount(async () => {
    await loadCloudSettings();
    if (adding) {
      await startCloudZaloQr();
    }
  });

  let cloudBaseUrl = $state("http://127.0.0.1:37880");
  let cloudEmail = $state("");
  let cloudToken = $state("");
  let cloudDeviceName = $state("Máy của tôi");
  let cloudRecoveryKey = $state("");
  let cloudIssuedRecoveryKey = $state("");
  let cloudBusy = $state(false);
  let cloudStatus = $state("");
  let cloudError = $state("");
  let cloudAccounts = $state<CloudAccount[]>([]);
  let cloudQrBusy = $state(false);
  let cloudQrFlowId = $state("");
  let cloudQrImage = $state<string | null>(null);
  let cloudQrPhase = $state("");
  let cloudQrScannedName = $state<string | null>(null);
  let cloudQrError = $state("");
  let cloudQrPoll: ReturnType<typeof setInterval> | null = null;

  const cloudConnected = $derived(session.cloudMode && session.listening);
  const cloudShowRetry = $derived(["expired", "declined", "error"].includes(cloudQrPhase));
  const cloudDimQr = $derived(cloudQrPhase === "scanned" || cloudShowRetry);

  const cloudErrorText = $derived.by(() => {
    switch (cloudQrPhase) {
      case "expired":
        return "Mã QR cloud đã hết hạn";
      case "declined":
        return "Đăng nhập cloud bị từ chối";
      case "error":
        return cloudQrError || "Cloud QR lỗi";
      default:
        return "";
    }
  });

  onDestroy(() => {
    stopCloudQrPoll();
  });

  async function loadCloudSettings() {
    if (typeof localStorage === "undefined") return;
    cloudBaseUrl = localStorage.getItem("zca.cloud.baseUrl") || cloudBaseUrl;
    const saved = await loadCloudDeviceSession(cloudBaseUrl).catch(() => null);
    if (saved?.hasDeviceToken) {
      cloudStatus = "Thiết bị này đã liên kết cloud.";
      refreshCloudAccounts(CLOUD_DEVICE_TOKEN_KEYCHAIN);
      session.connectCloud(cloudBaseUrl, CLOUD_DEVICE_TOKEN_KEYCHAIN);
    }
  }

  async function requestCloudLink() {
    cloudBusy = true;
    cloudError = "";
    try {
      const res = await requestCloudMagicLink(cloudBaseUrl, cloudEmail);
      cloudStatus = res.devMagicToken
        ? "Dev token đã được trả về từ backend."
        : "Đã gửi magic link qua email.";
      if (res.devMagicToken) cloudToken = res.devMagicToken;
      localStorage.setItem("zca.cloud.baseUrl", cloudBaseUrl);
    } catch (e) {
      cloudError = String(e);
    } finally {
      cloudBusy = false;
    }
  }

  async function verifyCloudLink() {
    cloudBusy = true;
    cloudError = "";
    try {
      const res = await verifyCloudMagicLink(
        cloudBaseUrl,
        cloudEmail,
        cloudToken,
        cloudDeviceName,
        cloudRecoveryKey || undefined,
      );
      localStorage.setItem("zca.cloud.baseUrl", cloudBaseUrl);
      cloudStatus = res.recoveryKey
        ? "Cloud đã liên kết. Lưu recovery key ở nơi an toàn."
        : "Cloud đã liên kết thiết bị này.";
      cloudIssuedRecoveryKey = res.recoveryKey ?? "";
      await refreshCloudAccounts(res.deviceToken);
      await session.connectCloud(cloudBaseUrl, res.deviceToken);
    } catch (e) {
      cloudError = String(e);
    } finally {
      cloudBusy = false;
    }
  }

  async function refreshCloudAccounts(deviceToken = CLOUD_DEVICE_TOKEN_KEYCHAIN) {
    if (!deviceToken) return;
    try {
      cloudAccounts = await listCloudAccounts(cloudBaseUrl, deviceToken);
    } catch (e) {
      cloudError = String(e);
    }
  }

  function deviceToken(): string {
    return CLOUD_DEVICE_TOKEN_KEYCHAIN;
  }

  function stopCloudQrPoll() {
    if (!cloudQrPoll) return;
    clearInterval(cloudQrPoll);
    cloudQrPoll = null;
  }

  async function startCloudZaloQr() {
    const token = deviceToken();
    if (!token) {
      cloudError = "Liên kết thiết bị cloud trước khi thêm tài khoản Zalo.";
      return;
    }
    stopCloudQrPoll();
    cloudQrBusy = true;
    cloudError = "";
    cloudQrError = "";
    cloudQrImage = null;
    cloudQrScannedName = null;
    cloudQrPhase = "starting";
    try {
      localStorage.setItem("zca.cloud.baseUrl", cloudBaseUrl);
      const res = await startCloudAccountQr(cloudBaseUrl, token);
      cloudQrFlowId = String(res.flowId ?? "");
      cloudQrPhase = String(res.state ?? "starting");
      if (!cloudQrFlowId) throw new Error("Backend không trả flowId cho cloud QR.");
      await pollCloudZaloQr();
      cloudQrPoll = setInterval(() => {
        pollCloudZaloQr();
      }, 1500);
    } catch (e) {
      cloudQrBusy = false;
      cloudQrPhase = "error";
      cloudQrError = String(e);
    }
  }

  async function pollCloudZaloQr() {
    const token = deviceToken();
    if (!token || !cloudQrFlowId) return;
    try {
      const status = await getCloudQrStatus(cloudBaseUrl, token, cloudQrFlowId);
      cloudQrPhase = String(status.state ?? "starting");
      cloudQrImage = typeof status.qrImage === "string" ? status.qrImage : cloudQrImage;
      cloudQrScannedName = typeof status.displayName === "string" ? status.displayName : cloudQrScannedName;
      cloudQrError = typeof status.error === "string" ? status.error : "";
      if (cloudQrPhase === "success") {
        stopCloudQrPoll();
        cloudQrBusy = false;
        cloudStatus = "Tài khoản Zalo cloud đã được thêm.";
        await refreshCloudAccounts(token);
        await session.connectCloud(cloudBaseUrl, token);
        if (adding) session.cancelAddAccount();
      } else if (["expired", "declined", "error"].includes(cloudQrPhase)) {
        stopCloudQrPoll();
        cloudQrBusy = false;
      }
    } catch (e) {
      stopCloudQrPoll();
      cloudQrBusy = false;
      cloudQrPhase = "error";
      cloudQrError = String(e);
    }
  }

  function initials(name: string | null): string {
    if (!name) return "?";
    const parts = name.trim().split(/\s+/);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (first + last).toUpperCase() || "?";
  }

  async function copyRecoveryKey() {
    if (!cloudIssuedRecoveryKey) return;
    await navigator.clipboard?.writeText(cloudIssuedRecoveryKey);
    cloudStatus = "Đã copy recovery key.";
  }

  function stateLabel(state: string): string {
    switch (state) {
      case "active":
        return "Đang hoạt động";
      case "reauth-needed":
        return "Cần đăng nhập lại";
      case "removed":
        return "Đã xoá";
      default:
        return state || "Không rõ";
    }
  }
</script>

<div class="from-brand/10 via-background to-background flex h-screen w-screen items-center justify-center bg-gradient-to-b p-6">
  <div class="bg-card relative flex w-full max-w-3xl overflow-hidden rounded-2xl border shadow-xl">
    {#if adding}
      <button
        type="button"
        onclick={() => session.cancelAddAccount()}
        title="Đóng"
        aria-label="Đóng"
        class="text-muted-foreground hover:bg-muted hover:text-foreground absolute right-3 top-3 z-10 flex size-8 items-center justify-center rounded-md transition-colors"
      >
        <X class="size-5" />
      </button>
    {/if}
    <!-- Left: brand + QR -->
    <div class="flex flex-1 flex-col items-center border-r px-8 py-10 text-center">
      <h1 class="text-brand text-4xl font-extrabold tracking-tight">Zalo</h1>
      <p class="text-muted-foreground mt-1 text-sm">Cloud session host</p>

      <div class="relative mt-7 flex size-64 items-center justify-center rounded-xl border p-3">
        {#if cloudQrImage}
          <img
            src={`data:image/png;base64,${cloudQrImage}`}
            alt="Mã QR đăng nhập Zalo cloud"
            class="size-full object-contain transition {cloudDimQr ? 'opacity-10 blur-sm' : ''}"
          />
        {:else}
          <div class="flex flex-col items-center gap-3 text-center">
            <span class="bg-brand/10 text-brand flex size-20 items-center justify-center rounded-full">
              <Cloud class="size-10" />
            </span>
            <span class="text-muted-foreground max-w-44 text-sm">
              Liên kết thiết bị cloud rồi thêm tài khoản Zalo bằng hosted QR.
            </span>
          </div>
        {/if}

        {#if cloudQrPhase === "success"}
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-green-600">
            <CircleCheck class="size-16" />
            <span class="text-foreground text-sm font-medium">Đã thêm vào cloud</span>
          </div>
        {:else if cloudQrPhase === "scanned"}
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <span class="bg-brand/10 text-brand flex size-16 items-center justify-center rounded-full">
              <Cloud class="size-8" />
            </span>
            {#if cloudQrScannedName}
              <span class="text-sm font-semibold">{cloudQrScannedName}</span>
            {/if}
            <span class="text-muted-foreground text-xs">Xác nhận trên điện thoại</span>
          </div>
        {:else if cloudShowRetry}
          <button
            type="button"
            onclick={startCloudZaloQr}
            disabled={cloudQrBusy}
            class="absolute inset-0 flex flex-col items-center justify-center gap-2"
            aria-label="Tải lại mã QR cloud"
          >
            <span class="bg-brand text-brand-foreground flex size-14 items-center justify-center rounded-full shadow">
              <RotateCw class="size-7" />
            </span>
            <span class="text-foreground text-sm font-medium">Bấm để tạo mã mới</span>
          </button>
        {/if}
      </div>

      <!-- Status line: countdown / scanned / error -->
      <div class="mt-4 h-5 text-sm">
        {#if cloudErrorText}
          <span class="text-destructive font-medium" role="alert">{cloudErrorText}</span>
        {:else if cloudQrPhase === "scanned"}
          <span class="text-green-600" role="status">Đã quét — xác nhận trên điện thoại.</span>
        {:else if ["starting", "waiting", "pending"].includes(cloudQrPhase)}
          <span class="text-muted-foreground" role="status">Đang chờ quét mã cloud…</span>
        {:else}
          <span class="text-muted-foreground" role="status">Cloud-only mode</span>
        {/if}
      </div>
    </div>

    <!-- Right: instructions + cloud mode -->
    <div class="hidden w-80 flex-col justify-center gap-5 px-7 py-8 sm:flex">
      <h2 class="text-base font-semibold">Cloud SaaS</h2>
      <p class="text-muted-foreground text-sm">
        Thiết bị đăng nhập bằng magic link; tài khoản Zalo được thêm bằng hosted QR trên backend.
      </p>

      {#if !adding}
        <div class="mt-3 rounded-xl border bg-background shadow-sm">
          <div class="flex items-start justify-between gap-3 border-b p-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2 text-sm font-semibold">
                <Cloud class="size-4" />
                Cloud SaaS
              </div>
              <p class="text-muted-foreground mt-0.5 truncate text-xs">{cloudBaseUrl}</p>
            </div>
            <span
              class="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium {cloudConnected
                ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                : 'bg-muted text-muted-foreground'}"
            >
              {#if cloudConnected}
                <Wifi class="size-3" />
                Online
              {:else}
                <Server class="size-3" />
                  Chưa liên kết
              {/if}
            </span>
          </div>
          <div class="flex flex-col gap-3 p-3">
            <div class="grid gap-2">
              <Input bind:value={cloudBaseUrl} placeholder="Cloud backend URL" />
              <div class="grid grid-cols-[1fr_auto] gap-2">
                <Input bind:value={cloudEmail} placeholder="Email đăng nhập cloud" />
                <Button size="sm" variant="secondary" disabled={cloudBusy || !cloudEmail} onclick={requestCloudLink}>
                  {#if cloudBusy}<Loader2 class="animate-spin" />{/if}
                  Gửi link
                </Button>
              </div>
              <Input bind:value={cloudToken} placeholder="Token từ email/MailHog" />
              <Input bind:value={cloudDeviceName} placeholder="Tên thiết bị" />
              <Input bind:value={cloudRecoveryKey} placeholder="Recovery key nếu thêm thiết bị mới" />
              <Button size="sm" disabled={cloudBusy || !cloudToken || !cloudEmail} onclick={verifyCloudLink}>
                {#if cloudBusy}<Loader2 class="animate-spin" />{:else}<ShieldCheck class="size-4" />{/if}
                Liên kết thiết bị
              </Button>
            </div>

            {#if cloudIssuedRecoveryKey}
              <div class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2">
                <div class="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-300">
                  <KeyRound class="size-3.5" />
                  Recovery key mới
                </div>
                <div class="mt-1 flex items-center gap-2">
                  <code class="min-w-0 flex-1 truncate rounded bg-background/70 px-2 py-1 text-[11px]">
                    {cloudIssuedRecoveryKey}
                  </code>
                  <button
                    type="button"
                    onclick={copyRecoveryKey}
                    title="Copy recovery key"
                    aria-label="Copy recovery key"
                    class="hover:bg-background flex size-7 items-center justify-center rounded-md"
                  >
                    <Copy class="size-3.5" />
                  </button>
                </div>
              </div>
            {/if}

            {#if cloudStatus}
              <p class="text-muted-foreground text-xs" role="status">{cloudStatus}</p>
            {/if}
            {#if cloudError}
              <p class="text-destructive text-xs" role="alert">{cloudError}</p>
            {/if}

            {#if cloudAccounts.length > 0}
              <div class="flex flex-col gap-1.5">
                {#each cloudAccounts as account (account.id)}
                  <div class="bg-muted/40 flex items-center gap-2 rounded-lg px-2 py-1.5">
                    <Avatar.Root class="size-7">
                      {#if account.avatar}
                        <Avatar.Image src={account.avatar} alt={account.displayName ?? "avatar"} />
                      {/if}
                      <Avatar.Fallback class="bg-brand/15 text-brand text-[10px]">
                        {initials(account.displayName ?? account.zaloAccountId)}
                      </Avatar.Fallback>
                    </Avatar.Root>
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-xs font-medium">{account.displayName || account.zaloAccountId}</div>
                      <div class="text-muted-foreground truncate text-[11px]">{account.zaloAccountId}</div>
                    </div>
                    <span
                      class="shrink-0 rounded-full px-2 py-0.5 text-[10px] {account.state === 'active'
                        ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                        : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}"
                    >
                      {stateLabel(account.state)}
                    </span>
                  </div>
                {/each}
              </div>
            {/if}

            <Button size="sm" variant="outline" disabled={cloudQrBusy || !cloudBaseUrl} onclick={startCloudZaloQr}>
              {#if cloudQrBusy}<Loader2 class="animate-spin" />{/if}
              Thêm Zalo cloud
            </Button>
            {#if cloudQrImage || cloudQrPhase}
              <div class="flex flex-col items-center gap-2 rounded-lg border p-2">
                {#if cloudQrImage && cloudQrPhase !== "success"}
                  <img
                    src={`data:image/png;base64,${cloudQrImage}`}
                    alt="Mã QR Zalo cloud"
                    class="size-32 object-contain"
                  />
                {/if}
                {#if cloudQrPhase === "success"}
                  <CircleCheck class="size-8 text-green-600" />
                {/if}
                <p class="text-muted-foreground text-center text-xs">
                  {#if cloudQrPhase === "scanned"}
                    Đã quét{cloudQrScannedName ? ` bởi ${cloudQrScannedName}` : ""}; xác nhận trên điện thoại.
                  {:else if cloudQrPhase === "success"}
                    Đăng nhập cloud thành công.
                  {:else if cloudQrPhase === "expired"}
                    Mã QR cloud đã hết hạn.
                  {:else if cloudQrPhase === "declined"}
                    Đăng nhập cloud bị từ chối.
                  {:else if cloudQrPhase === "error"}
                    {cloudQrError || "Cloud QR lỗi."}
                  {:else}
                    Đang chờ backend tạo mã QR cloud.
                  {/if}
                </p>
                {#if ["expired", "declined", "error"].includes(cloudQrPhase)}
                  <Button size="sm" variant="secondary" disabled={cloudQrBusy} onclick={startCloudZaloQr}>
                    <RotateCw class="size-4" />
                    Tạo mã mới
                  </Button>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      {/if}

      {#if session.error}
        <p class="text-destructive text-xs" role="alert">{session.error}</p>
      {/if}
    </div>
  </div>
</div>
