<script lang="ts">
  // "Tin nhắn" tab: iOS large-title + search + conversation list. Tapping a row
  // opens the thread (push). The header "+" folds out an open-by-uid composer.
  import { Plus, X } from "@lucide/svelte";
  import LargeTitle from "$lib/components/shell/large-title.svelte";
  import Screen from "$lib/components/shell/screen.svelte";
  import AccountSwitcher from "$lib/components/account/account-switcher.svelte";
  import AccountSheet from "$lib/components/account/account-sheet.svelte";
  import SearchBar from "./search-bar.svelte";
  import OpenByUid from "./open-by-uid.svelte";
  import ConversationRow from "./conversation-row.svelte";
  import { session } from "$lib/session-store.svelte";
  import { nav } from "$lib/nav.svelte";

  let query = $state("");
  let showOpenByUid = $state(false);
  let accountSheetOpen = $state(false);

  // Quick-toggle: with exactly 2 accounts, tapping the avatar switches directly;
  // otherwise open the account sheet (1 account → add, 3+ → pick).
  function onAvatarTap() {
    if (session.accounts.length === 2) {
      const other = session.accounts.find((a) => a.accountId !== session.activeAccountId);
      if (other) {
        session.switchAccount(other.accountId);
        return;
      }
    }
    accountSheetOpen = true;
  }

  const filtered = $derived(
    session.conversations.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase())),
  );

  function open(threadId: string, title: string) {
    session.selectThread(threadId);
    nav.push("thread", { threadId, title });
  }

  function openByUid(uid: string) {
    session.openThread(uid);
    showOpenByUid = false;
    open(uid, uid);
  }
</script>

<div class="flex h-full flex-col">
  <LargeTitle title="Tin nhắn">
    {#snippet action()}
      <div class="flex items-center gap-1.5">
        <AccountSwitcher onopen={onAvatarTap} />
        <button
          class="text-brand active:bg-muted flex size-9 items-center justify-center rounded-full transition-colors"
          onclick={() => (showOpenByUid = !showOpenByUid)}
          aria-label="Mở hội thoại theo uid"
        >
          {#if showOpenByUid}<X class="size-6" />{:else}<Plus class="size-6" strokeWidth={2.2} />{/if}
        </button>
      </div>
    {/snippet}
    {#snippet children()}
      <SearchBar bind:value={query} />
    {/snippet}
  </LargeTitle>

  {#if showOpenByUid}
    <OpenByUid onopen={openByUid} />
  {/if}

  <Screen class="pb-[calc(env(safe-area-inset-bottom)+88px)]">
    {#if filtered.length === 0}
      <div class="text-muted-foreground flex flex-col items-center gap-2 px-6 py-16 text-center text-sm">
        {#if session.conversations.length === 0}
          <span>Chưa có cuộc trò chuyện.</span>
          <span class="text-xs">Tin nhắn sẽ xuất hiện ở đây sau khi cloud đồng bộ hội thoại.</span>
        {:else}
          Không tìm thấy kết quả cho “{query}”.
        {/if}
      </div>
    {:else}
      <ul class="py-1">
        {#each filtered as c (c.threadId)}
          <li><ConversationRow convo={c} onselect={() => open(c.threadId, c.title)} /></li>
        {/each}
      </ul>
    {/if}
  </Screen>
</div>

{#if accountSheetOpen}
  <AccountSheet onclose={() => (accountSheetOpen = false)} />
{/if}
