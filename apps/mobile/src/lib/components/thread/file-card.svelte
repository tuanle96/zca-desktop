<script lang="ts">
  // File / image attachment card. Images render an inline preview; other files
  // show an icon + name + meta. Tapping invokes `onopen` (download/open behavior
  // is wired in Phase 8; the UI is complete here).
  import type { ChatMessage } from "@zca/types";
  import { FileText, Download } from "@lucide/svelte";
  import { fileExtension, fileMeta, filePreviewUrl } from "$lib/chat-format";

  interface Props {
    message: ChatMessage;
    onopen: () => void;
  }

  let { message, onopen }: Props = $props();

  const preview = $derived(filePreviewUrl(message));
  const isImage = $derived(message.file?.mediaKind === "image" && Boolean(preview));
</script>

{#if isImage && preview}
  <button onclick={onopen} class="block max-w-[72%] overflow-hidden rounded-2xl">
    <img src={preview} alt={message.file?.filename ?? "Ảnh"} class="max-h-72 w-full object-cover" />
  </button>
{:else}
  <button
    onclick={onopen}
    class={`flex max-w-[80%] items-center gap-3 rounded-2xl border p-2.5 text-left ${
      message.outgoing ? "border-brand/20 bg-brand/10" : "border-border bg-background"
    }`}
  >
    <div class="bg-slate-700 flex size-10 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold text-white">
      {fileExtension(message.file?.filename)}
    </div>
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium">{message.file?.filename ?? "Tệp đính kèm"}</p>
      <p class="text-muted-foreground text-xs">{fileMeta(message)}</p>
    </div>
    {#if message.file?.id}
      <Download class="text-muted-foreground size-4 shrink-0" />
    {:else}
      <FileText class="text-muted-foreground size-4 shrink-0" />
    {/if}
  </button>
{/if}
