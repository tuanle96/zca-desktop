// Map raw cloud verify/link errors to friendly Vietnamese messages. Ported
// verbatim from the desktop QrLoginScreen's formatCloudVerifyError.
export function formatCloudVerifyError(value: unknown): string {
	const text = typeof value === "string" ? value : String(value);
	if (/\brecovery_key_required\b/i.test(text)) {
		return "Tài khoản cloud này đã tồn tại. Nhập recovery key trong Tùy chọn nâng cao rồi bấm Kết nối thiết bị.";
	}
	if (/\brecovery_key_invalid\b/i.test(text)) {
		return "Recovery key không đúng. Hãy kiểm tra lại recovery key hoặc gửi mã đăng nhập mới.";
	}
	if (/status=?\s*401\b/.test(text) || /\bunauthorized\b/i.test(text)) {
		return "Mã đăng nhập đã hết hạn hoặc không hợp lệ. Hãy gửi lại mã.";
	}
	return text;
}
