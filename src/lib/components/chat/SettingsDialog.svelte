<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import {
    X,
    User,
    Palette,
    Database,
    Info,
    Sun,
    Moon,
    Monitor,
    LogOut,
    Check,
    Loader2,
  } from "@lucide/svelte";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { session } from "$lib/session.svelte";
  import { theme, type ThemeMode } from "$lib/theme.svelte";

  type Tab = "account" | "appearance" | "data" | "about";

  let tab = $state<Tab>("account");
  let confirmingLogout = $state(false);

  // Store diagnostics (accounts, threads, messages) for the active account.
  let stats = $state<{ accounts: number; threads: number; messages: number } | null>(null);
  let statsError = $state("");

  const repoUrl = "https://github.com/tuanle96/zca-desktop";
  const appVersion = "0.1.0";

  const navItems: { id: Tab; icon: typeof User; label: string }[] = [
    { id: "account", icon: User, label: "Tài khoản" },
    { id: "appearance", icon: Palette, label: "Giao diện" },
    { id: "data", icon: Database, label: "Dữ liệu" },
    { id: "about", icon: Info, label: "Giới thiệu" },
  ];

  const themeOptions: { id: ThemeMode; icon: typeof Sun; label: string }[] = [
    { id: "light", icon: Sun, label: "Sáng" },
    { id: "dark", icon: Moon, label: "Tối" },
    { id: "system", icon: Monitor, label: "Theo hệ thống" },
  ];

  function initials(name: string | null): string {
    if (!name) return "?";
    const parts = name.trim().split(/\s+/);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (first + last).toUpperCase() || "?";
  }

  function close() {
    session.settingsOpen = false;
    confirmingLogout = false;
  }

  async function loadStats() {
    const id = session.activeAccountId;
    if (!id) return;
    try {
      const [accounts, threads, messages] = await invoke<[number, number, number]>("store_stats", {
        accountId: id,
      });
      stats = { accounts, threads, messages };
      statsError = "";
    } catch (e) {
      statsError = String(e);
    }
  }

  async function confirmLogout() {
    const id = session.activeAccountId;
    if (!id) return;
    await session.logoutAccount(id);
    confirmingLogout = false;
    // logoutAccount closes the dialog when the last account is removed.
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  async function openRepo() {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(repoUrl);
  }

  onMount(() => {
    loadStats();
  });
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Backdrop -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) close();
  }}
>
  <div
    class="bg-card relative flex h-[34rem] w-full max-w-3xl overflow-hidden rounded-2xl border shadow-xl"
    role="dialog"
    aria-modal="true"
    aria-label="Cài đặt"
  >
    <!-- Left nav -->
    <aside class="bg-muted/40 flex w-56 shrink-0 flex-col border-r p-3">
      <h2 class="px-2 py-2 text-lg font-semibold">Cài đặt</h2>
      <nav class="mt-1 flex flex-col gap-0.5">
        {#each navItems as item (item.id)}
          <button
            type="button"
            onclick={() => (tab = item.id)}
            class="flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors {tab ===
            item.id
              ? 'bg-brand/10 text-brand font-medium'
              : 'hover:bg-muted text-foreground'}"
          >
            <item.icon class="size-4.5" />
            {item.label}
          </button>
        {/each}
      </nav>
    </aside>

    <!-- Content -->
    <section class="flex min-w-0 flex-1 flex-col">
      <button
        type="button"
        onclick={close}
        title="Đóng"
        aria-label="Đóng"
        class="text-muted-foreground hover:bg-muted hover:text-foreground absolute right-3 top-3 flex size-8 items-center justify-center rounded-md transition-colors"
      >
        <X class="size-5" />
      </button>

      <div class="flex-1 overflow-y-auto p-6">
        {#if tab === "account"}
          <h3 class="text-base font-semibold">Thông tin tài khoản</h3>
          {#if session.profile}
            <div class="mt-4 flex items-center gap-4">
              <Avatar.Root class="size-16">
                {#if session.profile.avatar}
                  <Avatar.Image src={session.profile.avatar} alt={session.profile.displayName ?? "avatar"} />
                {/if}
                <Avatar.Fallback class="bg-brand/15 text-brand text-xl font-medium">
                  {initials(session.profile.displayName)}
                </Avatar.Fallback>
              </Avatar.Root>
              <div class="min-w-0">
                <p class="truncate text-lg font-semibold">
                  {session.profile.displayName ?? "Tài khoản Zalo"}
                </p>
                <p class="text-muted-foreground truncate text-sm">ID: {session.profile.accountId}</p>
              </div>
            </div>

            <div class="mt-8 border-t pt-5">
              <p class="text-sm font-medium">Đăng xuất</p>
              <p class="text-muted-foreground mt-1 text-xs">
                Quên tài khoản này trên thiết bị hiện tại. Phiên đăng nhập và thông tin xác thực
                đã lưu sẽ bị xoá khỏi máy. Lịch sử trò chuyện được giữ lại để khôi phục khi đăng
                nhập lại.
              </p>

              {#if session.error}
                <p class="text-destructive mt-3 text-xs" role="alert">{session.error}</p>
              {/if}

              {#if confirmingLogout}
                <div class="mt-4 flex items-center gap-2">
                  <Button variant="destructive" disabled={session.busy} onclick={confirmLogout}>
                    {#if session.busy}
                      <Loader2 class="animate-spin" />
                    {:else}
                      <LogOut />
                    {/if}
                    Xác nhận đăng xuất
                  </Button>
                  <Button variant="ghost" disabled={session.busy} onclick={() => (confirmingLogout = false)}>
                    Huỷ
                  </Button>
                </div>
              {:else}
                <Button variant="destructive" class="mt-4" onclick={() => (confirmingLogout = true)}>
                  <LogOut />
                  Đăng xuất tài khoản này
                </Button>
              {/if}
            </div>
          {:else}
            <p class="text-muted-foreground mt-4 text-sm">Chưa có tài khoản nào đăng nhập.</p>
          {/if}
        {:else if tab === "appearance"}
          <h3 class="text-base font-semibold">Giao diện</h3>
          <p class="text-muted-foreground mt-1 text-sm">Chọn chủ đề sáng, tối hoặc theo hệ thống.</p>
          <div class="mt-5 grid grid-cols-3 gap-3">
            {#each themeOptions as opt (opt.id)}
              <button
                type="button"
                onclick={() => theme.set(opt.id)}
                class="relative flex flex-col items-center gap-2 rounded-xl border p-4 text-sm transition-colors {theme.mode ===
                opt.id
                  ? 'border-brand bg-brand/5 text-brand'
                  : 'hover:bg-muted text-foreground'}"
              >
                {#if theme.mode === opt.id}
                  <Check class="text-brand absolute right-2 top-2 size-4" />
                {/if}
                <opt.icon class="size-6" />
                {opt.label}
              </button>
            {/each}
          </div>
        {:else if tab === "data"}
          <h3 class="text-base font-semibold">Quản lý dữ liệu</h3>
          <p class="text-muted-foreground mt-1 text-sm">
            Dữ liệu được lưu cục bộ trên máy (SQLite). Thông tin xác thực được mã hoá.
          </p>
          {#if statsError}
            <p class="text-destructive mt-4 text-xs" role="alert">{statsError}</p>
          {:else if stats}
            <dl class="mt-5 grid grid-cols-3 gap-3">
              <div class="bg-muted/40 rounded-xl border p-4">
                <dt class="text-muted-foreground text-xs">Tài khoản đã lưu</dt>
                <dd class="mt-1 text-2xl font-semibold tabular-nums">{stats.accounts}</dd>
              </div>
              <div class="bg-muted/40 rounded-xl border p-4">
                <dt class="text-muted-foreground text-xs">Cuộc trò chuyện</dt>
                <dd class="mt-1 text-2xl font-semibold tabular-nums">{stats.threads}</dd>
              </div>
              <div class="bg-muted/40 rounded-xl border p-4">
                <dt class="text-muted-foreground text-xs">Tin nhắn đã lưu</dt>
                <dd class="mt-1 text-2xl font-semibold tabular-nums">{stats.messages}</dd>
              </div>
            </dl>
            <p class="text-muted-foreground mt-3 text-xs">Số liệu của tài khoản đang hoạt động.</p>
          {:else}
            <div class="text-muted-foreground mt-5 flex items-center gap-2 text-sm">
              <Loader2 class="size-4 animate-spin" /> Đang tải…
            </div>
          {/if}
        {:else if tab === "about"}
          <h3 class="text-base font-semibold">Giới thiệu</h3>
          <div class="mt-4 flex items-center gap-3">
            <span class="text-brand text-3xl font-extrabold tracking-tight">Zalo</span>
            <span class="text-muted-foreground text-sm">Desktop</span>
          </div>
          <p class="text-muted-foreground mt-3 text-sm">
            Ứng dụng Zalo desktop không chính thức, dùng cho mục đích cá nhân.
          </p>
          <dl class="mt-5 space-y-2 text-sm">
            <div class="flex gap-2">
              <dt class="text-muted-foreground w-24">Phiên bản</dt>
              <dd class="font-medium tabular-nums">{appVersion}</dd>
            </div>
            <div class="flex gap-2">
              <dt class="text-muted-foreground w-24">Mã nguồn</dt>
              <dd>
                <button
                  type="button"
                  class="text-brand hover:underline"
                  onclick={openRepo}
                >
                  {repoUrl}
                </button>
              </dd>
            </div>
          </dl>
        {/if}
      </div>
    </section>
  </div>
</div>
