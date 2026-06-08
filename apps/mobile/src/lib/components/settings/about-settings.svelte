<script lang="ts">
  // App version + repo link + disclaimer. iOS apps update via the App Store, so
  // there is no in-app updater here (desktop-only — intentionally absent).
  import { Cloud } from "@lucide/svelte";
  import AppHeader from "$lib/components/shell/app-header.svelte";
  import Screen from "$lib/components/shell/screen.svelte";
  import BrandMark from "$lib/components/brand-mark.svelte";
  import { nav } from "$lib/nav.svelte";

  const APP_VERSION = "0.1.0";
  const REPO_URL = "https://github.com/tuanle96/zca-desktop";

  async function openRepo() {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(REPO_URL);
  }
</script>

<div class="flex h-full flex-col">
  <AppHeader title="Giới thiệu" onback={() => nav.pop()} />
  <Screen>
    <div class="flex flex-col items-center gap-2 px-6 pb-2 pt-8 text-center">
      <div class="bg-brand/10 text-brand flex size-16 items-center justify-center rounded-2xl">
        <Cloud class="size-8" />
      </div>
      <h2 class="text-xl font-bold">Zalo <span class="text-brand">Mobile</span></h2>
      <p class="text-muted-foreground text-sm">Phiên bản {APP_VERSION}</p>
    </div>

    <div class="mx-4 mt-4 overflow-hidden rounded-2xl border border-border/60">
      <button onclick={openRepo} class="active:bg-muted flex w-full items-center gap-3 px-4 py-3 text-left transition-colors">
        <span class="text-foreground/75"><BrandMark provider="github" class="size-5" /></span>
        <span class="flex-1 font-medium">Mã nguồn trên GitHub</span>
        <span class="text-muted-foreground text-xs">tuanle96/zca-desktop</span>
      </button>
    </div>

    <p class="text-muted-foreground px-6 pt-6 text-center text-xs">
      Ứng dụng Zalo không chính thức, chỉ dùng cho mục đích cá nhân, phi thương mại. Không liên kết với Zalo hay VNG.
    </p>
  </Screen>
</div>
