<script lang="ts">
  import { MessageCircle, Users, Cloud, Settings } from "@lucide/svelte";
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

  const navItems = [
    { id: "chats" as const, icon: MessageCircle, label: "Tin nhắn", onClick: showChats },
    { id: "contacts" as const, icon: Users, label: "Danh bạ", onClick: showContacts },
  ];
</script>

<nav class="bg-brand text-brand-foreground flex w-16 shrink-0 flex-col items-center gap-1 py-4">
  <!-- Account avatar with a live-listening status dot -->
  <div class="relative mb-4" title={session.profile?.displayName ?? "Tài khoản"}>
    <Avatar.Root class="size-11 border-2 border-white/40">
      {#if session.profile?.avatar}
        <Avatar.Image src={session.profile.avatar} alt={session.profile.displayName ?? "avatar"} />
      {/if}
      <Avatar.Fallback class="bg-white/20 text-sm font-medium text-white">
        {initials(session.profile?.displayName ?? null)}
      </Avatar.Fallback>
    </Avatar.Root>
    <span
      class="border-brand absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full border-2 {session.listening
        ? 'bg-green-400'
        : 'bg-white/40'}"
      title={session.listening ? "Đang lắng nghe" : "Ngoại tuyến"}
    ></span>
  </div>

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
    </button>
  {/each}

  <button
    type="button"
    title="Cloud"
    aria-label="Cloud"
    class="flex size-12 items-center justify-center rounded-xl transition-colors hover:bg-white/10"
  >
    <Cloud class="size-6" />
  </button>

  <button
    type="button"
    title="Cài đặt"
    aria-label="Cài đặt"
    class="mt-auto flex size-12 items-center justify-center rounded-xl transition-colors hover:bg-white/10"
  >
    <Settings class="size-6" />
  </button>
</nav>
