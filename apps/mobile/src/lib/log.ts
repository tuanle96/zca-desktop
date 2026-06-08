// Minimal mobile logger. Unlike the desktop, the mobile core exposes no
// `log_from_ui` IPC, so UI logs go to the JS console only. Keep every line
// non-secret: never log the device token, recovery key, or any credential.
type Level = "info" | "error";

function emit(level: Level, message: string) {
	const line = `[zca:${level}] ${message}`;
	if (level === "error") console.error(line);
	else console.log(line);
}

export const log = {
	info: (message: string) => emit("info", message),
	error: (message: string) => emit("error", message),
};
