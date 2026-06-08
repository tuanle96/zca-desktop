// Mobile navigation store (Svelte 5 runes). The desktop shows list + chat
// side-by-side; mobile shows ONE screen at a time, so navigation is a bottom
// tab index plus a push/pop stack for drill-in screens (a thread, a settings
// detail). Pure client state — no SvelteKit nested routes (SPA, ssr=false).

export type TabId = "chats" | "contacts" | "settings";

/** A pushed screen. `name` selects the component in app-shell's registry;
 * `props` is passed through to it (e.g. a thread's id/title). */
export type ScreenRef = { name: string; props?: Record<string, unknown> };

class NavStore {
	/** Active bottom tab. Switching tabs clears the drill-in stack. */
	tab = $state<TabId>("chats");
	/** Drill-in stack on top of the active tab. Empty = a tab root is shown. */
	stack = $state<ScreenRef[]>([]);
	/** Unread badge shown on the "Tin nhắn" tab (set by the session store). */
	unread = $state(0);

	/** The screen currently covering the tab content, if any. */
	get top(): ScreenRef | null {
		return this.stack.length ? this.stack[this.stack.length - 1] : null;
	}

	/** Switch tabs (resets any drill-in stack — each tab starts at its root). */
	setTab(tab: TabId) {
		if (tab === this.tab && this.stack.length === 0) return;
		this.stack = [];
		this.tab = tab;
	}

	/** Push a drill-in screen over the current tab. */
	push(name: string, props?: Record<string, unknown>) {
		this.stack = [...this.stack, { name, props }];
	}

	/** Pop the top drill-in screen (back). No-op at a tab root. */
	pop() {
		if (this.stack.length) this.stack = this.stack.slice(0, -1);
	}

	/** Jump to a tab root, clearing the stack. */
	resetTo(tab: TabId) {
		this.tab = tab;
		this.stack = [];
	}
}

export const nav = new NavStore();
