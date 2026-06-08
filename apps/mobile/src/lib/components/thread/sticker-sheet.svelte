<script lang="ts">
  // Sticker picker as an iOS bottom sheet (slides up from the composer). Mirrors
  // the desktop StickerPicker: search, 4-col grid, recent/pack tab bar, empty
  // state. The catalog has no cloud endpoint yet (store methods return []), so
  // it shows the same empty state as desktop — sending a sticker still works.
  import { onMount } from "svelte";
  import { Search, Loader2, Clock } from "@lucide/svelte";
  import { session } from "$lib/session-store.svelte";
  import type { Sticker } from "@zca/types";

  let { onpick, onclose }: { onpick: (s: Sticker) => void; onclose: () => void } = $props();

  type Tab = { kind: "recent" } | { kind: "search" } | { kind: "pack"; catId: number };
  let active = $state<Tab>({ kind: "recent" });
  let keyword = $state("");
  let stickers = $state<Sticker[]>([]);
  let loading = $state(false);
  let packs = $state<number[]>([]);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadRecent() {
    loading = true;
    stickers = await session.recentStickers();
    loading = false;
  }

  async function runSearch() {
    loading = true;
    stickers = await session.searchStickers();
    loading = false;
  }

  function selectTab(tab: Tab) {
    active = tab;
    if (tab.kind === "recent") void loadRecent();
    else void session.stickerCategory().then((s) => (stickers = s));
  }

  // Debounced search; empty input returns to the recent tab.
  function onInput() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (!keyword.trim()) {
        selectTab({ kind: "recent" });
        return;
      }
      active = { kind: "search" };
      void runSearch();
    }, 300);
  }

  onMount(() => {
    void session.stickerCategories().then((c) => (packs = c));
    void loadRecent();
  });

  const heading = $derived(
    active.kind === "recent" ? "Gần đây" : active.kind === "search" ? "Kết quả tìm kiếm" : "Bộ sticker",
  );
</script>

<div class="fixed inset-0 z-50 flex flex-col justify-end">
  <button class="absolute inset-0 bg-black/40" onclick={onclose} aria-label="Đóng"></button>
  <div class="bg-background relative z-10 flex max-h-[68%] flex-col rounded-t-2xl pb-safe-bottom">
    <div class="bg-muted-foreground/30 mx-auto mb-2 mt-2.5 h-1 w-9 rounded-full"></div>

    <!-- Search -->
    <div class="px-3 pb-2">
      <div class="relative">
        <Search class="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
        <input
          bind:value={keyword}
          oninput={onInput}
          placeholder="Tìm kiếm sticker"
          class="border-input bg-muted/40 focus-visible:ring-brand/40 w-full rounded-full border py-2 pl-9 pr-3 text-base outline-none focus-visible:ring-2"
        />
      </div>
    </div>

    <!-- Grid -->
    <div class="min-h-0 flex-1 overflow-y-auto px-3">
      <p class="text-muted-foreground mb-1.5 px-0.5 text-xs font-semibold">{heading}</p>
      {#if loading}
        <div class="flex h-40 items-center justify-center">
          <Loader2 class="text-muted-foreground size-6 animate-spin" />
        </div>
      {:else if stickers.length === 0}
        <p class="text-muted-foreground py-12 text-center text-sm">
          {active.kind === "recent" ? "Chưa có sticker nào gần đây." : "Không tìm thấy sticker nào."}
        </p>
      {:else}
        <div class="grid grid-cols-4 gap-2 pb-2">
          {#each stickers as s (s.id)}
            <button
              type="button"
              onclick={() => onpick(s)}
              class="active:bg-muted flex aspect-square items-center justify-center rounded-lg p-1.5"
              aria-label="Gửi sticker"
            >
              <img src={s.url} alt="sticker" class="size-full object-contain" loading="lazy" />
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Tab bar: recent + one chip per used pack (none until a catalog ships) -->
    <div class="flex items-center gap-1 overflow-x-auto border-t px-2 py-1.5">
      <button
        type="button"
        onclick={() => selectTab({ kind: "recent" })}
        aria-label="Gần đây"
        class="flex size-9 shrink-0 items-center justify-center rounded-md {active.kind === 'recent'
          ? 'bg-brand/10 text-brand'
          : 'text-muted-foreground active:bg-muted'}"
      >
        <Clock class="size-5" />
      </button>
      {#each packs as catId (catId)}
        <button
          type="button"
          onclick={() => selectTab({ kind: "pack", catId })}
          aria-label="Bộ sticker {catId}"
          class="flex size-9 shrink-0 items-center justify-center rounded-md p-1 text-[10px] {active.kind === 'pack' &&
          active.catId === catId
            ? 'bg-brand/10 text-brand ring-brand/40 ring-1'
            : 'text-muted-foreground active:bg-muted'}"
        >
          #{catId}
        </button>
      {/each}
    </div>
  </div>
</div>
