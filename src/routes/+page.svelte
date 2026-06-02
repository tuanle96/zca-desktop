<script lang="ts">
  import { onDestroy } from "svelte";
  import RailNav from "$lib/components/chat/RailNav.svelte";
  import ConversationList from "$lib/components/chat/ConversationList.svelte";
  import ContactList from "$lib/components/chat/ContactList.svelte";
  import ChatPane from "$lib/components/chat/ChatPane.svelte";
  import ConnectBar from "$lib/components/chat/ConnectBar.svelte";
  import { session } from "$lib/session.svelte";

  onDestroy(() => session.dispose());
</script>

<div class="bg-background flex h-screen w-screen overflow-hidden">
  <RailNav />
  {#if session.view === "contacts"}
    <ContactList />
  {:else}
    <ConversationList />
  {/if}
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <ConnectBar />
    <ChatPane />
  </div>
</div>
