/**
 * Minimal Google Drive REST v3 client — deliberately just two calls, no SDK.
 * Mobile never uses rclone (wrong platform, no real mobile bindings); it
 * authenticates independently of Desktop (its own Google Sign-In, its own
 * `drive.readonly` scope) and only ever touches ONE file.
 */
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

export class DriveApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'DriveApiError';
  }
}

async function driveFetch(accessToken: string, path: string): Promise<Response> {
  const res = await fetch(`${DRIVE_API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new DriveApiError(res.status, body || `Drive API request failed (${res.status})`);
  }
  return res;
}

export interface DriveFileRef {
  id: string;
  name: string;
}

/** `files.list` scoped to an exact name — the fallback discovery path when no fileId hint is available/valid. */
export async function findPocketFileByName(accessToken: string, fileName: string): Promise<DriveFileRef | null> {
  const escaped = fileName.replace(/'/g, "\\'");
  const q = encodeURIComponent(`name = '${escaped}' and trashed = false`);
  const res = await driveFetch(accessToken, `/files?q=${q}&fields=files(id,name)&spaces=drive&pageSize=1`);
  const body = (await res.json()) as { files?: DriveFileRef[] };
  return body.files?.[0] ?? null;
}

/** `files.get?alt=media` — downloads the raw file bytes. */
export async function downloadDriveFile(accessToken: string, fileId: string): Promise<Uint8Array> {
  const res = await driveFetch(accessToken, `/files/${encodeURIComponent(fileId)}?alt=media`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Resolves the Drive file id to download: prefer the id embedded in the
 * pairing QR (a single direct `files.get` — the narrower, faster path), but
 * fall back to searching by name if that id no longer resolves (Desktop
 * republished into a differently-provisioned file, or the hint was absent
 * because this device was paired before Desktop's first-ever publish).
 */
export async function resolvePocketFileId(
  accessToken: string,
  hint: { fileId: string | null; fileName: string }
): Promise<string> {
  if (hint.fileId) {
    try {
      await driveFetch(accessToken, `/files/${encodeURIComponent(hint.fileId)}?fields=id`);
      return hint.fileId;
    } catch {
      // fall through to search by name
    }
  }
  const found = await findPocketFileByName(accessToken, hint.fileName);
  if (!found) {
    throw new Error('No se encontró el archivo de Arkode Pocket en Google Drive. Verificá que Arkode Desktop ya haya publicado al menos una vez.');
  }
  return found.id;
}
