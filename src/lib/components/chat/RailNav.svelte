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
</script>

<nav class="bg-brand text-brand-foreground flex w-16 shrink-0 flex-col items-center gap-2 py-4">
  <Avatar.Root class="mb-3 size-11 border-2 border-white/40">
    <Avatar.Fallback class="bg-white/20 text-sm font-medium text-white">
      {initials(session.profile?.displayName ?? null)}
    </Avatar.Fallback>
  </Avatar.Root>

  <button
    type="button"
    onclick={showChats}
    title="Tin nhắn"
    aria-label="Tin nhắn"
    class="flex size-12 items-center justify-center rounded-xl transition-colors {session.view === 'chats'
      ? 'bg-white/20'
      : 'hover:bg-white/10'}"
  >
    <MessageCircle class="size-6" />
  </button>

  <button
    type="button"
    onclick={showContacts}
    title="Danh bạ"
    aria-label="Danh bạ"
    class="flex size-12 items-center justify-center rounded-xl transition-colors {session.view === 'contacts'
      ? 'bg-white/20'
      : 'hover:bg-white/10'}"
  >
    <Users class="size-6" />
  </button>

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
