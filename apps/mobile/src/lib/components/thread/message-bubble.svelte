<script lang="ts">
  // One message. Consecutive messages from the same sender are grouped: the
  // avatar/name show once (group edges) and the timestamp shows on the last of a
  // group (iMessage-style). A dropped reaction sits as a pill on the bubble corner.
  // Long-press a text bubble to open the reaction bar.
  import type { ChatMessage, Conversation, ReactionIcon } from "@zca/types";
  import Avatar from "$lib/components/ui/avatar.svelte";
  import LinkPreview from "./link-preview.svelte";
  import FileCard from "./file-card.svelte";
  import ReactionBar from "./reaction-bar.svelte";
  import { clock, initials } from "$lib/chat-format";

  interface Props {
    message: ChatMessage;
    convo: Conversation | null;
    first?: boolean;
    last?: boolean;
    onreply: (m: ChatMessage) => void;
    onreact: (m: ChatMessage, icon: ReactionIcon) => void;
    onopenfile: (m: ChatMessage) => void;
  }

  let { message, convo, first = true, last = true, onreply, onreact, onopenfile }: Props = $props();

  let showActions = $state(false);
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;

  const isGroup = $derived(convo?.kind === "group");
  const showAvatar = $derived(!message.outgoing && isGroup && last);
  const showName = $derived(!message.outgoing && isGroup && first);
  const canReact = $derived(!message.deleted && !message.sticker && !message.file);

  function startHold(e: PointerEvent) {
    if (!canReact) return;
    startX = e.clientX;
    startY = e.clientY;
    holdTimer = setTimeout(() => (showActions = true), 450);
  }
  function moveHold(e: PointerEvent) {
    if (holdTimer && (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10)) cancelHold();
  }
  function cancelHold() {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }
  function doReact(icon: ReactionIcon) {
    onreact(message, icon);
    showActions = false;
  }
  function doReply() {
    onreply(message);
    showActions = false;
  }
</script>

{#if showActions}
  <button class="fixed inset-0 z-40 cursor-default" onclick={() => (showActions = false)} aria-label="Đóng"></button>
{/if}

<div class={`flex gap-2 px-3 ${first ? "mt-3" : "mt-0.5"} ${message.outgoing ? "flex-row-reverse" : "flex-row"}`}>
  {#if !message.outgoing && isGroup}
    {#if showAvatar}
      <Avatar
        src={message.authorAvatar}
        alt={message.authorName ?? ""}
        fallback={initials(message.authorName ?? "?")}
        class="size-7 self-end"
      />
    {:else}
      <div class="w-7 shrink-0"></div>
    {/if}
  {/if}

  <div class={`relative flex min-w-0 flex-col ${message.outgoing ? "items-end" : "items-start"}`}>
    {#if showName}
      <span class="text-muted-foreground mb-0.5 px-1 text-xs">{message.authorName}</span>
    {/if}

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="relative max-w-[78vw]"
      onpointerdown={startHold}
      onpointermove={moveHold}
      onpointerup={cancelHold}
      onpointercancel={cancelHold}
    >
      {#if showActions}
        <div class={`absolute bottom-full z-50 mb-1 ${message.outgoing ? "right-0" : "left-0"}`}>
          <ReactionBar onreact={doReact} onreply={doReply} />
        </div>
      {/if}

      {#if message.deleted}
        <div class="text-muted-foreground rounded-2xl border border-dashed border-border px-3 py-2 text-sm italic">
          Tin nhắn đã được thu hồi
        </div>
      {:else if message.sticker}
        <img src={message.sticker.url} alt="Sticker" class="size-28 object-contain" />
      {:else if message.file}
        <FileCard {message} onopen={() => onopenfile(message)} />
      {:else}
        <div
          class={message.outgoing
            ? "bg-brand text-brand-foreground rounded-2xl rounded-br-md px-3.5 py-2 text-sm"
            : "bg-secondary rounded-2xl rounded-bl-md px-3.5 py-2 text-sm"}
        >
          {#if message.quote}
            <div
              class={`mb-1 border-l-2 pl-2 text-xs ${
                message.outgoing ? "border-brand-foreground/40 text-brand-foreground/80" : "border-brand/40 text-muted-foreground"
              }`}
            >
              {message.quote.msg}
            </div>
          {/if}
          <p class="whitespace-pre-wrap break-words">{message.body}</p>
          {#if message.link}<LinkPreview link={message.link} />{/if}
        </div>
      {/if}

      {#if message.reactionIcon && !message.deleted}
        <span
          class={`bg-background border-border absolute -bottom-2.5 z-10 rounded-full border px-1 py-0.5 text-xs leading-none shadow-sm ${
            message.outgoing ? "left-1" : "right-1"
          }`}
        >
          {message.reactionIcon}
        </span>
      {/if}
    </div>

    {#if last}
      <span class={`text-muted-foreground mt-1 px-1 text-[10px] ${message.reactionIcon ? "pt-1.5" : ""}`}>
        {clock(message.at)}
      </span>
    {/if}
  </div>
</div>
