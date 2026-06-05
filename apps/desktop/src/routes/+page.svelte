<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Loader2 } from "@lucide/svelte";
  import RailNav from "$lib/components/chat/RailNav.svelte";
  import ConversationList from "$lib/components/chat/ConversationList.svelte";
  import ContactList from "$lib/components/chat/ContactList.svelte";
  import ChatPane from "$lib/components/chat/ChatPane.svelte";
  import QrLoginScreen from "$lib/components/chat/QrLoginScreen.svelte";
  import SettingsDialog from "$lib/components/chat/SettingsDialog.svelte";
  import { session } from "$lib/session.svelte";
  import { initDeepLinks } from "$lib/deeplink";

  let unlistenDeepLinks: (() => void) | null = null;

  // Check startup cloud-device state without touching the OS keychain.
  onMount(() => {
    session.restore();
    // Handle magic-link deep links (zca://) that open or focus the app.
    initDeepLinks().then((fn) => (unlistenDeepLinks = fn));
  });
  onDestroy(() => {
    unlistenDeepLinks?.();
    session.dispose();
  });
</script>

{#if session.loggedIn}
  <div class="bg-background flex h-screen w-screen overflow-hidden">
    <RailNav />
    {#if session.view === "contacts"}
      <ContactList />
    {:else}
      <ConversationList />
    {/if}
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <ChatPane />
    </div>
  </div>
  {#if session.qrAdding}
    <div class="fixed inset-0 z-50">
      <QrLoginScreen adding />
    </div>
  {/if}
  {#if session.settingsOpen}
    <SettingsDialog />
  {/if}
{:else if session.restoring}
  <div class="bg-background flex h-screen w-screen flex-col items-center justify-center gap-3">
    <Loader2 class="text-brand size-9 animate-spin" />
    <p class="text-muted-foreground text-sm">Đang kiểm tra trạng thái thiết bị cloud…</p>
  </div>
{:else}
  <QrLoginScreen />
  {#if session.cloudLinking}
    <div class="bg-background/80 fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 backdrop-blur-sm">
      <Loader2 class="text-brand size-9 animate-spin" />
      <p class="text-muted-foreground text-sm">Đang liên kết thiết bị từ email…</p>
    </div>
  {/if}
{/if}
