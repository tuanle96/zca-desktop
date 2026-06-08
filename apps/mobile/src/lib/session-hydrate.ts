// Pure mapping from the cloud wire rows to display DTOs. No store, no IPC, no OS
// notifications — just the row→bubble/snippet transforms the desktop session
// store uses inside hydrateCloudHistory.
import type { ChatMessage, LinkPreview, QuoteRef, ReactionIcon, Sticker } from "@zca/types";

/** A conversation row as returned by GET /conversations. */
export type CloudConversationRow = {
	id: string;
	accountId: string;
	threadId: string;
	kind: "user" | "group";
	title: string | null;
	avatar: string | null;
	lastAt: string | null;
	unread: number;
};

/** A message row as returned by GET /conversations/:id/messages (wire shape:
 * file carries `href`, mapped to the display `sourceUrl`). */
export type CloudMessageRow = {
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

export function snippet(text: string | null): string {
	if (!text) return "[non-text message]";
	return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

/** Conversation-list snippet for a message that may carry rich state. */
export function messageSnippet(
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

const REACTION_EMOJI: Record<ReactionIcon, string> = {
	heart: "❤️", like: "👍", haha: "😆", wow: "😮", cry: "😢", angry: "😠",
	kiss: "😘", tearsOfJoy: "😂", shit: "💩", rose: "🌹", brokenHeart: "💔",
	dislike: "👎", love: "😍", confused: "😕", wink: "😉", fade: "😶",
	sun: "☀️", birthday: "🎂", bomb: "💣", ok: "👌", peace: "✌️",
	thanks: "🙏", punch: "👊",
};

export function reactionEmoji(icon: ReactionIcon): string {
	return REACTION_EMOJI[icon];
}

/** Map one conversation's message rows into sorted display bubbles. */
export function mapCloudMessages(
	messages: CloudMessageRow[],
	row: CloudConversationRow,
	selfAvatar: string | null | undefined,
): ChatMessage[] {
	return messages
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
			authorAvatar: m.fromAvatar ?? (m.outgoing ? selfAvatar : row.avatar),
			at: Date.parse(m.observedAt) || Date.now(),
		}))
		.sort((a, c) => a.at - c.at);
}
