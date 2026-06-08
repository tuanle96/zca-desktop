<script lang="ts">
  // "Danh bạ" tab: A–Z grouped contact list with search + refresh. Lazy-loads on
  // first visit (cached per account in the store). Tapping a contact opens the
  // chat thread on the chats stack.
  import { onMount } from "svelte";
  import { RotateCw } from "@lucide/svelte";
  import type { Contact } from "@zca/types";
  import LargeTitle from "$lib/components/shell/large-title.svelte";
  import Screen from "$lib/components/shell/screen.svelte";
  import SearchBar from "$lib/components/conversations/search-bar.svelte";
  import ContactRow from "./contact-row.svelte";
  import { session } from "$lib/session-store.svelte";
  import { nav } from "$lib/nav.svelte";

  let query = $state("");

  onMount(() => {
    if (!session.contactsLoaded) void session.loadContacts();
  });

  const filtered = $derived(
    session.contacts.filter((c) => {
      const q = query.trim().toLowerCase();
      return c.displayName.toLowerCase().includes(q) || (c.zaloName ?? "").toLowerCase().includes(q);
    }),
  );

  const groups = $derived.by(() => {
    const map = new Map<string, Contact[]>();
    const sorted = [...filtered].sort((a, b) => a.displayName.localeCompare(b.displayName, "vi"));
    for (const c of sorted) {
      const ch = c.displayName.trim()[0]?.toUpperCase() ?? "#";
      const key = /\p{L}/u.test(ch) ? ch : "#";
      const bucket = map.get(key) ?? [];
      bucket.push(c);
      map.set(key, bucket);
    }
    return [...map.entries()];
  });

  function openContact(c: Contact) {
    nav.setTab("chats");
    session.openThread(c.userId, c.displayName);
    nav.push("thread", { threadId: c.userId, title: c.displayName });
  }
</script>

<div class="flex h-full flex-col">
  <LargeTitle title="Danh bạ">
    {#snippet action()}
      <button
        onclick={() => session.loadContacts()}
        disabled={session.busy}
        class="text-brand active:bg-muted flex size-9 items-center justify-center rounded-full transition-colors disabled:opacity-50"
        aria-label="Làm mới danh bạ"
      >
        <RotateCw class={`size-5 ${session.busy ? "animate-spin" : ""}`} />
      </button>
    {/snippet}
    {#snippet children()}
      <SearchBar bind:value={query} placeholder="Tìm bạn bè" />
    {/snippet}
  </LargeTitle>

  <Screen class="pb-[calc(env(safe-area-inset-bottom)+88px)]">
    {#if !session.contactsLoaded && session.busy}
      <p class="text-muted-foreground p-10 text-center text-sm">Đang tải danh bạ…</p>
    {:else if session.contacts.length === 0}
      <p class="text-muted-foreground p-10 text-center text-sm">Chưa có liên hệ. Nhấn làm mới để tải.</p>
    {:else if filtered.length === 0}
      <p class="text-muted-foreground p-10 text-center text-sm">Không tìm thấy “{query}”.</p>
    {:else}
      <p class="text-muted-foreground px-4 py-2 text-xs">{filtered.length} liên hệ</p>
      {#each groups as [letter, items] (letter)}
        <div class="bg-muted/40 text-muted-foreground sticky top-0 px-4 py-1 text-xs font-semibold">{letter}</div>
        {#each items as c (c.userId)}
          <ContactRow contact={c} onselect={() => openContact(c)} />
        {/each}
      {/each}
    {/if}
  </Screen>
</div>
