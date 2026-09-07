/**
 * Classifies a rejected `loadPairing()`/Keychain call into one of three
 * user-facing buckets. react-native-keychain surfaces Android's
 * BiometricPrompt error codes essentially verbatim in its rejection message
 * (e.g. `"code: 10, msg: El usuario canceló la operación de huella
 * digital."`) — that raw string must never reach the UI. Dismissing/
 * canceling the fingerprint prompt is a completely normal user action, not
 * an error, and every other technical detail (native error codes,
 * exception messages) is exactly that: technical, fit for a dev-console
 * log, never for on-screen display.
 *
 * Android BiometricPrompt error codes referenced below (androidx.biometric
 * .BiometricPrompt.ERROR_*): 5=CANCELED (system-initiated, e.g. another
 * prompt/app interrupted it), 7=LOCKOUT, 9=LOCKOUT_PERMANENT,
 * 10=USER_CANCELED (explicit dismiss), 13=NEGATIVE_BUTTON (tapped
 * "Cancelar" in the system dialog). All of 5/10/13 are the user (or the
 * system on the user's behalf) declining the prompt, not a failed
 * verification attempt — none of these are real problems worth surfacing
 * as an error.
 */
export type AuthFailureReason = 'user_cancel' | 'auth_failed' | 'technical_error';

const USER_CANCEL_CODES = new Set([5, 10, 13]);
const AUTH_FAILED_CODES = new Set([7, 9, 11]); // lockout (temporary/permanent) and no biometrics enrolled

const AUTH_FAILED_MESSAGE = 'No pudimos verificar tu identidad. Intentá nuevamente.';
const TECHNICAL_ERROR_MESSAGE = 'Ocurrió un problema al verificar tu identidad. Intentá nuevamente.';

export interface ClassifiedAuthError {
  reason: AuthFailureReason;
  /** Always a short, human, Spanish sentence — safe to render directly. Empty for user_cancel, which shows no message at all. */
  message: string;
}

export function classifyAuthError(err: unknown): ClassifiedAuthError {
  const raw = err instanceof Error ? err.message : String(err);
  const codeMatch = raw.match(/code:\s*(\d+)/i);
  const code = codeMatch ? Number(codeMatch[1]) : null;

  if (code !== null && USER_CANCEL_CODES.has(code)) {
    return { reason: 'user_cancel', message: '' };
  }
  if (code !== null && AUTH_FAILED_CODES.has(code)) {
    return { reason: 'auth_failed', message: AUTH_FAILED_MESSAGE };
  }
  // Fallback text match for shapes with no numeric code (iOS, or a keychain
  // version that phrases it differently) — still never falls through to
  // showing `raw` itself.
  const lower = raw.toLowerCase();
  if (lower.includes('cancel') || lower.includes('dismiss')) {
    return { reason: 'user_cancel', message: '' };
  }
  return { reason: 'technical_error', message: TECHNICAL_ERROR_MESSAGE };
}
