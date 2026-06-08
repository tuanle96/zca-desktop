// Reactive session state for the mobile chat UI (Svelte 5 runes). Cloud-only
// port of the desktop SessionStore: it reuses @zca/core-client for every cloud
// call and keeps the device token in the OS keychain (passed as the
// CLOUD_DEVICE_TOKEN_KEYCHAIN sentinel — never in the webview). Realtime + the
// reconnect loop live in CloudRealtime; row→display mapping in session-hydrate.
import {
	CLOUD_DEVICE_TOKEN_KEYCHAIN,
	clearCloudDeviceSession,
	deleteCloudAccount,
	downloadCloudFileBlob,
	initCloudFile,
	listCloudAccounts,
	listCloudContacts,
	listCloudConversations,
	listCloudMessages,
	loadCloudDeviceSession,
	sendCloudFile,
	sendCloudReaction,
	sendCloudSticker,
	sendCloudText,
	uploadCloudFileBlob,
	verifyCloudMagicLink,
	verifyCloudOAuthCode,
	type CloudAccount,
} from "@zca/core-client";
import type {
	AccountProfile,
	ChatMessage,
	Contact,
	Conversation,
	Group,
	QuoteInput,
	ReactionEvent,
	ReactionIcon,
	Sticker,
} from "@zca/types";
import {
	CLOUD_BASE_URL_STORAGE_KEY,
	DEFAULT_CLOUD_BASE_URL,
	cloudBaseUrlFromStorage,
	normalizeCloudBaseUrl,
} from "./cloudConfig";
import { log } from "./log";
import {
	defaultDeviceName,
	isCloudAuthError,
	isCloudRecoveryKeyInvalidError,
	isCloudRecoveryKeyRequiredError,
	sleep,
} from "./session-helpers";
import {
	mapCloudMessages,
	messageSnippet,
	reactionEmoji,
	snippet,
	type CloudConversationRow,
	type CloudMessageRow,
} from "./session-hydrate";
import { CloudRealtime } from "./session-realtime.svelte";

export const CLOUD_DEVICE_LINKED_STORAGE_KEY = "zca.cloud.deviceLinked";

export type UploadResult = { ok: boolean; error?: string };

/** A compact account entry for the account switcher. */
export type AccountTab = {
	accountId: string;
	displayName: string | null;
	avatar: string | null;
	unread: number;
};

/** All per-account data; the active account's slice is mirrored into the
 * top-level reactive fields, background accounts keep accumulating here. */
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
	accounts = $state<AccountTab[]>([]);
	activeAccountId = $state<string | null>(null);
	private buckets = new Map<string, AccountData>();
	private cloudConversationIds = new Map<string, string>();

	busy = $state(false);
	error = $state("");
	/** True while the startup cloud-device state check is in flight. */
	restoring = $state(true);
	cloudMode = $state(false);
	/** True while a magic-link/oauth link is being verified. */
	cloudLinking = $state(false);
	cloudIssuedRecoveryKey = $state("");
	/** True while a QR flow for an additional account is in progress (Phase 4). */
	qrAdding = $state(false);

	private cloudBaseUrl: string | null = null;
	private cloudDeviceToken: string | null = null;
	private inFlightMagicLink: string | null = null;
	private lastVerifiedMagicLink: string | null = null;

	private realtime = new CloudRealtime({
		creds: () => ({ baseUrl: this.cloudBaseUrl, token: this.cloudDeviceToken }),
		onMessage: (accountId) => {
			if (accountId && this.buckets.has(accountId)) {
				void this.hydrateCloudHistory(accountId);
			} else {
				for (const tab of this.accounts) void this.hydrateCloudHistory(tab.accountId);
			}
		},
		onConnected: (refresh) => {
			if (refresh) for (const tab of this.accounts) void this.hydrateCloudHistory(tab.accountId);
		},
		onAuthFailure: () => void this.handleCloudAuthFailure(),
	});

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

	get realtimeState() {
		return this.realtime.state;
	}
	get realtimeLabel(): string {
		return this.realtime.label;
	}
	get listening(): boolean {
		return this.realtime.listening;
	}

	// --- restore / connect / link --------------------------------------------

	/** On app start, silently restore a previously linked cloud device (if any). */
	async restore(): Promise<boolean> {
		try {
			return await this.restoreCloudDevice();
		} finally {
			this.restoring = false;
		}
	}

	async restoreCloudDevice(baseUrl?: string): Promise<boolean> {
		if (typeof localStorage === "undefined") return false;
		const targetBaseUrl = normalizeCloudBaseUrl(baseUrl || cloudBaseUrlFromStorage(localStorage));
		const saved = await loadCloudDeviceSession(targetBaseUrl).catch((e) => {
			log.error(`cloud-restore: device session lookup failed: ${String(e)}`);
			return null;
		});
		if (!saved?.hasDeviceToken) return false;

		const result = await this.connectCloud(targetBaseUrl, CLOUD_DEVICE_TOKEN_KEYCHAIN);
		if (result === "connected") {
			localStorage.setItem(CLOUD_BASE_URL_STORAGE_KEY, targetBaseUrl);
			localStorage.setItem(CLOUD_DEVICE_LINKED_STORAGE_KEY, "1");
			log.info("cloud-restore: connected cloud device session");
			return true;
		}

		this.resetCloudConnection();
		if (result === "auth-error") {
			localStorage.removeItem(CLOUD_DEVICE_LINKED_STORAGE_KEY);
			await clearCloudDeviceSession(targetBaseUrl).catch((e) =>
				log.error(`cloud-restore: clearing stale device session failed: ${String(e)}`),
			);
			log.info("cloud-restore: cleared stale cloud device token (auth failed)");
		}
		return false;
	}

	/** Connect using a cloud device token. Validates it by listing accounts
	 * BEFORE opening realtime, so a dead token fails fast. */
	async connectCloud(baseUrl: string, deviceToken: string): Promise<"connected" | "auth-error" | "failed"> {
		try {
			const accounts = await listCloudAccounts(baseUrl, deviceToken);
			this.cloudMode = true;
			this.cloudBaseUrl = baseUrl;
			this.cloudDeviceToken = deviceToken;
			for (const account of accounts) this.adoptCloudAccount(account, { activate: false });
			if (accounts.length === 0) {
				await this.realtime.ensure();
				return "failed";
			}
			this.activate(accounts[0].id);
			await this.realtime.ensure();
			for (const tab of this.accounts) this.hydrateCloudHistory(tab.accountId);
			return "connected";
		} catch (e) {
			if (isCloudAuthError(e)) {
				log.info(`cloud connect: device token rejected (${String(e)})`);
				return "auth-error";
			}
			this.error = String(e);
			log.error(`cloud connect failed: ${String(e)}`);
			return "failed";
		}
	}

	private resetCloudConnection() {
		this.realtime.stop();
		this.cloudBaseUrl = null;
		this.cloudDeviceToken = null;
		this.cloudMode = false;
		this.error = "";
	}

	/** Complete device linking from a magic-link token (verify → keychain → connect). */
	async linkViaMagicToken(email: string, token: string, baseUrl?: string): Promise<boolean> {
		const targetBaseUrl = normalizeCloudBaseUrl(
			baseUrl || (typeof localStorage !== "undefined" ? cloudBaseUrlFromStorage(localStorage) : DEFAULT_CLOUD_BASE_URL),
		);
		const magicLinkKey = `${targetBaseUrl}\n${email.trim().toLowerCase()}\n${token}`;
		if (this.lastVerifiedMagicLink === magicLinkKey) return true;
		if (this.cloudLinking) return this.inFlightMagicLink === magicLinkKey;
		this.cloudLinking = true;
		this.inFlightMagicLink = magicLinkKey;
		this.error = "";
		try {
			const res = await verifyCloudMagicLink(targetBaseUrl, email, token, defaultDeviceName());
			this.lastVerifiedMagicLink = magicLinkKey;
			this.cloudIssuedRecoveryKey = res.recoveryKey ?? "";
			this.persistLinked(targetBaseUrl);
			await this.connectCloud(targetBaseUrl, res.deviceToken);
			log.info("link: device linked via magic token");
			return true;
		} catch (e) {
			this.error = isCloudRecoveryKeyRequiredError(e)
				? "Tài khoản cloud này đã tồn tại. Nhập mã từ email, dán recovery key rồi bấm Kết nối thiết bị."
				: isCloudRecoveryKeyInvalidError(e)
					? "Recovery key không đúng. Hãy kiểm tra lại hoặc gửi mã đăng nhập mới."
					: isCloudAuthError(e)
						? "Mã đăng nhập đã hết hạn hoặc không hợp lệ. Hãy gửi lại mã."
						: String(e);
			log.error(`link: magic-link verify failed: ${String(e)}`);
			return false;
		} finally {
			if (this.inFlightMagicLink === magicLinkKey) this.inFlightMagicLink = null;
			this.cloudLinking = false;
		}
	}

	async linkViaOAuthCode(code: string, baseUrl?: string): Promise<boolean> {
		const targetBaseUrl = normalizeCloudBaseUrl(
			baseUrl || (typeof localStorage !== "undefined" ? cloudBaseUrlFromStorage(localStorage) : DEFAULT_CLOUD_BASE_URL),
		);
		const oauthKey = `${targetBaseUrl}\n${code}`;
		if (this.lastVerifiedMagicLink === oauthKey) return true;
		if (this.cloudLinking) return this.inFlightMagicLink === oauthKey;
		this.cloudLinking = true;
		this.inFlightMagicLink = oauthKey;
		this.error = "";
		try {
			const res = await verifyCloudOAuthCode(targetBaseUrl, code);
			this.lastVerifiedMagicLink = oauthKey;
			this.cloudIssuedRecoveryKey = res.recoveryKey ?? "";
			this.persistLinked(targetBaseUrl);
			await this.connectCloud(targetBaseUrl, res.deviceToken);
			log.info("link: device linked via oauth code");
			return true;
		} catch (e) {
			this.error = isCloudAuthError(e)
				? "Phiên đăng nhập OAuth đã hết hạn hoặc không hợp lệ. Hãy đăng nhập lại."
				: String(e);
			log.error(`link: oauth code verify failed: ${String(e)}`);
			return false;
		} finally {
			if (this.inFlightMagicLink === oauthKey) this.inFlightMagicLink = null;
			this.cloudLinking = false;
		}
	}

	private persistLinked(baseUrl: string) {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(CLOUD_BASE_URL_STORAGE_KEY, baseUrl);
		localStorage.setItem(CLOUD_DEVICE_LINKED_STORAGE_KEY, "1");
	}

	/** The device token was rejected (revoked or server reset). Purge it and
	 * drop back to the login gate without a scary error. */
	private async handleCloudAuthFailure() {
		const baseUrl = this.cloudBaseUrl;
		this.realtime.stop();
		this.cloudBaseUrl = null;
		this.cloudDeviceToken = null;
		this.cloudMode = false;
		this.error = "";
		if (typeof localStorage !== "undefined") localStorage.removeItem(CLOUD_DEVICE_LINKED_STORAGE_KEY);
		if (baseUrl) {
			await clearCloudDeviceSession(baseUrl).catch((e) =>
				log.error(`cloud auth-failure: clearing stale device session failed: ${String(e)}`),
			);
		}
	}

	addAccount() {
		this.qrAdding = true;
	}
	cancelAddAccount() {
		this.qrAdding = false;
	}

	/** Unlink this device entirely: purge the keychain token + reset to the gate. */
	async unlinkDevice() {
		const baseUrl = this.cloudBaseUrl;
		this.realtime.stop();
		this.cloudBaseUrl = null;
		this.cloudDeviceToken = null;
		this.cloudMode = false;
		this.error = "";
		if (typeof localStorage !== "undefined") localStorage.removeItem(CLOUD_DEVICE_LINKED_STORAGE_KEY);
		if (baseUrl) {
			await clearCloudDeviceSession(baseUrl).catch((e) => log.error(`unlink: clearing device session failed: ${String(e)}`));
		}
		this.buckets.clear();
		this.cloudConversationIds.clear();
		this.accounts = [];
		this.activeAccountId = null;
		this.profile = null;
		this.conversations = [];
		this.threads = {};
		this.contacts = [];
		this.contactsLoaded = false;
		this.groups = [];
		this.groupsLoaded = false;
		this.activeThreadId = null;
		this.cloudIssuedRecoveryKey = "";
		this.lastVerifiedMagicLink = null;
	}

	// --- account management ---------------------------------------------------

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
				{ accountId: profile.accountId, displayName: profile.displayName, avatar: profile.avatar, unread: 0 },
			];
		}
		if (activate) this.activate(profile.accountId);
	}

	private adoptCloudAccount(account: CloudAccount, opts: { activate?: boolean } = {}) {
		this.adoptAccount(
			{ accountId: account.id, displayName: account.displayName ?? account.zaloAccountId, avatar: account.avatar },
			opts,
		);
	}

	switchAccount(accountId: string) {
		if (accountId === this.activeAccountId) return;
		this.activate(accountId);
	}

	/** Remove an account from the cloud user, prune its bucket + rail entry. */
	async logoutAccount(accountId: string) {
		await this.run(async () => {
			if (!this.cloudBaseUrl || !this.cloudDeviceToken) throw new Error("cloud device session not connected");
			await deleteCloudAccount(this.cloudBaseUrl, this.cloudDeviceToken, accountId);
			this.cloudConversationIds.delete(accountId);
		});
		if (this.error) return;

		this.buckets.delete(accountId);
		this.accounts = this.accounts.filter((a) => a.accountId !== accountId);

		if (this.activeAccountId === accountId) {
			const next = this.accounts[0];
			if (next) {
				this.activeAccountId = null;
				this.activate(next.accountId);
			} else {
				this.activeAccountId = null;
				this.profile = null;
				this.conversations = [];
				this.threads = {};
				this.contacts = [];
				this.contactsLoaded = false;
				this.groups = [];
				this.groupsLoaded = false;
				this.activeThreadId = null;
			}
		}
		log.info(`logout: forgot account ${accountId} (remaining=${this.accounts.length})`);
	}

	private activate(accountId: string) {
		const target = this.buckets.get(accountId);
		if (!target) return;
		const previous = this.activeAccountId;
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
		this.activeAccountId = accountId;
		this.profile = target.profile;
		this.conversations = target.conversations;
		this.threads = target.threads;
		this.contacts = target.contacts;
		this.contactsLoaded = target.contactsLoaded;
		this.groups = target.groups;
		this.groupsLoaded = target.groupsLoaded;
		this.activeThreadId = target.activeThreadId;
		this.setAccountUnread(accountId, 0);
		if (previous !== accountId) {
			log.info(`account-switch: active ${previous ?? "none"} -> ${accountId} (conversations=${target.conversations.length})`);
		}
	}

	private setAccountUnread(accountId: string, n: number) {
		this.accounts = this.accounts.map((a) => (a.accountId === accountId ? { ...a, unread: n } : a));
	}

	// --- directories (operate on a specific account bucket) -------------------

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
			this.realtime.requestReconnect("hydrate-conversations-failed");
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
			const mapped = mapCloudMessages(messages, row, this.profile?.avatar);
			threads[row.threadId] = messageFetchFailed ? (b.threads[row.threadId] ?? []) : mapped;
			const last = mapped[mapped.length - 1];
			conversations.push({
				threadId: row.threadId,
				kind: row.kind,
				title: row.title || row.threadId,
				avatar: row.avatar,
				lastAt: row.lastAt
					? Date.parse(row.lastAt) || 0
					: (last?.at ?? b.conversations.find((c) => c.threadId === row.threadId)?.lastAt ?? 0),
				lastSnippet: last
					? messageSnippet(last.body, last.sticker, last.link, last.deleted)
					: (b.conversations.find((c) => c.threadId === row.threadId)?.lastSnippet ?? ""),
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

	/** Load the account's friends/contacts for the Danh bạ tab. Cached per bucket. */
	async loadContacts(accountId?: string) {
		const id = accountId ?? this.activeAccountId;
		if (!id || !this.cloudBaseUrl || !this.cloudDeviceToken) return;
		await this.run(async () => {
			const contacts = (await listCloudContacts(this.cloudBaseUrl!, this.cloudDeviceToken!, id)) as Contact[];
			const b = this.buckets.get(id);
			if (b) {
				b.contacts = contacts;
				b.contactsLoaded = true;
			}
			if (id === this.activeAccountId) {
				this.contacts = contacts;
				this.contactsLoaded = true;
			}
		});
	}

	// --- thread + message ops (active account) --------------------------------

	startChatWith(contact: Contact) {
		this.openThread(contact.userId, contact.displayName);
	}

	selectThread(threadId: string) {
		this.activeThreadId = threadId;
		const convo = this.conversations.find((c) => c.threadId === threadId);
		if (convo && convo.unread > 0) {
			this.conversations = this.conversations.map((c) => (c.threadId === threadId ? { ...c, unread: 0 } : c));
			if (this.profile) log.info(`thread-read: ${this.profile.accountId}/${threadId}`);
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
			if (!this.cloudBaseUrl || !this.cloudDeviceToken) throw new Error("cloud device session not connected");
			const msgId = String(
				(await sendCloudText(this.cloudBaseUrl, this.cloudDeviceToken, this.profile!.accountId, threadId, text, kind)).msgId ?? "",
			);
			this.appendToActive(
				{
					id: msgId || `cloud-${Date.now()}`,
					threadId,
					body: text,
					sticker: null,
					file: null,
					link: null,
					quote: quote
						? { ownerId: quote.uidFrom, fromD: "", globalMsgId: 0, cliMsgId: 0, msg: quote.content, cliMsgType: 1, ts: quote.ts }
						: null,
					reactionIcon: null,
					deleted: false,
					outgoing: true,
					authorName: this.profile?.displayName ?? "Tôi",
					authorAvatar: this.profile?.avatar,
					at: Date.now(),
				},
				snippet(text),
			);
			ok = true;
		});
		return ok;
	}

	// The sticker catalog (search/recent/categories) has no cloud endpoint yet,
	// so the picker shows no packs — same gap as the desktop. Sending works.
	async searchStickers(): Promise<Sticker[]> {
		return [];
	}
	async recentStickers(): Promise<Sticker[]> {
		return [];
	}
	async stickerCategories(): Promise<number[]> {
		return [];
	}
	async stickerCategory(): Promise<Sticker[]> {
		return [];
	}

	async sendSticker(sticker: Sticker): Promise<boolean> {
		const threadId = this.activeThreadId;
		if (!threadId || !this.profile) return false;
		const convo = this.conversations.find((c) => c.threadId === threadId);
		const kind = convo?.kind ?? "user";

		let ok = false;
		await this.run(async () => {
			if (!this.cloudBaseUrl || !this.cloudDeviceToken) throw new Error("cloud device session not connected");
			const msgId = String(
				(
					await sendCloudSticker(
						this.cloudBaseUrl,
						this.cloudDeviceToken,
						this.profile!.accountId,
						threadId,
						sticker.id,
						sticker.catId,
						sticker.stickerType,
						kind,
					)
				).msgId ?? "",
			);
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
					authorName: this.profile?.displayName ?? "Tôi",
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
		const cliMsgId = `${message.id}_cli`;
		let ok = false;
		await this.run(async () => {
			if (!this.cloudBaseUrl || !this.cloudDeviceToken) throw new Error("cloud device session not connected");
			await sendCloudReaction(
				this.cloudBaseUrl,
				this.cloudDeviceToken,
				this.profile!.accountId,
				message.threadId,
				message.id,
				cliMsgId,
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
			const contentSha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
			const sent = await sendCloudFile(this.cloudBaseUrl!, this.cloudDeviceToken!, this.profile!.accountId, threadId, meta.id, convo.kind);
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
					authorName: this.profile?.displayName ?? "Tôi",
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

	/** Fetch a file's decrypted bytes. Phase 8 wires the iOS share/save sheet. */
	async downloadCloudFileBytes(message: ChatMessage): Promise<Uint8Array | null> {
		const fileId = message.file?.id;
		if (!fileId || !this.cloudBaseUrl || !this.cloudDeviceToken) return null;
		let bytes: Uint8Array | null = null;
		await this.run(async () => {
			const raw = await downloadCloudFileBlob(this.cloudBaseUrl!, this.cloudDeviceToken!, fileId);
			bytes = new Uint8Array(raw);
		});
		return bytes;
	}

	dispose() {
		this.realtime.stop();
	}

	// --- internals ------------------------------------------------------------

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
		b.conversations = b.conversations.map((c) => (c.threadId === reaction.threadId ? { ...c } : c));
	}

	private appendToBucket(
		b: AccountData,
		message: ChatMessage,
		lastSnippet: string,
		meta: { kind: "user" | "group"; title: string; bumpUnread: boolean },
	) {
		const existing = b.threads[message.threadId] ?? [];
		if (existing.some((m) => m.id === message.id)) return;

		// Echo reconciliation: Zalo re-delivers our own send with a DIFFERENT
		// msg_id, so adopt the authoritative id on a content match within 15s
		// instead of appending a duplicate.
		if (message.outgoing) {
			const ECHO_WINDOW_MS = 15000;
			const sameContent = (m: ChatMessage) =>
				message.sticker ? m.sticker?.id === message.sticker.id : !m.sticker && m.body === message.body;
			const dupIdx = existing.findIndex(
				(m) => m.outgoing && sameContent(m) && Math.abs(m.at - message.at) <= ECHO_WINDOW_MS,
			);
			if (dupIdx >= 0) {
				const merged = [...existing];
				merged[dupIdx] = { ...merged[dupIdx], id: message.id };
				b.threads = { ...b.threads, [message.threadId]: merged };
				return;
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

	private appendToActive(message: ChatMessage, lastSnippet: string) {
		const b = this.activeBucket();
		if (!b) return;
		this.appendToBucket(b, message, lastSnippet, {
			kind: this.conversations.find((c) => c.threadId === message.threadId)?.kind ?? "user",
			title: this.conversations.find((c) => c.threadId === message.threadId)?.title ?? message.threadId,
			bumpUnread: false,
		});
		this.threads = b.threads;
		this.conversations = b.conversations;
	}

	/** Start (or reuse) a conversation for a thread id. */
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
