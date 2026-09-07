/**
 * Screenshot/screen-recording protection is relaxed ONLY in a development
 * build. `__DEV__` is set by React Native's own bundler — `true` for
 * `expo start`/a dev client, always `false` for a release build (EAS
 * production profile, or a local `assembleRelease`). This is deliberately
 * derived, not a manually-flipped boolean: a release can never accidentally
 * ship with screenshots allowed just because someone forgot to flip a flag
 * back before building, which is exactly what happened during this app's
 * own UX-review pass (screenshots were turned on by hand to review flows,
 * then this file was changed to remove that manual step entirely).
 *
 * `preventScreenCaptureAsync()` exists for a real reason — Android's
 * FLAG_SECURE it sets is what stops credentials from ending up in a
 * screenshot or the app-switcher thumbnail. Both call sites (App.tsx
 * globally, CredentialDetailScreen.tsx's own extra hardening) read this
 * single constant.
 */
export const DEV_ALLOW_SCREEN_CAPTURE = __DEV__;
