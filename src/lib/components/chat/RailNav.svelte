<script lang="ts">
  import { MessageCircle, Users, Cloud, Settings } from "@lucide/svelte";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { session } from "$lib/session.svelte";

  type Item = { id: string; label: string; icon: typeof MessageCircle };
  const items: Item[] = [
    { id: "chats", label: "Tin nhắn", icon: MessageCircle },
    { id: "contacts", label: "Danh bạ", icon: Users },
    { id: "cloud", label: "Cloud", icon: Cloud },
  ];

  let active = $state("chats");

  function initials(name: string | null): string {
    if (!name) return "?";
    const parts = name.trim().split(/\s+/);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (first + last).toUpperCase() || "?";
  }
</script>

<nav class="bg-brand text-brand-foreground flex w-16 shrink-0 flex-col items-center gap-2 py-4">
  <Avatar.Root class="mb-3 size-11 border-2 border-white/40">
    <Avatar.Fallback class="bg-white/20 text-sm font-medium text-white">
      {initials(session.profile?.displayName ?? null)}
    </Avatar.Fallback>
  </Avatar.Root>

  {#each items as item (item.id)}
    <button
      type="button"
      onclick={() => (active = item.id)}
      title={item.label}
      aria-label={item.label}
      class="flex size-12 items-center justify-center rounded-xl transition-colors {active === item.id
        ? 'bg-white/20'
        : 'hover:bg-white/10'}"
    >
      <item.icon class="size-6" />
    </button>
  {/each}

  <button
    type="button"
    title="Cài đặt"
    aria-label="Cài đặt"
    class="mt-auto flex size-12 items-center justify-center rounded-xl transition-colors hover:bg-white/10"
  >
    <Settings class="size-6" />
  </button>
</nav>
