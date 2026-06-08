// Cloud realtime controller: owns the SSE `listen` subscription and the
// exponential-backoff reconnect loop, decoupled from the store via callbacks.
// Ported from the desktop session store's realtime methods (cloud-only).
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { CLOUD_EVENT, startCloudRealtime } from "@zca/core-client";
import { log } from "./log";

export type RealtimeState = "offline" | "connecting" | "live" | "reconnecting";

type CloudRealtimeEvent = {
	type?: string;
	accountId?: string;
	message?: string;
	reason?: string;
	status?: number;
};

export interface RealtimeHooks {
	/** Current cloud credentials (null when disconnected). */
	creds: () => { baseUrl: string | null; token: string | null };
	/** A realtime message arrived for an account (or undefined = all). */
	onMessage: (accountId?: string) => void;
	/** The stream is live; `refresh` asks the store to re-hydrate all accounts. */
	onConnected: (refresh: boolean) => void;
	/** The device token was rejected (401/403) — drop to the gate. */
	onAuthFailure: () => void;
}

export class CloudRealtime {
	state = $state<RealtimeState>("offline");
	detail = $state("");
	listening = $state(false);
	private attempt = 0;
	private unlisten: UnlistenFn | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private starting = false;

	constructor(private hooks: RealtimeHooks) {}

	get label(): string {
		switch (this.state) {
			case "live":
				return "Realtime đang bật";
			case "connecting":
				return "Đang kết nối realtime";
			case "reconnecting":
				return this.attempt > 0 ? `Đang kết nối lại lần ${this.attempt}` : "Đang kết nối lại realtime";
			default:
				return "Realtime ngoại tuyến";
		}
	}

	/** Subscribe to the event stream (once) and open the SSE connection. */
	async ensure() {
		if (!this.unlisten) {
			this.unlisten = await listen<CloudRealtimeEvent>(CLOUD_EVENT, (event) => this.handle(event.payload));
		}
		await this.start("connect");
	}

	private handle(payload: CloudRealtimeEvent) {
		if (payload.type === "connected") {
			this.markConnected();
			return;
		}
		if (payload.type === "error") {
			if (payload.status === 401 || payload.status === 403) {
				log.info(`cloud realtime: device token rejected (status ${payload.status}); dropping to gate`);
				this.hooks.onAuthFailure();
				return;
			}
			log.error(`cloud realtime failed: ${payload.message ?? `status ${payload.status ?? "unknown"}`}`);
			this.scheduleReconnect("realtime-error");
			return;
		}
		if (payload.type === "disconnected") {
			if (payload.status === 401 || payload.status === 403) {
				this.hooks.onAuthFailure();
				return;
			}
			log.info(`cloud realtime disconnected: ${payload.reason ?? "unknown"}`);
			this.scheduleReconnect(payload.reason ?? "realtime-disconnected");
			return;
		}
		if (payload.type !== "message") return;
		if (this.state !== "live") this.markConnected(false);
		this.hooks.onMessage(payload.accountId);
	}

	/** Ask for a reconnect from outside (e.g. a hydrate fetch failed). */
	requestReconnect(reason: string) {
		this.scheduleReconnect(reason);
	}

	stop() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.unlisten?.();
		this.unlisten = null;
		this.attempt = 0;
		this.starting = false;
		this.state = "offline";
		this.detail = "";
		this.listening = false;
	}

	private async start(reason: string) {
		const { baseUrl, token } = this.hooks.creds();
		if (!baseUrl || !token) return;
		if (this.starting) return;
		if (this.state === "live" && reason !== "retry") return;

		this.starting = true;
		this.state = this.attempt > 0 ? "reconnecting" : "connecting";
		this.detail = reason;
		this.listening = false;
		try {
			await startCloudRealtime(baseUrl, token);
			log.info(`cloud realtime start requested: ${reason}`);
		} catch (e) {
			log.error(`cloud realtime start failed: ${String(e)}`);
			this.scheduleReconnect("start-failed");
		} finally {
			this.starting = false;
		}
	}

	private markConnected(refresh = true) {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.attempt = 0;
		this.state = "live";
		this.detail = "";
		this.listening = true;
		log.info("cloud realtime connected");
		this.hooks.onConnected(refresh);
	}

	private scheduleReconnect(reason: string) {
		const { baseUrl, token } = this.hooks.creds();
		if (!baseUrl || !token) return;
		if (this.timer) return;
		this.listening = false;
		this.state = "reconnecting";
		this.detail = reason;
		this.attempt = Math.min(this.attempt + 1, 6);
		const delayMs = Math.min(30_000, 1_000 * 2 ** (this.attempt - 1));
		log.info(`cloud realtime reconnect scheduled: reason=${reason} attempt=${this.attempt} delayMs=${delayMs}`);
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.start("retry");
		}, delayMs);
	}
}
