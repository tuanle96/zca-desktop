// Frontend logger: mirrors webview diagnostics into the core's unified tracing
// sink (rolling log files) via the `log_from_ui` Tauri command, and also echoes
// to the devtools console. Never log secrets here — the core redacts raw API
// captures, but UI log lines are recorded as-is.

import { invoke } from "@tauri-apps/api/core";

type Level = "error" | "warn" | "info" | "debug";

async function forward(level: Level, message: string) {
    try {
        await invoke("log_from_ui", { level, message });
    } catch {
        // Logging must never break the UI; ignore transport errors.
    }
}

function emit(level: Level, message: string, ...rest: unknown[]) {
    const line = rest.length ? `${message} ${rest.map(String).join(" ")}` : message;
    // Echo to the console for live dev, and forward to the core sink.
    const c = console[level === "debug" ? "log" : level] ?? console.log;
    c(`[ui] ${line}`);
    void forward(level, line);
}

export const log = {
    error: (message: string, ...rest: unknown[]) => emit("error", message, ...rest),
    warn: (message: string, ...rest: unknown[]) => emit("warn", message, ...rest),
    info: (message: string, ...rest: unknown[]) => emit("info", message, ...rest),
    debug: (message: string, ...rest: unknown[]) => emit("debug", message, ...rest),
};
