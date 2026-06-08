<script lang="ts">
  // One conversation row: avatar, title (bold when unread), relative time,
  // last-message snippet, and an unread pill. The whole row is a tap target.
  import type { Conversation } from "@zca/types";
  import Avatar from "$lib/components/ui/avatar.svelte";
  import { initials, timeLabel } from "$lib/chat-format";

  interface Props {
    convo: Conversation;
    onselect: () => void;
  }

  let { convo, onselect }: Props = $props();
</script>

<button
  type="button"
  onclick={onselect}
  class="active:bg-muted/60 flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors"
>
  <Avatar src={convo.avatar} alt={convo.title} fallback={initials(convo.title)} class="size-14" />
  <div class="min-w-0 flex-1 border-b border-border/60 pb-2.5">
    <div class="flex items-center justify-between gap-2">
      <span class={`truncate ${convo.unread > 0 ? "font-semibold" : "font-medium"}`}>{convo.title}</span>
      <span class="text-muted-foreground shrink-0 text-xs">{timeLabel(convo.lastAt)}</span>
    </div>
    <div class="mt-0.5 flex items-center justify-between gap-2">
      <span class={`truncate text-sm ${convo.unread > 0 ? "text-foreground" : "text-muted-foreground"}`}>
        {convo.lastSnippet || "—"}
      </span>
      {#if convo.unread > 0}
        <span class="bg-brand flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-medium text-white">
          {convo.unread > 99 ? "99+" : convo.unread}
        </span>
      {/if}
    </div>
  </div>
</button>
