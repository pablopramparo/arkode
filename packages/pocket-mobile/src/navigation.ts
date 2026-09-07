/**
 * A tiny hand-rolled screen stack — deliberately not React Navigation or
 * Expo Router. Pocket has five screens total and no deep-linking
 * requirement, so a real navigation library would be pure ceremony for an
 * app whose whole brief is "stay small."
 */
export type Route =
  | { name: 'home' }
  | { name: 'client'; clientId: string }
  | { name: 'credential'; credentialId: string }
  | { name: 'url'; urlId: string }
  | { name: 'settings' };
