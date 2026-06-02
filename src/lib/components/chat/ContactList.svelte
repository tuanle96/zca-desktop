<script lang="ts">
  import { Search, RefreshCw } from "@lucide/svelte";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { session } from "$lib/session.svelte";

  let query = $state("");

  const filtered = $derived(
    session.contacts.filter((c) =>
      `${c.displayName} ${c.zaloName ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );

  // Group by first letter of display name for an address-book feel.
  const groups = $derived(
    (() => {
      const map = new Map<string, typeof session.contacts>();
      for (const c of filtered) {
        const key = (c.displayName[0] ?? "#").toUpperCase();
        const letter = /[A-Z]/.test(key) ? key : "#";
        if (!map.has(letter)) map.set(letter, []);
        map.get(letter)!.push(c);
      }
      return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    })(),
  );

  function initials(name: string): string {
    const parts = name.trim().split(/\s+/);
    const a = parts[0]?.[0] ?? "";
    const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (a + b).toUpperCase() || "?";
  }
</script>

<aside class="bg-background flex h-full w-80 shrink-0 flex-col overflow-hidden border-r">
  <div class="flex items-center gap-2 p-3">
    <div class="bg-muted flex flex-1 items-center gap-2 rounded-full px-3 py-2">
      <Search class="text-muted-foreground size-4" />
      <input
        bind:value={query}
        placeholder="Tìm bạn bè"
        class="placeholder:text-muted-foreground w-full bg-transparent text-sm outline-none"
      />
    </div>
    <button
      type="button"
      onclick={() => session.loadContacts()}
      title="Tải lại danh bạ"
      aria-label="Tải lại danh bạ"
      class="text-muted-foreground hover:bg-muted flex size-9 items-center justify-center rounded-md"
    >
      <RefreshCw class="size-4 {session.busy ? 'animate-spin' : ''}" />
    </button>
  </div>

  <div class="text-muted-foreground px-3 pb-2 text-xs">
    {session.contacts.length} liên hệ
  </div>

  <ScrollArea class="min-h-0 flex-1">
    {#if !session.profile}
      <div class="text-muted-foreground px-4 py-10 text-center text-sm">
        Đăng nhập để xem danh bạ.
      </div>
    {:else if !session.contactsLoaded}
      <div class="text-muted-foreground px-4 py-10 text-center text-sm">
        Đang tải danh bạ…
      </div>
    {:else if filtered.length === 0}
      <div class="text-muted-foreground px-4 py-10 text-center text-sm">
        {session.contacts.length === 0 ? "Không có liên hệ nào." : `Không tìm thấy "${query}".`}
      </div>
    {:else}
      {#each groups as [letter, people] (letter)}
        <div class="bg-muted/40 text-muted-foreground px-4 py-1 text-xs font-medium">{letter}</div>
        <ul>
          {#each people as c (c.userId)}
            <li>
              <button
                type="button"
                onclick={() => session.startChatWith(c)}
                class="hover:bg-muted/60 flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors"
              >
                <Avatar.Root class="size-10">
                  {#if c.avatar}
                    <Avatar.Image src={c.avatar} alt={c.displayName} />
                  {/if}
                  <Avatar.Fallback class="bg-brand/10 text-brand text-sm font-medium">
                    {initials(c.displayName)}
                  </Avatar.Fallback>
                </Avatar.Root>
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium">{c.displayName}</div>
                  {#if c.zaloName && c.zaloName !== c.displayName}
                    <div class="text-muted-foreground truncate text-xs">{c.zaloName}</div>
                  {/if}
                </div>
              </button>
            </li>
          {/each}
        </ul>
      {/each}
    {/if}
  </ScrollArea>
</aside>
