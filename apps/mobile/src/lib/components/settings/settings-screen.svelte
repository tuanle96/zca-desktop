<script lang="ts">
  // "Cài đặt" tab: a grouped list that pushes detail screens (Appearance,
  // Accounts, Devices, About) via the nav stack.
  import { Palette, UserRound, Smartphone, Info, ChevronRight } from "@lucide/svelte";
  import LargeTitle from "$lib/components/shell/large-title.svelte";
  import Screen from "$lib/components/shell/screen.svelte";
  import { nav } from "$lib/nav.svelte";

  const rows: { name: string; title: string; icon: typeof Palette; tint: string }[] = [
    { name: "settings-appearance", title: "Giao diện", icon: Palette, tint: "bg-violet-500" },
    { name: "settings-account", title: "Tài khoản Zalo", icon: UserRound, tint: "bg-brand" },
    { name: "settings-device", title: "Thiết bị", icon: Smartphone, tint: "bg-emerald-500" },
    { name: "settings-about", title: "Giới thiệu", icon: Info, tint: "bg-slate-500" },
  ];
</script>

<div class="flex h-full flex-col">
  <LargeTitle title="Cài đặt" />
  <Screen class="pb-[calc(env(safe-area-inset-bottom)+88px)]">
    <div class="mx-4 mt-2 overflow-hidden rounded-2xl border border-border/60">
      {#each rows as r, i (r.name)}
        {@const Icon = r.icon}
        <button
          onclick={() => nav.push(r.name)}
          class={`active:bg-muted flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${i > 0 ? "border-t border-border/60" : ""}`}
        >
          <span class={`flex size-7 items-center justify-center rounded-md text-white ${r.tint}`}><Icon class="size-4" /></span>
          <span class="flex-1 font-medium">{r.title}</span>
          <ChevronRight class="text-muted-foreground size-4" />
        </button>
      {/each}
    </div>
  </Screen>
</div>
