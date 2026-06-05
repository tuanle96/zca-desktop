<script lang="ts">
  import { Search, Plus, X } from "@lucide/svelte";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { session } from "$lib/session.svelte";

  let query = $state("");
  let showOpenByUid = $state(false);
  let uidInput = $state("");

  const filtered = $derived(
    session.conversations.filter((c) =>
      c.title.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );

  function initials(name: string): string {
    const parts = name.trim().split(/\s+/);
    const a = parts[0]?.[0] ?? "";
    const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (a + b).toUpperCase() || "?";
  }

  function timeLabel(at: number): string {
    if (!at) return "";
    const mins = Math.floor((Date.now() - at) / 60000);
    if (mins < 1) return "vừa xong";
    if (mins < 60) return `${mins} phút`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} giờ`;
    return `${Math.floor(hrs / 24)} ngày`;
  }

  function openByUid() {
    const id = uidInput.trim();
    if (!id) return;
    session.openThread(id);
    uidInput = "";
    showOpenByUid = false;
  }
</script>

<aside class="bg-background flex h-full w-80 shrink-0 flex-col overflow-hidden border-r">
  <!-- Header: title + new-conversation -->
  <div class="flex items-center justify-between px-4 pt-3.5 pb-1">
    <h1 class="text-lg font-semibold">Tin nhắn</h1>
    <button
      type="button"
      onclick={() => (showOpenByUid = !showOpenByUid)}
      title="Mở hội thoại theo uid"
      aria-label="Mở hội thoại theo uid"
      class="text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 items-center justify-center rounded-md transition-colors"
    >
      {#if showOpenByUid}<X class="size-5" />{:else}<Plus class="size-5" />{/if}
    </button>
  </div>

  <!-- Search -->
  <div class="px-3 pb-2">
    <div class="bg-muted flex items-center gap-2 rounded-full px-3 py-2">
      <Search class="text-muted-foreground size-4" />
      <input
        bind:value={query}
        placeholder="Tìm kiếm"
        class="placeholder:text-muted-foreground w-full bg-transparent text-sm outline-none"
      />
    </div>
  </div>

  <!-- Open-by-uid composer (folds out from the + button) -->
  {#if showOpenByUid}
    <div class="bg-muted/40 flex items-center gap-2 border-y px-3 py-2">
      <input
        bind:value={uidInput}
        placeholder="Mở hội thoại theo uid…"
        class="border-input bg-background flex-1 rounded-md border px-2.5 py-1.5 text-xs outline-none"
        onkeydown={(e) => { if (e.key === "Enter") openByUid(); }}
      />
      <button
        type="button"
        onclick={openByUid}
        disabled={uidInput.trim().length === 0}
        class="bg-brand text-brand-foreground hover:bg-brand/90 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
      >
        Mở
      </button>
    </div>
  {/if}

  <ScrollArea class="min-h-0 flex-1">
    {#if filtered.length === 0}
      <div class="text-muted-foreground flex flex-col items-center gap-2 px-6 py-12 text-center text-sm">
        {#if session.conversations.length === 0}
          <span>Chưa có cuộc trò chuyện.</span>
          <span class="text-xs">Tin nhắn mới sẽ xuất hiện ở đây sau khi cloud đồng bộ hội thoại.</span>
        {:else}
          Không tìm thấy kết quả cho "{query}".
        {/if}
      </div>
    {:else}
      <ul class="py-1">
        {#each filtered as c (c.threadId)}
          <li>
            <button
              type="button"
              onclick={() => session.selectThread(c.threadId)}
              class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors {session.activeThreadId ===
              c.threadId
                ? 'bg-brand/10'
                : 'hover:bg-muted/60'}"
            >
              <Avatar.Root class="size-12 shrink-0">
                {#if c.avatar}
                  <Avatar.Image src={c.avatar} alt={c.title} />
                {/if}
                <Avatar.Fallback class="bg-brand/10 text-brand text-sm font-medium">
                  {initials(c.title)}
                </Avatar.Fallback>
              </Avatar.Root>
              <div class="min-w-0 flex-1 border-b pb-2.5 -mb-2.5">
                <div class="flex items-center justify-between gap-2">
                  <span class="truncate text-sm font-medium {c.unread > 0 ? 'font-semibold' : ''}">{c.title}</span>
                  <span class="text-muted-foreground shrink-0 text-xs">{timeLabel(c.lastAt)}</span>
                </div>
                <div class="mt-0.5 flex items-center justify-between gap-2">
                  <span class="text-muted-foreground truncate text-sm {c.unread > 0 ? 'text-foreground' : ''}">{c.lastSnippet || "—"}</span>
                  {#if c.unread > 0}
                    <span
                      class="bg-brand flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-medium text-white"
                    >
                      {c.unread}
                    </span>
                  {/if}
                </div>
              </div>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </ScrollArea>
</aside>
