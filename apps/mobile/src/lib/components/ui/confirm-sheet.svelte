<script lang="ts">
  // Bottom-sheet confirmation for destructive actions (iOS action-sheet style).
  import Button from "./button.svelte";

  interface Props {
    title: string;
    message?: string;
    confirmLabel?: string;
    destructive?: boolean;
    busy?: boolean;
    onconfirm: () => void;
    oncancel: () => void;
  }

  let {
    title,
    message = "",
    confirmLabel = "Xác nhận",
    destructive = false,
    busy = false,
    onconfirm,
    oncancel,
  }: Props = $props();
</script>

<div class="fixed inset-0 z-50 flex flex-col justify-end">
  <button class="absolute inset-0 bg-black/40" onclick={oncancel} aria-label="Đóng"></button>
  <div class="bg-background relative z-10 rounded-t-2xl px-4 pb-safe-bottom pt-3">
    <div class="bg-muted-foreground/30 mx-auto mb-3 h-1 w-9 rounded-full"></div>
    <p class="text-center text-base font-semibold">{title}</p>
    {#if message}<p class="text-muted-foreground mt-1 text-center text-sm">{message}</p>{/if}
    <div class="mt-4 flex flex-col gap-2 pb-2">
      <Button variant={destructive ? "destructive" : "default"} disabled={busy} onclick={onconfirm}>{confirmLabel}</Button>
      <Button variant="ghost" onclick={oncancel}>Huỷ</Button>
    </div>
  </div>
</div>
