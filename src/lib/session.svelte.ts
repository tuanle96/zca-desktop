// Reactive session state for the chat UI. Wraps the Tauri command/event API
// and derives conversation rows + per-thread message lists from the live
// zalo://message stream. Multi-account: each logged-in account keeps its own
// data bucket; the UI shows the active account and a rail of all accounts.
// No mock data — everything here reflects real IPC.

import { invoke } from "@tauri-apps/api/core";
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
const CLOUD_BASE_URL_STORAGE_KEY = "zca.cloud.baseUrl";

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
};

type CloudRealtimeEvent = {
    type?: string;
    accountId?: string;
    message?: string;
};

/** A compact account entry for the left account rail. */
export type AccountTab = {
    accountId: string;
    displayName: string | null;
    avatar: string | null;
    unread: number;
};

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
    busy = $state(false);
    error = $state("");
    /** True while the startup session-restore attempt is in flight. */
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

    async checkSession() {
        await this.run(async () => {
            this.sessionSummary = await invoke<CredentialSummary>("cred_file_summary");
        });
    }

    async loginAndListen() {
        this.cloudMode = false;
        this.stopCloudRealtime();
        await this.run(async () => {
            await this.ensureListener();
            const profile = await invoke<AccountProfile>("start_listening_from_file");
            this.adoptAccount(profile);
            this.listening = true;
        });
        if (this.profile) this.warmUp();
    }

    /** On app start, restore only a previously linked cloud device session. */
    async restore(): Promise<boolean> {
        const cloudRestored = await this.restoreCloud();
        if (cloudRestored) {
            this.restoring = false;
            return true;
        }

        this.restoring = false;
        return false;
    }

    private async restoreCloud(): Promise<boolean> {
        if (typeof localStorage === "undefined") return false;
        const baseUrl = localStorage.getItem(CLOUD_BASE_URL_STORAGE_KEY) || DEFAULT_CLOUD_BASE_URL;
        const saved = await loadCloudDeviceSession(baseUrl).catch((e) => {
            log.error(`cloud-restore: device session lookup failed: ${String(e)}`);
            return null;
        });
        if (!saved?.hasDeviceToken) return false;

        const connected = await this.connectCloud(baseUrl, CLOUD_DEVICE_TOKEN_KEYCHAIN).catch((e) => {
            this.cloudMode = false;
            this.cloudBaseUrl = null;
            this.cloudDeviceToken = null;
            log.error(`cloud-restore: connect failed: ${String(e)}`);
            return false;
        });
        if (connected) {
            localStorage.setItem(CLOUD_BASE_URL_STORAGE_KEY, baseUrl);
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
            await this.ensureCloudRealtime(baseUrl, deviceToken);
            const accounts = await listCloudAccounts(baseUrl, deviceToken);
            for (const account of accounts) this.adoptCloudAccount(account, { activate: false });
            if (accounts.length > 0) {
                this.activate(accounts[0].id);
                this.listening = true;
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
        if (this.busy) return;
        this.qrPhase = "loading";
        this.qrImage = null;
        this.qrScannedName = null;
        this.qrScannedAvatar = null;
        this.qrError = "";

        await this.ensureQrListener();
        await this.ensureListener();

        this.error = "";
        this.busy = true;
        try {
            log.info("qr-login: starting interactive QR flow");
            const profile = await invoke<AccountProfile>("start_qr_login");
            this.adoptAccount(profile);
            this.listening = true;
            this.qrPhase = "success";
            this.qrAdding = false;
            log.info(`qr-login: success, account=${profile.accountId}`);
            this.warmUp();
        } catch (e) {
            this.qrError = String(e);
            log.error(`qr-login: failed: ${this.qrError}`);
            const friendlyTerminal: QrPhase[] = ["declined", "expired"];
            if (!friendlyTerminal.includes(this.qrPhase)) {
                this.qrPhase = "error";
            }
        } finally {
            this.busy = false;
        }
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
            if (this.cloudMode && this.cloudBaseUrl && this.cloudDeviceToken) {
                await deleteCloudAccount(this.cloudBaseUrl, this.cloudDeviceToken, accountId);
                this.cloudConversationIds.delete(accountId);
            } else {
                await invoke("logout_account", { accountId });
            }
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
        if (this.cloudMode) {
            this.hydrateCloudHistory(id);
            return;
        }
        this.loadContacts(id);
        this.loadGroups(id);
        this.hydrateHistory(id);
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
        if (this.cloudMode) return;
        try {
            const contacts = await invoke<Contact[]>("list_contacts", { accountId: id });
            this.withBucket(id, (b) => {
                b.contacts = contacts;
                b.contactsLoaded = true;
            });
            if (id === this.activeAccountId) {
                this.contacts = contacts;
                this.contactsLoaded = true;
                this.refreshConversationIdentities();
            }
        } catch (e) {
            log.error(`list_contacts failed: ${String(e)}`);
        }
    }

    async loadGroups(accountId?: string) {
        const id = accountId ?? this.activeAccountId;
        if (!id) return;
        if (this.cloudMode) return;
        try {
            const groups = await invoke<Group[]>("list_groups", { accountId: id });
            this.withBucket(id, (b) => {
                b.groups = groups;
                b.groupsLoaded = true;
            });
            if (id === this.activeAccountId) {
                this.groups = groups;
                this.groupsLoaded = true;
                this.refreshConversationIdentities();
            }
        } catch (e) {
            log.error(`list_groups failed: ${String(e)}`);
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
        if (this.cloudMode) {
            await this.hydrateCloudHistory(accountId);
            return;
        }
        const id = accountId ?? this.activeAccountId;
        if (!id) return;
        let history: History;
        try {
            history = await invoke<History>("load_history", { accountId: id });
        } catch (e) {
            log.error(`load_history failed: ${String(e)}`);
            return;
        }
        const b = this.buckets.get(id);
        if (!b) return;

        const threads: Record<string, ChatMessage[]> = { ...b.threads };
        for (const m of history.messages) {
            const list = threads[m.threadId] ?? (threads[m.threadId] = []);
            if (list.some((x) => x.id === m.msgId)) continue;
            list.push({
                id: m.msgId,
                threadId: m.threadId,
                body: m.deleted ? "Tin nhắn đã được thu hồi" : m.sticker ? "" : (m.body ?? "[non-text message]"),
                sticker: m.sticker,
                file: null,
                quote: m.quote,
                link: m.link,
                reactionIcon: m.reactionIcon,
                deleted: m.deleted,
                outgoing: m.outgoing,
                authorName: m.fromName,
                authorAvatar: null,
                at: m.ts ?? 0,
            });
        }
        for (const tid of Object.keys(threads)) threads[tid].sort((a, c) => a.at - c.at);
        b.threads = threads;

        const byId = new Map(b.conversations.map((c) => [c.threadId, c]));
        for (const t of history.threads) {
            const msgs = threads[t.threadId] ?? [];
            const last = msgs[msgs.length - 1];
            const existing = byId.get(t.threadId);
            const title = this.titleForIn(b, t.threadId, t.kind, existing?.title || t.title || t.threadId);
            const avatar =
                this.avatarForIn(b, t.threadId, t.kind) ?? existing?.avatar ?? t.avatar ?? null;
            byId.set(t.threadId, {
                threadId: t.threadId,
                kind: t.kind,
                title,
                lastSnippet: last ? messageSnippet(last.body, last.sticker, last.link, last.deleted) : (existing?.lastSnippet ?? ""),
                lastAt: t.lastAt ?? existing?.lastAt ?? 0,
                unread: t.unread ?? existing?.unread ?? 0,
                avatar,
            });
        }
        b.conversations = [...byId.values()].sort((a, c) => c.lastAt - a.lastAt);

        // Reflect into the active view + the account's rail unread total.
        const totalUnread = b.conversations.reduce((s, c) => s + c.unread, 0);
        if (id !== this.activeAccountId) this.setAccountUnread(id, totalUnread);
        if (id === this.activeAccountId) {
            this.threads = b.threads;
            this.conversations = b.conversations;
        }
    }

    async hydrateCloudHistory(accountId?: string) {
        const id = accountId ?? this.activeAccountId;
        if (!id || !this.cloudBaseUrl || !this.cloudDeviceToken) return;
        let rows: CloudConversationRow[] = [];
        try {
            rows = await listCloudConversations(this.cloudBaseUrl, this.cloudDeviceToken, id) as CloudConversationRow[];
        } catch (e) {
            log.error(`cloud conversations failed: ${String(e)}`);
            return;
        }
        const b = this.buckets.get(id);
        if (!b) return;

        const threads: Record<string, ChatMessage[]> = {};
        const conversations: Conversation[] = [];
        for (const row of rows) {
            this.cloudConversationIds.set(`${id}:${row.threadId}`, row.id);
            let messages: CloudMessageRow[] = [];
            try {
                messages = await listCloudMessages(this.cloudBaseUrl, this.cloudDeviceToken, row.id, 100) as CloudMessageRow[];
            } catch (e) {
                log.error(`cloud messages failed: ${String(e)}`);
            }
            const mapped = messages
                .map((m) => ({
                    id: m.msgId,
                    threadId: row.threadId,
                    body: m.deleted ? "Tin nhắn đã được thu hồi" : (m.body ?? "[non-text message]"),
                    sticker: null,
                    file: null,
                    quote: null,
                    link: null,
                    reactionIcon: null,
                    deleted: m.deleted,
                    outgoing: m.outgoing,
                    authorName: m.fromName,
                    authorAvatar: m.fromAvatar ?? (m.outgoing ? this.profile?.avatar : row.avatar),
                    at: Date.parse(m.observedAt) || Date.now(),
                }))
                .sort((a, c) => a.at - c.at);
            threads[row.threadId] = mapped;
            const last = mapped[mapped.length - 1];
            conversations.push({
                threadId: row.threadId,
                kind: row.kind,
                title: row.title || row.threadId,
                avatar: row.avatar,
                lastAt: row.lastAt ? (Date.parse(row.lastAt) || 0) : (last?.at ?? 0),
                lastSnippet: last ? messageSnippet(last.body, last.sticker, last.link, last.deleted) : "",
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
                invoke("mark_thread_read", {
                    accountId: this.profile.accountId,
                    threadId,
                }).catch(() => { });
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
            const msgId = this.cloudMode && this.cloudBaseUrl && this.cloudDeviceToken
                ? String((await sendCloudText(this.cloudBaseUrl, this.cloudDeviceToken, this.profile!.accountId, threadId, text, kind)).msgId ?? "")
                : await invoke<string>("send_message", {
                    accountId: this.profile!.accountId,
                    threadId,
                    text,
                    kind,
                    quote: quote ?? null,
                });
            this.appendToActive(
                {
                    id: msgId || `local-${Date.now()}`,
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
        if (this.cloudMode) return [];
        const term = keyword.trim();
        if (!term || !this.profile) return [];
        try {
            return await invoke<Sticker[]>("search_stickers", {
                accountId: this.profile.accountId,
                keyword: term,
                limit,
            });
        } catch (e) {
            log.error(`search_stickers failed: ${String(e)}`);
            return [];
        }
    }

    /** The account's recently-used stickers for the picker's "Gần đây" row. */
    async recentStickers(limit = 24): Promise<Sticker[]> {
        if (this.cloudMode) return [];
        if (!this.profile) return [];
        try {
            return await invoke<Sticker[]>("recent_stickers", {
                accountId: this.profile.accountId,
                limit,
            });
        } catch (e) {
            log.error(`recent_stickers failed: ${String(e)}`);
            return [];
        }
    }

    /** The pack ids (categories) the account has used recently, for tab chips. */
    async stickerCategories(limit = 12): Promise<number[]> {
        if (this.cloudMode) return [];
        if (!this.profile) return [];
        try {
            return await invoke<number[]>("sticker_categories", {
                accountId: this.profile.accountId,
                limit,
            });
        } catch (e) {
            log.error(`sticker_categories failed: ${String(e)}`);
            return [];
        }
    }

    /** Load all stickers in a pack (category) for the picker's per-pack tab. */
    async stickerCategory(catId: number): Promise<Sticker[]> {
        if (this.cloudMode) return [];
        if (!this.profile) return [];
        try {
            return await invoke<Sticker[]>("sticker_category", {
                accountId: this.profile.accountId,
                catId,
            });
        } catch (e) {
            log.error(`sticker_category failed: ${String(e)}`);
            return [];
        }
    }

    /** Send a sticker to the active thread, rendering it optimistically. */
    async sendSticker(sticker: Sticker): Promise<boolean> {
        const threadId = this.activeThreadId;
        if (!threadId || !this.profile) return false;
        const convo = this.conversations.find((c) => c.threadId === threadId);
        const kind = convo?.kind ?? "user";

        let ok = false;
        await this.run(async () => {
            const msgId = this.cloudMode && this.cloudBaseUrl && this.cloudDeviceToken
                ? String((await sendCloudSticker(
                    this.cloudBaseUrl,
                    this.cloudDeviceToken,
                    this.profile!.accountId,
                    threadId,
                    sticker.id,
                    sticker.catId,
                    sticker.stickerType,
                    kind,
                )).msgId ?? "")
                : await invoke<string>("send_sticker", {
                    accountId: this.profile!.accountId,
                    threadId,
                    kind,
                    sticker,
                });
            this.appendToActive(
                {
                    id: msgId || `local-${Date.now()}`,
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
            if (this.cloudMode && this.cloudBaseUrl && this.cloudDeviceToken) {
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
            } else {
                await invoke("send_reaction", {
                    accountId: this.profile!.accountId,
                    threadId: message.threadId,
                    msgId: message.id,
                    cliMsgId: `${message.id}_cli`,
                    kind,
                    icon,
                });
            }
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

    async uploadCloudFile(file: File): Promise<boolean> {
        const threadId = this.activeThreadId;
        const convo = this.activeConversation;
        if (!threadId || !convo || !this.profile || !this.cloudBaseUrl || !this.cloudDeviceToken) return false;
        if (!this.cloudMode) return false;

        let ok = false;
        await this.run(async () => {
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
            this.appendToActive(
                {
                    id: `file-${meta.id}`,
                    threadId,
                    body: file.name || "Tệp đính kèm",
                    sticker: null,
                    file: {
                        id: meta.id,
                        filename: meta.filename,
                        mime: meta.mime,
                        sizeBytes: meta.sizeBytes,
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
            ok = true;
        });
        return ok;
    }

    async downloadCloudFile(message: ChatMessage): Promise<boolean> {
        if (!message.file || !this.cloudBaseUrl || !this.cloudDeviceToken) return false;
        let ok = false;
        await this.run(async () => {
            const bytes = await downloadCloudFileBlob(this.cloudBaseUrl!, this.cloudDeviceToken!, message.file!.id);
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

    private async ensureCloudRealtime(baseUrl: string, deviceToken: string) {
        if (!this.unlistenCloud) {
            this.unlistenCloud = await listen<CloudRealtimeEvent>(CLOUD_EVENT, (event) => {
                const payload = event.payload;
                if (payload.type === "error") {
                    log.error(`cloud realtime failed: ${payload.message ?? "stream error"}`);
                    return;
                }
                if (payload.type !== "message") return;
                const accountId = payload.accountId;
                if (accountId && this.buckets.has(accountId)) {
                    void this.hydrateCloudHistory(accountId);
                } else {
                    for (const tab of this.accounts) void this.hydrateCloudHistory(tab.accountId);
                }
            });
        }
        await startCloudRealtime(baseUrl, deviceToken);
    }

    private stopCloudRealtime() {
        this.unlistenCloud?.();
        this.unlistenCloud = null;
        this.cloudBaseUrl = null;
        this.cloudDeviceToken = null;
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
