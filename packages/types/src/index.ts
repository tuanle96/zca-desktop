// Shared display-only DTOs, mirrored from the Rust core/cloud DTOs returned over
// Tauri IPC. These intentionally carry no credential/session state — only display
// data — and no runtime code (types only), so both the desktop and mobile
// frontends can depend on them freely.

import type { ContactView, RichSticker, RichQuote, RichLink } from "./generated/contract";

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

// Alias of the generated wire type (same shape) — single source of truth.
export type Contact = ContactView;

export type Group = {
    groupId: string;
    name: string;
    avatar: string | null;
};

export type ThreadKind = "user" | "group";

// A sticker reference, mirrored from the core `Sticker` DTO. `url` is a
// renderable image URL on the allowlisted Zalo emoticon CDN; the three ids are
// what Zalo needs to (re)send the sticker.
export type Sticker = RichSticker;


// Reaction icon the UI can send, mirrored from the core `ReactionIcon`.
export type ReactionIcon =
    | "heart" | "like" | "haha" | "wow" | "cry" | "angry" | "kiss"
    | "tearsOfJoy" | "shit" | "rose" | "brokenHeart" | "dislike"
    | "love" | "confused" | "wink" | "fade" | "sun" | "birthday"
    | "bomb" | "ok" | "peace" | "thanks" | "punch";

// A reaction event from the realtime listener — someone added a reaction to a
// message. `icon` is a pre-resolved emoji character.
export type ReactionEvent = {
    threadId: string;
    msgId: string;
    uidFrom: string;
    dName: string | null;
    icon: string;
    isSelf: boolean;
    isGroup: boolean;
};

export type IncomingMessage = {
    accountId: string;
    threadId: string;
    threadKind: ThreadKind;
    fromId: string;
    fromName: string | null;
    text: string | null;
    sticker: Sticker | null;
    reaction: ReactionEvent | null;
    quote: QuoteRef | null;
    link: LinkPreview | null;
    undo: UndoEvent | null;
    msgId: string;
    timestamp: string;
    isSelf: boolean;
};

// A chat bubble rendered in the conversation pane. Outgoing messages are
// created optimistically; incoming ones come from the zalo://message stream.
// A sticker bubble carries `sticker` (rendered as an image) instead of text.

// A quoted (replied-to) message reference, carried on incoming messages.
export type QuoteRef = RichQuote;

// What the UI sends to quote a message when replying.
export type QuoteInput = {
    content: string;
    msgType: string;
    uidFrom: string;
    msgId: string;
    cliMsgId: string;
    ts: number;
    ttl: number;
};


// A link preview from a chat.link message.
export type LinkPreview = RichLink;

// An undo event — someone deleted a message.
export type UndoEvent = {
    threadId: string;
    msgId: string;
    cliMsgId: string;
    isSelf: boolean;
    isGroup: boolean;
};

export type ChatMessage = {
    id: string;
    threadId: string;
    body: string;
    sticker: Sticker | null;
    file?: {
        id?: string | null;
        filename: string | null;
        mime: string | null;
        sizeBytes: number;
        sourceUrl?: string | null;
        thumb?: string | null;
        mediaKind?: "image" | "video" | "audio" | "file" | string | null;
    } | null;
    quote: QuoteRef | null;
    link: LinkPreview | null;
    reactionIcon: string | null;
    deleted: boolean;
    outgoing: boolean;
    authorName: string | null;
    authorAvatar?: string | null;
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

// Generated cloud WIRE contract (single source of truth: crates/zca-types).
// Regenerate with `cargo test -p zca-types`. See ./generated/contract.ts.
export * from "./generated/contract";
