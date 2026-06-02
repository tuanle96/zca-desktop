// Reactive session state for the chat UI. Wraps the Tauri command/event API
// and derives conversation rows + per-thread message lists from the live
// zalo://message stream. No mock data — everything here reflects real IPC.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
    AccountProfile,
    ChatMessage,
    Conversation,
    CredentialSummary,
    IncomingMessage,
} from "./types";

const MESSAGE_EVENT = "zalo://message";

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

    conversations = $state<Conversation[]>([]);
    activeThreadId = $state<string | null>(null);
    /** messages keyed by threadId */
    private threads = $state<Record<string, ChatMessage[]>>({});

    private unlisten: UnlistenFn | null = null;

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
    }

    selectThread(threadId: string) {
        this.activeThreadId = threadId;
        const convo = this.conversations.find((c) => c.threadId === threadId);
        if (convo && convo.unread > 0) {
            this.conversations = this.conversations.map((c) =>
                c.threadId === threadId ? { ...c, unread: 0 } : c,
            );
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
    }

    private async ensureListener() {
        if (this.unlisten) return;
        this.unlisten = await listen<IncomingMessage>(MESSAGE_EVENT, (event) => {
            this.ingest(event.payload);
        });
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
                { threadId: id, kind: "user", title: title || id, lastSnippet: "", lastAt: Date.now(), unread: 0 },
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
