<script lang="ts">
  import { onMount } from "svelte";
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
    Cloud,
    Wifi,
    WifiOff,
    ShieldCheck,
    Trash2,
    Bell,
    BellOff,
  } from "@lucide/svelte";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    CLOUD_DEVICE_TOKEN_KEYCHAIN,
    listCloudAccounts,
    listCloudDevices,
    loadCloudDeviceSession,
    revokeCloudDevice,
    type CloudAccount,
    type CloudDevice,
  } from "$lib/cloud";
  import { DEFAULT_CLOUD_BASE_URL } from "$lib/cloudConfig";
  import { session } from "$lib/session.svelte";
  import { theme, type ThemeMode } from "$lib/theme.svelte";
  import { notifications } from "$lib/notifications.svelte";

  type Tab = "account" | "appearance" | "data" | "about";

  let tab = $state<Tab>("account");
  let confirmingLogout = $state(false);

  let cloudBaseUrl = $state(DEFAULT_CLOUD_BASE_URL);
  let cloudDeviceLinked = $state(false);
  let cloudAccounts = $state<CloudAccount[]>([]);
  let cloudDevices = $state<CloudDevice[]>([]);
  let cloudDataError = $state("");
  let revokingDeviceId = $state<string | null>(null);

  const repoUrl = "https://github.com/tuanle96/zca-desktop";
  const appVersion = "0.1.1";
  const activeCloudAccounts = $derived(cloudAccounts.filter((account) => account.state === "active").length);
  const activeCloudDevices = $derived(cloudDevices.filter((device) => !device.revokedAt).length);
  const realtimeDotClass = $derived(
    session.realtimeState === "live"
      ? "bg-green-500"
      : session.realtimeState === "connecting" || session.realtimeState === "reconnecting"
        ? "bg-amber-500"
        : "bg-muted-foreground/40",
  );

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

  async function loadCloudOverview() {
    if (typeof localStorage !== "undefined") {
      cloudBaseUrl = localStorage.getItem("zca.cloud.baseUrl") || cloudBaseUrl;
    }
    try {
      const saved = await loadCloudDeviceSession(cloudBaseUrl);
      cloudDeviceLinked = Boolean(saved?.hasDeviceToken);
      if (!cloudDeviceLinked) {
        cloudAccounts = [];
        cloudDevices = [];
        cloudDataError = "";
        return;
      }
      const [accounts, devices] = await Promise.all([
        listCloudAccounts(cloudBaseUrl, CLOUD_DEVICE_TOKEN_KEYCHAIN),
        listCloudDevices(cloudBaseUrl, CLOUD_DEVICE_TOKEN_KEYCHAIN),
      ]);
      cloudAccounts = accounts;
      cloudDevices = devices;
      cloudDataError = "";
    } catch (e) {
      cloudDataError = String(e);
    }
  }

  async function confirmLogout() {
    const id = session.activeAccountId;
    if (!id) return;
    await session.logoutAccount(id);
    confirmingLogout = false;
    // logoutAccount closes the dialog when the last account is removed.
  }

  async function revokeDevice(deviceId: string) {
    revokingDeviceId = deviceId;
    cloudDataError = "";
    try {
      await revokeCloudDevice(cloudBaseUrl, CLOUD_DEVICE_TOKEN_KEYCHAIN, deviceId);
      await loadCloudOverview();
    } catch (e) {
      cloudDataError = String(e);
    } finally {
      revokingDeviceId = null;
    }
  }

  function timeLabel(value: string | null): string {
    if (!value) return "Chưa thấy";
    const t = Date.parse(value);
    if (!Number.isFinite(t)) return value;
    return new Date(t).toLocaleString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  async function openRepo() {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(repoUrl);
  }

  async function toggleNotifications() {
    await notifications.setEnabled(!notifications.enabled);
  }

  onMount(() => {
    loadCloudOverview();
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
              <p class="text-sm font-medium">Chế độ phiên</p>
              <div class="mt-3 grid grid-cols-2 gap-2">
                <div class="bg-muted/40 rounded-lg border p-3">
                  <div class="text-muted-foreground flex items-center gap-2 text-xs">
                    <Cloud class="size-4" />
                    Zalo Cloud
                  </div>
                  <p class="mt-1 text-sm font-medium">
                    Đồng bộ qua cloud
                  </p>
                </div>
                <div class="bg-muted/40 rounded-lg border p-3">
                  <div class="text-muted-foreground flex items-center gap-2 text-xs">
                    {#if session.realtimeState === "live"}
                      <Wifi class="size-4" />
                      Realtime
                    {:else}
                      <WifiOff class="size-4" />
                      Offline
                    {/if}
                  </div>
                  <p class="mt-1 text-sm font-medium">
                    {session.realtimeLabel}
                  </p>
                </div>
              </div>
            </div>

            <div class="mt-8 border-t pt-5">
              <p class="text-sm font-medium">Đăng xuất</p>
              <p class="text-muted-foreground mt-1 text-xs">
                Xoá tài khoản Zalo này khỏi cloud. Các thiết bị khác cùng tài khoản cloud sẽ
                không còn thấy tài khoản này sau khi đồng bộ lại.
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
                    Xác nhận xoá tài khoản cloud
                  </Button>
                  <Button variant="ghost" disabled={session.busy} onclick={() => (confirmingLogout = false)}>
                    Huỷ
                  </Button>
                </div>
              {:else}
                <Button variant="destructive" class="mt-4" onclick={() => (confirmingLogout = true)}>
                  <LogOut />
                  Xoá tài khoản cloud này
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

          <div class="mt-8 border-t pt-5">
            <p class="text-sm font-medium">Thông báo</p>
            <p class="text-muted-foreground mt-1 text-xs">
              Hiện thông báo của hệ điều hành khi có tin nhắn mới và cửa sổ đang ẩn hoặc không được focus.
            </p>
            <button
              type="button"
              onclick={toggleNotifications}
              class="mt-4 flex w-full items-center justify-between rounded-xl border p-4 text-left transition-colors hover:bg-muted"
            >
              <div class="flex items-center gap-3">
                {#if notifications.enabled}
                  <Bell class="text-brand size-5" />
                {:else}
                  <BellOff class="text-muted-foreground size-5" />
                {/if}
                <div>
                  <p class="text-sm font-medium">Thông báo tin nhắn</p>
                  <p class="text-muted-foreground text-xs">
                    {notifications.enabled ? "Đang bật" : "Đang tắt"}
                  </p>
                </div>
              </div>
              <span
                class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors {notifications.enabled
                  ? 'bg-brand'
                  : 'bg-muted-foreground/30'}"
                role="switch"
                aria-checked={notifications.enabled}
                aria-label="Bật/tắt thông báo tin nhắn"
              >
                <span
                  class="inline-block size-5 transform rounded-full bg-white shadow transition-transform {notifications.enabled
                    ? 'translate-x-5'
                    : 'translate-x-0.5'}"
                ></span>
              </span>
            </button>
            {#if notifications.enabled && !notifications.permissionGranted}
              <p class="text-muted-foreground mt-2 text-xs">
                Lưu ý: cần cấp quyền thông báo cho ứng dụng trong cài đặt hệ điều hành để thông báo hiển thị.
              </p>
            {/if}
          </div>
        {:else if tab === "data"}
          <h3 class="text-base font-semibold">Dữ liệu cloud</h3>
          <p class="text-muted-foreground mt-1 text-sm">
            Dữ liệu hội thoại được lưu trên cloud. Máy này chỉ giữ khoá đăng nhập trong Keychain của máy.
          </p>
          {#if cloudDataError}
            <p class="text-destructive mt-4 text-xs" role="alert">{cloudDataError}</p>
          {:else if cloudDeviceLinked}
            <dl class="mt-5 grid grid-cols-3 gap-3">
              <div class="bg-muted/40 rounded-xl border p-4">
                <dt class="text-muted-foreground text-xs">Tài khoản cloud</dt>
                <dd class="mt-1 text-2xl font-semibold tabular-nums">{activeCloudAccounts}</dd>
              </div>
              <div class="bg-muted/40 rounded-xl border p-4">
                <dt class="text-muted-foreground text-xs">Thiết bị đang mở</dt>
                <dd class="mt-1 text-2xl font-semibold tabular-nums">{activeCloudDevices}</dd>
              </div>
              <div class="bg-muted/40 rounded-xl border p-4">
                <dt class="text-muted-foreground text-xs">Realtime</dt>
                <dd class="mt-2 flex items-center gap-2 text-sm font-medium">
                  <span class="size-2 rounded-full {realtimeDotClass}"></span>
                  {session.realtimeLabel}
                </dd>
              </div>
            </dl>
            <div class="mt-5 rounded-xl border p-4">
              <div class="text-muted-foreground flex items-center gap-2 text-xs">
                <Cloud class="size-4" />
                Backend endpoint
              </div>
              <p class="mt-1 truncate text-sm font-medium">{cloudBaseUrl}</p>
              <p class="text-muted-foreground mt-2 text-xs">
                Postgres lưu metadata/ciphertext; object storage lưu file blobs đã mã hoá.
              </p>
            </div>
            <div class="mt-3 rounded-xl border p-4">
              <div class="text-muted-foreground flex items-center gap-2 text-xs">
                <ShieldCheck class="size-4" />
                Thiết bị này
              </div>
              <p class="mt-1 text-sm font-medium">Đã liên kết cloud device session</p>
              <p class="text-muted-foreground mt-2 text-xs">
                Token thiết bị nằm trong macOS Keychain; Zalo credential không được trả về UI.
              </p>
            </div>
            <div class="mt-3 rounded-xl border p-4">
              <div class="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p class="text-sm font-medium">Thiết bị đã liên kết</p>
                  <p class="text-muted-foreground text-xs">Revoke thiết bị không còn dùng để chặn fetch/stream.</p>
                </div>
                <Button variant="ghost" size="sm" disabled={Boolean(revokingDeviceId)} onclick={loadCloudOverview}>
                  Làm mới
                </Button>
              </div>
              <div class="space-y-2">
                {#each cloudDevices as device (device.id)}
                  <div class="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2">
                    <div class="min-w-0">
                      <p class="truncate text-sm font-medium">{device.name}</p>
                      <p class="text-muted-foreground truncate text-xs">
                        {device.revokedAt ? `Đã revoke ${timeLabel(device.revokedAt)}` : `Seen ${timeLabel(device.lastSeenAt)}`}
                      </p>
                    </div>
                    {#if device.revokedAt}
                      <span class="text-muted-foreground shrink-0 rounded-full border px-2 py-1 text-xs">Revoked</span>
                    {:else}
                      <Button
                        variant="ghost"
                        size="sm"
                        class="text-destructive hover:text-destructive"
                        disabled={Boolean(revokingDeviceId)}
                        onclick={() => revokeDevice(device.id)}
                      >
                        {#if revokingDeviceId === device.id}
                          <Loader2 class="animate-spin" />
                        {:else}
                          <Trash2 />
                        {/if}
                        Revoke
                      </Button>
                    {/if}
                  </div>
                {:else}
                  <p class="text-muted-foreground py-3 text-sm">Chưa có device nào.</p>
                {/each}
              </div>
            </div>
          {:else}
            <p class="text-muted-foreground mt-5 text-sm">
              Thiết bị này chưa có cloud device session. Đăng nhập bằng magic link để liên kết.
            </p>
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
