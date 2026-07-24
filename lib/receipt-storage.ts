import * as FileSystem from "expo-file-system/legacy";

/**
 * Receipt images captured by the camera or picked from the gallery arrive as
 * cache URIs that Android may purge at any time. Confirmed transactions copy
 * their image into this app-owned permanent directory so the attachment
 * survives cache cleanup. Gallery originals are never modified or deleted.
 */
const RECEIPTS_SUBDIRECTORY = "receipts/";

function receiptsDirectoryUri(): string {
  const base = FileSystem.documentDirectory;
  if (!base) throw new Error("App document storage is unavailable.");
  return `${base}${RECEIPTS_SUBDIRECTORY}`;
}

export function isManagedReceiptImageUri(uri: string | null | undefined): boolean {
  if (!uri || !FileSystem.documentDirectory) return false;
  return uri.startsWith(receiptsDirectoryUri());
}

export async function persistReceiptImage(sourceUri: string, imageId: string): Promise<string> {
  const directory = receiptsDirectoryUri();
  const info = await FileSystem.getInfoAsync(directory);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  }
  const extensionMatch = /\.(jpe?g|png|webp|heic)$/i.exec(sourceUri.split("?")[0] ?? "");
  const extension = extensionMatch ? extensionMatch[0].toLocaleLowerCase() : ".jpg";
  const destination = `${directory}${imageId}${extension}`;
  await FileSystem.copyAsync({ from: sourceUri, to: destination });
  return destination;
}

/** Deletes only app-owned receipt copies; any other URI is left untouched. */
export async function deleteReceiptImage(uri: string | null | undefined): Promise<void> {
  if (!uri || !isManagedReceiptImageUri(uri)) return;
  await FileSystem.deleteAsync(uri, { idempotent: true });
}
