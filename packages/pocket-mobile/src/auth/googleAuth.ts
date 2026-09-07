import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';

/**
 * Pocket's OWN, independent Google Sign-In — a completely separate account
 * connection from whatever Drive account Desktop's rclone uses. Desktop's
 * OAuth token is never handed to the phone (see docs/pocket.md): each side
 * authenticates to Google on its own.
 *
 * Scope: `drive.readonly` — read access to the user's whole Drive, not just
 * files this app created. This is a deliberate, documented trade-off (see
 * docs/pocket.md's "Google Drive — Mobile" section): the narrower
 * `drive.file` scope would only cover files created BY this app's own OAuth
 * client, and Desktop's rclone-published file was created by a DIFFERENT
 * client, so `drive.file` cannot see it without a Google Picker consent
 * step. `drive.readonly` is genuinely the minimal scope that lets Pocket
 * locate and read that one file with no extra UI dance, at the cost of a
 * broader (but read-only) grant.
 *
 * No `offlineAccess` (no server-side refresh token) is requested — there is
 * no backend to hold one. `getGoogleAccessToken()` relies on the native SDK
 * itself to silently refresh the access token from the OS-level Google
 * session, which is exactly the "no servidor propio" model this app needs.
 */
const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

export function configureGoogleSignIn(webClientId: string): void {
  GoogleSignin.configure({
    webClientId,
    scopes: [DRIVE_READONLY_SCOPE],
    offlineAccess: false,
  });
}

export async function isSignedInToGoogle(): Promise<boolean> {
  return GoogleSignin.hasPreviousSignIn();
}

export async function signInToGoogle(): Promise<void> {
  await GoogleSignin.hasPlayServices();
  await GoogleSignin.signIn();
}

export async function getGoogleAccessToken(): Promise<string> {
  const tokens = await GoogleSignin.getTokens();
  return tokens.accessToken;
}

export async function signOutOfGoogle(): Promise<void> {
  await GoogleSignin.signOut();
}

export function isUserCancelledSignIn(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === statusCodes.SIGN_IN_CANCELLED;
}
