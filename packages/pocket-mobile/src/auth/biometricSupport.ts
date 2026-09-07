import * as LocalAuthentication from 'expo-local-authentication';

/**
 * An informational capability check ONLY — NOT the real security gate. The
 * actual gate is `react-native-keychain`'s own OS-enforced access control on
 * the stored Pocket DEK (see storage/secureKeyStore.ts): reading it is what
 * natively triggers the biometric/passcode prompt, cryptographically tied
 * to the key material itself. A separate `LocalAuthentication.authenticateAsync()`
 * boolean check is deliberately NOT used as a gate on its own — it would be
 * a weaker, JS-level check with no binding to the actual secret, giving a
 * false sense of a second layer where there isn't a meaningful one. This
 * function exists only to decide, before pairing, whether to tell the user
 * "no tenés biometría configurada, se te va a pedir el PIN del equipo".
 */
export async function isBiometricSupported(): Promise<boolean> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    return hasHardware && isEnrolled;
  } catch {
    return false;
  }
}
