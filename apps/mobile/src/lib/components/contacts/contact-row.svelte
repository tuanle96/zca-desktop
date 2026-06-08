<script lang="ts">
  // One contact: avatar + display name + secondary Zalo name. Tap to open chat.
  import type { Contact } from "@zca/types";
  import Avatar from "$lib/components/ui/avatar.svelte";
  import { initials } from "$lib/chat-format";

  interface Props {
    contact: Contact;
    onselect: () => void;
  }

  let { contact, onselect }: Props = $props();
</script>

<button
  type="button"
  onclick={onselect}
  class="active:bg-muted/60 flex w-full items-center gap-3 px-4 py-2 text-left transition-colors"
>
  <Avatar src={contact.avatar} alt={contact.displayName} fallback={initials(contact.displayName)} class="size-11" />
  <div class="min-w-0 flex-1 border-b border-border/60 pb-2">
    <p class="truncate font-medium">{contact.displayName}</p>
    {#if contact.zaloName && contact.zaloName !== contact.displayName}
      <p class="text-muted-foreground truncate text-sm">{contact.zaloName}</p>
    {/if}
  </div>
</button>
