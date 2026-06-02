// Reactive session state for the chat UI. Wraps the Tauri command/event API
// and derives conversation rows + per-thread message lists from the live
// zalo://message stream. No mock data — everything here reflects real IPC.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { log } from "./log";
import type {
    AccountProfile,
    ChatMessage,
    Contact,
    Conversation,
    CredentialSummary,
    History,
    IncomingMessage,
    QrLoginEvent,
    QrPhase,
} from "./types";

const MESSAGE_EVENT = "zalo://message";
const QR_EVENT = "zalo://qr";

function snippet(text: string | null): string {
    if (!text) return "[non-text message]";
    return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

class SessionStore {
    profile = $state<AccountProfile | null>(null);
    sessionSummary = $state<CredentialSummary | null>(null);
    listening = $state(false);
    busy = $state(false);
    error = $state("");
    /** True while the startup session-restore attempt is in flight. */
    restoring = $state(true);

    conversations = $state<Conversation[]>([]);
    activeThreadId = $state<string | null>(null);
    /** messages keyed by threadId */
    private threads = $state<Record<string, ChatMessage[]>>({});

    contacts = $state<Contact[]>([]);
    contactsLoaded = $state(false);
    /** which middle/main pane is shown: chats or contacts */
    view = $state<"chats" | "contacts">("chats");

    // --- QR login state (derived from the zalo://qr event stream). The QR is
    // the app's login gate: while `profile` is null the UI shows the QR screen
    // and nothing else. The credential triple never enters the webview. ---
    qrPhase = $state<QrPhase>("idle");
    /** base64-encoded PNG of the current QR code, when one is shown */
    qrImage = $state<string | null>(null);
    /** public name/avatar of the account that scanned, once scanned */
    qrScannedName = $state<string | null>(null);
    qrScannedAvatar = $state<string | null>(null);
    qrError = $state("");
    /** Seconds remaining before the current QR expires (0 when not counting). */
    qrSecondsLeft = $state(0);

    private unlisten: UnlistenFn | null = null;
    private unlistenQr: UnlistenFn | null = null;
    private qrTimer: ReturnType<typeof setInterval> | null = null;

    /** True once an account is authenticated; gates the chat shell. */
    get loggedIn(): boolean {
        return this.profile !== null;
    }

    get activeMessages(): ChatMessage[] {
        return this.activeThreadId ? (this.threads[this.activeThreadId] ?? []) : [];
    }

    get activeConversation(): Conversation | null {
        return this.conversations.find((c) => c.threadId === this.activeThreadId) ?? null;
    }

    async checkSession() {
        await this.run(async () => {
            this.sessionSummary = await invoke<CredentialSummary>("cred_file_summary");
        });
    }

    async login() {
        await this.run(async () => {
            this.profile = await invoke<AccountProfile>("login_from_file");
        });
    }

    async loginAndListen() {
        await this.run(async () => {
            await this.ensureListener();
            this.profile = await invoke<AccountProfile>("start_listening_from_file");
            this.listening = true;
        });
        // Best-effort: warm the address book once logged in.
        if (this.profile) {
            this.loadContacts();
            this.hydrateHistory();
        }
    }

    /**
     * On app start, try to restore a previously saved account from the local
     * store (decrypted in the core; credentials never enter the webview). If an
     * account comes back online the chat shell unlocks without a QR scan.
     */
    async restore(): Promise<boolean> {
        let restored = false;
        await this.run(async () => {
            await this.ensureListener();
            const profiles = await invoke<AccountProfile[]>("restore_sessions");
            if (profiles.length > 0) {
                this.profile = profiles[0];
                this.listening = true;
                restored = true;
                log.info(`restore: ${profiles.length} account(s) restored`);
            }
        });
        this.restoring = false;
        if (restored && this.profile) {
            this.loadContacts();
            this.hydrateHistory();
        }
        return restored;
    }

    /**
     * Run the interactive QR login flow. This is the app's login gate: the core
     * streams non-secret progress over `zalo://qr` (so the QR appears as soon as
     * it is generated), and the credential triple never enters the webview. On
     * success the account is logged in and listening, and the chat shell unlocks.
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
            // Resolves only after scan + confirm complete and the listener starts.
            this.profile = await invoke<AccountProfile>("start_qr_login");
            this.listening = true;
            this.qrPhase = "success";
            log.info(`qr-login: success, account=${this.profile?.accountId ?? "?"}`);
            this.loadContacts();
            this.hydrateHistory();
        } catch (e) {
            // A declined/expired stage already set a friendlier phase; only fall
            // back to a generic error when we're still mid-flight. (The async
            // event listener may have mutated qrPhase, so compare via a set to
            // avoid misleading literal-narrowing.)
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

    async loadContacts() {
        if (!this.profile) return;
        await this.run(async () => {
            this.contacts = await invoke<Contact[]>("list_contacts", {
                accountId: this.profile!.accountId,
            });
            this.contactsLoaded = true;
            // Backfill avatars into any conversation rows created before the
            // address book loaded (e.g. realtime messages that arrived first).
            this.conversations = this.conversations.map((c) =>
                c.avatar ? c : { ...c, avatar: this.avatarFor(c.threadId) },
            );
        });
    }

    /**
     * Hydrate conversations + per-thread messages from the local store so chat
     * history is visible immediately at login/restore — before (and regardless
     * of) any realtime event. Merges with whatever is already in memory.
     */
    async hydrateHistory() {
        if (!this.profile) return;
        const accountId = this.profile.accountId;
        let history: History;
        try {
            history = await invoke<History>("load_history", { accountId });
        } catch (e) {
            log.error(`load_history failed: ${String(e)}`);
            return;
        }

        // Rebuild the message threads map from persisted rows.
        const threads: Record<string, ChatMessage[]> = { ...this.threads };
        for (const m of history.messages) {
            const list = threads[m.threadId] ?? (threads[m.threadId] = []);
            if (list.some((x) => x.id === m.msgId)) continue;
            list.push({
                id: m.msgId,
                threadId: m.threadId,
                body: m.body ?? "[non-text message]",
                outgoing: m.outgoing,
                authorName: m.fromName,
                at: m.ts ?? 0,
            });
        }
        for (const id of Object.keys(threads)) {
            threads[id].sort((a, b) => a.at - b.at);
        }
        this.threads = threads;

        // Merge persisted threads into the conversation list (don't clobber any
        // live rows already present).
        const byId = new Map(this.conversations.map((c) => [c.threadId, c]));
        for (const t of history.threads) {
            const msgs = threads[t.threadId] ?? [];
            const last = msgs[msgs.length - 1];
            const title = t.title || t.threadId;
            const existing = byId.get(t.threadId);
            byId.set(t.threadId, {
                threadId: t.threadId,
                kind: t.kind,
                title: existing?.title || title,
                lastSnippet: last ? snippet(last.body) : (existing?.lastSnippet ?? ""),
                lastAt: t.lastAt ?? existing?.lastAt ?? 0,
                unread: t.unread ?? existing?.unread ?? 0,
                avatar: existing?.avatar ?? t.avatar ?? this.avatarFor(t.threadId),
            });
        }
        this.conversations = [...byId.values()].sort((a, b) => b.lastAt - a.lastAt);
    }

    /** Open (or focus) a DM thread with a contact, using their name as title. */
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
            // Persist the read state so it survives restart.
            if (this.profile) {
                invoke("mark_thread_read", { accountId: this.profile.accountId, threadId }).catch(
                    () => { },
                );
            }
        }
    }

    async sendActive(body: string): Promise<boolean> {
        const text = body.trim();
        const threadId = this.activeThreadId;
        if (!text || !threadId || !this.profile) return false;

        let ok = false;
        await this.run(async () => {
            const msgId = await invoke<string>("send_message", {
                accountId: this.profile!.accountId,
                threadId,
                text,
            });
            this.appendMessage(
                {
                    id: msgId || `local-${Date.now()}`,
                    threadId,
                    body: text,
                    outgoing: true,
                    authorName: this.profile?.displayName ?? "Me",
                    at: Date.now(),
                },
                snippet(text),
            );
            ok = true;
        });
        return ok;
    }

    dispose() {
        this.unlisten?.();
        this.unlisten = null;
        this.unlistenQr?.();
        this.unlistenQr = null;
        this.stopQrCountdown();
    }

    private async ensureListener() {
        if (this.unlisten) return;
        this.unlisten = await listen<IncomingMessage>(MESSAGE_EVENT, (event) => {
            this.ingest(event.payload);
        });
    }

    /** Resolve a peer's avatar URL from the loaded contacts, by user/thread id. */
    private avatarFor(threadId: string): string | null {
        return this.contacts.find((c) => c.userId === threadId)?.avatar ?? null;
    }

    private ingest(msg: IncomingMessage) {
        const name = msg.fromName ?? msg.fromId;
        this.appendMessage(
            {
                id: msg.msgId,
                threadId: msg.threadId,
                body: msg.text ?? "[non-text message]",
                outgoing: msg.isSelf,
                authorName: name,
                at: Date.now(),
            },
            snippet(msg.text),
            { kind: msg.threadKind, title: name, bumpUnread: !msg.isSelf && msg.threadId !== this.activeThreadId },
        );
    }

    private appendMessage(
        message: ChatMessage,
        lastSnippet: string,
        meta?: { kind: "user" | "group"; title: string; bumpUnread: boolean },
    ) {
        const existing = this.threads[message.threadId] ?? [];
        if (existing.some((m) => m.id === message.id)) return; // dedupe by msg id
        this.threads = {
            ...this.threads,
            [message.threadId]: [...existing, message],
        };

        const idx = this.conversations.findIndex((c) => c.threadId === message.threadId);
        if (idx >= 0) {
            const current = this.conversations[idx];
            const updated: Conversation = {
                ...current,
                title: meta?.title ?? current.title,
                lastSnippet,
                lastAt: message.at,
                unread: meta?.bumpUnread ? current.unread + 1 : current.unread,
                // Backfill the avatar if contacts loaded after the row was created.
                avatar: current.avatar ?? this.avatarFor(message.threadId),
            };
            const rest = this.conversations.filter((_, i) => i !== idx);
            this.conversations = [updated, ...rest];
        } else {
            const convo: Conversation = {
                threadId: message.threadId,
                kind: meta?.kind ?? "user",
                title: meta?.title ?? message.threadId,
                lastSnippet,
                lastAt: message.at,
                unread: meta?.bumpUnread ? 1 : 0,
                avatar: this.avatarFor(message.threadId),
            };
            this.conversations = [convo, ...this.conversations];
            if (!this.activeThreadId) this.activeThreadId = convo.threadId;
        }
    }

    /** Start (or reuse) a conversation for a thread id typed by the user. */
    openThread(threadId: string, title?: string) {
        const id = threadId.trim();
        if (!id) return;
        if (!this.threads[id]) this.threads = { ...this.threads, [id]: [] };
        if (!this.conversations.some((c) => c.threadId === id)) {
            this.conversations = [
                {
                    threadId: id,
                    kind: "user",
                    title: title || id,
                    lastSnippet: "",
                    lastAt: Date.now(),
                    unread: 0,
                    avatar: this.avatarFor(id),
                },
                ...this.conversations,
            ];
        }
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
