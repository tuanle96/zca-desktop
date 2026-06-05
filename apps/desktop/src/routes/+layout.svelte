<script lang="ts">
  import "../app.css";
  import { onMount, onDestroy } from "svelte";
  import { theme } from "$lib/theme.svelte";
  import { notifications } from "$lib/notifications.svelte";
  let { children } = $props();

  onMount(() => {
    theme.init();
    notifications.init();
  });
  onDestroy(() => {
    theme.dispose();
    notifications.dispose();
  });
</script>

{@render children()}
