<script lang="ts">
  // Renders the hosted QR (base64 PNG) with phase overlays: waiting, scanned
  // (name + confirm hint), success, and a retry affordance for terminal errors.
  import { Loader2, RotateCw, Check } from "@lucide/svelte";
  import Button from "$lib/components/ui/button.svelte";
  import { cn } from "$lib/utils";

  interface Props {
    phase: string;
    qrImage: string | null;
    scannedName: string | null;
    error: string;
    onretry: () => void;
  }

  let { phase, qrImage, scannedName, error, onretry }: Props = $props();

  const showRetry = $derived(["expired", "declined", "error"].includes(phase));
  const dim = $derived(phase === "scanned" || phase === "success" || showRetry);

  function terminalLabel(): string {
    if (phase === "expired") return "Mã QR đã hết hạn";
    if (phase === "declined") return "Đăng nhập bị từ chối";
    return error || "QR lỗi";
  }
</script>

<div class="relative mx-auto flex aspect-square w-64 items-center justify-center rounded-2xl border border-border bg-white p-3">
  {#if qrImage}
    <img
      src={`data:image/png;base64,${qrImage}`}
      alt="Mã QR đăng nhập Zalo"
      class={cn("size-full object-contain transition-opacity", dim && "opacity-10")}
    />
  {:else if !showRetry}
    <Loader2 class="text-muted-foreground size-8 animate-spin" />
  {/if}

  {#if phase === "scanned"}
    <div class="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center">
      <div class="bg-brand/10 text-brand flex size-12 items-center justify-center rounded-full">
        <Check class="size-6" />
      </div>
      <p class="text-sm font-semibold">{scannedName || "Đã quét mã"}</p>
      <p class="text-muted-foreground text-xs">Xác nhận trên điện thoại để tiếp tục</p>
    </div>
  {:else if phase === "success"}
    <div class="absolute inset-0 flex items-center justify-center">
      <div class="bg-brand text-brand-foreground flex size-14 items-center justify-center rounded-full">
        <Check class="size-8" />
      </div>
    </div>
  {:else if showRetry}
    <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <p class="text-destructive text-sm">{terminalLabel()}</p>
      <Button variant="outline" onclick={onretry}><RotateCw class="size-4" /> Thử lại</Button>
    </div>
  {/if}
</div>
