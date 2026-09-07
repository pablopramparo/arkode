import { useEffect } from 'react';
import { ActivityIndicator, Image, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePocketSession } from '../state/PocketSessionProvider';
import { Screen, AppButton } from '../components/ui';
import { theme } from '../lib/theme';

/**
 * Shown whenever the session is locked (cold start with an existing pairing,
 * or coming back from the background — see PocketSessionProvider's AppState
 * listener). Auto-triggers the unlock read on mount for a fast "just
 * works" feel; the button is there for retrying after a cancel/failure,
 * never a redundant extra tap on the happy path.
 *
 * Three distinct outcomes render three distinct ways (see
 * `lib/biometricErrors.ts` for the classification):
 *  - user_cancel: the user dismissed the OS biometric prompt — a completely
 *    normal action, not an error. Same neutral "Arkode está bloqueado"
 *    screen as plain 'locked', no color change, no message, just the
 *    retry button.
 *  - auth_failed: a real failed/locked-out verification — a short human
 *    sentence, never react-native-keychain's raw "code: N, msg: ..." text.
 *  - technical_error: anything else (including a Drive/network failure
 *    after a successful Keychain read) — a different short human sentence.
 * Nothing here ever renders a raw native error string.
 */
export function BiometricGateScreen() {
  const { phase, unlock } = usePocketSession();

  useEffect(() => {
    if (phase.kind === 'locked') void unlock();
    // Deliberately only on mount / when transitioning into 'locked' — not a
    // dependency on `unlock` itself, to avoid re-firing the prompt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind === 'locked']);

  const failure = phase.kind === 'auth_failed' ? phase : null;
  const isCancel = failure?.reason === 'user_cancel';
  const iconColor = !failure ? theme.muted : isCancel ? theme.muted : failure.reason === 'auth_failed' ? theme.warning : theme.danger;
  const messageColor = failure?.reason === 'auth_failed' ? theme.warning : theme.danger;

  return (
    <Screen style={{ justifyContent: 'center', alignItems: 'center', gap: 16 }}>
      <Image
        source={require('../../assets/arkode-logo-completo.png')}
        style={{ width: 240, height: 56, marginBottom: 8 }}
        resizeMode="contain"
        accessibilityLabel="Arkode"
      />

      <Ionicons name="lock-closed-outline" size={40} color={iconColor} />
      <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600' }}>Arkode está bloqueado</Text>

      {phase.kind === 'unlocking' && <ActivityIndicator color={theme.accent} />}

      {!failure || isCancel ? (
        <Text style={{ color: theme.muted, fontSize: 13, textAlign: 'center' }}>
          Tus credenciales están protegidas con la biometría de este equipo.
        </Text>
      ) : (
        <Text style={{ color: messageColor, fontSize: 13, textAlign: 'center' }}>{failure.message}</Text>
      )}

      {failure && <AppButton title="Desbloquear" onPress={() => void unlock()} />}
    </Screen>
  );
}
