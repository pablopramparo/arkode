import JailMonkey from 'jail-monkey';

/**
 * Best-effort only, per the product's own "no seguridad ceremonial" stance:
 * root/jailbreak detection is trivially bypassable on a device that's
 * actually been tampered with by someone who knows what they're doing, so
 * this is used ONLY to show a non-blocking warning, never to refuse to run.
 * A false positive/negative here is an acceptable cost — blocking usage on
 * a detector this easy to spoof would only punish legitimate power users
 * while giving everyone else false confidence.
 */
export function deviceLooksCompromised(): boolean {
  try {
    return JailMonkey.isJailBroken();
  } catch {
    return false;
  }
}
