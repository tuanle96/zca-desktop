<script lang="ts">
  // Theme selector (light / dark / system) + live realtime status.
  import { Sun, Moon, Monitor, Check } from "@lucide/svelte";
  import AppHeader from "$lib/components/shell/app-header.svelte";
  import Screen from "$lib/components/shell/screen.svelte";
  import { theme, type ThemeMode } from "$lib/theme.svelte";
  import { session } from "$lib/session-store.svelte";
  import { nav } from "$lib/nav.svelte";

  const opts: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
    { mode: "light", label: "Sáng", icon: Sun },
    { mode: "dark", label: "Tối", icon: Moon },
    { mode: "system", label: "Theo hệ thống", icon: Monitor },
  ];

  const dot = $derived(
    session.realtimeState === "live"
      ? "bg-green-500"
      : session.realtimeState === "offline"
        ? "bg-muted-foreground/40"
        : "bg-amber-500",
  );
</script>

<div class="flex h-full flex-col">
  <AppHeader title="Giao diện" onback={() => nav.pop()} />
  <Screen>
    <p class="text-muted-foreground px-5 pb-1 pt-4 text-xs font-medium uppercase tracking-wide">Chủ đề</p>
    <div class="mx-4 overflow-hidden rounded-2xl border border-border/60">
      {#each opts as o, i (o.mode)}
        {@const Icon = o.icon}
        <button
          onclick={() => theme.set(o.mode)}
          class={`active:bg-muted flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${i > 0 ? "border-t border-border/60" : ""}`}
        >
          <Icon class="text-muted-foreground size-5" />
          <span class="flex-1 font-medium">{o.label}</span>
          {#if theme.mode === o.mode}<Check class="text-brand size-5" />{/if}
        </button>
      {/each}
    </div>

    <p class="text-muted-foreground px-5 pb-1 pt-6 text-xs font-medium uppercase tracking-wide">Kết nối</p>
    <div class="mx-4 flex items-center gap-2 rounded-2xl border border-border/60 px-4 py-3">
      <span class={`size-2.5 rounded-full ${dot}`}></span>
      <span class="text-sm">{session.realtimeLabel}</span>
    </div>
  </Screen>
</div>
