<script lang="ts">
  import "../app.css";
  import { onMount, onDestroy } from "svelte";
  import { theme } from "$lib/theme.svelte";
  let { children } = $props();

  onMount(() => theme.init());
  onDestroy(() => theme.dispose());
</script>

{@render children()}
