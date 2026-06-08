<script lang="ts">
  // iOS large-title header for tab roots (Messages / Contacts / Settings style):
  // big bold title, optional trailing action, optional row beneath (e.g. search).
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    action?: Snippet;
    children?: Snippet;
  }

  let { title, action, children }: Props = $props();
</script>

<div class="glass sticky top-0 z-10 pt-safe-top shadow-[inset_0_-1px_0_0_rgba(255,255,255,0.12)]">
  <div class="flex items-end justify-between gap-2 px-4 pb-1 pt-2">
    <h1 class="text-[32px] font-bold leading-none tracking-tight">{title}</h1>
    {#if action}<div class="flex items-center pb-0.5">{@render action()}</div>{/if}
  </div>
  {#if children}<div class="px-4 pb-2 pt-2">{@render children()}</div>{/if}
</div>
