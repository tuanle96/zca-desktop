<script lang="ts">
  // Cloud Zalo accounts: list + remove (with confirmation). Removing the last
  // account drops back to the add-account gate (handled by the store).
  import { Trash2 } from "@lucide/svelte";
  import AppHeader from "$lib/components/shell/app-header.svelte";
  import Screen from "$lib/components/shell/screen.svelte";
  import Avatar from "$lib/components/ui/avatar.svelte";
  import ConfirmSheet from "$lib/components/ui/confirm-sheet.svelte";
  import { session } from "$lib/session-store.svelte";
  import { initials } from "$lib/chat-format";
  import { nav } from "$lib/nav.svelte";

  let confirmId = $state<string | null>(null);
  const pending = $derived(session.accounts.find((a) => a.accountId === confirmId) ?? null);

  async function remove() {
    if (!confirmId) return;
    await session.logoutAccount(confirmId);
    confirmId = null;
  }
</script>

<div class="flex h-full flex-col">
  <AppHeader title="Tài khoản Zalo" onback={() => nav.pop()} />
  <Screen>
    <div class="mx-4 mt-4 divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60">
      {#each session.accounts as a (a.accountId)}
        <div class="flex items-center gap-3 px-4 py-3">
          <Avatar src={a.avatar} alt={a.displayName ?? ""} fallback={initials(a.displayName ?? "?")} class="size-10" />
          <span class="min-w-0 flex-1 truncate font-medium">{a.displayName ?? a.accountId}</span>
          <button
            onclick={() => (confirmId = a.accountId)}
            class="text-destructive active:bg-muted flex size-9 items-center justify-center rounded-full"
            aria-label="Xoá tài khoản"
          >
            <Trash2 class="size-5" />
          </button>
        </div>
      {/each}
    </div>
    <p class="text-muted-foreground px-5 pt-2 text-xs">Xoá tài khoản khỏi cloud sẽ ngừng đồng bộ hội thoại của tài khoản đó.</p>
  </Screen>
</div>

{#if pending}
  <ConfirmSheet
    title="Xoá tài khoản này?"
    message={`Ngừng đồng bộ ${pending.displayName ?? pending.accountId} khỏi cloud.`}
    confirmLabel="Xoá tài khoản"
    destructive
    busy={session.busy}
    onconfirm={remove}
    oncancel={() => (confirmId = null)}
  />
{/if}
