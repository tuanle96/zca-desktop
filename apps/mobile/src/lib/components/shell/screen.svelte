<script lang="ts">
  // Scrollable screen body. The shell owns the fixed header + tab bar; a Screen
  // is the flex-growing, internally-scrolling content region between them.
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils";

  interface Props {
    children: Snippet;
    class?: string;
  }

  let { children, class: klass = "" }: Props = $props();
</script>

<div class={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", klass)}>
  {@render children()}
</div>
