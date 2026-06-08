<script lang="ts">
  // iOS-style navigation bar: translucent blurred background, centered 17pt
  // title, brand-colored back chevron, optional trailing action. Notch-padded.
  import type { Snippet } from "svelte";
  import { ChevronLeft } from "@lucide/svelte";

  interface Props {
    title?: string;
    /** When set, a back chevron is shown that calls this on tap. */
    onback?: () => void;
    /** Optional trailing action (icon button, etc.). */
    action?: Snippet;
  }

  let { title = "", onback, action }: Props = $props();
</script>

<header
  class="glass sticky top-0 z-10 pt-safe-top shadow-[inset_0_-1px_0_0_rgba(255,255,255,0.12)]"
>
  <div class="grid h-11 grid-cols-[1fr_auto_1fr] items-center px-1">
    <div class="flex justify-start">
      {#if onback}
        <button
          class="text-brand flex h-11 items-center pl-1 pr-3 transition-opacity active:opacity-50"
          onclick={onback}
          aria-label="Quay lại"
        >
          <ChevronLeft class="size-7" strokeWidth={2.2} />
        </button>
      {/if}
    </div>
    <h1 class="truncate px-2 text-center text-[17px] font-semibold">{title}</h1>
    <div class="flex items-center justify-end pr-1">
      {#if action}{@render action()}{/if}
    </div>
  </div>
</header>
