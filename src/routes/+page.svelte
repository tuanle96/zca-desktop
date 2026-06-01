<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { Button } from "$lib/components/ui/button/index.js";

  let name = $state("");
  let greetMsg = $state("");

  async function greet() {
    greetMsg = await invoke("greet", { name });
  }
</script>

<main class="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
  <h1 class="text-3xl font-bold tracking-tight">Zalo Desktop</h1>
  <p class="text-muted-foreground text-sm">Tauri v2 · Svelte 5 · Tailwind v4 · shadcn-svelte</p>

  <form class="flex w-full max-w-sm items-center gap-2" onsubmit={(e) => { e.preventDefault(); greet(); }}>
    <input
      bind:value={name}
      placeholder="Tên..."
      class="border-input bg-background flex-1 rounded-md border px-3 py-2 text-sm"
    />
    <Button type="submit">Greet</Button>
  </form>

  {#if greetMsg}
    <p class="text-sm">{greetMsg}</p>
  {/if}
</main>
