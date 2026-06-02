<script lang="ts">
  import { Search, Plus } from "@lucide/svelte";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { session } from "$lib/session.svelte";

  let query = $state("");

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
</script>

<aside class="bg-background flex h-full w-80 shrink-0 flex-col overflow-hidden border-r">
  <div class="flex items-center gap-2 p-3">
    <div class="bg-muted flex flex-1 items-center gap-2 rounded-full px-3 py-2">
      <Search class="text-muted-foreground size-4" />
      <input
        bind:value={query}
        placeholder="Tìm kiếm"
        class="placeholder:text-muted-foreground w-full bg-transparent text-sm outline-none"
      />
    </div>
    <button
      type="button"
      title="Cuộc trò chuyện mới"
      aria-label="Cuộc trò chuyện mới"
      class="text-muted-foreground hover:bg-muted flex size-9 items-center justify-center rounded-md"
    >
      <Plus class="size-5" />
    </button>
  </div>

  <ScrollArea class="min-h-0 flex-1">
    {#if filtered.length === 0}
      <div class="text-muted-foreground px-4 py-10 text-center text-sm">
        {#if session.conversations.length === 0}
          Chưa có cuộc trò chuyện. Đăng nhập và lắng nghe để nhận tin nhắn realtime.
        {:else}
          Không tìm thấy kết quả cho "{query}".
        {/if}
      </div>
    {:else}
      <ul>
        {#each filtered as c (c.threadId)}
          <li>
            <button
              type="button"
              onclick={() => session.selectThread(c.threadId)}
              class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors {session.activeThreadId ===
              c.threadId
                ? 'bg-accent'
                : 'hover:bg-muted/60'}"
            >
              <Avatar.Root class="size-12">
                <Avatar.Fallback class="bg-brand/10 text-brand text-sm font-medium">
                  {initials(c.title)}
                </Avatar.Fallback>
              </Avatar.Root>
              <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between gap-2">
                  <span class="truncate text-sm font-medium">{c.title}</span>
                  <span class="text-muted-foreground shrink-0 text-xs">{timeLabel(c.lastAt)}</span>
                </div>
                <div class="flex items-center justify-between gap-2">
                  <span class="text-muted-foreground truncate text-sm">{c.lastSnippet || "—"}</span>
                  {#if c.unread > 0}
                    <span
                      class="bg-destructive flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-medium text-white"
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
