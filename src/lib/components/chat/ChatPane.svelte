<script lang="ts">
  import { Phone, Video, Search, PanelRight, Send, Smile, Paperclip } from "@lucide/svelte";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { session } from "$lib/session.svelte";

  let draft = $state("");
  let scroller = $state<HTMLElement | null>(null);

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

  async function send() {
    const ok = await session.sendActive(draft);
    if (ok) draft = "";
  }
</script>

{#if !convo}
  <section class="bg-muted/30 flex flex-1 flex-col items-center justify-center gap-3 text-center">
    <div class="bg-brand/10 text-brand flex size-20 items-center justify-center rounded-full">
      <Send class="size-9" />
    </div>
    <h2 class="text-xl font-semibold">Chào mừng đến Zalo Desktop</h2>
    <p class="text-muted-foreground max-w-sm text-sm">
      Chọn một cuộc trò chuyện ở bên trái, hoặc đăng nhập và bật lắng nghe để nhận tin nhắn realtime.
    </p>
  </section>
{:else}
  <section class="flex min-h-0 flex-1 flex-col">
    <header class="flex items-center gap-3 border-b px-4 py-3">
      <Avatar.Root class="size-10">
        <Avatar.Fallback class="bg-brand/10 text-brand text-sm font-medium">
          {initials(convo.title)}
        </Avatar.Fallback>
      </Avatar.Root>
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold">{convo.title}</div>
        <div class="text-muted-foreground text-xs">
          {convo.kind === "group" ? "Nhóm" : "Liên hệ"} · {convo.threadId}
        </div>
      </div>
      <div class="text-muted-foreground flex items-center gap-1">
        <button class="hover:bg-muted flex size-9 items-center justify-center rounded-md" title="Gọi thoại" aria-label="Gọi thoại"><Phone class="size-5" /></button>
        <button class="hover:bg-muted flex size-9 items-center justify-center rounded-md" title="Gọi video" aria-label="Gọi video"><Video class="size-5" /></button>
        <button class="hover:bg-muted flex size-9 items-center justify-center rounded-md" title="Tìm trong hội thoại" aria-label="Tìm trong hội thoại"><Search class="size-5" /></button>
        <button class="hover:bg-muted flex size-9 items-center justify-center rounded-md" title="Thông tin" aria-label="Thông tin"><PanelRight class="size-5" /></button>
      </div>
    </header>

    <div bind:this={scroller} class="bg-muted/30 min-h-0 flex-1 overflow-y-auto px-4 py-4">
      {#if messages.length === 0}
        <p class="text-muted-foreground py-10 text-center text-sm">
          Chưa có tin nhắn trong hội thoại này.
        </p>
      {:else}
        <div class="flex flex-col gap-2">
          {#each messages as m (m.id)}
            <div class="flex {m.outgoing ? 'justify-end' : 'justify-start'}">
              <div
                class="max-w-[68%] rounded-2xl px-3.5 py-2 text-sm shadow-sm {m.outgoing
                  ? 'bg-brand text-brand-foreground rounded-br-sm'
                  : 'bg-card rounded-bl-sm'}"
              >
                <p class="whitespace-pre-wrap break-words">{m.body}</p>
                <span class="mt-1 block text-right text-[10px] opacity-60">{clock(m.at)}</span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <footer class="border-t p-3">
      <form class="flex items-center gap-2" onsubmit={(e) => { e.preventDefault(); send(); }}>
        <button type="button" class="text-muted-foreground hover:bg-muted flex size-9 items-center justify-center rounded-md" title="Sticker" aria-label="Sticker"><Smile class="size-5" /></button>
        <button type="button" class="text-muted-foreground hover:bg-muted flex size-9 items-center justify-center rounded-md" title="Đính kèm" aria-label="Đính kèm"><Paperclip class="size-5" /></button>
        <input
          bind:value={draft}
          placeholder={`Nhập tin nhắn tới ${convo.title}`}
          class="border-input bg-background focus-visible:ring-ring flex-1 rounded-full border px-4 py-2 text-sm outline-none focus-visible:ring-2"
        />
        <Button type="submit" size="icon" class="bg-brand hover:bg-brand/90 text-brand-foreground rounded-full" disabled={session.busy || draft.trim().length === 0}>
          <Send class="size-4" />
        </Button>
      </form>
    </footer>
  </section>
{/if}
