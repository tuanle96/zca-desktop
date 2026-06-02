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
};

export type Contact = {
    userId: string;
    displayName: string;
    zaloName: string | null;
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
};
