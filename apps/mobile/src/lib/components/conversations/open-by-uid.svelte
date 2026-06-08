<script lang="ts">
  // Power-user fold-out: open/start a conversation by Zalo uid.
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";

  interface Props {
    onopen: (uid: string) => void;
  }

  let { onopen }: Props = $props();
  let uid = $state("");

  function submit() {
    const id = uid.trim();
    if (!id) return;
    onopen(id);
    uid = "";
  }
</script>

<div class="bg-muted/40 flex items-center gap-2 border-b border-border px-4 py-2">
  <Input bind:value={uid} placeholder="Mở hội thoại theo uid…" class="min-h-10 flex-1 text-sm" />
  <Button disabled={uid.trim().length === 0} onclick={submit} class="min-h-10">Mở</Button>
</div>
