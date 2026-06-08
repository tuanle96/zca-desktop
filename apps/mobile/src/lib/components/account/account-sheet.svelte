<script lang="ts">
  // Bottom sheet: list linked Zalo accounts (avatar/name/unread/active) to switch
  // between, plus an "add account" row that triggers the QR flow (Phase 4 overlay).
  import { Plus, Check } from "@lucide/svelte";
  import Avatar from "$lib/components/ui/avatar.svelte";
  import { session } from "$lib/session-store.svelte";
  import { initials } from "$lib/chat-format";

  interface Props {
    onclose: () => void;
  }
  let { onclose }: Props = $props();

  function pick(id: string) {
    session.switchAccount(id);
    onclose();
  }
  function add() {
    onclose();
    session.addAccount();
  }
</script>

<div class="fixed inset-0 z-50 flex flex-col justify-end">
  <button class="absolute inset-0 bg-black/40" onclick={onclose} aria-label="Đóng"></button>
  <div class="bg-background relative z-10 rounded-t-2xl pb-safe-bottom">
    <div class="bg-muted-foreground/30 mx-auto my-2 h-1 w-9 rounded-full"></div>
    <p class="text-muted-foreground px-5 pb-1 pt-1 text-xs font-medium">Tài khoản Zalo</p>
    <ul class="px-2">
      {#each session.accounts as a (a.accountId)}
        <li>
          <button
            onclick={() => pick(a.accountId)}
            class="active:bg-muted flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors"
          >
            <Avatar src={a.avatar} alt={a.displayName ?? ""} fallback={initials(a.displayName ?? "?")} class="size-10" />
            <span class="min-w-0 flex-1 truncate font-medium">{a.displayName ?? a.accountId}</span>
            {#if a.unread > 0}
              <span class="bg-brand rounded-full px-2 py-0.5 text-xs font-medium text-white">{a.unread > 99 ? "99+" : a.unread}</span>
            {/if}
            {#if a.accountId === session.activeAccountId}<Check class="text-brand size-5 shrink-0" />{/if}
          </button>
        </li>
      {/each}
    </ul>
    <button
      onclick={add}
      class="text-brand active:bg-muted mx-2 my-1 flex items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors"
      style="width: calc(100% - 1rem)"
    >
      <span class="bg-brand/10 flex size-10 items-center justify-center rounded-full"><Plus class="size-5" /></span>
      <span class="font-medium">Thêm tài khoản Zalo</span>
    </button>
  </div>
</div>
