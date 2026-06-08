<script lang="ts">
  // Floating glass tab bar (iOS 26 "Liquid Glass" style approximation): a rounded
  // capsule detached from the screen edges, frosted via `.glass`, with the active
  // tab highlighted by a soft pill. Content scrolls under it.
  import { MessageCircle, Users, Settings } from "@lucide/svelte";
  import { nav, type TabId } from "$lib/nav.svelte";
  import { cn } from "$lib/utils";

  const tabs: { id: TabId; label: string; icon: typeof MessageCircle }[] = [
    { id: "chats", label: "Tin nhắn", icon: MessageCircle },
    { id: "contacts", label: "Danh bạ", icon: Users },
    { id: "settings", label: "Cài đặt", icon: Settings },
  ];
</script>

<nav
  class="glass absolute inset-x-5 bottom-[calc(env(safe-area-inset-bottom)+10px)] z-20 grid grid-cols-3 gap-1 rounded-[26px] p-1.5 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.28)] ring-1 ring-black/5 dark:ring-white/10"
>
  {#each tabs as t (t.id)}
    {@const Icon = t.icon}
    {@const active = nav.tab === t.id}
    <button
      class={cn(
        "relative flex flex-col items-center gap-0.5 rounded-[20px] py-1.5 text-[10px] font-medium transition-colors active:opacity-60",
        active ? "text-brand bg-brand/10" : "text-muted-foreground",
      )}
      onclick={() => nav.setTab(t.id)}
      aria-current={active ? "page" : undefined}
    >
      <Icon class="size-[25px]" strokeWidth={active ? 2.3 : 1.9} />
      <span class="tracking-tight">{t.label}</span>
      {#if t.id === "chats" && nav.unread > 0}
        <span
          class="bg-destructive absolute right-[16%] top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white"
        >
          {nav.unread > 99 ? "99+" : nav.unread}
        </span>
      {/if}
    </button>
  {/each}
</nav>
