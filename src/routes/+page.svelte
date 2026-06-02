<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { Button } from "$lib/components/ui/button/index.js";

  type CredentialSummary = {
    imeiLen: number;
    cookieCount: number;
    userAgentLen: number;
    language: string;
  };

  type AccountProfile = {
    accountId: string;
    displayName: string | null;
  };

  let payload = $state("");
  let summary = $state<CredentialSummary | null>(null);
  let profile = $state<AccountProfile | null>(null);
  let error = $state("");
  let busy = $state(false);

  async function importCredentials() {
    error = "";
    summary = null;
    profile = null;
    busy = true;
    try {
      summary = await invoke<CredentialSummary>("import_credentials", { payload });
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function login() {
    error = "";
    profile = null;
    busy = true;
    try {
      profile = await invoke<AccountProfile>("login", { payload });
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<main class="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-8">
  <header class="space-y-1">
    <h1 class="text-3xl font-bold tracking-tight">Zalo Desktop</h1>
    <p class="text-muted-foreground text-sm">Import a ZaloDataExtractor JSON export, then log in.</p>
  </header>

  <form class="flex flex-col gap-3" onsubmit={(e) => { e.preventDefault(); importCredentials(); }}>
    <textarea
      bind:value={payload}
      rows="8"
      placeholder={'{ "imei": "...", "cookie": [...], "userAgent": "..." }'}
      class="border-input bg-background rounded-md border px-3 py-2 font-mono text-xs"
    ></textarea>
    <div class="flex gap-2">
      <Button type="submit" variant="outline" disabled={busy || payload.trim().length === 0}>
        {busy ? "Working…" : "Validate"}
      </Button>
      <Button type="button" onclick={login} disabled={busy || payload.trim().length === 0}>
        {busy ? "Working…" : "Log in"}
      </Button>
    </div>
  </form>

  {#if error}
    <p class="text-destructive text-sm" role="alert">{error}</p>
  {/if}

  {#if profile}
    <div class="rounded-md border p-4 text-sm" role="status">
      <p class="font-medium">Logged in</p>
      <ul class="text-muted-foreground mt-2 space-y-1">
        <li>Account: {profile.displayName ?? "(no display name)"}</li>
        <li>ID: {profile.accountId}</li>
      </ul>
    </div>
  {:else if summary}
    <div class="rounded-md border p-4 text-sm" role="status">
      <p class="font-medium">Credentials look valid</p>
      <ul class="text-muted-foreground mt-2 space-y-1">
        <li>Cookies: {summary.cookieCount}</li>
        <li>Language: {summary.language}</li>
        <li>imei length: {summary.imeiLen}</li>
        <li>userAgent length: {summary.userAgentLen}</li>
      </ul>
    </div>
  {/if}
</main>
