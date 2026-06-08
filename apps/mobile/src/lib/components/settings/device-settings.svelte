<script lang="ts">
  // Linked devices: list active devices + revoke (with confirm); plus "unlink
  // this device" which purges the keychain token and returns to the login gate.
  import { onMount } from "svelte";
  import { Smartphone, Trash2 } from "@lucide/svelte";
  import { listCloudDevices, revokeCloudDevice, CLOUD_DEVICE_TOKEN_KEYCHAIN, type CloudDevice } from "@zca/core-client";
  import AppHeader from "$lib/components/shell/app-header.svelte";
  import Screen from "$lib/components/shell/screen.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import ConfirmSheet from "$lib/components/ui/confirm-sheet.svelte";
  import { cloudBaseUrlFromStorage } from "$lib/cloudConfig";
  import { session } from "$lib/session-store.svelte";
  import { nav } from "$lib/nav.svelte";

  const TOKEN = CLOUD_DEVICE_TOKEN_KEYCHAIN;
  let baseUrl = "";
  let devices = $state<CloudDevice[]>([]);
  let loading = $state(true);
  let error = $state("");
  let revokeId = $state<string | null>(null);
  let unlinkOpen = $state(false);
  let busy = $state(false);

  const active = $derived(devices.filter((d) => !d.revokedAt));
  const pending = $derived(active.find((d) => d.id === revokeId) ?? null);

  onMount(() => {
    if (typeof localStorage !== "undefined") baseUrl = cloudBaseUrlFromStorage(localStorage);
    void load();
  });

  async function load() {
    loading = true;
    error = "";
    try {
      devices = (await listCloudDevices(baseUrl, TOKEN)) as CloudDevice[];
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  async function revoke() {
    if (!revokeId) return;
    busy = true;
    try {
      await revokeCloudDevice(baseUrl, TOKEN, revokeId);
      revokeId = null;
      await load();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function unlink() {
    busy = true;
    await session.unlinkDevice();
    busy = false;
    unlinkOpen = false;
    // Session reset → +page shows the login gate automatically.
  }

  function lastSeen(d: CloudDevice): string {
    if (!d.lastSeenAt) return "Chưa hoạt động";
    const t = Date.parse(d.lastSeenAt);
    return t ? new Date(t).toLocaleString("vi-VN") : "";
  }
</script>

<div class="flex h-full flex-col">
  <AppHeader title="Thiết bị" onback={() => nav.pop()} />
  <Screen>
    {#if loading}
      <p class="text-muted-foreground p-10 text-center text-sm">Đang tải thiết bị…</p>
    {:else if error}
      <p class="text-destructive p-6 text-center text-sm">{error}</p>
    {:else}
      <div class="mx-4 mt-4 divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60">
        {#each active as d (d.id)}
          <div class="flex items-center gap-3 px-4 py-3">
            <span class="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-full">
              <Smartphone class="size-5" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium">{d.name}</p>
              <p class="text-muted-foreground truncate text-xs">{lastSeen(d)}</p>
            </div>
            <button
              onclick={() => (revokeId = d.id)}
              class="text-destructive active:bg-muted flex size-9 items-center justify-center rounded-full"
              aria-label="Thu hồi thiết bị"
            >
              <Trash2 class="size-5" />
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <div class="mx-4 mt-6">
      <Button variant="destructive" class="w-full" onclick={() => (unlinkOpen = true)}>Huỷ liên kết thiết bị này</Button>
      <p class="text-muted-foreground px-1 pt-2 text-xs">Xoá token thiết bị khỏi máy này và quay về màn đăng nhập.</p>
    </div>
  </Screen>
</div>

{#if pending}
  <ConfirmSheet
    title="Thu hồi thiết bị?"
    message={`“${pending.name}” sẽ phải đăng nhập lại để dùng cloud.`}
    confirmLabel="Thu hồi"
    destructive
    {busy}
    onconfirm={revoke}
    oncancel={() => (revokeId = null)}
  />
{/if}

{#if unlinkOpen}
  <ConfirmSheet
    title="Huỷ liên kết thiết bị này?"
    message="Bạn sẽ cần đăng nhập lại trên máy này."
    confirmLabel="Huỷ liên kết"
    destructive
    {busy}
    onconfirm={unlink}
    oncancel={() => (unlinkOpen = false)}
  />
{/if}
