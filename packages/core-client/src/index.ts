// Shared cloud client. Thin `invoke()` wrappers over the Tauri core's `cloud_*`
// commands — the actual HTTP/SSE to the cloud server runs in the Rust core
// (command/cloud.rs on desktop; the mobile core reuses the same contract). No
// secrets cross this layer: the device token lives in the core's OS keychain and
// is referenced by the `__keychain__` sentinel, never passed through the webview.
//
// The wire response types are NOT redeclared here — they come from the generated
// single-source contract (`@zca/types`, generated from the Rust `zca-types`
// crate). These `Cloud*` names are kept as thin aliases so existing imports don't
// change.
import { invoke } from "@tauri-apps/api/core";
import type {
    MagicLinkResponse,
    MagicLinkVerifyResponse,
    DeviceView,
    AccountView,
    ContactView,
} from "@zca/types";

export const CLOUD_EVENT = "zca-cloud://event";
export const CLOUD_DEVICE_TOKEN_KEYCHAIN = "__keychain__";

export type CloudMagicLinkResponse = MagicLinkResponse;
export type CloudVerifyResponse = MagicLinkVerifyResponse;
export type CloudDevice = DeviceView;
export type CloudAccount = AccountView;
export type CloudContact = ContactView;

/// Desktop/mobile-only view of the locally-stored device session (not a wire type).
export type CloudDeviceSession = {
    baseUrl: string;
    hasDeviceToken: boolean;
};

export function loadCloudDeviceSession(baseUrl: string) {
    return invoke<CloudDeviceSession | null>("cloud_load_device_session", { baseUrl });
}

export function clearCloudDeviceSession(baseUrl: string) {
    return invoke<void>("cloud_clear_device_session", { baseUrl });
}

export function requestCloudMagicLink(baseUrl: string, email: string) {
    return invoke<CloudMagicLinkResponse>("cloud_request_magic_link", { baseUrl, email });
}

export function verifyCloudMagicLink(
    baseUrl: string,
    email: string,
    token: string,
    deviceName: string,
    recoveryKey?: string,
) {
    return invoke<CloudVerifyResponse>("cloud_verify_magic_link", {
        baseUrl,
        email,
        token,
        deviceName,
        recoveryKey,
    });
}

export function registerCloudDevice(baseUrl: string, deviceToken: string, name: string, recoveryKey: string) {
    return invoke<{ deviceId: string; deviceToken: string }>("cloud_register_device", {
        baseUrl,
        deviceToken,
        name,
        recoveryKey,
    });
}

export function listCloudDevices(baseUrl: string, deviceToken: string) {
    return invoke<CloudDevice[]>("cloud_list_devices", { baseUrl, deviceToken });
}

export function startCloudRealtime(baseUrl: string, deviceToken: string) {
    return invoke<void>("cloud_start_realtime", { baseUrl, deviceToken });
}

export function revokeCloudDevice(baseUrl: string, deviceToken: string, deviceId: string) {
    return invoke<Record<string, unknown>>("cloud_revoke_device", { baseUrl, deviceToken, deviceId });
}

export function listCloudAccounts(baseUrl: string, deviceToken: string) {
    return invoke<CloudAccount[]>("cloud_list_accounts", { baseUrl, deviceToken });
}

export function startCloudAccountQr(baseUrl: string, deviceToken: string) {
    return invoke<Record<string, unknown>>("cloud_start_account_qr", { baseUrl, deviceToken });
}

export function getCloudQrStatus(baseUrl: string, deviceToken: string, flowId: string) {
    return invoke<Record<string, unknown>>("cloud_get_qr_status", { baseUrl, deviceToken, flowId });
}

export function deleteCloudAccount(baseUrl: string, deviceToken: string, accountId: string) {
    return invoke<Record<string, unknown>>("cloud_delete_account", { baseUrl, deviceToken, accountId });
}

export function listCloudConversations(baseUrl: string, deviceToken: string, accountId?: string) {
    return invoke<Record<string, unknown>[]>("cloud_list_conversations", { baseUrl, deviceToken, accountId });
}

export function listCloudContacts(baseUrl: string, deviceToken: string, accountId: string) {
    return invoke<CloudContact[]>("cloud_list_contacts", { baseUrl, deviceToken, accountId });
}

export function listCloudMessages(baseUrl: string, deviceToken: string, conversationId: string, limit = 100) {
    return invoke<Record<string, unknown>[]>("cloud_list_messages", {
        baseUrl,
        deviceToken,
        conversationId,
        limit,
    });
}

export function sendCloudText(
    baseUrl: string,
    deviceToken: string,
    accountId: string,
    threadId: string,
    text: string,
    threadKind: "user" | "group" = "user",
) {
    return invoke<Record<string, unknown>>("cloud_send_text", {
        baseUrl,
        deviceToken,
        accountId,
        threadId,
        text,
        threadKind,
    });
}

export function sendCloudSticker(
    baseUrl: string,
    deviceToken: string,
    accountId: string,
    threadId: string,
    stickerId: number,
    catId: number,
    stickerType: number,
    threadKind: "user" | "group" = "user",
) {
    return invoke<Record<string, unknown>>("cloud_send_sticker", {
        baseUrl,
        deviceToken,
        accountId,
        payload: { threadId, stickerId, catId, stickerType, threadKind },
    });
}

export function sendCloudReaction(
    baseUrl: string,
    deviceToken: string,
    accountId: string,
    threadId: string,
    msgId: string,
    cliMsgId: string,
    icon: string,
    threadKind: "user" | "group" = "user",
) {
    return invoke<Record<string, unknown>>("cloud_send_reaction", {
        baseUrl,
        deviceToken,
        accountId,
        payload: { threadId, msgId, cliMsgId, icon, threadKind },
    });
}

export function sendCloudFile(
    baseUrl: string,
    deviceToken: string,
    accountId: string,
    threadId: string,
    fileId: string,
    threadKind: "user" | "group" = "user",
) {
    return invoke<Record<string, unknown>>("cloud_send_file", {
        baseUrl,
        deviceToken,
        accountId,
        payload: { threadId, fileId, threadKind },
    });
}

export function initCloudFile(baseUrl: string, deviceToken: string, payload: Record<string, unknown>) {
    return invoke<{
        id: string;
        objectKey: string;
        filename: string | null;
        mime: string | null;
        sizeBytes: number;
        contentSha256: string;
        createdAt: string;
    }>("cloud_init_file", { baseUrl, deviceToken, payload });
}

export function uploadCloudFileBlob(baseUrl: string, deviceToken: string, fileId: string, bytes: number[]) {
    return invoke<Record<string, unknown>>("cloud_upload_file_blob", { baseUrl, deviceToken, fileId, bytes });
}

export function downloadCloudFileBlob(baseUrl: string, deviceToken: string, fileId: string) {
    return invoke<number[]>("cloud_download_file_blob", { baseUrl, deviceToken, fileId });
}
