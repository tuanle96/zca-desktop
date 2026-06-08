// Display formatting helpers for the conversation list + chat thread. Ported
// from the desktop ConversationList/ChatPane (pure, no state).
import type { ChatMessage, ReactionIcon } from "@zca/types";

export function initials(name: string): string {
	const parts = name.trim().split(/\s+/);
	const a = parts[0]?.[0] ?? "";
	const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
	return (a + b).toUpperCase() || "?";
}

/** Relative age for a conversation row (vừa xong / phút / giờ / ngày). */
export function timeLabel(at: number): string {
	if (!at) return "";
	const mins = Math.floor((Date.now() - at) / 60000);
	if (mins < 1) return "vừa xong";
	if (mins < 60) return `${mins} phút`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs} giờ`;
	return `${Math.floor(hrs / 24)} ngày`;
}

/** Wall-clock time for a message bubble. */
export function clock(at: number): string {
	return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function dayLabel(at: number): string {
	const d = new Date(at);
	const isToday = d.toDateString() === new Date().toDateString();
	return isToday ? "Hôm nay" : d.toLocaleDateString("vi-VN");
}

export function fileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fileKindLabel(m: ChatMessage): string {
	const kind = m.file?.mediaKind;
	if (kind === "image") return "Ảnh";
	if (kind === "video") return "Video";
	if (kind === "audio") return "Âm thanh";
	return "Tệp";
}

export function fileExtension(filename: string | null | undefined): string {
	const ext = filename?.split(".").pop()?.trim();
	if (!ext || ext === filename) return "FILE";
	return ext.slice(0, 4).toUpperCase();
}

export function fileMeta(m: ChatMessage): string {
	const parts = [fileKindLabel(m)];
	const size = fileSize(m.file?.sizeBytes ?? 0);
	if (size) parts.push(size);
	return parts.join(" · ");
}

export function filePreviewUrl(m: ChatMessage): string | null {
	return m.file?.thumb || m.file?.sourceUrl || null;
}

export const REACTION_OPTIONS: { icon: ReactionIcon; emoji: string; label: string }[] = [
	{ icon: "like", emoji: "👍", label: "Thích" },
	{ icon: "heart", emoji: "❤️", label: "Yêu thích" },
	{ icon: "haha", emoji: "😆", label: "Haha" },
	{ icon: "wow", emoji: "😮", label: "Wow" },
	{ icon: "cry", emoji: "😢", label: "Buồn" },
	{ icon: "angry", emoji: "😠", label: "Giận" },
];
