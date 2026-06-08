<script lang="ts">
  // Top-level shell router. Shows ONE screen at a time — the top of the drill-in
  // stack (thread / settings detail) or the active tab's root — plus the bottom
  // tab bar when no screen is pushed. Each screen renders its own header.
  import { onMount } from "svelte";
  import { nav, type TabId } from "$lib/nav.svelte";
  import { session } from "$lib/session-store.svelte";
  import TabBar from "./tab-bar.svelte";

  // The native iOS glass tab bar (injected by glass-tabbar.mm) drives nav via
  // window.__setTab and flips this on once installed; until then (or on Android)
  // the HTML tab bar is the fallback.
  let nativeBar = $state(false);

  onMount(() => {
    const w = window as unknown as {
      __setTab?: (name: string) => void;
      __onGlassTabBar?: () => void;
    };
    w.__setTab = (name: string) => nav.setTab(name as TabId);
    w.__onGlassTabBar = () => (nativeBar = true);
    // Native may have installed before this mounted.
    if ((window as unknown as { webkit?: { messageHandlers?: { glassTabBar?: unknown } } }).webkit?.messageHandlers?.glassTabBar) {
      nativeBar = true;
    }
  });

  // Push nav state to the native glass tab bar: hide on a pushed screen, mirror
  // the active tab + unread badge.
  $effect(() => {
    const handler = (window as unknown as { webkit?: { messageHandlers?: { glassTabBar?: { postMessage(m: unknown): void } } } })
      .webkit?.messageHandlers?.glassTabBar;
    handler?.postMessage({ hidden: !!nav.top, activeTab: nav.tab, unread: nav.unread });
  });
  import ConversationListScreen from "$lib/components/conversations/conversation-list-screen.svelte";
  import ThreadScreen from "$lib/components/thread/thread-screen.svelte";
  import ContactsScreen from "$lib/components/contacts/contacts-screen.svelte";
  import SettingsScreen from "$lib/components/settings/settings-screen.svelte";
  import AppearanceSettings from "$lib/components/settings/appearance-settings.svelte";
  import AccountSettings from "$lib/components/settings/account-settings.svelte";
  import DeviceSettings from "$lib/components/settings/device-settings.svelte";
  import AboutSettings from "$lib/components/settings/about-settings.svelte";

  // Keep the chats tab badge in sync with the active account's unread total.
  $effect(() => {
    nav.unread = session.conversations.reduce((sum, c) => sum + (c.unread || 0), 0);
  });
</script>

<div class="bg-background relative h-dvh overflow-hidden">
  <div class="h-full">
    {#if nav.top}
      {@const name = nav.top.name}
      {#if name === "thread"}
        <ThreadScreen title={(nav.top.props?.title as string) ?? ""} />
      {:else if name === "settings-appearance"}
        <AppearanceSettings />
      {:else if name === "settings-account"}
        <AccountSettings />
      {:else if name === "settings-device"}
        <DeviceSettings />
      {:else if name === "settings-about"}
        <AboutSettings />
      {/if}
    {:else if nav.tab === "chats"}
      <ConversationListScreen />
    {:else if nav.tab === "contacts"}
      <ContactsScreen />
    {:else}
      <SettingsScreen />
    {/if}
  </div>
  <!-- HTML tab bar — fallback when the native glass tab bar isn't installed. -->
  {#if !nav.top && !nativeBar}
    <TabBar />
  {/if}
</div>
