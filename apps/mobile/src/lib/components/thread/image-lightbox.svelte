<script lang="ts">
  // Full-screen image viewer. Shows the attachment large (remote URL, or decrypted
  // bytes for cloud-stored images) and a share button that opens the iOS share
  // sheet via the Web Share API (navigator.share with a File).
  import { onMount } from "svelte";
  import { X, Share } from "@lucide/svelte";
  import type { ChatMessage } from "@zca/types";
  import { session } from "$lib/session-store.svelte";
  import { filePreviewUrl } from "$lib/chat-format";

  interface Props {
    message: ChatMessage;
    onclose: () => void;
  }
  let { message, onclose }: Props = $props();

  let src = $state<string | null>(null);
  let busy = $state(false);
  let objectUrl: string | null = null;

  onMount(() => {
    src = filePreviewUrl(message);
    if (!src && message.file?.id) void loadBytes();
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  });

  async function loadBytes() {
    busy = true;
    const bytes = await session.downloadCloudFileBytes(message);
    if (bytes) {
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: message.file?.mime ?? "image/jpeg" }));
      src = objectUrl;
    }
    busy = false;
  }

  async function share() {
    busy = true;
    try {
      const bytes = await session.downloadCloudFileBytes(message);
      const mime = message.file?.mime ?? "image/jpeg";
      const file = bytes
        ? new File([new Blob([bytes], { type: mime })], message.file?.filename ?? "image.jpg", { type: mime })
        : null;
      if (file && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else if (message.file?.sourceUrl) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(message.file.sourceUrl);
      }
    } catch {
      /* user cancelled the share sheet */
    }
    busy = false;
  }
</script>

<div class="fixed inset-0 z-[60] flex flex-col bg-black">
  <div class="flex items-center justify-between px-2 pt-safe-top">
    <button onclick={onclose} class="flex size-11 items-center justify-center text-white active:opacity-60" aria-label="Đóng">
      <X class="size-7" />
    </button>
    <button
      onclick={share}
      disabled={busy}
      class="flex size-11 items-center justify-center text-white transition-opacity active:opacity-60 disabled:opacity-40"
      aria-label="Chia sẻ"
    >
      <Share class="size-6" />
    </button>
  </div>
  <button class="flex min-h-0 flex-1 items-center justify-center p-2" onclick={onclose} aria-label="Đóng ảnh">
    {#if src}
      <img {src} alt={message.file?.filename ?? "Ảnh"} class="max-h-full max-w-full object-contain" />
    {:else}
      <span class="text-sm text-white/70">{busy ? "Đang tải ảnh…" : "Không tải được ảnh"}</span>
    {/if}
  </button>
</div>
