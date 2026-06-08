// Deep-link handling for cloud device linking on mobile. The browser OAuth /
// emailed magic link returns into the app via the iOS Universal Link / Android
// App Link `https://link.zca.app/verify?...` (configured in tauri.conf.json).
// Ported from the desktop deeplink.ts, minus the desktop-only loopback callback
// (mobile receives links directly through @tauri-apps/plugin-deep-link).
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { log } from "./log";
import { session } from "./session-store.svelte";

const VERIFY_HOST = "link.zca.app";

type Parsed =
	| { kind: "magic"; email: string; token: string }
	| { kind: "oauth"; code: string; baseUrl?: string };

/** Parse a verify deep link: the Universal Link `https://link.zca.app/verify?…`
 * or the legacy `zca://` custom scheme. `code` ⇒ OAuth, `email`+`token` ⇒ magic. */
export function parseVerifyLink(url: string): Parsed | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const isUniversal = parsed.host === VERIFY_HOST && parsed.pathname.replace(/\/+$/, "").endsWith("/verify");
	const isCustom = parsed.protocol === "zca:";
	if (!isUniversal && !isCustom) return null;

	const code = parsed.searchParams.get("code")?.trim();
	if (code) return { kind: "oauth", code, baseUrl: parsed.searchParams.get("baseUrl")?.trim() || undefined };

	const email = parsed.searchParams.get("email")?.trim();
	const token = parsed.searchParams.get("token")?.trim();
	if (email && token) return { kind: "magic", email, token };
	return null;
}

async function handleUrls(urls: string[]): Promise<void> {
	for (const url of urls) {
		const p = parseVerifyLink(url);
		if (!p) continue;
		if (p.kind === "oauth") {
			log.info("deep-link: oauth code received, verifying");
			await session.linkViaOAuthCode(p.code, p.baseUrl);
			return;
		}
		log.info("deep-link: magic-link received, verifying");
		await session.linkViaMagicToken(p.email, p.token);
		return; // one link per open is enough
	}
}

/** Process the link the app launched with, then listen for links while running. */
export async function initDeepLinks(): Promise<() => void> {
	let unlisten: (() => void) | null = null;
	try {
		const startUrls = await getCurrent();
		if (startUrls?.length) await handleUrls(startUrls);
	} catch (e) {
		log.error(`deep-link: getCurrent failed: ${String(e)}`);
	}
	try {
		unlisten = await onOpenUrl((urls) => void handleUrls(urls));
	} catch (e) {
		log.error(`deep-link: onOpenUrl subscribe failed: ${String(e)}`);
	}
	return () => unlisten?.();
}
