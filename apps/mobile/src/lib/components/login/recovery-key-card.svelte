<script lang="ts">
  // Shows the recovery key issued once on first device link, with a copy button
  // and a "save this" warning. Best-effort clipboard (navigator.clipboard may be
  // restricted in the iOS webview — the key stays visible for manual copy).
  import { KeyRound, Copy, Check } from "@lucide/svelte";
  import Button from "$lib/components/ui/button.svelte";

  interface Props {
    recoveryKey: string;
  }

  let { recoveryKey }: Props = $props();
  let copied = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // Clipboard blocked — the key is shown below for manual copy.
      copied = false;
    }
  }
</script>

<div class="border-brand/40 bg-brand-muted/40 flex flex-col gap-2 rounded-xl border p-4">
  <div class="text-brand flex items-center gap-2 text-sm font-semibold">
    <KeyRound class="size-4" /> Recovery key
  </div>
  <p class="text-muted-foreground text-xs">
    Lưu mã này ở nơi an toàn — bạn cần nó để liên kết thiết bị mới. Mã chỉ hiện một lần.
  </p>
  <code class="bg-background/70 text-foreground break-all rounded-lg border border-border px-3 py-2 text-sm">
    {recoveryKey}
  </code>
  <Button variant="outline" onclick={copy} class="self-start">
    {#if copied}<Check class="size-4" /> Đã sao chép{:else}<Copy class="size-4" /> Sao chép{/if}
  </Button>
</div>
