<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    Loader2,
    RotateCw,
    CircleCheck,
    Check,
    X,
    Cloud,
    Copy,
    KeyRound,
    ShieldCheck,
    Server,
    Wifi,
    MonitorSmartphone,
    ChevronDown,
    Plus,
  } from "@lucide/svelte";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import BrandMark from "$lib/components/brand-mark.svelte";
  import {
    CLOUD_DEVICE_TOKEN_KEYCHAIN,
    getCloudOAuthProviders,
    listCloudAccounts,
    requestCloudMagicLink,
    startCloudAccountQr,
    getCloudQrStatus,
    verifyCloudMagicLink,
    verifyCloudOAuthCode,
    type CloudAccount,
    type CloudOAuthProviders,
  } from "$lib/cloud";
  import { DEFAULT_CLOUD_BASE_URL, cloudBaseUrlFromStorage, normalizeCloudBaseUrl } from "$lib/cloudConfig";
  import { CLOUD_BASE_URL_STORAGE_KEY, CLOUD_DEVICE_LINKED_STORAGE_KEY, session } from "$lib/session.svelte";

  // `adding` = shown as an overlay to add another account (cancellable);
  // otherwise this is the full-screen login gate (auto-starts the flow).
  let { adding = false }: { adding?: boolean } = $props();

  onMount(async () => {
    await loadCloudSettings();
    if (adding) {
      await startCloudZaloQr();
    }
  });

  let cloudBaseUrl = $state(DEFAULT_CLOUD_BASE_URL);
  let cloudEmail = $state("");
  let cloudToken = $state("");
  let cloudOAuthCode = $state("");
  let cloudDeviceName = $state("Máy của tôi");
  let cloudRecoveryKey = $state("");
  let cloudIssuedRecoveryKey = $state("");
  let cloudBusy = $state(false);
  let oauthBusyProvider = $state<"google" | "github" | "">("");
  let oauthProviders = $state<CloudOAuthProviders | null>(null);
  let cloudStatus = $state("");
  let cloudError = $state("");
  let cloudAccounts = $state<CloudAccount[]>([]);
  let cloudDeviceLinked = $state(false);
  let cloudQrBusy = $state(false);
  let cloudQrFlowId = $state("");
  let cloudQrImage = $state<string | null>(null);
  let cloudQrPhase = $state("");
  let cloudQrScannedName = $state<string | null>(null);
  let cloudQrError = $state("");
  let cloudQrPoll: ReturnType<typeof setInterval> | null = null;

  const cloudConnected = $derived(session.cloudMode && session.realtimeState === "live");
  // Step 1 = link this device; step 2 = add a Zalo account (device already linked).
  const step = $derived(adding || session.cloudMode ? 2 : 1);
  const cloudShowRetry = $derived(["expired", "declined", "error"].includes(cloudQrPhase));
  const cloudDimQr = $derived(cloudQrPhase === "scanned" || cloudShowRetry);

  $effect(() => {
    if (session.cloudMode && !cloudDeviceLinked) {
      cloudDeviceLinked = true;
      cloudToken = "";
      cloudError = "";
      if (session.cloudIssuedRecoveryKey) {
        cloudIssuedRecoveryKey = session.cloudIssuedRecoveryKey;
      }
      cloudStatus = "Thiết bị cloud đã liên kết. Thêm tài khoản Zalo để bắt đầu.";
    }
  });

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

  function formatCloudVerifyError(value: unknown): string {
    const text = typeof value === "string" ? value : String(value);
    if (/\brecovery_key_required\b/i.test(text)) {
      return "Tài khoản cloud này đã tồn tại. Nhập recovery key trong Tùy chọn nâng cao rồi bấm Kết nối thiết bị.";
    }
    if (/\brecovery_key_invalid\b/i.test(text)) {
      return "Recovery key không đúng. Hãy kiểm tra lại recovery key hoặc gửi mã đăng nhập mới.";
    }
    if (/status=?\s*401\b/.test(text) || /\bunauthorized\b/i.test(text)) {
      return "Mã đăng nhập đã hết hạn hoặc không hợp lệ. Hãy gửi lại mã.";
    }
    return text;
  }

  async function loadCloudSettings() {
    if (typeof localStorage === "undefined") return;
    cloudBaseUrl = cloudBaseUrlFromStorage(localStorage);
    cloudDeviceLinked = localStorage.getItem(CLOUD_DEVICE_LINKED_STORAGE_KEY) === "1";
    if (cloudDeviceLinked) cloudStatus = "Thiết bị này đã từng liên kết cloud.";
    try {
      await refreshOAuthProviders();
    } catch {
      oauthProviders = null;
    }
  }

  async function refreshOAuthProviders() {
    cloudBaseUrl = normalizeCloudBaseUrl(cloudBaseUrl);
    const providers = await getCloudOAuthProviders(cloudBaseUrl);
    oauthProviders = providers;
    return providers;
  }

  function oauthProviderLabel(provider: "google" | "github") {
    return provider === "google" ? "Google" : "GitHub";
  }

  function oauthProviderAvailable(provider: "google" | "github") {
    return oauthProviders?.[provider]?.configured !== false;
  }

  async function continueLinkedCloudDevice() {
    cloudBusy = true;
    cloudError = "";
    try {
      cloudBaseUrl = normalizeCloudBaseUrl(cloudBaseUrl);
      localStorage.setItem(CLOUD_BASE_URL_STORAGE_KEY, cloudBaseUrl);
      const connected = await session.restoreCloudDevice(cloudBaseUrl);
      if (!connected) {
        cloudDeviceLinked = false;
        localStorage.removeItem(CLOUD_DEVICE_LINKED_STORAGE_KEY);
        cloudStatus = "Không tìm thấy phiên cloud đã liên kết trên Keychain.";
        return;
      }
      cloudDeviceLinked = true;
      cloudStatus = "Đã kết nối thiết bị cloud.";
      await refreshCloudAccounts(CLOUD_DEVICE_TOKEN_KEYCHAIN);
    } catch (e) {
      cloudError = String(e);
    } finally {
      cloudBusy = false;
    }
  }

  async function requestCloudLink() {
    cloudBusy = true;
    cloudError = "";
    try {
      cloudBaseUrl = normalizeCloudBaseUrl(cloudBaseUrl);
      const res = await requestCloudMagicLink(cloudBaseUrl, cloudEmail);
      cloudStatus = res.devMagicToken
        ? "Đã nhận mã đăng nhập (chế độ dev)."
        : "Đã gửi mã đăng nhập qua email.";
      if (res.devMagicToken) cloudToken = res.devMagicToken;
      localStorage.setItem(CLOUD_BASE_URL_STORAGE_KEY, cloudBaseUrl);
    } catch (e) {
      cloudError = formatCloudVerifyError(e);
    } finally {
      cloudBusy = false;
    }
  }

  async function verifyCloudLink() {
    cloudBusy = true;
    cloudError = "";
    try {
      cloudBaseUrl = normalizeCloudBaseUrl(cloudBaseUrl);
      const res = await verifyCloudMagicLink(
        cloudBaseUrl,
        cloudEmail,
        cloudToken,
        cloudDeviceName,
        cloudRecoveryKey || undefined,
      );
      cloudBaseUrl = normalizeCloudBaseUrl(cloudBaseUrl);
      localStorage.setItem(CLOUD_BASE_URL_STORAGE_KEY, cloudBaseUrl);
      localStorage.setItem(CLOUD_DEVICE_LINKED_STORAGE_KEY, "1");
      cloudDeviceLinked = true;
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

  async function startOAuthLogin(provider: "google" | "github") {
    oauthBusyProvider = provider;
    cloudError = "";
    cloudStatus = "";
    try {
      cloudBaseUrl = normalizeCloudBaseUrl(cloudBaseUrl);
      const providers = await refreshOAuthProviders();
      if (!providers[provider].configured) {
        cloudError = `${oauthProviderLabel(provider)} OAuth chưa được cấu hình trên máy chủ cloud.`;
        return;
      }
      localStorage.setItem(CLOUD_BASE_URL_STORAGE_KEY, cloudBaseUrl);
      const params = new URLSearchParams({
        deviceName: cloudDeviceName || "Máy của tôi",
      });
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(`${cloudBaseUrl}/auth/oauth/${provider}/start?${params.toString()}`);
      cloudStatus = "Đã mở trình duyệt để đăng nhập cloud.";
    } catch (e) {
      cloudError = String(e);
    } finally {
      oauthBusyProvider = "";
    }
  }

  async function verifyOAuthCode() {
    cloudBusy = true;
    cloudError = "";
    try {
      cloudBaseUrl = normalizeCloudBaseUrl(cloudBaseUrl);
      const res = await verifyCloudOAuthCode(cloudBaseUrl, cloudOAuthCode);
      localStorage.setItem(CLOUD_BASE_URL_STORAGE_KEY, cloudBaseUrl);
      localStorage.setItem(CLOUD_DEVICE_LINKED_STORAGE_KEY, "1");
      cloudDeviceLinked = true;
      cloudIssuedRecoveryKey = res.recoveryKey ?? "";
      cloudStatus = res.recoveryKey
        ? "Cloud đã liên kết. Lưu recovery key ở nơi an toàn."
        : "Cloud đã liên kết thiết bị này.";
      cloudOAuthCode = "";
      await refreshCloudAccounts(res.deviceToken);
      await session.connectCloud(cloudBaseUrl, res.deviceToken);
    } catch (e) {
      cloudError = formatCloudVerifyError(e);
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
      cloudBaseUrl = normalizeCloudBaseUrl(cloudBaseUrl);
      localStorage.setItem(CLOUD_BASE_URL_STORAGE_KEY, cloudBaseUrl);
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
      // The QR is created and now just waiting to be scanned — the "create QR"
      // action is done, so stop the button spinner. cloudQrBusy should reflect
      // only the brief generation step, not the whole waiting-to-scan window.
      if (cloudQrImage && cloudQrBusy) cloudQrBusy = false;
      if (cloudQrPhase === "success") {
        stopCloudQrPoll();
        cloudQrBusy = false;
        cloudStatus = "Tài khoản Zalo cloud đã được thêm.";
        await refreshCloudAccounts(token);
        // The QR flow reports "success" before the backend makes the freshly
        // linked account queryable via /api/v1/accounts. connectCloud only flips
        // session.profile (and thus the login gate) once that account appears, so
        // retry a few times to ride out the eventual-consistency window instead
        // of stranding the user on the success screen.
        let connected = false;
        for (let attempt = 0; attempt < 8 && !connected; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 750));
          connected = (await session.connectCloud(cloudBaseUrl, token)) === "connected";
        }
        if (connected) {
          if (adding) session.cancelAddAccount();
        } else {
          cloudQrError =
            "Đã thêm vào cloud nhưng chưa nạp được tài khoản. Thử lại hoặc khởi động lại ứng dụng.";
        }
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

<div class="bg-background flex h-screen w-screen items-center justify-center overflow-y-auto p-6">
  <div
    class="bg-card relative flex w-full max-w-3xl flex-col overflow-hidden rounded-[1.5rem] border shadow-[0_18px_48px_-24px_oklch(0.2_0.02_265_/_0.28)] sm:flex-row"
  >
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

    <!-- Left: brand + stepper + quiet visual -->
    <div class="flex flex-1 flex-col items-center border-b px-8 py-11 text-center sm:border-b-0 sm:border-r">
      <h1 class="font-display text-brand text-[2.6rem] leading-none font-bold tracking-tight">Zalo</h1>
      <p class="text-muted-foreground mt-2 text-sm">Đăng nhập cloud</p>

      <!-- Stepper -->
      <div class="mt-9 w-56">
        <div class="flex items-center">
          <span
            class="flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold transition-colors {step >
            1
              ? 'border-brand bg-brand text-brand-foreground'
              : 'border-brand text-brand'}"
          >
            {#if step > 1}<Check class="size-4" />{:else}1{/if}
          </span>
          <div class="mx-2 h-px flex-1 {step > 1 ? 'bg-brand' : 'bg-border'}"></div>
          <span
            class="flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold transition-colors {step >=
            2
              ? 'border-brand text-brand'
              : 'border-border text-muted-foreground'}"
          >
            2
          </span>
        </div>
        <div class="mt-2.5 flex justify-between text-xs">
          <span class={step === 1 ? "text-foreground font-medium" : "text-muted-foreground"}>Kết nối thiết bị</span>
          <span class={step === 2 ? "text-foreground font-medium" : "text-muted-foreground"}>Thêm Zalo</span>
        </div>
      </div>

      <!-- Visual: device tile (step 1) or QR (step 2) -->
      <div class="relative mt-9 flex size-52 items-center justify-center">
        {#if step === 1}
          <div
            class="bg-brand/[0.04] ring-brand/10 flex size-full flex-col items-center justify-center gap-4 rounded-2xl ring-1"
          >
            <span class="bg-brand/10 text-brand flex size-16 items-center justify-center rounded-2xl">
              <MonitorSmartphone class="size-8" />
            </span>
            <span class="text-muted-foreground max-w-40 text-sm">Liên kết máy này với cloud để bắt đầu.</span>
          </div>
        {:else if cloudQrImage && cloudQrPhase !== "success"}
          <div class="rounded-2xl border bg-white p-3 shadow-sm">
            <img
              src={`data:image/png;base64,${cloudQrImage}`}
              alt="Mã QR đăng nhập Zalo cloud"
              class="size-40 object-contain transition {cloudDimQr ? 'opacity-10 blur-sm' : ''}"
            />
          </div>
        {:else if cloudQrBusy}
          <div class="flex flex-col items-center gap-3">
            <Loader2 class="text-brand size-8 animate-spin" />
            <span class="text-muted-foreground text-sm">Đang tạo mã QR…</span>
          </div>
        {:else if cloudQrPhase !== "success"}
          <div
            class="border-border/70 flex size-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-5"
          >
            <Cloud class="text-muted-foreground size-8" />
            <span class="text-muted-foreground max-w-40 text-sm">Bấm “Thêm tài khoản Zalo” để hiện mã QR.</span>
          </div>
        {/if}

        {#if step === 2 && cloudQrPhase === "success"}
          <div class="bg-card absolute inset-0 flex flex-col items-center justify-center gap-2 text-green-600">
            <CircleCheck class="size-14" />
            <span class="text-foreground text-sm font-medium">Đã thêm vào cloud</span>
          </div>
        {:else if step === 2 && cloudQrPhase === "scanned"}
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <span class="bg-brand/10 text-brand flex size-14 items-center justify-center rounded-full">
              <Cloud class="size-7" />
            </span>
            {#if cloudQrScannedName}
              <span class="text-sm font-semibold">{cloudQrScannedName}</span>
            {/if}
            <span class="text-muted-foreground text-xs">Xác nhận trên điện thoại</span>
          </div>
        {:else if step === 2 && cloudShowRetry}
          <button
            type="button"
            onclick={startCloudZaloQr}
            disabled={cloudQrBusy}
            class="absolute inset-0 flex flex-col items-center justify-center gap-2"
            aria-label="Tải lại mã QR cloud"
          >
            <span class="bg-brand text-brand-foreground flex size-12 items-center justify-center rounded-full shadow">
              <RotateCw class="size-6" />
            </span>
            <span class="text-foreground text-sm font-medium">Bấm để tạo mã mới</span>
          </button>
        {/if}
      </div>

      <!-- Status line -->
      <div class="mt-7 h-5 text-sm">
        {#if step === 1}
          <span class="text-muted-foreground">Bước 1 / 2</span>
        {:else if cloudErrorText}
          <span class="text-destructive font-medium" role="alert">{cloudErrorText}</span>
        {:else if cloudQrPhase === "scanned"}
          <span class="text-green-600" role="status">Đã quét — xác nhận trên điện thoại.</span>
        {:else if ["starting", "waiting", "pending"].includes(cloudQrPhase)}
          <span class="text-muted-foreground" role="status">Đang chờ quét mã cloud…</span>
        {:else}
          <span class="text-muted-foreground">Bước 2 / 2</span>
        {/if}
      </div>
    </div>

    <!-- Right: controls for the active step -->
    <div class="flex w-full flex-col justify-center gap-5 px-7 py-9 sm:w-80">
      <!-- Header: brand eyebrow + connection state -->
      <div class="flex items-center justify-between">
        <span class="text-muted-foreground inline-flex items-center gap-1.5 text-xs font-medium">
          <Cloud class="size-3.5" />
          Zalo Cloud
        </span>
        <span
          class="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium {cloudConnected
            ? 'bg-green-500/10 text-green-700 dark:text-green-400'
            : 'bg-muted text-muted-foreground'}"
        >
          {#if cloudConnected}
            <Wifi class="size-3" />
            Đã kết nối
          {:else}
            <Server class="size-3" />
            Chưa kết nối
          {/if}
        </span>
      </div>

      {#if cloudIssuedRecoveryKey}
        <div class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
          <div class="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-300">
            <KeyRound class="size-3.5" />
            Lưu recovery key này
          </div>
          <p class="text-muted-foreground mt-0.5 text-[11px]">Dùng để khôi phục khi đổi thiết bị. Chỉ hiện một lần.</p>
          <div class="mt-1.5 flex items-center gap-2">
            <code class="bg-background/70 min-w-0 flex-1 truncate rounded px-2 py-1 text-[11px]">
              {cloudIssuedRecoveryKey}
            </code>
            <button
              type="button"
              onclick={copyRecoveryKey}
              title="Copy recovery key"
              aria-label="Copy recovery key"
              class="hover:bg-background flex size-7 shrink-0 items-center justify-center rounded-md border"
            >
              <Copy class="size-3.5" />
            </button>
          </div>
        </div>
      {/if}

      {#if step === 1}
        <!-- Step 1: link this device via browser OAuth, with magic-link fallback -->
        <div>
          <h2 class="font-display text-xl font-semibold tracking-tight">Kết nối thiết bị</h2>
          <p class="text-muted-foreground mt-1 text-sm">Đăng nhập bằng trình duyệt để liên kết máy này với cloud.</p>
        </div>

        {#if cloudDeviceLinked && !cloudConnected}
          <Button variant="outline" disabled={cloudBusy || !cloudBaseUrl} onclick={continueLinkedCloudDevice}>
            {#if cloudBusy}<Loader2 class="animate-spin" />{:else}<ShieldCheck class="size-4" />{/if}
            Tiếp tục với thiết bị đã liên kết
          </Button>
          <div class="text-muted-foreground flex items-center gap-3 text-xs">
            <span class="bg-border h-px flex-1"></span>
            hoặc liên kết lại
            <span class="bg-border h-px flex-1"></span>
          </div>
        {/if}

        <div class="grid gap-1.5">
          <label for="cloud-device" class="text-xs font-medium">Tên thiết bị</label>
          <Input id="cloud-device" bind:value={cloudDeviceName} placeholder="Máy của tôi" />
        </div>

        <div class="grid gap-2">
          <Button
            class="bg-foreground text-background hover:bg-foreground/90"
            disabled={!!oauthBusyProvider || !oauthProviderAvailable("google")}
            onclick={() => startOAuthLogin("google")}
          >
            {#if oauthBusyProvider === "google"}<Loader2 class="animate-spin" />{:else}<span class="flex size-5 items-center justify-center rounded-full bg-white"><BrandMark provider="google" class="size-4" /></span>{/if}
            Tiếp tục với Google
          </Button>
          <Button
            variant="outline"
            disabled={!!oauthBusyProvider || !oauthProviderAvailable("github")}
            onclick={() => startOAuthLogin("github")}
          >
            {#if oauthBusyProvider === "github"}<Loader2 class="animate-spin" />{:else}<BrandMark provider="github" class="size-4" />{/if}
            Tiếp tục với GitHub
          </Button>
          {#if oauthProviders && !oauthProviders.google.configured && !oauthProviders.github.configured}
            <p class="text-muted-foreground text-xs">Máy chủ cloud chưa bật Google/GitHub OAuth.</p>
          {/if}
        </div>

        <details class="group border-border/70 bg-background/40 rounded-lg border px-3 py-2 text-sm">
          <summary
            class="text-muted-foreground flex cursor-pointer list-none items-center justify-between font-medium [&::-webkit-details-marker]:hidden"
          >
            Đăng nhập bằng email
            <ChevronDown class="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div class="mt-3 grid gap-3">
            <div class="grid gap-1.5">
              <label for="cloud-email" class="text-xs font-medium">Email</label>
              <div class="grid grid-cols-[1fr_auto] gap-2">
                <Input id="cloud-email" type="email" bind:value={cloudEmail} placeholder="ban@example.com" />
                <Button variant="secondary" disabled={cloudBusy || !cloudEmail} onclick={requestCloudLink}>
                  {#if cloudBusy}<Loader2 class="animate-spin" />{/if}
                  Gửi mã
                </Button>
              </div>
            </div>

            <div class="grid gap-1.5">
              <label for="cloud-token" class="text-xs font-medium">Mã xác thực</label>
              <Input id="cloud-token" bind:value={cloudToken} placeholder="Dán mã từ email" />
            </div>

            <Button
              class="bg-brand text-brand-foreground hover:bg-brand/90"
              disabled={cloudBusy || !cloudToken || !cloudEmail}
              onclick={verifyCloudLink}
            >
              {#if cloudBusy}<Loader2 class="animate-spin" />{:else}<ShieldCheck class="size-4" />{/if}
              Kết nối bằng email
            </Button>
          </div>
        </details>

        <details class="group border-border/70 bg-background/40 rounded-lg border px-3 py-2 text-sm">
          <summary
            class="text-muted-foreground flex cursor-pointer list-none items-center justify-between font-medium [&::-webkit-details-marker]:hidden"
          >
            Tùy chọn nâng cao
            <ChevronDown class="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div class="mt-3 grid gap-3">
            <div class="grid gap-1.5">
              <label for="cloud-url" class="text-xs font-medium">Địa chỉ máy chủ cloud</label>
              <Input
                id="cloud-url"
                bind:value={cloudBaseUrl}
                oninput={() => (oauthProviders = null)}
                placeholder="https://cloud.example.com"
              />
            </div>
            <div class="grid gap-1.5">
              <label for="cloud-recovery" class="text-xs font-medium">Recovery key</label>
              <Input id="cloud-recovery" bind:value={cloudRecoveryKey} placeholder="Dán khi chuyển sang thiết bị mới" />
            </div>
            <div class="grid gap-1.5">
              <label for="cloud-oauth-code" class="text-xs font-medium">Mã OAuth dự phòng</label>
              <div class="grid grid-cols-[1fr_auto] gap-2">
                <Input id="cloud-oauth-code" bind:value={cloudOAuthCode} placeholder="Dán mã từ trình duyệt" />
                <Button variant="secondary" disabled={cloudBusy || !cloudOAuthCode} onclick={verifyOAuthCode}>
                  {#if cloudBusy}<Loader2 class="animate-spin" />{/if}
                  Nhận
                </Button>
              </div>
            </div>
            <p class="text-muted-foreground text-xs">
              OAuth sẽ mở trình duyệt tại máy chủ cloud này. Nếu trình duyệt không tự trả về app, dán mã OAuth dự phòng ở đây.
            </p>
          </div>
        </details>
      {:else}
        <!-- Step 2: add a Zalo account via hosted QR -->
        <div>
          <h2 class="font-display text-xl font-semibold tracking-tight">Thêm tài khoản Zalo</h2>
          <p class="text-muted-foreground mt-1 text-sm">
            Mở Zalo trên điện thoại › quét mã QR bên trái để thêm tài khoản vào cloud.
          </p>
        </div>

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

        <Button variant="outline" disabled={cloudQrBusy || !cloudBaseUrl} onclick={startCloudZaloQr}>
          {#if cloudQrBusy}<Loader2 class="animate-spin" />{:else}<Plus class="size-4" />{/if}
          {cloudQrImage ? "Tạo mã QR mới" : "Thêm tài khoản Zalo"}
        </Button>
      {/if}

      {#if cloudStatus}
        <p class="text-muted-foreground text-xs" role="status">{cloudStatus}</p>
      {/if}
      {#if cloudError}
        <p class="text-destructive text-xs" role="alert">{cloudError}</p>
      {/if}
      {#if session.error}
        <p class="text-destructive text-xs" role="alert">{session.error}</p>
      {/if}
    </div>
  </div>
</div>
