<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { log } from "$lib/log";
  import { theme } from "$lib/theme.svelte";

  let { children } = $props();

  // Apply the saved theme (light/dark/system) + surface uncaught errors to the
  // console so they're captured in the simulator log for debugging.
  onMount(() => {
    theme.init();
    const onError = (e: ErrorEvent) => log.error(`uncaught: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
    const onRejection = (e: PromiseRejectionEvent) => log.error(`unhandled rejection: ${String(e.reason)}`);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      theme.dispose();
    };
  });
</script>

{@render children()}
