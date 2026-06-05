// Native OS notifications for incoming messages (ADR-0010). Frontend-only:
// builds a notification from the same non-secret display data already shown in
// the conversation list (sender/title + snippet). No credential, token, thread
// id, or account id is ever placed in a notification payload.
//
// Trigger policy (anti-noise + privacy): a notification fires only when the user
// has notifications enabled AND the app window is not focused (or the message is
// for a thread other than the active one). Own echoes / sends never notify.
//
// macOS caveat (mirrors ADR-0009 deep links): the OS shows notifications under
// the installed `.app` identity; under `tauri dev` they appear under the dev
// binary. The OS-level permission must also be granted by the user.

import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { log } from "./log";

const ENABLED_STORAGE_KEY = "zca:notifications:enabled";

function isBrowser(): boolean {
    return typeof window !== "undefined";
}

function readEnabled(): boolean {
    if (!isBrowser()) return true;
    // Default ON: only an explicit "0" disables it.
    return window.localStorage.getItem(ENABLED_STORAGE_KEY) !== "0";
}

/** A single message to surface, built from display data the UI already holds. */
export type NotifyInput = {
    /** Conversation/sender display name shown as the notification title. */
    title: string;
    /** Non-secret snippet (same string as the conversation-list preview). */
    body: string;
    /** Thread the message belongs to, so an active-thread message can be skipped. */
    threadId: string;
};

class NotificationStore {
    /** User toggle (persisted, default on). Controls whether we notify at all. */
    enabled = $state<boolean>(readEnabled());
    /** True once the OS-level permission has been granted. */
    permissionGranted = $state<boolean>(false);
    /** Whether the app window currently has focus (suppresses notifications). */
    private focused = true;
    /** The active thread id, set by the session so we can skip its messages. */
    private activeThreadId: string | null = null;

    private unlistenFocus: (() => void) | null = null;
    private initialized = false;

    /** Start tracking window focus. Called once from the root layout. */
    async init() {
        if (!isBrowser() || this.initialized) return;
        this.initialized = true;
        try {
            const appWindow = getCurrentWindow();
            this.focused = await appWindow.isFocused().catch(() => true);
            this.unlistenFocus = await appWindow.onFocusChanged(({ payload: focused }) => {
                this.focused = focused;
            });
        } catch (e) {
            // Focus tracking is best-effort; without it we simply never suppress
            // on focus (we still suppress active-thread + own messages).
            log.error(`notifications: focus tracking unavailable: ${String(e)}`);
        }
        // Reflect the current OS permission state without prompting.
        try {
            this.permissionGranted = await isPermissionGranted();
        } catch {
            this.permissionGranted = false;
        }
    }

    dispose() {
        this.unlistenFocus?.();
        this.unlistenFocus = null;
        this.initialized = false;
    }

    /** Toggle notifications on/off (persisted). Requests OS permission when
     * turning on so the first real notification isn't silently dropped. */
    async setEnabled(value: boolean) {
        this.enabled = value;
        if (isBrowser()) {
            window.localStorage.setItem(ENABLED_STORAGE_KEY, value ? "1" : "0");
        }
        if (value) await this.ensurePermission();
    }

    /** Tell the store which thread is open, so its incoming messages don't
     * pop a redundant notification while the user is already reading it. */
    setActiveThread(threadId: string | null) {
        this.activeThreadId = threadId;
    }

    /** Request OS notification permission if not already granted. Returns the
     * resulting grant state. Safe to call repeatedly. */
    async ensurePermission(): Promise<boolean> {
        try {
            if (await isPermissionGranted()) {
                this.permissionGranted = true;
                return true;
            }
            const result = await requestPermission();
            this.permissionGranted = result === "granted";
            if (!this.permissionGranted) {
                log.info("notifications: OS permission not granted");
            }
            return this.permissionGranted;
        } catch (e) {
            log.error(`notifications: permission request failed: ${String(e)}`);
            this.permissionGranted = false;
            return false;
        }
    }

    /** True when a message for `threadId` should surface as a notification:
     * notifications enabled, and either the window is unfocused or the message
     * is for a non-active thread. Window-state suppression keeps it quiet while
     * the user is actively in the app on that conversation. */
    shouldNotify(threadId: string): boolean {
        if (!this.enabled) return false;
        if (this.focused && threadId === this.activeThreadId) return false;
        return true;
    }

    /** Surface one incoming message as a native notification, honoring the
     * trigger policy. No-op (silent) when policy or permission blocks it.
     * Never throws — notifications must never break the message pipeline. */
    async notify(input: NotifyInput): Promise<void> {
        if (!this.shouldNotify(input.threadId)) return;
        try {
            const granted = this.permissionGranted || (await this.ensurePermission());
            if (!granted) return;
            sendNotification({ title: input.title, body: input.body });
        } catch (e) {
            log.error(`notifications: send failed: ${String(e)}`);
        }
    }
}

export const notifications = new NotificationStore();
