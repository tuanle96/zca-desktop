<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Loader2 } from "@lucide/svelte";
  import RailNav from "$lib/components/chat/RailNav.svelte";
  import ConversationList from "$lib/components/chat/ConversationList.svelte";
  import ContactList from "$lib/components/chat/ContactList.svelte";
  import ChatPane from "$lib/components/chat/ChatPane.svelte";
  import QrLoginScreen from "$lib/components/chat/QrLoginScreen.svelte";
  import { session } from "$lib/session.svelte";

  // Try to restore a saved session before showing the QR gate.
  onMount(() => session.restore());
  onDestroy(() => session.dispose());
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
{:else if session.restoring}
  <div class="bg-background flex h-screen w-screen flex-col items-center justify-center gap-3">
    <Loader2 class="text-brand size-9 animate-spin" />
    <p class="text-muted-foreground text-sm">Đang khôi phục phiên đăng nhập…</p>
  </div>
{:else}
  <QrLoginScreen />
{/if}
