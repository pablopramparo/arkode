import { useEffect, useState } from 'react';
import { AppState, BackHandler, StyleSheet, View, type AppStateStatus } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import Constants from 'expo-constants';
import * as ScreenCapture from 'expo-screen-capture';
import * as SplashScreen from 'expo-splash-screen';
import { PocketSessionProvider, usePocketSession } from './src/state/PocketSessionProvider';
import { configureGoogleSignIn } from './src/auth/googleAuth';
import { PairingScreen } from './src/screens/PairingScreen';
import { BiometricGateScreen } from './src/screens/BiometricGateScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { ClientDetailScreen } from './src/screens/ClientDetailScreen';
import { CredentialDetailScreen } from './src/screens/CredentialDetailScreen';
import { UrlDetailScreen } from './src/screens/UrlDetailScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { theme } from './src/lib/theme';
import type { Route } from './src/navigation';
import { DEV_ALLOW_SCREEN_CAPTURE } from './src/lib/devFlags';

// Keep the native splash screen up until the very first real phase decision
// (paired vs. not) is known — `hasStoredPairing()` is fast (a local
// Keychain existence check, no biometric prompt), so this only covers that
// genuinely-brief real initialization, never used as a decorative delay.
void SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * Root screen switch, driven entirely by `usePocketSession().phase` — see
 * PocketSessionProvider for the actual state machine (pairing → locked →
 * unlocking → unlocked, with a grace period before backgrounding drops back
 * to locked).
 */
function RootNavigator() {
  const { phase } = usePocketSession();
  // A real (if tiny) stack, not just "the current screen" — the previous
  // version tracked a single Route, so every screen's own "‹ Volver" always
  // jumped straight to Home regardless of how you got there, AND the
  // hardware Android back button had nothing to intercept at all, so
  // pressing it from anywhere just exited the whole app. Reported directly
  // as broken navigation, not a style preference. `navigate` pushes,
  // `goBack` pops; the physical back button now does the same `goBack` the
  // on-screen link does, and only lets Android handle it (exit/background
  // the app) once the stack is back down to Home.
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }]);
  const route = stack[stack.length - 1];
  const navigate = (next: Route) => setStack((s) => [...s, next]);
  const goBack = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  // A fresh unlock (or coming back from background) always lands on Home —
  // deep navigation state is not worth preserving across a re-lock for an
  // app this small, and it avoids landing on a stale credential screen for
  // data that may have just changed.
  useEffect(() => {
    if (phase.kind === 'unlocked') setStack([{ name: 'home' }]);
  }, [phase.kind === 'unlocked']);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 1) {
        goBack();
        return true; // handled — don't let Android also exit/background the app
      }
      return false; // already at Home — let Android's own default back behavior run
    });
    return () => sub.remove();
  }, [stack.length]);

  // The native splash covers 'loading'; hide it the instant we know whether
  // this device is paired, handing off to whichever real screen comes next
  // (pairing camera, or the biometric gate — never a blank frame in between).
  useEffect(() => {
    if (phase.kind !== 'loading') void SplashScreen.hideAsync().catch(() => {});
  }, [phase.kind]);

  if (phase.kind === 'loading') return null;
  if (phase.kind === 'needs_pairing') return <PairingScreen />;
  if (phase.kind === 'locked' || phase.kind === 'unlocking' || phase.kind === 'auth_failed') return <BiometricGateScreen />;

  const { payload, lastGoodGeneratedAt, lastOutcome, refreshing } = phase;

  if (route.name === 'settings') return <SettingsScreen onBack={goBack} />;
  if (route.name === 'client') {
    return <ClientDetailScreen payload={payload} clientId={route.clientId} onNavigate={navigate} onBack={goBack} />;
  }
  if (route.name === 'credential') {
    return <CredentialDetailScreen payload={payload} credentialId={route.credentialId} onBack={goBack} />;
  }
  if (route.name === 'url') {
    return <UrlDetailScreen payload={payload} urlId={route.urlId} onBack={goBack} />;
  }
  return (
    <HomeScreen
      payload={payload}
      lastGoodGeneratedAt={lastGoodGeneratedAt}
      lastOutcome={lastOutcome}
      refreshing={refreshing}
      onNavigate={navigate}
    />
  );
}

/**
 * An always-mounted opaque curtain that only ever toggles visibility (never
 * mounts/unmounts), so it can hide the screen the INSTANT the app resigns
 * active — faster than waiting for a full React re-render of the real
 * screen tree to clear sensitive text. This is what keeps a plaintext
 * password out of the OS app-switcher thumbnail on both platforms (Android
 * additionally gets FLAG_SECURE via expo-screen-capture, which also blocks
 * screenshots outright — iOS has no such API, this curtain is the only
 * mitigation available there).
 */
function PrivacyCurtain() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      setVisible(state === 'background' || state === 'inactive');
    });
    return () => sub.remove();
  }, []);
  // Always mounted — only `opacity` toggles, so there is no render/mount
  // delay between the OS event firing and the curtain actually covering
  // the screen.
  return (
    <View
      style={[StyleSheet.absoluteFill, { backgroundColor: theme.background, opacity: visible ? 1 : 0 }]}
      pointerEvents="none"
      testID="privacy-curtain"
    />
  );
}

export default function App() {
  useEffect(() => {
    // configure() is mandatory before signIn() regardless of whether a real
    // web client ID is configured — see googleAuth.ts's own doc comment for
    // why webClientId itself is optional for this app's Android-only,
    // offlineAccess:false configuration. Skipping this call entirely
    // whenever the placeholder hadn't been replaced was a real gap: it
    // silently left Google Sign-In unusable even for a plain Android test
    // that never needed a web client ID at all.
    const webClientId = (Constants.expoConfig?.extra as { googleWebClientId?: string } | undefined)?.googleWebClientId;
    configureGoogleSignIn(webClientId && !webClientId.startsWith('REPLACE_WITH_') ? webClientId : undefined);
    // Global, for the app's whole lifetime — see docs/pocket.md's
    // screenshots section for why this is a deliberate "global for
    // simplicity" choice rather than trying to scope it per-screen.
    if (!DEV_ALLOW_SCREEN_CAPTURE) void ScreenCapture.preventScreenCaptureAsync();
  }, []);

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: theme.background }}>
        <StatusBar style="light" />
        <PocketSessionProvider>
          <RootNavigator />
        </PocketSessionProvider>
        <PrivacyCurtain />
      </View>
    </SafeAreaProvider>
  );
}
