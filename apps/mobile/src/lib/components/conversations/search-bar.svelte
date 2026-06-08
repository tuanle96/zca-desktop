<script lang="ts">
  // Rounded search field, reused by conversations + contacts (Phase 9).
  import { Search } from "@lucide/svelte";

  interface Props {
    value?: string;
    placeholder?: string;
  }

  let { value = $bindable(""), placeholder = "Tìm kiếm" }: Props = $props();
</script>

<div class="bg-muted flex items-center gap-2 rounded-full px-3.5 py-2.5">
  <Search class="text-muted-foreground size-4 shrink-0" />
  <input
    {placeholder}
    {value}
    oninput={(e) => (value = e.currentTarget.value)}
    autocapitalize="none"
    autocorrect="off"
    class="placeholder:text-muted-foreground text-foreground w-full bg-transparent text-sm outline-none"
  />
</div>
