<script lang="ts">
  // The pushed chat thread: header (back + title + realtime dot), message list,
  // composer. Builds the QuoteInput on reply exactly like the desktop ChatPane.
  import type { ChatMessage, QuoteInput, ReactionIcon, Sticker } from "@zca/types";
  import AppHeader from "$lib/components/shell/app-header.svelte";
  import MessageList from "./message-list.svelte";
  import Composer from "./composer.svelte";
  import ImageLightbox from "./image-lightbox.svelte";
  import StickerSheet from "./sticker-sheet.svelte";
  import { session } from "$lib/session-store.svelte";
  import { nav } from "$lib/nav.svelte";

  interface Props {
    title?: string;
  }
  let { title = "" }: Props = $props();

  let draft = $state("");
  let replyTo = $state<ChatMessage | null>(null);
  let lightbox = $state<ChatMessage | null>(null);
  let stickerOpen = $state(false);

  const convo = $derived(session.activeConversation);
  const headerTitle = $derived(convo?.title ?? title ?? "Hội thoại");
  const dotClass = $derived(
    session.realtimeState === "live"
      ? "bg-green-500"
      : session.realtimeState === "connecting" || session.realtimeState === "reconnecting"
        ? "bg-amber-500"
        : "bg-muted-foreground/40",
  );

  async function send() {
    let quote: QuoteInput | undefined;
    if (replyTo) {
      quote = {
        content: replyTo.body,
        msgType: replyTo.sticker ? "chat.sticker" : "webchat",
        uidFrom: replyTo.outgoing ? (session.profile?.accountId ?? "") : replyTo.id,
        msgId: replyTo.id,
        cliMsgId: replyTo.id,
        ts: replyTo.at,
        ttl: 0,
      };
    }
    const ok = await session.sendActive(draft, quote);
    if (ok) {
      draft = "";
      replyTo = null;
    }
  }

  function react(m: ChatMessage, icon: ReactionIcon) {
    void session.sendReaction(m, icon);
  }

  function pickSticker(s: Sticker) {
    stickerOpen = false;
    void session.sendSticker(s);
  }

  function openFile(m: ChatMessage) {
    if (m.file?.mediaKind === "image") {
      lightbox = m;
      return;
    }
    void shareFile(m);
  }

  // Non-image attachment: decrypt the bytes and present the iOS share sheet via
  // the Web Share API; fall back to opening the source URL in the browser.
  async function shareFile(m: ChatMessage) {
    try {
      const bytes = await session.downloadCloudFileBytes(m);
      const mime = m.file?.mime ?? "application/octet-stream";
      const file = bytes
        ? new File([new Blob([bytes], { type: mime })], m.file?.filename ?? "tệp", { type: mime })
        : null;
      if (file && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else if (m.file?.sourceUrl) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(m.file.sourceUrl);
      }
    } catch {
      /* user cancelled the share sheet */
    }
  }
</script>

<div class="flex h-full flex-col">
  <AppHeader title={headerTitle} onback={() => nav.pop()}>
    {#snippet action()}
      <span class={`mr-2 size-2.5 rounded-full ${dotClass}`} title={session.realtimeLabel} aria-label={session.realtimeLabel}></span>
    {/snippet}
  </AppHeader>

  <MessageList {convo} onreply={(m) => (replyTo = m)} onreact={react} onopenfile={openFile} />

  <Composer
    bind:draft
    {replyTo}
    canAttach={session.canUseCloudFiles}
    onsend={send}
    onattach={() => {}}
    onsticker={() => (stickerOpen = true)}
    oncancelreply={() => (replyTo = null)}
  />
</div>

{#if stickerOpen}
  <StickerSheet onpick={pickSticker} onclose={() => (stickerOpen = false)} />
{/if}

{#if lightbox}
  <ImageLightbox message={lightbox} onclose={() => (lightbox = null)} />
{/if}
