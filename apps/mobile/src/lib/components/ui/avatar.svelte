<script lang="ts">
  // Minimal avatar: remote image with an initials fallback (and on image error).
  // Replaces shadcn's Avatar (not in mobile). Avatar URLs are CSP-allowlisted.
  import { cn } from "$lib/utils";

  interface Props {
    src?: string | null;
    alt?: string;
    fallback: string;
    class?: string;
  }

  let { src = null, alt = "", fallback, class: klass = "size-12" }: Props = $props();
  let failed = $state(false);
</script>

<div
  class={cn(
    "bg-brand/10 text-brand relative flex shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-medium",
    klass,
  )}
>
  {#if src && !failed}
    <img {src} {alt} class="size-full object-cover" onerror={() => (failed = true)} />
  {:else}
    {fallback}
  {/if}
</div>
