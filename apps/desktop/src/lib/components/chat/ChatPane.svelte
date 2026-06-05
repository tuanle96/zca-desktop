<script lang="ts">
  import {
    Phone,
    Video,
    Search,
    PanelRight,
    Send,
    Smile,
    Paperclip,
    MessageCircle,
    Quote,
    X,
    Heart,
    FileDown,
    Cloud,
    Wifi,
    WifiOff,
  } from "@lucide/svelte";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { session } from "$lib/session.svelte";
  import StickerPicker from "./StickerPicker.svelte";
  import type { ChatMessage, QuoteInput, Sticker } from "$lib/types";

  let draft = $state("");
  let scroller = $state<HTMLElement | null>(null);
  let showStickers = $state(false);
  let replyTo = $state<ChatMessage | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let dragDepth = $state(0);
  let uploadError = $state("");
  // Track the hovered message explicitly. Relying on CSS :hover alone leaves the
  // action buttons stuck visible in the webview when the list auto-scrolls under
  // a stationary cursor (Chromium doesn't recompute :hover without pointer moves).
  let hoveredId = $state<string | null>(null);

  const convo = $derived(session.activeConversation);
  const messages = $derived(session.activeMessages);
  const isDraggingFile = $derived(dragDepth > 0 && session.canUseCloudFiles);
  const realtimeLabel = $derived(session.realtimeLabel);
  const realtimeDotClass = $derived(
    session.realtimeState === "live"
      ? "bg-green-500"
      : session.realtimeState === "connecting" || session.realtimeState === "reconnecting"
        ? "bg-amber-500"
        : "bg-muted-foreground/40",
  );
  const realtimeShortLabel = $derived(
    session.realtimeState === "live"
      ? "Live"
      : session.realtimeState === "connecting" || session.realtimeState === "reconnecting"
        ? "Reconnecting"
        : "Offline",
  );
  const fileButtonTitle = $derived(
    session.canUseCloudFiles ? "Đính kèm tệp cloud" : "Đính kèm bật sau khi cloud kết nối",
  );

  // Autoscroll to the newest message when the active thread's list grows.
  $effect(() => {
    void messages.length;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    // Content shifted under the cursor; the old hover target is no longer valid.
    hoveredId = null;
  });

  function initials(name: string): string {
    const parts = name.trim().split(/\s+/);
    const a = parts[0]?.[0] ?? "";
    const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (a + b).toUpperCase() || "?";
  }

  function clock(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // Show a day separator when the calendar day changes between messages.
  function dayLabel(at: number): string {
    const d = new Date(at);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    return isToday ? "Hôm nay" : d.toLocaleDateString("vi-VN");
  }

  function showDaySep(i: number): boolean {
    if (i === 0) return true;
    return dayLabel(messages[i].at) !== dayLabel(messages[i - 1].at);
  }

  async function send() {
    let quote: QuoteInput | undefined;
    if (replyTo) {
      quote = {
        content: replyTo.body,
        msgType: replyTo.sticker ? "chat.sticker" : "webchat",
        uidFrom: replyTo.outgoing ? (session.profile?.accountId ?? "") : replyTo.id,
        msgId: replyTo.id,
        cliMsgId: replyTo.id,
        ts: replyTo.at,
        ttl: 0,
      };
    }
    const ok = await session.sendActive(draft, quote);
    if (ok) { draft = ""; replyTo = null; }
  }

  async function pickSticker(sticker: Sticker) {
    showStickers = false;
    await session.sendSticker(sticker);
  }

  async function uploadFiles(files: File[]) {
    if (!files.length || !session.canUseCloudFiles || session.busy) return;
    uploadError = "";
    for (const file of files) {
      const result = await session.uploadCloudFile(file);
      if (!result.ok) {
        uploadError = `Không gửi được ${file.name || "tệp đính kèm"}: ${result.error ?? "không rõ lỗi"}`;
        return;
      }
    }
  }

  async function pickFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    await uploadFiles(files);
  }

  function hasDraggedFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  function dragEnter(event: DragEvent) {
    if (!hasDraggedFiles(event) || !session.canUseCloudFiles) return;
    event.preventDefault();
    dragDepth += 1;
  }

  function dragOver(event: DragEvent) {
    if (!hasDraggedFiles(event) || !session.canUseCloudFiles) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  function dragLeave(event: DragEvent) {
    if (!hasDraggedFiles(event) || !session.canUseCloudFiles) return;
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
  }

  async function dropFiles(event: DragEvent) {
    if (!hasDraggedFiles(event) || !session.canUseCloudFiles) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []);
    dragDepth = 0;
    await uploadFiles(files);
  }

  function fileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function filePreviewUrl(m: ChatMessage): string | null {
    return m.file?.thumb || m.file?.sourceUrl || null;
  }

  function canDownloadCloudFile(m: ChatMessage): boolean {
    return Boolean(m.file?.id);
  }

  function openRemoteFile(m: ChatMessage) {
    if (m.file?.sourceUrl) window.open(m.file.sourceUrl, "_blank", "noopener,noreferrer");
  }

  function bubbleAvatar(m: ChatMessage): string | null {
    if (m.outgoing) return null;
    return m.authorAvatar ?? convo?.avatar ?? null;
  }

  function bubbleName(m: ChatMessage): string {
    return m.authorName ?? convo?.title ?? "Zalo";
  }
</script>

{#if !convo}
  <section class="bg-muted/20 flex flex-1 flex-col items-center justify-center gap-4 text-center">
    <div class="bg-brand/10 text-brand flex size-24 items-center justify-center rounded-full">
      <MessageCircle class="size-11" />
    </div>
    <div class="space-y-1.5">
      <h2 class="text-xl font-semibold">Chào mừng đến Zalo Desktop</h2>
      <p class="text-muted-foreground mx-auto max-w-sm text-sm">
        Chọn một cuộc trò chuyện ở bên trái, hoặc chờ cloud đồng bộ hội thoại mới nhất.
      </p>
    </div>
    {#if session.profile}
      <div class="text-muted-foreground mt-2 flex items-center gap-2 text-xs">
        <span class="flex items-center gap-1.5 rounded-full border bg-background px-2 py-1">
          <Cloud class="size-3.5" />
          Cloud mode
        </span>
        <span class="flex items-center gap-1.5 rounded-full border bg-background px-2 py-1">
          <span class="size-2 rounded-full {realtimeDotClass}"></span>
          {realtimeLabel}
        </span>
      </div>
    {/if}
  </section>
{:else}
  <section
    class="bg-muted/20 relative flex min-h-0 flex-1 flex-col"
    aria-label={`Hội thoại ${convo.title}`}
    ondragenter={dragEnter}
    ondragover={dragOver}
    ondragleave={dragLeave}
    ondrop={dropFiles}
  >
    {#if isDraggingFile}
      <div class="border-brand/70 bg-brand/10 text-brand pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-lg border-2 border-dashed text-sm font-medium">
        Thả tệp vào đây để gửi
      </div>
    {/if}
    <!-- Header -->
    <header class="bg-background flex items-center gap-3 border-b px-4 py-2.5">
      <Avatar.Root class="size-10 shrink-0">
        {#if convo.avatar}
          <Avatar.Image src={convo.avatar} alt={convo.title} />
        {/if}
        <Avatar.Fallback class="bg-brand/10 text-brand text-sm font-medium">
          {initials(convo.title)}
        </Avatar.Fallback>
      </Avatar.Root>
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold">{convo.title}</div>
      <div class="text-muted-foreground flex items-center gap-2 text-xs">
          <span class="flex items-center gap-1">
            <span class="size-1.5 rounded-full {realtimeDotClass}"></span>
            {convo.kind === "group" ? "Nhóm" : "Liên hệ"}
          </span>
          <span class="flex items-center gap-1">
            <Cloud class="size-3" />
            Cloud
          </span>
          <span class="flex items-center gap-1">
            {#if session.realtimeState === "live"}
              <Wifi class="size-3" />
            {:else}
              <WifiOff class="size-3" />
            {/if}
            {realtimeShortLabel}
          </span>
        </div>
      </div>
      <div class="text-muted-foreground flex items-center gap-0.5">
        <button class="hover:bg-muted hover:text-foreground flex size-9 items-center justify-center rounded-md transition-colors" title="Gọi thoại" aria-label="Gọi thoại"><Phone class="size-5" /></button>
        <button class="hover:bg-muted hover:text-foreground flex size-9 items-center justify-center rounded-md transition-colors" title="Gọi video" aria-label="Gọi video"><Video class="size-5" /></button>
        <button class="hover:bg-muted hover:text-foreground flex size-9 items-center justify-center rounded-md transition-colors" title="Tìm trong hội thoại" aria-label="Tìm trong hội thoại"><Search class="size-5" /></button>
        <button class="hover:bg-muted hover:text-foreground flex size-9 items-center justify-center rounded-md transition-colors" title="Thông tin" aria-label="Thông tin"><PanelRight class="size-5" /></button>
      </div>
    </header>

    <!-- Messages -->
    <div bind:this={scroller} class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      {#if messages.length === 0}
        <p class="text-muted-foreground py-10 text-center text-sm">
          Chưa có tin nhắn trong hội thoại này. Hãy gửi lời chào.
        </p>
      {:else}
        <div class="mx-auto flex max-w-3xl flex-col gap-1.5">
          {#each messages as m, i (m.id)}
            {#if showDaySep(i)}
              <div class="my-2 flex justify-center">
                <span class="bg-muted text-muted-foreground rounded-full px-3 py-0.5 text-xs">{dayLabel(m.at)}</span>
              </div>
            {/if}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="group/message flex {m.outgoing ? 'justify-end' : 'justify-start'}"
              onpointerenter={() => hoveredId = m.id}
              onpointerleave={() => { if (hoveredId === m.id) hoveredId = null; }}
            >
              {#if m.sticker}
                <div class="flex items-end gap-1.5 {m.outgoing ? 'flex-row-reverse' : 'flex-row'}">
                  {#if !m.outgoing}
                    <Avatar.Root class="mb-5 size-8 shrink-0">
                      {#if bubbleAvatar(m)}
                        <Avatar.Image src={bubbleAvatar(m)!} alt={bubbleName(m)} />
                      {/if}
                      <Avatar.Fallback class="bg-brand/10 text-brand text-xs font-medium">
                        {initials(bubbleName(m))}
                      </Avatar.Fallback>
                    </Avatar.Root>
                  {/if}
                  <div class="flex flex-col {m.outgoing ? 'items-end' : 'items-start'}">
                    <img
                      src={m.sticker.url}
                      alt="sticker"
                      class="size-32 object-contain"
                      loading="lazy"
                    />
                    <div class="text-muted-foreground mt-0.5 flex items-center gap-1 text-[10px]">
                      {#if m.reactionIcon}
                        <span class="text-xs leading-none">{m.reactionIcon}</span>
                      {/if}
                      <span>{clock(m.at)}</span>
                    </div>
                  </div>
                  <div class="flex items-center gap-1 transition-opacity {hoveredId === m.id ? 'opacity-100' : 'opacity-0'} group-focus-within/message:opacity-100">
                    <button
                      onclick={() => replyTo = m}
                      class="bg-background text-muted-foreground hover:bg-muted hover:text-brand flex size-7 items-center justify-center rounded-full border shadow-sm transition-colors"
                      title="Trích dẫn"
                      aria-label="Trích dẫn"
                    >
                      <Quote class="size-3.5" />
                    </button>
                    <button
                      onclick={() => session.sendReaction(m, "heart")}
                      class="bg-background text-muted-foreground hover:bg-muted hover:text-brand flex size-7 items-center justify-center rounded-full border shadow-sm transition-colors"
                      title="Thả tim"
                      aria-label="Thả tim"
                    >
                      <Heart class="size-3.5" />
                    </button>
                  </div>
                </div>
              {:else}
                <div class="flex items-end gap-1.5 {m.outgoing ? 'flex-row-reverse' : 'flex-row'}">
                  {#if !m.outgoing}
                    <Avatar.Root class="mb-1 size-8 shrink-0">
                      {#if bubbleAvatar(m)}
                        <Avatar.Image src={bubbleAvatar(m)!} alt={bubbleName(m)} />
                      {/if}
                      <Avatar.Fallback class="bg-brand/10 text-brand text-xs font-medium">
                        {initials(bubbleName(m))}
                      </Avatar.Fallback>
                    </Avatar.Root>
                  {/if}
                  <div
                    class="max-w-[68%] rounded-2xl px-3.5 py-2 text-sm shadow-sm {m.outgoing
                      ? 'bg-brand text-brand-foreground rounded-br-md'
                      : 'bg-background rounded-bl-md'}"
                  >
                    {#if m.quote}
                      <div class="mb-1 rounded-md border-l-2 border-current/30 bg-black/5 px-2 py-1 text-xs opacity-80">
                        <div class="font-medium">{m.quote.fromD || "Tin nhắn"}</div>
                        <div class="line-clamp-2 break-words">{m.quote.msg}</div>
                      </div>
                    {/if}
                    {#if m.file}
                      <div class="flex max-w-full flex-col gap-2 rounded-md border border-current/15 bg-black/5 p-2 text-left text-xs">
                        {#if m.file.mediaKind === "image" && filePreviewUrl(m)}
                          <button
                            type="button"
                            onclick={() => canDownloadCloudFile(m) ? session.downloadCloudFile(m) : openRemoteFile(m)}
                            class="overflow-hidden rounded-md border border-current/10 bg-background/50"
                            title={m.file.filename || "Mở hình ảnh"}
                            aria-label={m.file.filename || "Mở hình ảnh"}
                          >
                            <img src={filePreviewUrl(m)!} alt={m.file.filename || "Hình ảnh"} class="max-h-56 w-full object-cover" loading="lazy" />
                          </button>
                        {/if}
                        <button
                          type="button"
                          onclick={() => canDownloadCloudFile(m) ? session.downloadCloudFile(m) : openRemoteFile(m)}
                          class="hover:bg-background/40 flex max-w-full items-center gap-2 rounded-md p-1 text-left transition-colors"
                          disabled={!canDownloadCloudFile(m) && !m.file.sourceUrl}
                        >
                          <FileDown class="size-4 shrink-0" />
                          <span class="min-w-0 flex-1">
                            <span class="block truncate font-medium">{m.file.filename || "Tệp đính kèm"}</span>
                            <span class="opacity-70">
                              {#if m.file.mediaKind && m.file.mediaKind !== "file"}{m.file.mediaKind}{/if}
                              {#if fileSize(m.file.sizeBytes)} {fileSize(m.file.sizeBytes)}{/if}
                            </span>
                          </span>
                        </button>
                      </div>
                    {:else if m.deleted}
                      <p class="text-muted-foreground italic">{m.body}</p>
                    {:else}
                      <p class="whitespace-pre-wrap break-words">{m.body}</p>
                    {/if}
                    {#if m.link}
                      <a
                        href={m.link.href}
                        target="_blank"
                        rel="noreferrer"
                        class="mt-2 block rounded-md border border-current/15 bg-black/5 p-2 text-xs hover:bg-black/10"
                      >
                        <div class="font-medium">{m.link.title || m.link.href}</div>
                        {#if m.link.description}
                          <div class="mt-0.5 line-clamp-2 opacity-75">{m.link.description}</div>
                        {/if}
                      </a>
                    {/if}
                    <div class="mt-1 flex items-center justify-end gap-1">
                      {#if m.reactionIcon}
                        <span class="text-xs leading-none">{m.reactionIcon}</span>
                      {/if}
                      <span class="text-[10px] opacity-60">{clock(m.at)}</span>
                    </div>
                  </div>
                  <div class="flex items-center gap-1 transition-opacity {hoveredId === m.id ? 'opacity-100' : 'opacity-0'} group-focus-within/message:opacity-100">
                    <button
                      onclick={() => replyTo = m}
                      class="bg-background text-muted-foreground hover:bg-muted hover:text-brand flex size-7 items-center justify-center rounded-full border shadow-sm transition-colors"
                      title="Trích dẫn"
                      aria-label="Trích dẫn"
                    >
                      <Quote class="size-3.5" />
                    </button>
                    <button
                      onclick={() => session.sendReaction(m, "heart")}
                      class="bg-background text-muted-foreground hover:bg-muted hover:text-brand flex size-7 items-center justify-center rounded-full border shadow-sm transition-colors"
                      title="Thả tim"
                      aria-label="Thả tim"
                    >
                      <Heart class="size-3.5" />
                    </button>
                  </div>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Reply bar -->
    {#if replyTo}
      <div class="bg-muted/50 mx-4 flex items-center gap-2 rounded-t-lg px-3 py-2">
        <Quote class="text-brand size-4" />
        <span class="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          Trả lời <b>{replyTo.authorName ?? "bạn"}</b>: {replyTo.sticker ? "[Sticker]" : replyTo.body.slice(0, 60)}
        </span>
        <button onclick={() => replyTo = null} class="text-muted-foreground hover:text-foreground">
          <X class="size-3.5" />
        </button>
      </div>
    {/if}

    <!-- Composer -->
    <footer class="bg-background border-t px-3 py-2.5">
      <div class="relative">
        {#if showStickers}
          <!-- Click-away backdrop closes the picker. -->
          <button
            type="button"
            class="fixed inset-0 z-40 cursor-default"
            aria-label="Đóng bảng sticker"
            onclick={() => (showStickers = false)}
          ></button>
          <div class="absolute bottom-2 left-0 z-50">
            <StickerPicker onpick={pickSticker} />
          </div>
        {/if}
        <form class="flex items-center gap-1.5" onsubmit={(e) => { e.preventDefault(); send(); }}>
          <button
            type="button"
            onclick={() => (showStickers = !showStickers)}
            class="flex size-9 items-center justify-center rounded-md transition-colors {showStickers
              ? 'bg-brand/10 text-brand'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
            title="Sticker"
            aria-label="Sticker"
          >
            <Smile class="size-5" />
          </button>
          <input
            bind:this={fileInput}
            class="pointer-events-none fixed -left-[9999px] top-0 size-px opacity-0"
            type="file"
            multiple
            tabindex="-1"
            onchange={pickFile}
          />
          <button
            type="button"
            class="text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 flex size-9 items-center justify-center rounded-md transition-colors"
            title={fileButtonTitle}
            aria-label={fileButtonTitle}
            disabled={!session.canUseCloudFiles || session.busy}
            onclick={() => fileInput?.click()}
          >
            <Paperclip class="size-5" />
          </button>
          <input
            bind:value={draft}
            placeholder={`Cloud: nhập tin nhắn tới ${convo.title}`}
            class="border-input bg-background focus-visible:ring-brand/40 flex-1 rounded-full border px-4 py-2 text-sm outline-none focus-visible:ring-2"
          />
          <Button type="submit" size="icon" class="bg-brand hover:bg-brand/90 text-brand-foreground rounded-full" disabled={session.busy || draft.trim().length === 0}>
            <Send class="size-4" />
          </Button>
        </form>
        {#if uploadError}
          <div class="text-destructive px-12 pt-1 text-xs" aria-live="polite">{uploadError}</div>
        {/if}
      </div>
    </footer>
  </section>
{/if}
