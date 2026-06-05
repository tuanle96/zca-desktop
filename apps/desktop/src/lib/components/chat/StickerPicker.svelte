<script lang="ts">
  import { Search, Loader2, Clock } from "@lucide/svelte";
  import { session } from "$lib/session.svelte";
  import type { Sticker } from "$lib/types";

  // Emit the picked sticker to the parent (composer) which sends it.
  let { onpick }: { onpick: (sticker: Sticker) => void } = $props();

  // A tab is either the special "recent" row, a search result set, or a pack
  // (category) the user has used before.
  type Tab = { kind: "recent" } | { kind: "search" } | { kind: "pack"; catId: number };

  let active = $state<Tab>({ kind: "recent" });
  let keyword = $state("");
  let stickers = $state<Sticker[]>([]);
  let loading = $state(false);
  // Pack tabs derived from the account's recently-used categories.
  let packs = $state<number[]>([]);
  // A representative thumbnail per pack (first recent sticker of that cat).
  let packThumbs = $state<Record<number, string>>({});
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  // Default search terms so a fresh account (no history) still sees stickers.
  const DEFAULT_TERMS = ["hi", "love", "haha", "ok", "sad", "cute"];

  function sameTab(a: Tab, b: Tab): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === "pack" && b.kind === "pack") return a.catId === b.catId;
    return true;
  }

  async function loadRecent() {
    loading = true;
    const recent = await session.recentStickers(24);
    stickers = recent;
    loading = false;
    // If the account has no recent stickers yet, seed the grid with a search so
    // the picker is never empty on first use.
    if (recent.length === 0 && active.kind === "recent") {
      await runSearch(DEFAULT_TERMS[0], { keepTab: true });
    }
  }

  async function loadPack(catId: number) {
    loading = true;
    stickers = await session.stickerCategory(catId);
    loading = false;
  }

  async function runSearch(term: string, opts: { keepTab?: boolean } = {}) {
    if (!opts.keepTab) active = { kind: "search" };
    loading = true;
    stickers = await session.searchStickers(term, 40);
    loading = false;
  }

  function selectTab(tab: Tab) {
    if (sameTab(active, tab)) return;
    active = tab;
    if (tab.kind === "recent") loadRecent();
    else if (tab.kind === "pack") loadPack(tab.catId);
  }

  // Debounced search as the user types. Empty input returns to the recent tab.
  function onInput() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const term = keyword.trim();
      if (!term) {
        selectTab({ kind: "recent" });
        return;
      }
      runSearch(term);
    }, 300);
  }

  // Initial load: pull the pack tabs + their thumbnails, then the recent row.
  $effect(() => {
    void (async () => {
      const cats = await session.stickerCategories(12);
      packs = cats;
      // Build a thumbnail map from the recent stickers (first per category).
      const recent = await session.recentStickers(48);
      const thumbs: Record<number, string> = {};
      for (const s of recent) {
        if (s.catId && !thumbs[s.catId]) thumbs[s.catId] = s.url;
      }
      packThumbs = thumbs;
    })();
    loadRecent();
  });

  function pick(s: Sticker) {
    onpick(s);
  }

  const heading = $derived(
    active.kind === "recent" ? "Gần đây" : active.kind === "search" ? "Kết quả tìm kiếm" : "Bộ sticker",
  );
</script>

<div class="bg-background flex w-80 flex-col rounded-xl border shadow-lg">
  <!-- Search -->
  <div class="border-b p-2.5">
    <div class="relative">
      <Search class="text-muted-foreground absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
      <input
        bind:value={keyword}
        oninput={onInput}
        placeholder="Tìm kiếm sticker"
        class="border-input bg-muted/40 focus-visible:ring-brand/40 w-full rounded-full border py-1.5 pl-8 pr-3 text-sm outline-none focus-visible:ring-2"
      />
    </div>
  </div>

  <!-- Grid -->
  <div class="h-64 overflow-y-auto p-2.5">
    <p class="text-muted-foreground mb-1.5 px-0.5 text-xs font-semibold">{heading}</p>
    {#if loading}
      <div class="flex h-48 items-center justify-center">
        <Loader2 class="text-muted-foreground size-6 animate-spin" />
      </div>
    {:else if stickers.length === 0}
      <p class="text-muted-foreground py-10 text-center text-sm">
        {active.kind === "recent" ? "Chưa có sticker nào gần đây." : "Không tìm thấy sticker nào."}
      </p>
    {:else}
      <div class="grid grid-cols-4 gap-2">
        {#each stickers as s (s.id)}
          <button
            type="button"
            onclick={() => pick(s)}
            class="hover:bg-muted flex aspect-square items-center justify-center rounded-lg p-1.5 transition-colors"
            title="Gửi sticker"
          >
            <img src={s.url} alt="sticker" class="size-full object-contain" loading="lazy" />
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Pack tab bar: recent + one chip per used category -->
  <div class="flex items-center gap-1 overflow-x-auto border-t px-2 py-1.5">
    <button
      type="button"
      onclick={() => selectTab({ kind: "recent" })}
      class="flex size-9 shrink-0 items-center justify-center rounded-md transition-colors {active.kind ===
      'recent'
        ? 'bg-brand/10 text-brand'
        : 'text-muted-foreground hover:bg-muted'}"
      title="Gần đây"
      aria-label="Gần đây"
    >
      <Clock class="size-5" />
    </button>
    {#each packs as catId (catId)}
      <button
        type="button"
        onclick={() => selectTab({ kind: "pack", catId })}
        class="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md p-1 transition-colors {active.kind ===
          'pack' && active.catId === catId
          ? 'bg-brand/10 ring-brand/40 ring-1'
          : 'hover:bg-muted'}"
        title="Bộ sticker {catId}"
        aria-label="Bộ sticker {catId}"
      >
        {#if packThumbs[catId]}
          <img src={packThumbs[catId]} alt="pack" class="size-full object-contain" loading="lazy" />
        {:else}
          <span class="text-muted-foreground text-[10px]">#{catId}</span>
        {/if}
      </button>
    {/each}
  </div>
</div>
