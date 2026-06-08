<script lang="ts">
  // Hosted "add a Zalo account" QR flow (desktop step 2). Starts a device-token
  // authed QR, polls status ~1.5s, and on success rides out the backend
  // eventual-consistency window with a connect-retry loop before entering the
  // shell. Shown post-link (no account yet) or as an add-account overlay (Phase 10).
  import { onMount, onDestroy } from "svelte";
  import { QrCode, X } from "@lucide/svelte";
  import { CLOUD_DEVICE_TOKEN_KEYCHAIN, startCloudAccountQr, getCloudQrStatus } from "@zca/core-client";
  import { session } from "$lib/session-store.svelte";
  import { CLOUD_BASE_URL_STORAGE_KEY, DEFAULT_CLOUD_BASE_URL, cloudBaseUrlFromStorage, normalizeCloudBaseUrl } from "$lib/cloudConfig";
  import QrDisplay from "./qr-display.svelte";
  import RecoveryKeyCard from "./recovery-key-card.svelte";
  import Button from "$lib/components/ui/button.svelte";

  interface Props {
    /** True when shown as an overlay to add another account (cancellable). */
    adding?: boolean;
  }
  let { adding = false }: Props = $props();

  const TOKEN = CLOUD_DEVICE_TOKEN_KEYCHAIN;
  let baseUrl = DEFAULT_CLOUD_BASE_URL;
  let flowId = $state("");
  let phase = $state("starting");
  let qrImage = $state<string | null>(null);
  let scannedName = $state<string | null>(null);
  let qrError = $state("");
  let poll: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    if (typeof localStorage !== "undefined") baseUrl = cloudBaseUrlFromStorage(localStorage);
    void start();
  });
  onDestroy(stopPoll);

  function stopPoll() {
    if (poll) {
      clearInterval(poll);
      poll = null;
    }
  }

  async function start() {
    stopPoll();
    qrError = "";
    qrImage = null;
    scannedName = null;
    phase = "starting";
    try {
      baseUrl = normalizeCloudBaseUrl(baseUrl);
      if (typeof localStorage !== "undefined") localStorage.setItem(CLOUD_BASE_URL_STORAGE_KEY, baseUrl);
      const res = await startCloudAccountQr(baseUrl, TOKEN);
      flowId = String(res.flowId ?? "");
      phase = String(res.state ?? "starting");
      if (!flowId) throw new Error("Máy chủ không trả flowId cho QR.");
      await pollOnce();
      poll = setInterval(() => void pollOnce(), 1500);
    } catch (e) {
      phase = "error";
      qrError = String(e);
    }
  }

  async function pollOnce() {
    if (!flowId) return;
    try {
      const status = await getCloudQrStatus(baseUrl, TOKEN, flowId);
      phase = String(status.state ?? "starting");
      if (typeof status.qrImage === "string") qrImage = status.qrImage;
      if (typeof status.displayName === "string") scannedName = status.displayName;
      qrError = typeof status.error === "string" ? status.error : "";

      if (phase === "success") {
        stopPoll();
        // The QR reports success before the account is queryable; connectCloud
        // only flips the gate once it appears, so retry a few times.
        let connected = false;
        for (let attempt = 0; attempt < 8 && !connected; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 750));
          connected = (await session.connectCloud(baseUrl, TOKEN)) === "connected";
        }
        if (connected) {
          if (adding) session.cancelAddAccount();
        } else {
          phase = "error";
          qrError = "Đã thêm vào cloud nhưng chưa nạp được tài khoản. Thử lại hoặc khởi động lại ứng dụng.";
        }
      } else if (["expired", "declined", "error"].includes(phase)) {
        stopPoll();
      }
    } catch (e) {
      stopPoll();
      phase = "error";
      qrError = String(e);
    }
  }
</script>

<div class="bg-background h-dvh overflow-y-auto pt-safe-top pb-safe-bottom">
  <div class="mx-auto flex w-full max-w-md flex-col gap-5 px-5 py-6">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <QrCode class="text-brand size-5" />
        <h1 class="text-lg font-semibold">Thêm tài khoản Zalo</h1>
      </div>
      {#if adding}
        <button
          class="text-muted-foreground active:bg-muted flex size-9 items-center justify-center rounded-full"
          onclick={() => session.cancelAddAccount()}
          aria-label="Đóng"
        >
          <X class="size-5" />
        </button>
      {/if}
    </div>

    {#if session.cloudIssuedRecoveryKey}
      <RecoveryKeyCard recoveryKey={session.cloudIssuedRecoveryKey} />
    {/if}

    <QrDisplay {phase} {qrImage} {scannedName} error={qrError} onretry={start} />

    <p class="text-muted-foreground text-center text-sm">
      Mở Zalo trên điện thoại → <strong>Cài đặt</strong> → quét mã QR ở trên để thêm tài khoản.
    </p>
  </div>
</div>
