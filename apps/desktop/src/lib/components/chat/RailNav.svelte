<script lang="ts">
  import { MessageCircle, Users, Cloud, Settings, Plus } from "@lucide/svelte";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { session } from "$lib/session.svelte";

  function initials(name: string | null): string {
    if (!name) return "?";
    const parts = name.trim().split(/\s+/);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (first + last).toUpperCase() || "?";
  }

  function showChats() {
    session.view = "chats";
  }

  function showContacts() {
    session.view = "contacts";
    if (!session.contactsLoaded && session.profile) session.loadContacts();
  }

  // Total unread messages for the active account (sum of per-conversation
  // unread counts). Drives the badge on the "Tin nhắn" rail icon.
  const chatsUnread = $derived(
    session.conversations.reduce((sum, c) => sum + c.unread, 0),
  );

  const navItems = [
    { id: "chats" as const, icon: MessageCircle, label: "Tin nhắn", onClick: showChats },
    { id: "contacts" as const, icon: Users, label: "Danh bạ", onClick: showContacts },
  ];

  const cloudDotClass = $derived(
    session.cloudMode && session.realtimeState === "live"
      ? "bg-green-300"
      : session.cloudMode && (session.realtimeState === "connecting" || session.realtimeState === "reconnecting")
        ? "bg-amber-300"
        : "bg-white/35",
  );
</script>

<nav class="bg-brand text-brand-foreground flex w-16 shrink-0 flex-col items-center gap-1 py-3">
  <!-- Account switcher rail: one avatar per logged-in account -->
  <div class="flex flex-col items-center gap-2 pb-2">
    {#each session.accounts as acc (acc.accountId)}
      <button
        type="button"
        onclick={() => session.switchAccount(acc.accountId)}
        title={acc.displayName ?? acc.accountId}
        aria-label={acc.displayName ?? acc.accountId}
        class="relative rounded-full transition {acc.accountId === session.activeAccountId
          ? 'ring-2 ring-white ring-offset-2 ring-offset-[var(--brand)]'
          : 'opacity-70 hover:opacity-100'}"
      >
        <Avatar.Root class="size-10">
          {#if acc.avatar}
            <Avatar.Image src={acc.avatar} alt={acc.displayName ?? "avatar"} />
          {/if}
          <Avatar.Fallback class="bg-white/20 text-xs font-medium text-white">
            {initials(acc.displayName)}
          </Avatar.Fallback>
        </Avatar.Root>
        {#if acc.unread > 0 && acc.accountId !== session.activeAccountId}
          <span
            class="border-brand absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border-2 bg-red-500 px-1 text-[10px] font-medium text-white"
          >
            {acc.unread > 99 ? "99+" : acc.unread}
          </span>
        {/if}
      </button>
    {/each}

    <!-- Add another account -->
    <button
      type="button"
      onclick={() => session.addAccount()}
      title="Thêm tài khoản"
      aria-label="Thêm tài khoản"
      class="flex size-10 items-center justify-center rounded-full border border-dashed border-white/40 transition-colors hover:bg-white/10"
    >
      <Plus class="size-5" />
    </button>
  </div>

  <div class="mb-2 h-px w-8 bg-white/20"></div>

  {#each navItems as item (item.id)}
    <button
      type="button"
      onclick={item.onClick}
      title={item.label}
      aria-label={item.label}
      class="relative flex size-12 items-center justify-center rounded-xl transition-colors {session.view ===
      item.id
        ? 'bg-white/20'
        : 'hover:bg-white/10'}"
    >
      <item.icon class="size-6" />
      {#if item.id === "chats" && chatsUnread > 0}
        <span
          class="border-brand absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full border-2 bg-red-500 px-1 text-[10px] font-medium text-white"
        >
          {chatsUnread > 9 ? "9+" : chatsUnread}
        </span>
      {/if}
    </button>
  {/each}

  <button
    type="button"
    onclick={() => (session.settingsOpen = true)}
    title={session.cloudMode ? session.realtimeLabel : "Cloud mode"}
    aria-label={session.cloudMode ? session.realtimeLabel : "Cloud mode"}
    class="relative flex size-12 items-center justify-center rounded-xl transition-colors hover:bg-white/10"
  >
    <Cloud class="size-6" />
    <span
      class="absolute right-2 top-2 size-2 rounded-full {cloudDotClass}"
    ></span>
  </button>

  <button
    type="button"
    onclick={() => (session.settingsOpen = true)}
    title="Cài đặt"
    aria-label="Cài đặt"
    class="mt-auto flex size-12 items-center justify-center rounded-xl transition-colors {session.settingsOpen
      ? 'bg-white/20'
      : 'hover:bg-white/10'}"
  >
    <Settings class="size-6" />
  </button>
</nav>
