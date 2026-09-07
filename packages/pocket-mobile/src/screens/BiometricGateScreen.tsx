import { useEffect } from 'react';
import { ActivityIndicator, Text } from 'react-native';
import { usePocketSession } from '../state/PocketSessionProvider';
import { Screen, Title, Muted, AppButton } from '../components/ui';
import { theme } from '../lib/theme';

/**
 * Shown whenever the session is locked (cold start with an existing pairing,
 * or coming back from the background — see PocketSessionProvider's AppState
 * listener). Auto-triggers the unlock read on mount for a fast "just
 * works" feel; the button is there for retrying after a cancel/failure,
 * never a redundant extra tap on the happy path.
 */
export function BiometricGateScreen() {
  const { phase, unlock } = usePocketSession();

  useEffect(() => {
    if (phase.kind === 'locked') void unlock();
    // Deliberately only on mount / when transitioning into 'locked' — not a
    // dependency on `unlock` itself, to avoid re-firing the prompt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind === 'locked']);

  const failed = phase.kind === 'auth_failed' ? phase.message : null;

  // The "Desbloquear" button is a manual-retry escape hatch, never a
  // required tap on the happy path: cold start and every foreground after
  // the grace period both trigger the biometric prompt automatically (the
  // effect above). Showing the button unconditionally made the auto-prompt
  // easy to miss and trained the "tap Desbloquear, then authenticate" habit
  // this pass was asked to remove — it now only appears once there's
  // actually something to retry.
  return (
    <Screen style={{ justifyContent: 'center', alignItems: 'center', gap: 16 }}>
      <Title>Arkode Pocket</Title>
      {phase.kind === 'unlocking' && <ActivityIndicator color={theme.accent} />}
      {failed && <Text style={{ color: theme.danger, textAlign: 'center' }}>{failed}</Text>}
      <Muted>Tus credenciales están protegidas por la biometría de este equipo.</Muted>
      {phase.kind === 'auth_failed' && <AppButton title="Desbloquear" onPress={() => void unlock()} />}
    </Screen>
  );
}
