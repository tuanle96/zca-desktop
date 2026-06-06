import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type AppUpdate = Update;

export type UpdateProgress = {
  downloadedBytes: number;
  contentLength?: number;
};

export async function checkForAppUpdate(): Promise<AppUpdate | null> {
  return check({ timeout: 15_000 });
}

export function updateNotes(update: AppUpdate): string {
  return update.body?.trim() || "Không có release note.";
}

export async function downloadInstallAndRelaunch(
  update: AppUpdate,
  onProgress?: (progress: UpdateProgress) => void,
): Promise<void> {
  let downloadedBytes = 0;
  let contentLength: number | undefined;

  await update.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === "Started") {
      downloadedBytes = 0;
      contentLength = event.data.contentLength;
    } else if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
    }
    onProgress?.({ downloadedBytes, contentLength });
  });

  await relaunch();
}
