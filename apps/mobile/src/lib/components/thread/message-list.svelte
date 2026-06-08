<script lang="ts">
  // Scrollable message region with day separators, sender grouping, and
  // autoscroll-to-newest.
  import type { ChatMessage, Conversation, ReactionIcon } from "@zca/types";
  import MessageBubble from "./message-bubble.svelte";
  import { dayLabel } from "$lib/chat-format";
  import { session } from "$lib/session-store.svelte";

  interface Props {
    convo: Conversation | null;
    onreply: (m: ChatMessage) => void;
    onreact: (m: ChatMessage, icon: ReactionIcon) => void;
    onopenfile: (m: ChatMessage) => void;
  }

  let { convo, onreply, onreact, onopenfile }: Props = $props();

  let scroller = $state<HTMLElement | null>(null);
  const messages = $derived(session.activeMessages);

  const GROUP_GAP_MS = 5 * 60 * 1000;

  function showDaySep(i: number): boolean {
    if (i === 0) return true;
    return dayLabel(messages[i].at) !== dayLabel(messages[i - 1].at);
  }

  function sameSender(a: ChatMessage, b: ChatMessage): boolean {
    if (a.outgoing !== b.outgoing) return false;
    if (a.outgoing) return true;
    return (a.authorName ?? "") === (b.authorName ?? "");
  }

  /** True when message i starts a new sender group (vs. the message before it). */
  function startsGroup(i: number): boolean {
    if (i === 0 || showDaySep(i)) return true;
    const prev = messages[i - 1];
    const cur = messages[i];
    return !sameSender(prev, cur) || cur.at - prev.at > GROUP_GAP_MS;
  }

  // Autoscroll to the newest message whenever the list grows.
  $effect(() => {
    void messages.length;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });
</script>

<div bind:this={scroller} class="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-3 pt-1">
  {#if messages.length === 0}
    <p class="text-muted-foreground m-auto px-6 text-center text-sm">Chưa có tin nhắn trong hội thoại này.</p>
  {:else}
    {#each messages as m, i (m.id)}
      {#if showDaySep(i)}
        <div class="my-2 flex justify-center">
          <span class="bg-muted text-muted-foreground rounded-full px-2.5 py-0.5 text-[11px]">{dayLabel(m.at)}</span>
        </div>
      {/if}
      <MessageBubble
        message={m}
        {convo}
        first={startsGroup(i)}
        last={i === messages.length - 1 || startsGroup(i + 1)}
        {onreply}
        {onreact}
        {onopenfile}
      />
    {/each}
  {/if}
</div>
