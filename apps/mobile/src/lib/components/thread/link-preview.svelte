<script lang="ts">
  // Compact link card under a chat.link message bubble.
  import type { LinkPreview } from "@zca/types";
  import { ExternalLink } from "@lucide/svelte";

  interface Props {
    link: LinkPreview;
  }

  let { link }: Props = $props();

  function open() {
    if (link.href) window.open(link.href, "_blank", "noopener,noreferrer");
  }
</script>

<button
  onclick={open}
  class="border-border bg-background/60 active:bg-muted mt-1 flex w-full items-start gap-2 rounded-lg border p-2 text-left"
>
  {#if link.thumb}
    <img src={link.thumb} alt="" class="size-12 shrink-0 rounded object-cover" />
  {/if}
  <div class="min-w-0 flex-1">
    <p class="truncate text-xs font-medium">{link.title || link.href}</p>
    {#if link.description}
      <p class="text-muted-foreground line-clamp-2 text-xs">{link.description}</p>
    {/if}
  </div>
  <ExternalLink class="text-muted-foreground size-3.5 shrink-0" />
</button>
