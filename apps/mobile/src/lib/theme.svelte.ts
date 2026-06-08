// App theme (light / dark / system) persisted to localStorage and applied by
// toggling the `.dark` class on <html> (see app.css `.dark` variables). Ported
// from the desktop. Frontend-only — no IPC, no secrets.

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "zca:theme";

function isBrowser(): boolean {
	return typeof window !== "undefined";
}

function readStored(): ThemeMode {
	if (!isBrowser()) return "system";
	const v = window.localStorage.getItem(STORAGE_KEY);
	return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function prefersDark(): boolean {
	return isBrowser() && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Resolve a mode to the concrete dark/light that should be applied now. */
function resolve(mode: ThemeMode): "light" | "dark" {
	if (mode === "system") return prefersDark() ? "dark" : "light";
	return mode;
}

class ThemeStore {
	mode = $state<ThemeMode>(readStored());
	/** The concrete theme currently applied (follows `mode` + system pref). */
	resolved = $state<"light" | "dark">(resolve(readStored()));

	private mql: MediaQueryList | null = null;
	private onSystemChange = () => {
		if (this.mode === "system") this.apply();
	};

	/** Apply the current mode to the document + start tracking system changes. */
	init() {
		if (!isBrowser()) return;
		this.apply();
		this.mql = window.matchMedia("(prefers-color-scheme: dark)");
		this.mql.addEventListener("change", this.onSystemChange);
	}

	dispose() {
		this.mql?.removeEventListener("change", this.onSystemChange);
		this.mql = null;
	}

	set(mode: ThemeMode) {
		this.mode = mode;
		if (isBrowser()) window.localStorage.setItem(STORAGE_KEY, mode);
		this.apply();
	}

	private apply() {
		const next = resolve(this.mode);
		this.resolved = next;
		if (isBrowser()) {
			document.documentElement.classList.toggle("dark", next === "dark");
		}
	}
}

export const theme = new ThemeStore();
