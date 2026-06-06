// Magic-link handling (ADR-0009). Modern emails open an HTTPS browser landing
// page first; that page delivers the token to the running app through a local
// loopback callback. The old `zca://magic-link?email=&token=` form remains
// accepted for compatibility.
//
// macOS caveat: custom-scheme deep links only fire for the INSTALLED .app
// bundle, not under `tauri dev`. The copy-paste token field remains the dev
// path.

import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { log } from "./log";
import { session } from "./session.svelte";

export type MagicLinkParams = { email: string; token: string };
type LocalMagicLinkPayload = MagicLinkParams & { baseUrl?: string };

const MAGIC_LINK_CALLBACK_EVENT = "zca-cloud://magic-link-callback";

/** Parse a `zca://magic-link?email=&token=` URL. Returns null if it isn't one. */
export function parseMagicLink(url: string): MagicLinkParams | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    // Accept the custom scheme `zca:` with host `magic-link`, and tolerate the
    // HTTPS fallback path `/auth/magic-link` in case the scheme is disabled.
    const isCustom = parsed.protocol === "zca:" && parsed.hostname === "magic-link";
    const isHttp = parsed.pathname.replace(/\/+$/, "").endsWith("/auth/magic-link");
    if (!isCustom && !isHttp) return null;

    const email = parsed.searchParams.get("email")?.trim();
    const token = parsed.searchParams.get("token")?.trim();
    if (!email || !token) return null;
    return { email, token };
}

async function handleUrls(urls: string[]): Promise<void> {
    for (const url of urls) {
        const params = parseMagicLink(url);
        if (!params) continue;
        log.info("deep-link: magic-link received, verifying");
        await session.linkViaMagicToken(params.email, params.token);
        return; // one magic link per open is enough
    }
}

/**
 * Wire up deep-link handling. Processes a link the app may have been launched
 * with, then listens for links delivered while running. Returns an unlisten fn.
 */
export async function initDeepLinks(): Promise<() => void> {
    let unlistenLocal: UnlistenFn | null = null;
    let unlistenDeepLink: (() => void) | null = null;
    try {
        const startUrls = await getCurrent();
        if (startUrls?.length) await handleUrls(startUrls);
    } catch (e) {
        log.error(`deep-link: getCurrent failed: ${String(e)}`);
    }
    try {
        unlistenLocal = await listen<LocalMagicLinkPayload>(MAGIC_LINK_CALLBACK_EVENT, (event) => {
            const { email, token, baseUrl } = event.payload;
            if (!email || !token) return;
            log.info("local-callback: magic-link received, verifying");
            void session.linkViaMagicToken(email, token, baseUrl);
        });
    } catch (e) {
        log.error(`local-callback: subscribe failed: ${String(e)}`);
    }
    try {
        unlistenDeepLink = await onOpenUrl((urls) => void handleUrls(urls));
    } catch (e) {
        log.error(`deep-link: onOpenUrl subscribe failed: ${String(e)}`);
    }
    return () => {
        unlistenLocal?.();
        unlistenDeepLink?.();
    };
}
