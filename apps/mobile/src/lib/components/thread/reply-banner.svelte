<script lang="ts">
  // Quoted-message preview shown above the composer while replying.
  import type { ChatMessage } from "@zca/types";
  import { Reply, X } from "@lucide/svelte";

  interface Props {
    replyTo: ChatMessage;
    oncancel: () => void;
  }

  let { replyTo, oncancel }: Props = $props();
</script>

<div class="bg-muted/50 flex items-center gap-2 border-t border-border px-3 py-2">
  <Reply class="text-brand size-4 shrink-0" />
  <div class="min-w-0 flex-1">
    <p class="text-brand text-xs font-medium">Đang trả lời {replyTo.authorName ?? ""}</p>
    <p class="text-muted-foreground truncate text-xs">{replyTo.sticker ? "[Sticker]" : replyTo.body}</p>
  </div>
  <button
    onclick={oncancel}
    aria-label="Hủy trả lời"
    class="text-muted-foreground active:bg-muted flex size-8 items-center justify-center rounded-full"
  >
    <X class="size-4" />
  </button>
</div>
