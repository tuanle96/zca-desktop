<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { onDestroy } from "svelte";
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

  type IncomingMessage = {
    accountId: string;
    threadId: string;
    threadKind: "user" | "group";
    fromId: string;
    fromName: string | null;
    text: string | null;
    msgId: string;
    timestamp: string;
    isSelf: boolean;
  };

  let payload = $state("");
  let summary = $state<CredentialSummary | null>(null);
  let profile = $state<AccountProfile | null>(null);
  let messages = $state<IncomingMessage[]>([]);
  let listening = $state(false);
  let error = $state("");
  let busy = $state(false);

  let threadId = $state("");
  let outgoing = $state("");
  let sentMsgId = $state("");

  let unlisten: UnlistenFn | null = null;

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

  async function startListening() {
    error = "";
    busy = true;
    try {
      if (!unlisten) {
        unlisten = await listen<IncomingMessage>("zalo://message", (event) => {
          messages = [event.payload, ...messages].slice(0, 50);
        });
      }
      profile = await invoke<AccountProfile>("start_listening", { payload });
      listening = true;
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function sendMessage() {
    error = "";
    sentMsgId = "";
    busy = true;
    try {
      if (!profile) throw new Error("log in first");
      sentMsgId = await invoke<string>("send_message", {
        accountId: profile.accountId,
        threadId,
        text: outgoing,
      });
      outgoing = "";
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  onDestroy(() => {
    unlisten?.();
  });</script>

<main class="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-8">
  <header class="space-y-1">
    <h1 class="text-3xl font-bold tracking-tight">Zalo Desktop</h1>
    <p class="text-muted-foreground text-sm">Import a ZaloDataExtractor JSON export, then log in and listen.</p>
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
      <Button type="button" variant="outline" onclick={login} disabled={busy || payload.trim().length === 0}>
        {busy ? "Working…" : "Log in"}
      </Button>
      <Button type="button" onclick={startListening} disabled={busy || listening || payload.trim().length === 0}>
        {listening ? "Listening…" : "Log in + listen"}
      </Button>
    </div>
  </form>

  {#if error}
    <p class="text-destructive text-sm" role="alert">{error}</p>
  {/if}

  {#if profile}
    <div class="rounded-md border p-4 text-sm" role="status">
      <p class="font-medium">Logged in{listening ? " · listening" : ""}</p>
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

  {#if profile}
    <section class="flex flex-col gap-3">
      <h2 class="text-sm font-medium">Send a message</h2>
      <form class="flex flex-col gap-2" onsubmit={(e) => { e.preventDefault(); sendMessage(); }}>
        <input
          bind:value={threadId}
          placeholder="thread id (recipient uid)"
          class="border-input bg-background rounded-md border px-3 py-2 text-sm"
        />
        <div class="flex gap-2">
          <input
            bind:value={outgoing}
            placeholder="Message…"
            class="border-input bg-background flex-1 rounded-md border px-3 py-2 text-sm"
          />
          <Button type="submit" disabled={busy || threadId.trim().length === 0 || outgoing.trim().length === 0}>
            Send
          </Button>
        </div>
      </form>
      {#if sentMsgId}
        <p class="text-muted-foreground text-xs">Sent · msgId {sentMsgId}</p>
      {/if}
    </section>
  {/if}

  {#if messages.length > 0}
    <section class="flex flex-col gap-2">
      <h2 class="text-sm font-medium">Incoming messages</h2>      <ul class="flex flex-col gap-2">
        {#each messages as m (m.msgId)}
          <li class="rounded-md border p-3 text-sm">
            <p class="text-muted-foreground text-xs">
              {m.fromName ?? m.fromId} · {m.threadKind}{m.isSelf ? " · self" : ""}
            </p>
            <p>{m.text ?? "(non-text message)"}</p>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</main>
