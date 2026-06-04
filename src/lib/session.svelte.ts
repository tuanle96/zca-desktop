// Reactive session state for the chat UI. Wraps the Tauri command/event API
// and derives conversation rows + per-thread message lists from the live
// zalo://message stream. Multi-account: each logged-in account keeps its own
// data bucket; the UI shows the active account and a rail of all accounts.
// No mock data — everything here reflects real IPC.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
    CLOUD_DEVICE_TOKEN_KEYCHAIN,
    CLOUD_EVENT,
    deleteCloudAccount,
    listCloudAccounts,
    listCloudConversations,
    listCloudMessages,
    downloadCloudFileBlob,
    initCloudFile,
    loadCloudDeviceSession,
    sendCloudReaction,
    sendCloudFile,
    sendCloudSticker,
    sendCloudText,
    startCloudRealtime,
    uploadCloudFileBlob,
    type CloudAccount,
} from "./cloud";
import { log } from "./log";
import type {
    AccountProfile,
    ChatMessage,
    Contact,
    Conversation,
    CredentialSummary,
    Group,
    History,
    IncomingMessage,
    LinkPreview,
    QrLoginEvent,
    QrPhase,
    QuoteInput,
    QuoteRef,
    ReactionEvent,
    ReactionIcon,
    Sticker,
    UndoEvent,
} from "./types";

const MESSAGE_EVENT = "zalo://message";
const QR_EVENT = "zalo://qr";
const DEFAULT_CLOUD_BASE_URL = "http://127.0.0.1:37880";
export const CLOUD_BASE_URL_STORAGE_KEY = "zca.cloud.baseUrl";
export const CLOUD_DEVICE_LINKED_STORAGE_KEY = "zca.cloud.deviceLinked";

function snippet(text: string | null): string {
    if (!text) return "[non-text message]";
    return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

/** Conversation-list snippet for a message that may carry rich state. */
function messageSnippet(
    text: string | null,
    sticker: Sticker | null,
    link: LinkPreview | null = null,
    deleted = false,
): string {
    if (deleted) return "Tin nhắn đã được thu hồi";
    if (sticker) return "[Sticker]";
    if (link) return link.title || link.href;
    return snippet(text);
}

function reactionEmoji(icon: ReactionIcon): string {
    const map: Record<ReactionIcon, string> = {
        heart: "❤️",
        like: "👍",
        haha: "😆",
        wow: "😮",
        cry: "😢",
        angry: "😠",
        kiss: "😘",
        tearsOfJoy: "😂",
        shit: "💩",
        rose: "🌹",
        brokenHeart: "💔",
        dislike: "👎",
        love: "😍",
        confused: "😕",
        wink: "😉",
        fade: "😶",
        sun: "☀️",
        birthday: "🎂",
        bomb: "💣",
        ok: "👌",
        peace: "✌️",
        thanks: "🙏",
        punch: "👊",
    };
    return map[icon];
}

/** All per-account data. The active account's slice is mirrored into the
 * top-level reactive fields below; background accounts live here and keep
 * accumulating realtime messages. */
type AccountData = {
    profile: AccountProfile;
    conversations: Conversation[];
    threads: Record<string, ChatMessage[]>;
    contacts: Contact[];
    contactsLoaded: boolean;
    groups: Group[];
    groupsLoaded: boolean;
    activeThreadId: string | null;
};

type CloudConversationRow = {
    id: string;
    accountId: string;
    threadId: string;
    kind: "user" | "group";
    title: string | null;
    avatar: string | null;
    lastAt: string | null;
    unread: number;
};

type CloudMessageRow = {
    id: string;
    conversationId: string;
    msgId: string;
    fromId: string | null;
    fromName: string | null;
    fromAvatar?: string | null;
    body: string | null;
    outgoing: boolean;
    kind: string;
    observedAt: string;
    deleted: boolean;
    sticker?: Sticker | null;
    quote?: QuoteRef | null;
    link?: LinkPreview | null;
    file?: {
        id?: string | null;
        filename: string | null;
        mime: string | null;
        sizeBytes: number;
        href?: string | null;
        thumb?: string | null;
        mediaKind?: string | null;
    } | null;
    reactionIcon?: string | null;
};

export type UploadResult = {
    ok: boolean;
    error?: string;
};

type CloudRealtimeEvent = {
    type?: string;
    accountId?: string;
    message?: string;
    reason?: string;
    status?: number;
};

/** A compact account entry for the left account rail. */
export type AccountTab = {
    accountId: string;
    displayName: string | null;
    avatar: string | null;
    unread: number;
};

type RealtimeState = "offline" | "connecting" | "live" | "reconnecting";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyAccount(profile: AccountProfile): AccountData {
    return {
        profile,
        conversations: [],
        threads: {},
        contacts: [],
        contactsLoaded: false,
        groups: [],
        groupsLoaded: false,
        activeThreadId: null,
    };
}

class SessionStore {
    // --- active-account view (mirrors the active bucket; reactive) ---
    profile = $state<AccountProfile | null>(null);
    conversations = $state<Conversation[]>([]);
    activeThreadId = $state<string | null>(null);
    private threads = $state<Record<string, ChatMessage[]>>({});
    contacts = $state<Contact[]>([]);
    contactsLoaded = $state(false);
    groups = $state<Group[]>([]);
    groupsLoaded = $state(false);

    // --- multi-account ---
    /** Account rail entries (all logged-in accounts). Reactive. */
    accounts = $state<AccountTab[]>([]);
    activeAccountId = $state<string | null>(null);
    /** Background buckets for non-active accounts (and the active one, synced on switch). */
    private buckets = new Map<string, AccountData>();
    private cloudConversationIds = new Map<string, string>();

    sessionSummary = $state<CredentialSummary | null>(null);
    listening = $state(false);
    realtimeState = $state<RealtimeState>("offline");
    realtimeDetail = $state("");
    busy = $state(false);
    error = $state("");
      /** True while the startup cloud-device state check is in flight. */
      restoring = $state(true);
    cloudMode = $state(false);
    private cloudBaseUrl: string | null = null;
    private cloudDeviceToken: string | null = null;

    /** which middle/main pane is shown: chats or contacts */
    view = $state<"chats" | "contacts">("chats");

    /** Settings dialog visibility (opened from the rail gear). */
    settingsOpen = $state(false);

    // --- QR login state (zalo://qr stream). Shown full-screen as the login
    // gate when no account is logged in, or as an overlay when adding another
    // account. The credential triple never enters the webview. ---
    qrPhase = $state<QrPhase>("idle");
    qrImage = $state<string | null>(null);
    qrScannedName = $state<string | null>(null);
    qrScannedAvatar = $state<string | null>(null);
    qrError = $state("");
    qrSecondsLeft = $state(0);
    /** True while a QR flow for an ADDITIONAL account is in progress (overlay). */
    qrAdding = $state(false);

    private unlisten: UnlistenFn | null = null;
    private unlistenQr: UnlistenFn | null = null;
    private unlistenCloud: UnlistenFn | null = null;
    private qrTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempt = 0;
    private realtimeStarting = false;

    /** True once at least one account is authenticated; gates the chat shell. */
    get loggedIn(): boolean {
        return this.profile !== null;
    }

    get activeMessages(): ChatMessage[] {
        return this.activeThreadId ? (this.threads[this.activeThreadId] ?? []) : [];
    }

    get activeConversation(): Conversation | null {
        return this.conversations.find((c) => c.threadId === this.activeThreadId) ?? null;
    }

    get canUseCloudFiles(): boolean {
        return this.cloudMode && Boolean(this.cloudBaseUrl && this.cloudDeviceToken && this.profile);
    }

    get realtimeLabel(): string {
        switch (this.realtimeState) {
            case "live":
                return "Realtime đang bật";
            case "connecting":
                return "Đang kết nối realtime";
            case "reconnecting":
                return this.reconnectAttempt > 0
                    ? `Đang reconnect lần ${this.reconnectAttempt}`
                    : "Đang reconnect realtime";
            case "offline":
            default:
                return "Realtime offline";
        }
    }

    async checkSession() {
        this.sessionSummary = null;
    }

    async loginAndListen() {
        this.error = "Cloud-only mode: đăng nhập bằng magic link và hosted QR.";
    }

      /** On app start, do not touch the OS keychain before user intent is clear. */
      async restore(): Promise<boolean> {
          this.restoring = false;
          return false;
      }

      async restoreCloudDevice(baseUrl?: string): Promise<boolean> {
          if (typeof localStorage === "undefined") return false;
          const targetBaseUrl = baseUrl || localStorage.getItem(CLOUD_BASE_URL_STORAGE_KEY) || DEFAULT_CLOUD_BASE_URL;
          const saved = await loadCloudDeviceSession(targetBaseUrl).catch((e) => {
              log.error(`cloud-restore: device session lookup failed: ${String(e)}`);
              return null;
          });
          if (!saved?.hasDeviceToken) return false;

          const connected = await this.connectCloud(targetBaseUrl, CLOUD_DEVICE_TOKEN_KEYCHAIN).catch((e) => {
              this.cloudMode = false;
              this.cloudBaseUrl = null;
              this.cloudDeviceToken = null;
            log.error(`cloud-restore: connect failed: ${String(e)}`);
            return false;
          });
          if (connected) {
              localStorage.setItem(CLOUD_BASE_URL_STORAGE_KEY, targetBaseUrl);
              localStorage.setItem(CLOUD_DEVICE_LINKED_STORAGE_KEY, "1");
              log.info("cloud-restore: connected cloud device session");
          }
          return connected;
      }

    async connectCloud(baseUrl: string, deviceToken: string): Promise<boolean> {
        let connected = false;
        await this.run(async () => {
            this.cloudMode = true;
            this.cloudBaseUrl = baseUrl;
            this.cloudDeviceToken = deviceToken;
            await this.ensureCloudRealtime();
            const accounts = await listCloudAccounts(baseUrl, deviceToken);
            for (const account of accounts) this.adoptCloudAccount(account, { activate: false });
            if (accounts.length > 0) {
                this.activate(accounts[0].id);
                connected = true;
            }
        });
        if (connected) {
            for (const tab of this.accounts) this.hydrateCloudHistory(tab.accountId);
        }
        return connected;
    }

    /** Trigger the hosted QR flow to add another Zalo account to the cloud user. */
    async addAccount() {
        this.qrAdding = true;
    }

    /** Cancel an in-progress "add account" QR overlay. */
    cancelAddAccount() {
        this.qrAdding = false;
        this.qrPhase = "idle";
        this.stopQrCountdown();
    }

    /**
     * Run the interactive QR login flow. Login gate for the first account, or
     * the "add account" overlay for subsequent ones. On success the account is
     * added to the rail and becomes active.
     */
    async startQrLogin() {
        this.qrError = "Cloud-only mode: use hosted cloud QR.";
        this.qrPhase = "error";
    }

    // --- account management -------------------------------------------------

    /** Add (or refresh) an account bucket + rail entry. Activates by default. */
    private adoptAccount(profile: AccountProfile, opts: { activate?: boolean } = {}) {
        const activate = opts.activate ?? true;
        if (!this.buckets.has(profile.accountId)) {
            this.buckets.set(profile.accountId, emptyAccount(profile));
        } else {
            this.buckets.get(profile.accountId)!.profile = profile;
        }
        if (!this.accounts.some((a) => a.accountId === profile.accountId)) {
            this.accounts = [
                ...this.accounts,
                {
                    accountId: profile.accountId,
                    displayName: profile.displayName,
                    avatar: profile.avatar,
                    unread: 0,
                },
            ];
        }
        if (activate) this.activate(profile.accountId);
    }

    private adoptCloudAccount(account: CloudAccount, opts: { activate?: boolean } = {}) {
        this.adoptAccount(
            {
                accountId: account.id,
                displayName: account.displayName ?? account.zaloAccountId,
                avatar: account.avatar,
            },
            opts,
        );
    }

    /** Switch the active account: persist the current view back to its bucket,
     * then load the target bucket into the reactive view fields. */
    switchAccount(accountId: string) {
        if (accountId === this.activeAccountId) return;
        this.activate(accountId);
    }

    /**
     * Remove an account from the current cloud user, then prune the UI bucket
     * and rail entry. If it was the active account, activate another; if it was
     * the last account, drop back to the cloud login gate. No secret crosses IPC.
     */
    async logoutAccount(accountId: string) {
        await this.run(async () => {
            if (!this.cloudBaseUrl || !this.cloudDeviceToken) {
                throw new Error("cloud device session not connected");
            }
            await deleteCloudAccount(this.cloudBaseUrl, this.cloudDeviceToken, accountId);
            this.cloudConversationIds.delete(accountId);
        });
        if (this.error) return; // surfaced by the dialog; keep the account listed

        this.buckets.delete(accountId);
        this.accounts = this.accounts.filter((a) => a.accountId !== accountId);

        if (this.activeAccountId === accountId) {
            const next = this.accounts[0];
            if (next) {
                this.activeAccountId = null; // force activate() to load the next bucket
                this.activate(next.accountId);
            } else {
                // No accounts left — reset the active view and show the QR gate.
                this.activeAccountId = null;
                this.profile = null;
                this.conversations = [];
                this.threads = {};
                this.contacts = [];
                this.contactsLoaded = false;
                this.groups = [];
                this.groupsLoaded = false;
                this.activeThreadId = null;
                this.listening = false;
                this.settingsOpen = false;
            }
        }
        log.info(`logout: forgot account ${accountId} (remaining=${this.accounts.length})`);
    }

    private activate(accountId: string) {
        const target = this.buckets.get(accountId);
        if (!target) return;
        const previous = this.activeAccountId;
        // Save current active view back to its bucket.
        if (this.activeAccountId) {
            const cur = this.buckets.get(this.activeAccountId);
            if (cur) {
                cur.conversations = this.conversations;
                cur.threads = this.threads;
                cur.contacts = this.contacts;
                cur.contactsLoaded = this.contactsLoaded;
                cur.groups = this.groups;
                cur.groupsLoaded = this.groupsLoaded;
                cur.activeThreadId = this.activeThreadId;
            }
        }
        // Load the target bucket into the reactive view.
        this.activeAccountId = accountId;
        this.profile = target.profile;
        this.conversations = target.conversations;
        this.threads = target.threads;
        this.contacts = target.contacts;
        this.contactsLoaded = target.contactsLoaded;
        this.groups = target.groups;
        this.groupsLoaded = target.groupsLoaded;
        this.activeThreadId = target.activeThreadId;
        this.view = "chats";
        // The active account's unread badge clears on switch.
        this.setAccountUnread(accountId, 0);
        // Non-secret switch diagnostic: proves the active account + its view
        // (conversation count) swapped. account ids only, no message content.
        if (previous !== accountId) {
            log.info(
                `account-switch: active ${previous ?? "none"} -> ${accountId} (conversations=${target.conversations.length})`,
            );
        }
    }

    private setAccountUnread(accountId: string, n: number) {
        this.accounts = this.accounts.map((a) =>
            a.accountId === accountId ? { ...a, unread: n } : a,
        );
    }

    private bumpAccountUnread(accountId: string) {
        this.accounts = this.accounts.map((a) =>
            a.accountId === accountId ? { ...a, unread: a.unread + 1 } : a,
        );
    }

    /** Load directories + history for `accountId` (defaults to active). */
    private warmUp(accountId?: string) {
        const id = accountId ?? this.activeAccountId;
        if (!id) return;
        this.hydrateCloudHistory(id);
    }

    // --- QR event plumbing --------------------------------------------------

    private async ensureQrListener() {
        if (this.unlistenQr) return;
        this.unlistenQr = await listen<QrLoginEvent>(QR_EVENT, (event) => {
            this.applyQrEvent(event.payload);
        });
    }

    private applyQrEvent(event: QrLoginEvent) {
        switch (event.stage) {
            case "generated":
                this.qrImage = event.image;
                this.qrScannedName = null;
                this.qrScannedAvatar = null;
                this.qrPhase = "waiting-scan";
                this.startQrCountdown(event.expiresInSecs);
                break;
            case "scanned":
                this.qrScannedName = event.displayName;
                this.qrScannedAvatar = event.avatar || null;
                this.qrPhase = "scanned";
                this.stopQrCountdown();
                break;
            case "declined":
                this.qrPhase = "declined";
                this.stopQrCountdown();
                break;
            case "expired":
                this.qrPhase = "expired";
                this.stopQrCountdown();
                break;
            case "success":
                this.qrPhase = "success";
                this.stopQrCountdown();
                break;
        }
    }

    private startQrCountdown(seconds: number) {
        this.stopQrCountdown();
        this.qrSecondsLeft = Math.max(0, Math.floor(seconds));
        this.qrTimer = setInterval(() => {
            this.qrSecondsLeft = Math.max(0, this.qrSecondsLeft - 1);
            if (this.qrSecondsLeft === 0) this.stopQrCountdown();
        }, 1000);
    }

    private stopQrCountdown() {
        if (this.qrTimer) {
            clearInterval(this.qrTimer);
            this.qrTimer = null;
        }
    }

    // --- directories (operate on a specific account bucket) -----------------

    async loadContacts(accountId?: string) {
        const id = accountId ?? this.activeAccountId;
        if (!id) return;
        this.withBucket(id, (b) => {
            b.contacts = [];
            b.contactsLoaded = true;
        });
        if (id === this.activeAccountId) {
            this.contacts = [];
            this.contactsLoaded = true;
        }
    }

    async loadGroups(accountId?: string) {
        const id = accountId ?? this.activeAccountId;
        if (!id) return;
        this.withBucket(id, (b) => {
            b.groups = [];
            b.groupsLoaded = true;
        });
        if (id === this.activeAccountId) {
            this.groups = [];
            this.groupsLoaded = true;
        }
    }

    private groupForIn(b: AccountData, threadId: string): Group | undefined {
        return b.groups.find((g) => g.groupId === threadId);
    }

    private titleForIn(b: AccountData, threadId: string, kind: "user" | "group", fallback: string): string {
        if (kind === "group") return this.groupForIn(b, threadId)?.name || fallback;
        return b.contacts.find((c) => c.userId === threadId)?.displayName || fallback;
    }

    private avatarForIn(b: AccountData, threadId: string, kind: "user" | "group"): string | null {
        if (kind === "group") return this.groupForIn(b, threadId)?.avatar ?? null;
        return b.contacts.find((c) => c.userId === threadId)?.avatar ?? null;
    }

    private refreshConversationIdentities() {
        const b = this.activeBucket();
        if (!b) return;
        this.conversations = this.conversations.map((c) => ({
            ...c,
            title: this.titleForIn(b, c.threadId, c.kind, c.title),
            avatar: this.avatarForIn(b, c.threadId, c.kind) ?? c.avatar,
        }));
    }

    /** Hydrate conversations + per-thread messages for an account. */
    async hydrateHistory(accountId?: string) {
        await this.hydrateCloudHistory(accountId);
    }

    async hydrateCloudHistory(accountId?: string) {
        const id = accountId ?? this.activeAccountId;
        if (!id || !this.cloudBaseUrl || !this.cloudDeviceToken) return;
        let rows: CloudConversationRow[] = [];
        try {
            rows = await this.retryCloud(
                "cloud conversations",
                () => listCloudConversations(this.cloudBaseUrl!, this.cloudDeviceToken!, id) as Promise<CloudConversationRow[]>,
            );
        } catch (e) {
            log.error(`cloud conversations failed: ${String(e)}`);
            this.scheduleCloudReconnect("hydrate-conversations-failed");
            return;
        }
        const b = this.buckets.get(id);
        if (!b) return;

        const threads: Record<string, ChatMessage[]> = {};
        const conversations: Conversation[] = [];
        for (const row of rows) {
            this.cloudConversationIds.set(`${id}:${row.threadId}`, row.id);
            let messages: CloudMessageRow[] = [];
            let messageFetchFailed = false;
            try {
                messages = await this.retryCloud(
                    "cloud messages",
                    () => listCloudMessages(this.cloudBaseUrl!, this.cloudDeviceToken!, row.id, 100) as Promise<CloudMessageRow[]>,
                    2,
                );
            } catch (e) {
                messageFetchFailed = true;
                log.error(`cloud messages failed: ${String(e)}`);
            }
            const mapped = messages
                .map((m) => ({
                    id: m.msgId,
                    threadId: row.threadId,
                    body: m.deleted
                        ? "Tin nhắn đã được thu hồi"
                        : (m.body ?? (m.file?.filename || (m.sticker ? "" : "[non-text message]"))),
                    sticker: m.sticker ?? null,
                    file: m.file
                        ? {
                            id: m.file.id ?? null,
                            filename: m.file.filename,
                            mime: m.file.mime,
                            sizeBytes: m.file.sizeBytes,
                            sourceUrl: m.file.href ?? null,
                            thumb: m.file.thumb ?? null,
                            mediaKind: m.file.mediaKind ?? null,
                        }
                        : null,
                    quote: m.quote ?? null,
                    link: m.link ?? null,
                    reactionIcon: m.reactionIcon ?? null,
                    deleted: m.deleted,
                    outgoing: m.outgoing,
                    authorName: m.fromName,
                    authorAvatar: m.fromAvatar ?? (m.outgoing ? this.profile?.avatar : row.avatar),
                    at: Date.parse(m.observedAt) || Date.now(),
                }))
                .sort((a, c) => a.at - c.at);
            threads[row.threadId] = messageFetchFailed ? (b.threads[row.threadId] ?? []) : mapped;
            const last = mapped[mapped.length - 1];
            conversations.push({
                threadId: row.threadId,
                kind: row.kind,
                title: row.title || row.threadId,
                avatar: row.avatar,
                lastAt: row.lastAt ? (Date.parse(row.lastAt) || 0) : (last?.at ?? b.conversations.find((c) => c.threadId === row.threadId)?.lastAt ?? 0),
                lastSnippet: last ? messageSnippet(last.body, last.sticker, last.link, last.deleted) : (b.conversations.find((c) => c.threadId === row.threadId)?.lastSnippet ?? ""),
                unread: row.unread ?? 0,
            });
        }
        b.threads = threads;
        b.conversations = conversations.sort((a, c) => c.lastAt - a.lastAt);
        if (id === this.activeAccountId) {
            this.threads = b.threads;
            this.conversations = b.conversations;
        }
    }

    // --- thread + message ops (active account) ------------------------------

    startChatWith(contact: Contact) {
        this.view = "chats";
        this.openThread(contact.userId, contact.displayName);
    }

    selectThread(threadId: string) {
        this.activeThreadId = threadId;
        const convo = this.conversations.find((c) => c.threadId === threadId);
        if (convo && convo.unread > 0) {
            this.conversations = this.conversations.map((c) =>
                c.threadId === threadId ? { ...c, unread: 0 } : c,
            );
            if (this.profile) {
                log.info(`thread-read: ${this.profile.accountId}/${threadId}`);
            }
        }
    }

    async sendActive(body: string, quote?: QuoteInput): Promise<boolean> {
        const text = body.trim();
        const threadId = this.activeThreadId;
        if (!text || !threadId || !this.profile) return false;
        const convo = this.conversations.find((c) => c.threadId === threadId);
        const kind = convo?.kind ?? "user";

        let ok = false;
        await this.run(async () => {
            if (!this.cloudBaseUrl || !this.cloudDeviceToken) {
                throw new Error("cloud device session not connected");
            }
            const msgId = String((await sendCloudText(this.cloudBaseUrl, this.cloudDeviceToken, this.profile!.accountId, threadId, text, kind)).msgId ?? "");
            this.appendToActive(
                {
                    id: msgId || `cloud-${Date.now()}`,
                    threadId,
                    body: text,
                    sticker: null,
                    file: null,
                    link: null,
                    quote: quote ? {
                        ownerId: quote.uidFrom,
                        fromD: "",
                        globalMsgId: 0,
                        cliMsgId: 0,
                        msg: quote.content,
                        cliMsgType: 1,
                        ts: quote.ts,
                    } : null,
                    reactionIcon: null,
                    deleted: false,
                    outgoing: true,
                    authorName: this.profile?.displayName ?? "Me",
                    authorAvatar: this.profile?.avatar,
                    at: Date.now(),
                },
                snippet(text),
            );
            ok = true;
        });
        return ok;
    }

    /** Search stickers for the picker (reuses the active account's session). */
    async searchStickers(keyword: string, limit = 40): Promise<Sticker[]> {
        void keyword;
        void limit;
        return [];
    }

    /** The account's recently-used stickers for the picker's "Gần đây" row. */
    async recentStickers(limit = 24): Promise<Sticker[]> {
        void limit;
        return [];
    }

    /** The pack ids (categories) the account has used recently, for tab chips. */
    async stickerCategories(limit = 12): Promise<number[]> {
        void limit;
        return [];
    }

    /** Load all stickers in a pack (category) for the picker's per-pack tab. */
    async stickerCategory(catId: number): Promise<Sticker[]> {
        void catId;
        return [];
    }

    /** Send a sticker to the active thread, rendering it optimistically. */
    async sendSticker(sticker: Sticker): Promise<boolean> {
        const threadId = this.activeThreadId;
        if (!threadId || !this.profile) return false;
        const convo = this.conversations.find((c) => c.threadId === threadId);
        const kind = convo?.kind ?? "user";

        let ok = false;
        await this.run(async () => {
            if (!this.cloudBaseUrl || !this.cloudDeviceToken) {
                throw new Error("cloud device session not connected");
            }
            const msgId = String((await sendCloudSticker(
                this.cloudBaseUrl,
                this.cloudDeviceToken,
                this.profile!.accountId,
                threadId,
                sticker.id,
                sticker.catId,
                sticker.stickerType,
                kind,
            )).msgId ?? "");
            this.appendToActive(
                {
                    id: msgId || `cloud-${Date.now()}`,
                    threadId,
                    body: "",
                    sticker,
                    file: null,
                    quote: null,
                    link: null,
                    reactionIcon: null,
                    deleted: false,
                    outgoing: true,
                    authorName: this.profile?.displayName ?? "Me",
                    authorAvatar: this.profile?.avatar,
                    at: Date.now(),
                },
                "[Sticker]",
            );
            ok = true;
        });
        return ok;
    }

    async sendReaction(message: ChatMessage, icon: ReactionIcon = "heart"): Promise<boolean> {
        if (!this.profile) return false;
        const convo = this.conversations.find((c) => c.threadId === message.threadId);
        const kind = convo?.kind ?? "user";
        let ok = false;
        await this.run(async () => {
            if (!this.cloudBaseUrl || !this.cloudDeviceToken) {
                throw new Error("cloud device session not connected");
            }
            await sendCloudReaction(
                this.cloudBaseUrl,
                this.cloudDeviceToken,
                this.profile!.accountId,
                message.threadId,
                message.id,
                `${message.id}_cli`,
                icon,
                kind,
            );
            const b = this.activeBucket();
            if (b) {
                this.applyReactionToBucket(b, {
                    threadId: message.threadId,
                    msgId: message.id,
                    uidFrom: this.profile!.accountId,
                    dName: this.profile!.displayName,
                    icon: reactionEmoji(icon),
                    isSelf: true,
                    isGroup: kind === "group",
                });
                this.threads = b.threads;
                this.conversations = b.conversations;
            }
            ok = true;
        });
        return ok;
    }

    async uploadCloudFile(file: File): Promise<UploadResult> {
        const threadId = this.activeThreadId;
        const convo = this.activeConversation;
        if (!threadId || !convo || !this.profile || !this.cloudBaseUrl || !this.cloudDeviceToken) {
            return { ok: false, error: "cloud device session not connected" };
        }
        if (!this.cloudMode) return { ok: false, error: "cloud mode is not active" };

        let result: UploadResult = { ok: false, error: "upload did not complete" };
        this.busy = true;
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const digest = await crypto.subtle.digest("SHA-256", bytes);
            const contentSha256 = [...new Uint8Array(digest)]
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");
            const conversationId = this.cloudConversationIds.get(`${this.profile!.accountId}:${threadId}`);
            const meta = await initCloudFile(this.cloudBaseUrl!, this.cloudDeviceToken!, {
                accountId: this.profile!.accountId,
                conversationId,
                filename: file.name,
                mime: file.type || "application/octet-stream",
                sizeBytes: file.size,
                contentSha256,
              });
              await uploadCloudFileBlob(this.cloudBaseUrl!, this.cloudDeviceToken!, meta.id, [...bytes]);
              const sent = await sendCloudFile(
                  this.cloudBaseUrl!,
                  this.cloudDeviceToken!,
                  this.profile!.accountId,
                  threadId,
                  meta.id,
                  convo.kind,
              );
              const sentFile = (sent.file ?? {}) as Record<string, unknown>;
              this.appendToActive(
                  {
                      id: String(sent.msgId ?? `file-${meta.id}`),
                      threadId,
                      body: file.name || "Tệp đính kèm",
                      sticker: null,
                      file: {
                          id: String(sentFile.id ?? meta.id),
                          filename: (sentFile.filename as string | null | undefined) ?? meta.filename,
                          mime: (sentFile.mime as string | null | undefined) ?? meta.mime,
                          sizeBytes: Number(sentFile.sizeBytes ?? meta.sizeBytes),
                          sourceUrl: (sentFile.href as string | null | undefined) ?? null,
                          thumb: (sentFile.thumb as string | null | undefined) ?? null,
                          mediaKind: (sentFile.mediaKind as string | null | undefined) ?? "file",
                      },
                    quote: null,
                    link: null,
                    reactionIcon: null,
                    deleted: false,
                    outgoing: true,
                    authorName: this.profile?.displayName ?? "Me",
                    authorAvatar: this.profile?.avatar,
                    at: Date.now(),
                },
                `[File] ${file.name || meta.id}`,
            );
            result = { ok: true };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.error(`cloud file upload/send failed: ${message}`);
            result = { ok: false, error: message };
        } finally {
            this.busy = false;
        }
        return result;
    }

    async downloadCloudFile(message: ChatMessage): Promise<boolean> {
        const fileId = message.file?.id;
        if (!fileId || !this.cloudBaseUrl || !this.cloudDeviceToken) return false;
        let ok = false;
        await this.run(async () => {
            const bytes = await downloadCloudFileBlob(this.cloudBaseUrl!, this.cloudDeviceToken!, fileId);
            const blob = new Blob([new Uint8Array(bytes)], {
                type: message.file!.mime || "application/octet-stream",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = message.file!.filename || "download";
            a.click();
            URL.revokeObjectURL(url);
            ok = true;
        });
        return ok;
    }

    dispose() {
        this.unlisten?.();
        this.unlisten = null;
        this.unlistenQr?.();
        this.unlistenQr = null;
        this.stopCloudRealtime();
        this.stopQrCountdown();
    }

    private async ensureListener() {
        if (this.unlisten) return;
        this.unlisten = await listen<IncomingMessage>(MESSAGE_EVENT, (event) => {
            this.ingest(event.payload);
        });
    }

    private async ensureCloudRealtime() {
        if (!this.unlistenCloud) {
            this.unlistenCloud = await listen<CloudRealtimeEvent>(CLOUD_EVENT, (event) => {
                const payload = event.payload;
                if (payload.type === "connected") {
                    this.markCloudRealtimeConnected();
                    return;
                }
                if (payload.type === "error") {
                    log.error(`cloud realtime failed: ${payload.message ?? `status ${payload.status ?? "unknown"}`}`);
                    this.scheduleCloudReconnect("realtime-error");
                    return;
                }
                if (payload.type === "disconnected") {
                    log.info(`cloud realtime disconnected: ${payload.reason ?? "unknown"}`);
                    this.scheduleCloudReconnect(payload.reason ?? "realtime-disconnected");
                    return;
                }
                if (payload.type !== "message") return;
                if (this.realtimeState !== "live") this.markCloudRealtimeConnected({ refresh: false });
                const accountId = payload.accountId;
                if (accountId && this.buckets.has(accountId)) {
                    void this.hydrateCloudHistory(accountId);
                } else {
                    for (const tab of this.accounts) void this.hydrateCloudHistory(tab.accountId);
                }
            });
        }
        await this.startCloudRealtimeStream("connect");
    }

    private stopCloudRealtime() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.unlistenCloud?.();
        this.unlistenCloud = null;
        this.cloudBaseUrl = null;
        this.cloudDeviceToken = null;
        this.reconnectAttempt = 0;
        this.realtimeStarting = false;
        this.realtimeState = "offline";
        this.realtimeDetail = "";
        this.listening = false;
    }

    private async startCloudRealtimeStream(reason: string) {
        if (!this.cloudBaseUrl || !this.cloudDeviceToken) return;
        if (this.realtimeStarting) return;
        if (this.realtimeState === "live" && reason !== "retry") return;

        this.realtimeStarting = true;
        this.realtimeState = this.reconnectAttempt > 0 ? "reconnecting" : "connecting";
        this.realtimeDetail = reason;
        this.listening = false;
        try {
            await startCloudRealtime(this.cloudBaseUrl, this.cloudDeviceToken);
            log.info(`cloud realtime start requested: ${reason}`);
        } catch (e) {
            log.error(`cloud realtime start failed: ${String(e)}`);
            this.scheduleCloudReconnect("start-failed");
        } finally {
            this.realtimeStarting = false;
        }
    }

    private markCloudRealtimeConnected(opts: { refresh?: boolean } = {}) {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempt = 0;
        this.realtimeState = "live";
        this.realtimeDetail = "";
        this.listening = true;
        log.info("cloud realtime connected");
        if (opts.refresh ?? true) {
            for (const tab of this.accounts) void this.hydrateCloudHistory(tab.accountId);
        }
    }

    private scheduleCloudReconnect(reason: string) {
        if (!this.cloudMode || !this.cloudBaseUrl || !this.cloudDeviceToken) return;
        if (this.reconnectTimer) return;
        this.listening = false;
        this.realtimeState = "reconnecting";
        this.realtimeDetail = reason;
        this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 6);
        const delayMs = Math.min(30_000, 1_000 * 2 ** (this.reconnectAttempt - 1));
        log.info(`cloud realtime reconnect scheduled: reason=${reason} attempt=${this.reconnectAttempt} delayMs=${delayMs}`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.startCloudRealtimeStream("retry");
        }, delayMs);
    }

    private async retryCloud<T>(label: string, operation: () => Promise<T>, attempts = 3): Promise<T> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                return await operation();
            } catch (e) {
                lastError = e;
                log.error(`${label} attempt ${attempt}/${attempts} failed: ${String(e)}`);
                if (attempt < attempts) await sleep(Math.min(2_500, 300 * 2 ** (attempt - 1)));
            }
        }
        throw lastError;
    }

    private activeBucket(): AccountData | undefined {
        return this.activeAccountId ? this.buckets.get(this.activeAccountId) : undefined;
    }

    private withBucket(accountId: string, fn: (b: AccountData) => void) {
        const b = this.buckets.get(accountId);
        if (b) fn(b);
    }

    /** Route an incoming message to its account bucket. If it's the active
     * account, also update the reactive view; otherwise bump its rail badge. */
    private ingest(msg: IncomingMessage) {
        const b = this.buckets.get(msg.accountId);
        if (!b) return; // event for an account we don't track
        const name = msg.fromName ?? msg.fromId;
        const title = this.titleForIn(b, msg.threadId, msg.threadKind, name);
        const isActive = msg.accountId === this.activeAccountId;
        const bumpUnread = !msg.isSelf && !(isActive && msg.threadId === this.activeThreadId);

        // Non-secret routing diagnostic: which account a message was routed to,
        // and whether that is the active view or a background bucket. account +
        // thread ids only, never message content. This is the observable signal
        // that an event for account B does NOT enter account A's active view.
        log.info(
            `route: msg account=${msg.accountId} thread=${msg.threadId} -> ${isActive ? "active-view" : "background-bucket"} (active=${this.activeAccountId ?? "none"})`,
        );

        if (msg.reaction) {
            this.applyReactionToBucket(b, msg.reaction);
            if (isActive) {
                this.threads = b.threads;
                this.conversations = b.conversations;
            }
            return;
        }

        if (msg.undo) {
            this.applyUndoToBucket(b, msg.undo);
            if (isActive) {
                this.threads = b.threads;
                this.conversations = b.conversations;
            }
            return;
        }

        this.appendToBucket(
            b,
            {
                id: msg.msgId,
                threadId: msg.threadId,
                body: msg.sticker ? "" : (msg.text ?? "[non-text message]"),
                sticker: msg.sticker,
                file: null,
                quote: msg.quote,
                link: msg.link,
                reactionIcon: null,
                deleted: false,
                outgoing: msg.isSelf,
                authorName: name,
                authorAvatar: msg.isSelf ? b.profile.avatar : this.avatarForIn(b, msg.threadId, msg.threadKind),
                at: Date.now(),
            },
            messageSnippet(msg.text, msg.sticker, msg.link),
            { kind: msg.threadKind, title, bumpUnread },
        );

        if (isActive) {
            // Mirror into the reactive view.
            this.threads = b.threads;
            this.conversations = b.conversations;
        } else if (bumpUnread) {
            this.bumpAccountUnread(msg.accountId);
        }
    }

    private applyReactionToBucket(b: AccountData, reaction: ReactionEvent) {
        const list = b.threads[reaction.threadId];
        if (!list) return;
        let changed = false;
        b.threads = {
            ...b.threads,
            [reaction.threadId]: list.map((m) => {
                if (m.id !== reaction.msgId) return m;
                changed = true;
                return { ...m, reactionIcon: reaction.icon };
            }),
        };
        if (!changed) return;
        b.conversations = b.conversations.map((c) =>
            c.threadId === reaction.threadId ? { ...c } : c,
        );
    }

    private applyUndoToBucket(b: AccountData, undo: UndoEvent) {
        const list = b.threads[undo.threadId];
        if (!list) return;
        let changed = false;
        const recalled = "Tin nhắn đã được thu hồi";
        const next = list.map((m) => {
            if (m.id !== undo.msgId) return m;
            changed = true;
            return {
                ...m,
                body: recalled,
                sticker: null,
                link: null,
                deleted: true,
            };
        });
        if (!changed) return;
        b.threads = { ...b.threads, [undo.threadId]: next };

        const last = next[next.length - 1];
        b.conversations = b.conversations.map((c) =>
            c.threadId === undo.threadId && last?.id === undo.msgId
                ? { ...c, lastSnippet: recalled }
                : c,
        );
    }

    /** Append into a specific bucket (no reactive mirror). Returns nothing. */
    private appendToBucket(
        b: AccountData,
        message: ChatMessage,
        lastSnippet: string,
        meta: { kind: "user" | "group"; title: string; bumpUnread: boolean },
    ) {
        const existing = b.threads[message.threadId] ?? [];
        if (existing.some((m) => m.id === message.id)) return; // dedupe by msg id

        // Echo reconciliation: Zalo delivers our own sent message back through
        // the listener with a DIFFERENT msg_id than the send-response id, so a
        // pure msg-id dedupe would store it twice. If this is an incoming echo
        // (outgoing) that matches a just-sent optimistic message in the same
        // thread (same body for text, same sticker id for stickers) within a
        // short window, treat it as the same message: adopt the authoritative
        // id rather than appending a duplicate.
        if (message.outgoing) {
            const ECHO_WINDOW_MS = 15000;
            const sameContent = (m: ChatMessage) =>
                message.sticker
                    ? m.sticker?.id === message.sticker.id
                    : !m.sticker && m.body === message.body;
            const dupIdx = existing.findIndex(
                (m) =>
                    m.outgoing &&
                    sameContent(m) &&
                    Math.abs(m.at - message.at) <= ECHO_WINDOW_MS,
            );
            if (dupIdx >= 0) {
                const merged = [...existing];
                merged[dupIdx] = { ...merged[dupIdx], id: message.id };
                b.threads = { ...b.threads, [message.threadId]: merged };
                return; // reconciled in place; no new row, no conversation bump
            }
        }

        b.threads = { ...b.threads, [message.threadId]: [...existing, message] };

        const idx = b.conversations.findIndex((c) => c.threadId === message.threadId);
        if (idx >= 0) {
            const current = b.conversations[idx];
            const updated: Conversation = {
                ...current,
                title: this.titleForIn(b, message.threadId, current.kind, meta.title ?? current.title),
                lastSnippet,
                lastAt: message.at,
                unread: meta.bumpUnread ? current.unread + 1 : current.unread,
                avatar: current.avatar ?? this.avatarForIn(b, message.threadId, current.kind),
            };
            b.conversations = [updated, ...b.conversations.filter((_, i) => i !== idx)];
        } else {
            b.conversations = [
                {
                    threadId: message.threadId,
                    kind: meta.kind,
                    title: meta.title ?? message.threadId,
                    lastSnippet,
                    lastAt: message.at,
                    unread: meta.bumpUnread ? 1 : 0,
                    avatar: this.avatarForIn(b, message.threadId, meta.kind),
                },
                ...b.conversations,
            ];
            if (b.activeThreadId === null && b === this.activeBucket()) {
                b.activeThreadId = message.threadId;
                this.activeThreadId = message.threadId;
            }
        }
    }

    /** Append an outgoing message to the active account + mirror the view. */
    private appendToActive(message: ChatMessage, lastSnippet: string) {
        const b = this.activeBucket();
        if (!b) return;
        this.appendToBucket(b, message, lastSnippet, {
            kind: this.conversations.find((c) => c.threadId === message.threadId)?.kind ?? "user",
            title:
                this.conversations.find((c) => c.threadId === message.threadId)?.title ??
                message.threadId,
            bumpUnread: false,
        });
        this.threads = b.threads;
        this.conversations = b.conversations;
    }

    /** Start (or reuse) a conversation for a thread id typed by the user. */
    openThread(threadId: string, title?: string) {
        const id = threadId.trim();
        const b = this.activeBucket();
        if (!id || !b) return;
        if (!b.threads[id]) b.threads = { ...b.threads, [id]: [] };
        if (!b.conversations.some((c) => c.threadId === id)) {
            b.conversations = [
                {
                    threadId: id,
                    kind: "user",
                    title: this.titleForIn(b, id, "user", title || id),
                    lastSnippet: "",
                    lastAt: Date.now(),
                    unread: 0,
                    avatar: this.avatarForIn(b, id, "user"),
                },
                ...b.conversations,
            ];
        }
        b.activeThreadId = id;
        this.threads = b.threads;
        this.conversations = b.conversations;
        this.activeThreadId = id;
    }

    private async run(fn: () => Promise<void>) {
        this.error = "";
        this.busy = true;
        try {
            await fn();
        } catch (e) {
            this.error = String(e);
        } finally {
            this.busy = false;
        }
    }
}

export const session = new SessionStore();
