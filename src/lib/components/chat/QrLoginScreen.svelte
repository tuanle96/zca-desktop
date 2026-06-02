<script lang="ts">
  import { onMount } from "svelte";
  import { Loader2, RotateCw, CircleCheck, Smartphone, ScanLine, LogIn, X } from "@lucide/svelte";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { session } from "$lib/session.svelte";

  // `adding` = shown as an overlay to add another account (cancellable);
  // otherwise this is the full-screen login gate (auto-starts the flow).
  let { adding = false }: { adding?: boolean } = $props();

  onMount(() => {
    if (!adding) session.startQrLogin();
  });

  const showRetry = $derived(
    session.qrPhase === "expired" ||
      session.qrPhase === "declined" ||
      session.qrPhase === "error",
  );

  const dimQr = $derived(session.qrPhase === "scanned" || showRetry);

  const errorText = $derived.by(() => {
    switch (session.qrPhase) {
      case "expired":
        return "Mã QR đã hết hạn";
      case "declined":
        return "Đăng nhập bị từ chối";
      case "error":
        return session.qrError || "Đã xảy ra lỗi";
      default:
        return "";
    }
  });

  const steps = [
    { icon: Smartphone, text: "Mở ứng dụng Zalo trên điện thoại của bạn" },
    { icon: ScanLine, text: "Chọn biểu tượng quét mã QR trên thanh tìm kiếm" },
    { icon: LogIn, text: "Quét mã QR ở bên để đăng nhập" },
  ];

  function initials(name: string | null): string {
    if (!name) return "?";
    const parts = name.trim().split(/\s+/);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (first + last).toUpperCase() || "?";
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
      <p class="text-muted-foreground mt-1 text-sm">Đăng nhập Zalo Desktop</p>

      <div class="relative mt-7 flex size-64 items-center justify-center rounded-xl border p-3">
        {#if session.qrImage}
          <img
            src={`data:image/png;base64,${session.qrImage}`}
            alt="Mã QR đăng nhập Zalo"
            class="size-full object-contain transition {dimQr ? 'opacity-10 blur-sm' : ''}"
          />
        {:else}
          <Loader2 class="text-muted-foreground size-12 animate-spin" />
        {/if}

        {#if session.qrPhase === "success"}
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-green-600">
            <CircleCheck class="size-16" />
            <span class="text-foreground text-sm font-medium">Đăng nhập thành công</span>
          </div>
        {:else if session.qrPhase === "scanned"}
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <Avatar.Root class="size-16 ring-brand/30 ring-2">
              {#if session.qrScannedAvatar}
                <Avatar.Image src={session.qrScannedAvatar} alt={session.qrScannedName ?? "avatar"} />
              {/if}
              <Avatar.Fallback class="bg-brand/15 text-brand text-lg font-medium">
                {initials(session.qrScannedName)}
              </Avatar.Fallback>
            </Avatar.Root>
            {#if session.qrScannedName}
              <span class="text-sm font-semibold">{session.qrScannedName}</span>
            {/if}
            <span class="text-muted-foreground text-xs">Xác nhận trên điện thoại</span>
          </div>
        {:else if showRetry}
          <button
            type="button"
            onclick={() => session.startQrLogin()}
            disabled={session.busy}
            class="absolute inset-0 flex flex-col items-center justify-center gap-2"
            aria-label="Tải lại mã QR"
          >
            <span class="bg-brand text-brand-foreground flex size-14 items-center justify-center rounded-full shadow">
              <RotateCw class="size-7" />
            </span>
            <span class="text-foreground text-sm font-medium">Bấm để tải lại</span>
          </button>
        {/if}
      </div>

      <!-- Status line: countdown / scanned / error -->
      <div class="mt-4 h-5 text-sm">
        {#if errorText}
          <span class="text-destructive font-medium" role="alert">{errorText}</span>
        {:else if session.qrPhase === "scanned"}
          <span class="text-green-600" role="status">Đã quét — xác nhận trên điện thoại.</span>
        {:else if session.qrPhase === "waiting-scan" && session.qrSecondsLeft > 0}
          <span class="text-muted-foreground" role="status">
            Mã QR hết hạn sau <span class="text-foreground font-semibold tabular-nums">{session.qrSecondsLeft}s</span>
          </span>
        {/if}
      </div>
    </div>

    <!-- Right: instructions -->
    <div class="hidden w-72 flex-col justify-center gap-6 px-8 py-10 sm:flex">
      <h2 class="text-base font-semibold">Đăng nhập bằng mã QR</h2>
      <ol class="flex flex-col gap-5">
        {#each steps as step, i (i)}
          <li class="flex items-start gap-3">
            <span class="bg-brand/10 text-brand flex size-9 shrink-0 items-center justify-center rounded-lg">
              <step.icon class="size-5" />
            </span>
            <span class="text-muted-foreground pt-1.5 text-sm">{step.text}</span>
          </li>
        {/each}
      </ol>

      {#if !adding}
        <button
          type="button"
          onclick={() => session.loginAndListen()}
          disabled={session.busy}
          class="text-muted-foreground/70 hover:text-foreground mt-2 self-start text-xs underline underline-offset-2 transition"
        >
          Đăng nhập từ phiên đã lưu
        </button>
      {/if}

      {#if session.error && !errorText}
        <p class="text-destructive text-xs" role="alert">{session.error}</p>
      {/if}
    </div>
  </div>
</div>
