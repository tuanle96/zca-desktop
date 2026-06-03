<script lang="ts">
  import { Phone, Video, Search, PanelRight, Send, Smile, Paperclip, MessageCircle } from "@lucide/svelte";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { session } from "$lib/session.svelte";
  import StickerPicker from "./StickerPicker.svelte";
  import type { Sticker } from "$lib/types";

  let draft = $state("");
  let scroller = $state<HTMLElement | null>(null);
  let showStickers = $state(false);

  const convo = $derived(session.activeConversation);
  const messages = $derived(session.activeMessages);

  // Autoscroll to the newest message when the active thread's list grows.
  $effect(() => {
    void messages.length;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });

  function initials(name: string): string {
    const parts = name.trim().split(/\s+/);
    const a = parts[0]?.[0] ?? "";
    const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (a + b).toUpperCase() || "?";
  }

  function clock(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // Show a day separator when the calendar day changes between messages.
  function dayLabel(at: number): string {
    const d = new Date(at);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    return isToday ? "Hôm nay" : d.toLocaleDateString("vi-VN");
  }

  function showDaySep(i: number): boolean {
    if (i === 0) return true;
    return dayLabel(messages[i].at) !== dayLabel(messages[i - 1].at);
  }

  async function send() {
    const ok = await session.sendActive(draft);
    if (ok) draft = "";
  }

  async function pickSticker(sticker: Sticker) {
    showStickers = false;
    await session.sendSticker(sticker);
  }
</script>

{#if !convo}
  <section class="bg-muted/20 flex flex-1 flex-col items-center justify-center gap-4 text-center">
    <div class="bg-brand/10 text-brand flex size-24 items-center justify-center rounded-full">
      <MessageCircle class="size-11" />
    </div>
    <div class="space-y-1.5">
      <h2 class="text-xl font-semibold">Chào mừng đến Zalo Desktop</h2>
      <p class="text-muted-foreground mx-auto max-w-sm text-sm">
        Chọn một cuộc trò chuyện ở bên trái, hoặc mở danh bạ để bắt đầu trò chuyện.
      </p>
    </div>
    {#if session.profile}
      <div class="text-muted-foreground mt-2 flex items-center gap-1.5 text-xs">
        <span class="size-2 rounded-full {session.listening ? 'bg-green-500' : 'bg-muted-foreground/40'}"></span>
        {session.listening ? "Đang lắng nghe tin nhắn realtime" : "Chưa lắng nghe"}
      </div>
    {/if}
  </section>
{:else}
  <section class="bg-muted/20 flex min-h-0 flex-1 flex-col">
    <!-- Header -->
    <header class="bg-background flex items-center gap-3 border-b px-4 py-2.5">
      <Avatar.Root class="size-10 shrink-0">
        {#if convo.avatar}
          <Avatar.Image src={convo.avatar} alt={convo.title} />
        {/if}
        <Avatar.Fallback class="bg-brand/10 text-brand text-sm font-medium">
          {initials(convo.title)}
        </Avatar.Fallback>
      </Avatar.Root>
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold">{convo.title}</div>
        <div class="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span class="size-1.5 rounded-full {session.listening ? 'bg-green-500' : 'bg-muted-foreground/40'}"></span>
          {convo.kind === "group" ? "Nhóm" : "Liên hệ"}
        </div>
      </div>
      <div class="text-muted-foreground flex items-center gap-0.5">
        <button class="hover:bg-muted hover:text-foreground flex size-9 items-center justify-center rounded-md transition-colors" title="Gọi thoại" aria-label="Gọi thoại"><Phone class="size-5" /></button>
        <button class="hover:bg-muted hover:text-foreground flex size-9 items-center justify-center rounded-md transition-colors" title="Gọi video" aria-label="Gọi video"><Video class="size-5" /></button>
        <button class="hover:bg-muted hover:text-foreground flex size-9 items-center justify-center rounded-md transition-colors" title="Tìm trong hội thoại" aria-label="Tìm trong hội thoại"><Search class="size-5" /></button>
        <button class="hover:bg-muted hover:text-foreground flex size-9 items-center justify-center rounded-md transition-colors" title="Thông tin" aria-label="Thông tin"><PanelRight class="size-5" /></button>
      </div>
    </header>

    <!-- Messages -->
    <div bind:this={scroller} class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      {#if messages.length === 0}
        <p class="text-muted-foreground py-10 text-center text-sm">
          Chưa có tin nhắn trong hội thoại này. Hãy gửi lời chào.
        </p>
      {:else}
        <div class="mx-auto flex max-w-3xl flex-col gap-1.5">
          {#each messages as m, i (m.id)}
            {#if showDaySep(i)}
              <div class="my-2 flex justify-center">
                <span class="bg-muted text-muted-foreground rounded-full px-3 py-0.5 text-xs">{dayLabel(m.at)}</span>
              </div>
            {/if}
            <div class="flex {m.outgoing ? 'justify-end' : 'justify-start'}">
              {#if m.sticker}
                <div class="flex flex-col {m.outgoing ? 'items-end' : 'items-start'}">
                  <img
                    src={m.sticker.url}
                    alt="sticker"
                    class="size-32 object-contain"
                    loading="lazy"
                  />
                  <span class="text-muted-foreground mt-0.5 text-[10px]">{clock(m.at)}</span>
                </div>
              {:else}
                <div
                  class="max-w-[68%] rounded-2xl px-3.5 py-2 text-sm shadow-sm {m.outgoing
                    ? 'bg-brand text-brand-foreground rounded-br-md'
                    : 'bg-background rounded-bl-md'}"
                >
                  <p class="whitespace-pre-wrap break-words">{m.body}</p>
                  <span class="mt-1 block text-right text-[10px] opacity-60">{clock(m.at)}</span>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Composer -->
    <footer class="bg-background border-t px-3 py-2.5">
      <div class="relative">
        {#if showStickers}
          <!-- Click-away backdrop closes the picker. -->
          <button
            type="button"
            class="fixed inset-0 z-40 cursor-default"
            aria-label="Đóng bảng sticker"
            onclick={() => (showStickers = false)}
          ></button>
          <div class="absolute bottom-2 left-0 z-50">
            <StickerPicker onpick={pickSticker} />
          </div>
        {/if}
        <form class="flex items-center gap-1.5" onsubmit={(e) => { e.preventDefault(); send(); }}>
          <button
            type="button"
            onclick={() => (showStickers = !showStickers)}
            class="flex size-9 items-center justify-center rounded-md transition-colors {showStickers
              ? 'bg-brand/10 text-brand'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
            title="Sticker"
            aria-label="Sticker"
          >
            <Smile class="size-5" />
          </button>
          <button type="button" class="text-muted-foreground hover:bg-muted hover:text-foreground flex size-9 items-center justify-center rounded-md transition-colors" title="Đính kèm" aria-label="Đính kèm"><Paperclip class="size-5" /></button>
          <input
            bind:value={draft}
            placeholder={`Nhập tin nhắn tới ${convo.title}`}
            class="border-input bg-background focus-visible:ring-brand/40 flex-1 rounded-full border px-4 py-2 text-sm outline-none focus-visible:ring-2"
          />
          <Button type="submit" size="icon" class="bg-brand hover:bg-brand/90 text-brand-foreground rounded-full" disabled={session.busy || draft.trim().length === 0}>
            <Send class="size-4" />
          </Button>
        </form>
      </div>
    </footer>
  </section>
{/if}
