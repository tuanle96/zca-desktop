<script lang="ts">
  // Mobile entry. On launch: restore a linked cloud device + wire deep links,
  // then gate:
  //   restoring        → connecting splash
  //   logged in        → app shell (+ add-account overlay when session.qrAdding)
  //   linked, no acct  → add-account QR screen
  //   not linked       → login screen
  import { onMount, onDestroy } from "svelte";
  import { session } from "$lib/session-store.svelte";
  import { initDeepLinks } from "$lib/deeplink";
  import AppShell from "$lib/components/shell/app-shell.svelte";
  import LoginScreen from "$lib/components/login/login-screen.svelte";
  import AddAccountScreen from "$lib/components/login/add-account-screen.svelte";

  let cleanupDeepLinks: (() => void) | null = null;

  onMount(async () => {
    void session.restore();
    cleanupDeepLinks = await initDeepLinks();
  });
  onDestroy(() => cleanupDeepLinks?.());
</script>

{#if session.restoring}
  <div class="bg-background flex h-dvh flex-col items-center justify-center gap-3">
    <div class="border-brand size-8 animate-spin rounded-full border-2 border-t-transparent"></div>
    <p class="text-muted-foreground text-sm">Đang kết nối…</p>
  </div>
{:else if session.loggedIn}
  <AppShell />
  {#if session.qrAdding}
    <div class="fixed inset-0 z-50">
      <AddAccountScreen adding />
    </div>
  {/if}
{:else if session.cloudMode}
  <AddAccountScreen />
{:else}
  <LoginScreen />
{/if}
