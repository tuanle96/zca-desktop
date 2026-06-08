<script lang="ts">
  // Active-account avatar button for the conversation-list header. The sheet it
  // opens is rendered at the screen root (NOT here) — a `backdrop-filter` ancestor
  // (the blurred header) would otherwise become the containing block for the
  // sheet's `position: fixed`, pinning it to the header instead of the viewport.
  import Avatar from "$lib/components/ui/avatar.svelte";
  import { session } from "$lib/session-store.svelte";
  import { initials } from "$lib/chat-format";

  interface Props {
    onopen: () => void;
  }
  let { onopen }: Props = $props();
</script>

<button onclick={onopen} aria-label="Đổi tài khoản" class="active:opacity-60">
  <Avatar
    src={session.profile?.avatar}
    alt={session.profile?.displayName ?? ""}
    fallback={initials(session.profile?.displayName ?? "?")}
    class="ring-brand/30 size-8 ring-2"
  />
</button>
