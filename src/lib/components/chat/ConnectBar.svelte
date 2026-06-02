<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { session } from "$lib/session.svelte";

  let threadInput = $state("");

  function openThread() {
    if (threadInput.trim()) {
      session.openThread(threadInput.trim());
      threadInput = "";
    }
  }
</script>

<div class="bg-background flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
  {#if session.profile}
    <span class="text-muted-foreground">
      Đã đăng nhập: <span class="text-foreground font-medium">{session.profile.displayName ?? session.profile.accountId}</span>
      {#if session.listening}
        · <span class="text-green-600">đang lắng nghe</span>
      {/if}
    </span>
    {#if !session.listening}
      <Button size="sm" variant="outline" onclick={() => session.loginAndListen()} disabled={session.busy}>
        Bật lắng nghe
      </Button>
    {/if}
    <div class="ml-auto flex items-center gap-2">
      <input
        bind:value={threadInput}
        placeholder="Mở hội thoại theo uid…"
        class="border-input bg-background w-48 rounded-md border px-2.5 py-1.5 text-xs outline-none"
        onkeydown={(e) => { if (e.key === "Enter") openThread(); }}
      />
      <Button size="sm" variant="outline" onclick={openThread} disabled={threadInput.trim().length === 0}>Mở</Button>
    </div>
  {:else}
    <span class="text-muted-foreground">Phiên đọc từ <code>.zalo-cred.json</code> — token không vào webview.</span>
    <div class="ml-auto flex items-center gap-2">
      <Button size="sm" variant="outline" onclick={() => session.checkSession()} disabled={session.busy}>
        Kiểm tra session
      </Button>
      <Button size="sm" class="bg-brand hover:bg-brand/90 text-brand-foreground" onclick={() => session.loginAndListen()} disabled={session.busy}>
        {session.busy ? "Đang xử lý…" : "Đăng nhập + lắng nghe"}
      </Button>
    </div>
  {/if}

  {#if session.error}
    <p class="text-destructive w-full text-xs" role="alert">{session.error}</p>
  {/if}
</div>
