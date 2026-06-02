// Frontend mirrors of the core DTOs returned over Tauri IPC.
// These intentionally carry no credential/session state — only display data.

export type CredentialSummary = {
    imeiLen: number;
    cookieCount: number;
    userAgentLen: number;
    language: string;
};

export type AccountProfile = {
    accountId: string;
    displayName: string | null;
    avatar: string | null;
};

// Non-secret QR-login progress, mirrored from the core `QrLoginEvent`
// (zalo://qr). Internally tagged on `stage`; carries only display data — never
// imei/cookie/userAgent.
export type QrLoginEvent =
    | { stage: "generated"; image: string; expiresInSecs: number }
    | { stage: "scanned"; displayName: string; avatar: string }
    | { stage: "declined" }
    | { stage: "expired" }
    | { stage: "success" };

// UI-side phase for the QR login modal, derived from the event stream.
export type QrPhase =
    | "idle"
    | "loading"
    | "waiting-scan"
    | "scanned"
    | "success"
    | "declined"
    | "expired"
    | "error";

export type Contact = {
    userId: string;
    displayName: string;
    zaloName: string | null;
    avatar: string | null;
};

export type Group = {
    groupId: string;
    name: string;
    avatar: string | null;
};

export type ThreadKind = "user" | "group";

export type IncomingMessage = {
    accountId: string;
    threadId: string;
    threadKind: ThreadKind;
    fromId: string;
    fromName: string | null;
    text: string | null;
    msgId: string;
    timestamp: string;
    isSelf: boolean;
};

// A chat bubble rendered in the conversation pane. Outgoing messages are
// created optimistically; incoming ones come from the zalo://message stream.
export type ChatMessage = {
    id: string;
    threadId: string;
    body: string;
    outgoing: boolean;
    authorName: string | null;
    at: number;
};

// A conversation row in the middle pane, derived from message activity.
export type Conversation = {
    threadId: string;
    kind: ThreadKind;
    title: string;
    lastSnippet: string;
    lastAt: number;
    unread: number;
    /** Avatar URL for the peer/group, when known (resolved from contacts). */
    avatar: string | null;
};

// Persisted history reloaded from the local store at login/restore.
export type StoredThread = {
    accountId: string;
    threadId: string;
    kind: ThreadKind;
    title: string | null;
    avatar: string | null;
    lastAt: number | null;
    unread: number;
};

export type StoredMessage = {
    accountId: string;
    threadId: string;
    msgId: string;
    fromId: string | null;
    fromName: string | null;
    body: string | null;
    outgoing: boolean;
    ts: number | null;
};

export type History = {
    threads: StoredThread[];
    messages: StoredMessage[];
};
