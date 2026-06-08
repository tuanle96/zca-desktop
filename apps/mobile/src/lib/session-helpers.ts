// Small pure helpers for the session store (no state, no IPC).

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A cloud auth failure (stale/revoked device token). Reconnecting won't help —
 * the device must be re-linked — so callers stop retrying and drop to the gate
 * instead of looping on 401/403. */
export function isCloudAuthError(value: unknown): boolean {
	const text = typeof value === "string" ? value : String(value);
	return /status=?\s*40[13]\b/.test(text) || /\bunauthorized\b/i.test(text) || /\bforbidden\b/i.test(text);
}

export function isCloudRecoveryKeyRequiredError(value: unknown): boolean {
	return /\brecovery_key_required\b/i.test(typeof value === "string" ? value : String(value));
}

export function isCloudRecoveryKeyInvalidError(value: unknown): boolean {
	return /\brecovery_key_invalid\b/i.test(typeof value === "string" ? value : String(value));
}

/** Best-effort human-friendly device name for unattended (deep-link) linking. */
export function defaultDeviceName(): string {
	if (typeof navigator !== "undefined") {
		const ua = navigator.userAgent || "";
		if (/android/i.test(ua)) return "Điện thoại Android";
		if (/iphone|ipad|ipod/i.test(ua)) return "Điện thoại iPhone";
	}
	return "Điện thoại của tôi";
}
