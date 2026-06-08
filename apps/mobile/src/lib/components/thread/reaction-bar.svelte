<script lang="ts">
  // Long-press action bar: 6 quick reactions + a reply action.
  import { Reply } from "@lucide/svelte";
  import type { ReactionIcon } from "@zca/types";
  import { REACTION_OPTIONS } from "$lib/chat-format";

  interface Props {
    onreact: (icon: ReactionIcon) => void;
    onreply: () => void;
  }

  let { onreact, onreply }: Props = $props();
</script>

<div class="bg-popover flex items-center gap-0.5 rounded-full border border-border p-1 shadow-lg">
  {#each REACTION_OPTIONS as r (r.icon)}
    <button
      class="active:bg-muted flex size-9 items-center justify-center rounded-full text-xl leading-none"
      onclick={() => onreact(r.icon)}
      aria-label={r.label}
    >
      {r.emoji}
    </button>
  {/each}
  <button
    class="text-muted-foreground active:bg-muted flex size-9 items-center justify-center rounded-full"
    onclick={onreply}
    aria-label="Trả lời"
  >
    <Reply class="size-5" />
  </button>
</div>
