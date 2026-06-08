<script lang="ts">
  // Message composer: sticker toggle, attach, growing text field, send. Shows the
  // reply banner when replying. Padded for the home indicator; the iOS keyboard
  // resizes the webview so the bottom-anchored composer stays visible.
  import type { ChatMessage } from "@zca/types";
  import { Send, Smile, Paperclip } from "@lucide/svelte";
  import ReplyBanner from "./reply-banner.svelte";

  interface Props {
    draft?: string;
    replyTo: ChatMessage | null;
    canAttach: boolean;
    onsend: () => void;
    onattach: () => void;
    onsticker: () => void;
    oncancelreply: () => void;
  }

  let { draft = $bindable(""), replyTo, canAttach, onsend, onattach, onsticker, oncancelreply }: Props = $props();

  function keydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onsend();
    }
  }
</script>

<div class="glass pb-safe-bottom shrink-0 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14)]">
  {#if replyTo}
    <ReplyBanner {replyTo} oncancel={oncancelreply} />
  {/if}
  <div class="flex items-end gap-1.5 px-2 py-2">
    <button
      class="text-muted-foreground active:bg-muted flex size-10 shrink-0 items-center justify-center rounded-full"
      onclick={onsticker}
      aria-label="Sticker"
    >
      <Smile class="size-6" />
    </button>
    <button
      class="text-muted-foreground active:bg-muted flex size-10 shrink-0 items-center justify-center rounded-full disabled:opacity-40"
      onclick={onattach}
      disabled={!canAttach}
      aria-label="Đính kèm tệp"
    >
      <Paperclip class="size-5" />
    </button>
    <textarea
      rows="1"
      value={draft}
      oninput={(e) => (draft = e.currentTarget.value)}
      onkeydown={keydown}
      placeholder="Nhập tin nhắn"
      class="border-input text-foreground max-h-28 min-h-10 flex-1 resize-none rounded-2xl border bg-transparent px-3.5 py-2 text-base outline-none focus:border-ring"
    ></textarea>
    <button
      class="bg-brand text-brand-foreground flex size-10 shrink-0 items-center justify-center rounded-full disabled:opacity-40"
      onclick={onsend}
      disabled={!draft.trim()}
      aria-label="Gửi"
    >
      <Send class="size-5" />
    </button>
  </div>
</div>
